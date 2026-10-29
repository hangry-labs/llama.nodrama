const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const core = path.join(__dirname, '../internal/web/static/app/core');
function simulation(mode = 'router') {
  let time = 1800000000000;
  const context = vm.createContext({ state: { params: { poll: 1000 }, selectedModel: 'demo-a' } });
  vm.runInContext(fs.readFileSync(path.join(core, '05-demo-data.js'), 'utf8'), context);
  context.now = () => time;
  context.mode = mode;
  const demo = vm.runInContext(`createDemoData(mode, { model_path: '/models/demo.gguf', default_generation_settings: { temperature: 0.7 } },
    mode === 'router' ? [{id:'demo-a',status:{value:'loaded'}},{id:'demo-b',status:{value:'unloaded'}}] : null,
    [{id:'demo-model',meta:{n_ctx_train:32768}}], now)`, context);
  return { demo, context, advance: ms => { time += ms; } };
}

test('single and router demos produce normalized, internally consistent snapshots', () => {
  for (const mode of ['single', 'router']) {
    const { demo } = simulation(mode);
    const snapshot = demo.snapshot();
    assert.equal(snapshot.mode, mode);
    assert.equal(snapshot.props.n_ctx, 32768);
    assert.equal(snapshot.slots.length, 4);
    assert.ok(snapshot.slots.some(slot => slot.decodedTokens > 0));
    for (const slot of snapshot.slots) {
      assert.equal(slot.contextTokens, 8192);
      assert.ok(slot.promptProgress >= 0 && slot.promptProgress <= 1);
      assert.ok(slot.generationProgress >= 0 && slot.generationProgress <= 1);
      if (slot.isProcessing) assert.equal(slot.decodedTokens + slot.remainingTokens, 512);
      assert.equal(snapshot.history.slots[slot.id].length, 120);
    }
    const busy = snapshot.slots.filter(slot => slot.isProcessing).length;
    assert.equal(snapshot.rawMetrics['llamacpp:requests_processing'], busy);
    assert.equal(snapshot.overview.busySlots, busy);
    assert.ok(snapshot.queries.length >= 4);
  }
});

test('slot states, progress and histories advance with time and remain bounded', () => {
  const { demo, advance } = simulation();
  const first = demo.snapshot();
  const initial = first.slots[1].decodedTokens;
  advance(2000);
  const next = demo.snapshot();
  assert.ok(next.slots[1].decodedTokens > initial);
  assert.ok(next.history.metrics['nodrama:tokens_predicted_rate'].some(point => point.v > 0));
  assert.equal(next.history.metrics['nodrama:tokens_predicted_rate'].length, 120);
  advance(24 * 3600000);
  assert.equal(demo.snapshot().history.slots[0].length, 120);
});

test('cache details balance occupancy and link to queries and slots', () => {
  const { demo } = simulation();
  const { promptCache: cache, queries } = demo.snapshot();
  assert.equal(cache.detailsAvailable, true);
  const sum = cache.topEntries.reduce((total, entry) => total + entry.mib, 0);
  assert.ok(Math.abs(sum + cache.untrackedMiB + cache.unusedMiB - cache.limitMiB) < 0.001);
  for (const entry of cache.topEntries) assert.ok(queries.some(query => query.cacheKey === entry.key && query.slotIds.includes(entry.lastSlotId)));
  demo.slotAction(0, 'erase');
  assert.ok(!demo.snapshot().promptCache.topEntries.some(entry => entry.lastSlotId === 0));
  demo.slotAction(0, 'restore');
  assert.ok(demo.snapshot().promptCache.topEntries.some(entry => entry.lastSlotId === 0));
});

test('history reset clears samples without rebuilding historical activity', () => {
  const { demo, advance } = simulation();
  assert.equal(demo.metricHistory('nodrama:tokens_predicted_rate').points.length, 120);
  demo.resetHistory();
  assert.equal(demo.metricHistory('nodrama:tokens_predicted_rate').points.length, 1);
  advance(1000);
  assert.equal(demo.metricHistory('nodrama:tokens_predicted_rate').points.length, 2);
});

test('model load/unload changes selected-model slot activity', () => {
  const { demo, context } = simulation();
  demo.modelAction('demo-a', 'unload');
  assert.ok(demo.snapshot().slots.every(slot => !slot.isProcessing));
  demo.modelAction('demo-b', 'load');
  context.state.selectedModel = 'demo-b';
  assert.equal(demo.snapshot().models[0].id, 'demo-b');
  assert.ok(demo.snapshot().slots.some(slot => slot.isProcessing));
});

test('launch options retain negative numeric values and stop at the argument separator', () => {
  const context = vm.createContext({});
  const file = path.join(core, '../shell/20-config-options.js');
  vm.runInContext(fs.readFileSync(file, 'utf8'), context);
  const options = vm.runInContext(`parseLaunchArgs(['-c','-1','--temperature=-0.5','--metrics','--','--not-a-flag'])`, context);
  assert.deepEqual(JSON.parse(JSON.stringify(options)).map(option => [option.label, option.value]),
    [['-c', '-1'], ['--temperature', '-0.5'], ['--metrics', true]]);
});

test('snapshot poller restart preserves the independent log poller', () => {
  const stopped = [];
  const context = vm.createContext({ state: { pollers: [
    { name: 'snapshot', stop: () => stopped.push('snapshot') },
    { name: 'log', stop: () => stopped.push('log') },
  ] }, document: { addEventListener() {} } });
  vm.runInContext(fs.readFileSync(path.join(core, '30-polling.js'), 'utf8'), context);
  vm.runInContext('stopPoller("snapshot")', context);
  assert.deepEqual(stopped, ['snapshot']);
  assert.equal(context.state.pollers[0].name, 'log');
});

test('manual pause survives hidden/visible tab transitions', () => {
  let visibility;
  const context = vm.createContext({
    state: { paused: true, healthy: true, ui: { bootDone: true } },
    document: { hidden: false, addEventListener: (_name, callback) => { visibility = callback; } },
    setStatus() {},
  });
  vm.runInContext(fs.readFileSync(path.join(core, '30-polling.js'), 'utf8'), context);
  context.document.hidden = true; visibility();
  context.document.hidden = false; visibility();
  assert.equal(context.state.paused, true);
  context.state.paused = false;
  context.document.hidden = true; visibility();
  assert.equal(context.state.paused, true);
  context.document.hidden = false; visibility();
  assert.equal(context.state.paused, false);
});

test('fetch timeout still applies while reading a body with a caller signal', { timeout: 1000 }, async () => {
  const context = vm.createContext({
    AbortController, setTimeout, clearTimeout, URL,
    state: { mode: 'single' }, window: { location: { origin: 'http://localhost' } },
    external: new AbortController(),
    t: (_key, values) => `Timed out after ${values.seconds}s`,
    fetch: async (_url, { signal }) => new Response(new ReadableStream({
      start(controller) {
        signal.addEventListener('abort', () => controller.error(new DOMException('Stopped', 'AbortError')));
      },
    })),
  });
  vm.runInContext(fs.readFileSync(path.join(core, '10-network-demo.js'), 'utf8'), context);
  await assert.rejects(vm.runInContext('fetchJSON("/api/snapshot", { timeout: 15, signal: external.signal })', context),
    error => error.timedOut === true && !error.aborted && /Timed out/.test(error.message));
  assert.equal(context.external.signal.aborted, false);
});

test('caller cancellation remains distinct from a monitoring timeout', async () => {
  const context = vm.createContext({
    AbortController, setTimeout, clearTimeout, URL,
    state: { mode: 'single' }, window: { location: { origin: 'http://localhost' } },
    external: new AbortController(),
    fetch: (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')));
    }),
  });
  vm.runInContext(fs.readFileSync(path.join(core, '10-network-demo.js'), 'utf8'), context);
  const pending = vm.runInContext('fetchJSON("/api/snapshot", { signal: external.signal })', context);
  context.external.abort();
  await assert.rejects(pending, error => error.aborted === true && !error.timedOut);
});
