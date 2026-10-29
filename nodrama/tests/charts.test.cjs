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

test('scrolling peaks keep their sample time and height throughout the transition', () => {
  const frames = run(`(() => {
    const options = {min:0,max:10,height:80};
    const before = chartGeometry([{t:1000,v:0},{t:2000,v:10},{t:3000,v:0}], options);
    const after = chartGeometry([{t:2000,v:10},{t:3000,v:0},{t:4000,v:0}], options);
    const transition = chartTransition(before, after, before.vertices);
    return [0,.25,.5,.75,1].map(f => transition(f).vertices.find(p => p.t === 2000));
  })()`);
  assert.deepEqual(Array.from(frames, p => p.x), [200, 151.25, 102.5, 53.75, 5]);
  for (const peak of frames) { assert.equal(peak.v, 10); assert.equal(peak.y, 5); }
});

test('growing history animates new samples without reshaping retained samples', () => {
  const result = run(`(() => {
    const before = chartGeometry([{t:1000,v:0},{t:2000,v:10},{t:3000,v:0}], {min:0,max:10});
    const after = chartGeometry([...before.data,{t:4000,v:2}], {min:0,max:10});
    return chartTransition(before, after, before.vertices)(.5);
  })()`);
  assert.equal(result.vertices.length, 4);
  const peak = result.vertices.find(p => p.t === 2000);
  assert.equal(peak.v, 10);
  assert.equal(peak.y, 5);
  assert.ok(peak.x < 200 && peak.x > 135);
  assert.ok(result.vertices.at(-1).x > 395, 'new sample enters from beyond the plot edge');
});

test('a browser poll can animate several backend samples arriving together', () => {
  const result = run(`(() => {
    const before = chartGeometry([0,250,500,750,1000].map(t => ({t,v:t===500?10:0})), {min:0,max:10});
    const after = chartGeometry([250,500,750,1000,1250,1500,1750,2000].map(t => ({t,v:t===500?10:0})), {min:0,max:10});
    return chartTransition(before,after,before.vertices)(.5);
  })()`);
  assert.equal(result.vertices.find(p => p.t === 500).v, 10);
  assert.equal(result.vertices.find(p => p.t === 500).y, 5);
  assert.equal(result.view.end, 1500);
});

test('an interrupted scroll continues from its displayed window without jumping', () => {
  const result = run(`(() => {
    const options = {min:0,max:10};
    const before = chartGeometry([{t:1000,v:0},{t:2000,v:10},{t:3000,v:0}], options);
    const after = chartGeometry([{t:2000,v:10},{t:3000,v:0},{t:4000,v:0}], options);
    const current = chartTransition(before, after, before.vertices)(.4);
    const next = chartGeometry([{t:3000,v:0},{t:4000,v:0},{t:5000,v:4}], options);
    const continued = chartTransition(after, next, current.vertices, current.view)(0);
    return {current:current.vertices,continued:continued.vertices};
  })()`);
  for (const point of result.current) {
    const next = result.continued.find(p => p.t === point.t);
    assert.equal(next.x, point.x);
    assert.equal(next.y, point.y);
  }
});

test('transitions preserve collection gaps and step edges; resets do not animate', () => {
  const result = run(`(() => {
    const options = {min:0,max:10};
    const before = chartGeometry([{t:0,v:0},{t:1000,v:10},{t:2000,v:0},{t:12000,v:4}], options);
    const after = chartGeometry([...before.data.slice(1),{t:13000,v:2}], options);
    const frame = chartTransition(before,after,before.vertices)(.5);
    const reset = chartGeometry([{t:20000,v:0},{t:21000,v:1}], options);
    return {paths:chartPaths(frame.vertices,64,true), reset:chartTransition(after,reset,after.vertices),
      identical:sameChartGeometry(before,chartGeometry(before.data,options))};
  })()`);
  assert.equal((result.paths.line.match(/M/g) || []).length, 2);
  assert.match(result.paths.line, /H/);
  assert.doesNotMatch(result.paths.line, /L/);
  assert.equal(result.reset, null);
  assert.equal(result.identical, true);
});

test('latest marker follows the visible edge while incoming samples are clipped', () => {
  const result = run(`[
    chartRightEdge([{x:300,y:60},{x:500,y:20}],false),
    chartRightEdge([{x:300,y:60},{x:500,y:20}],true),
    chartRightEdge([{x:300,y:60},{x:500,y:20,start:true}],false)
  ]`);
  assert.equal(result[0].x, 395); assert.equal(result[0].y, 41);
  assert.equal(result[1].x, 395); assert.equal(result[1].y, 60);
  assert.equal(result[2].x, 300); assert.equal(result[2].y, 60);
});
