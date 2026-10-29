const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../internal/web/static/app/metrics/05-summary.js'), 'utf8'), context);
const run = source => vm.runInContext(source, context);

test('history statistics use finite samples in time order and the actual window', () => {
  const result = run('summarizeMetricHistory([{t:2000,v:5},{t:0,v:1},{t:1000,v:3},{t:3000,v:NaN}])');
  assert.equal(result.average, 3);
  assert.equal(result.min, 1);
  assert.equal(result.max, 5);
  assert.equal(result.duration, 2);
  assert.equal(result.count, 3);
  assert.equal(result.delta, 4);
});

test('counter resets do not become misleading net-work deltas', () => {
  assert.equal(run('summarizeMetricHistory([{t:0,v:100},{t:1,v:1},{t:2,v:101}]).delta'), null);
  assert.equal(run('summarizeMetricHistory([])'), null);
});

test('constant and empty series produce finite bounded chart geometry', () => {
  for (const input of ['[]', '[{t:0,v:0},{t:1,v:0}]', '[{t:0,v:5},{t:1,v:5}]']) {
    const chart = run('chartGeometry(' + input + ')');
    for (const point of chart.vertices) {
      assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
      assert.ok(point.y >= 5 && point.y <= chart.height - 5);
    }
  }
});

test('chart paths break at collection gaps instead of joining unknown data', () => {
  const paths = run('chartPaths(chartGeometry([{t:0,v:1},{t:1000,v:2},{t:2000,v:3},{t:12000,v:4}]).vertices,64)');
  assert.equal((paths.line.match(/M/g) || []).length, 2);
  assert.equal((paths.area.match(/Z/g) || []).length, 2);
});

test('discrete request gauges use steps, with no invented diagonal interpolation', () => {
  const paths = run('chartPaths(chartGeometry([{t:0,v:0},{t:1000,v:2}], {min:0}).vertices,64,true)');
  assert.match(paths.line, /H/);
  assert.match(paths.line, /V/);
  assert.doesNotMatch(paths.line, /L/);
});
