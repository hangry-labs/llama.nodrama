"use strict";

function summarizeMetricHistory(points) {
  const valid = (points || []).filter(point => Number.isFinite(point.t) && Number.isFinite(point.v))
    .slice().sort((a, b) => a.t - b.t);
  if (!valid.length) return null;
  const values = valid.map(point => point.v);
  return { count: valid.length, first: valid[0], latest: valid[valid.length - 1],
    min: Math.min(...values), max: Math.max(...values),
    average: values.reduce((sum, value) => sum + value, 0) / values.length,
    duration: (valid[valid.length - 1].t - valid[0].t) / 1000,
    // Counters can reset on restart; do not present a reset as negative work.
    delta: values.some((value, index) => index > 0 && value < values[index - 1]) ? null : values[values.length - 1] - values[0] };
}

// Older servers and the synthetic preview have only their short observed
// history. Keep partial intervals explicit rather than extrapolating them.
function summarizeCounterChanges(points) {
  const data = (points || []).filter(p => Number.isFinite(p.t) && Number.isFinite(p.v)).slice().sort((a, b) => a.t - b.t);
  const intervals = data.slice(1).map((p, i) => p.t - data[i].t).filter(n => n > 0).sort((a, b) => a - b);
  const maxGap = Math.max(1000, 3 * (intervals[Math.floor(intervals.length / 2)] || 1000));
  return [60, 300, 3600].map(windowSeconds => {
    const to = data.at(-1)?.t || 0, cutoff = to - windowSeconds * 1000;
    let index = data.findIndex(p => p.t >= cutoff);
    if (index > 0 && data[index].t !== cutoff) index--;
    const selected = index >= 0 ? data.slice(index) : [];
    const from = selected[0]?.t ?? to;
    let status = selected.length < 2 ? "collecting" : from > cutoff ? "partial" : "complete";
    if (selected.some((p, i) => (p.resetAt > cutoff && p.resetAt <= to) || (i && p.v < selected[i - 1].v))) status = "reset";
    else if (selected.some((p, i) => i && p.t - selected[i - 1].t > maxGap)) status = "gap";
    return { windowSeconds, from, to, observedMs: to - from, status,
      delta: ["complete", "partial"].includes(status) ? selected.at(-1).v - selected[0].v : null };
  });
}

function chartGeometry(points, options = {}) {
  const data = (points || []).filter(point => Number.isFinite(point.t) && Number.isFinite(point.v))
    .slice().sort((a, b) => a.t - b.t);
  const width = 400, height = options.height || 64;
  const values = data.map(point => point.v);
  const min = Number.isFinite(options.min) ? options.min : (values.length ? Math.min(...values) : 0);
  const max = Number.isFinite(options.max) ? options.max : (values.length ? Math.max(...values) : 1);
  const ceiling = max > min ? max : min + Math.max(1, Math.abs(min) * 0.1);
  const start = data[0]?.t || 0, end = data[data.length - 1]?.t || start;
  const intervals = data.slice(1).map((point, index) => point.t - data[index].t).filter(value => value > 0).sort((a, b) => a - b);
  const cadence = intervals[Math.floor(intervals.length / 2)] || 1000;
  const view = { start, end, height, min, max: ceiling };
  const vertices = chartVertices(data, view, cadence);
  return { data, vertices, width, ...view, cadence };
}

function chartVertices(data, view, cadence) {
  return data.map((point, index) => ({
    t: point.t, v: point.v,
    x: 5 + (point.t - view.start) / Math.max(1, view.end - view.start) * 390,
    y: view.height - 5 - Math.max(0, Math.min(1, (point.v - view.min) / (view.max - view.min))) * (view.height - 10),
    start: index === 0 || point.t - data[index - 1].t > cadence * 3,
  }));
}

function sameChartGeometry(a, b) {
  return a && a.height === b.height && a.min === b.min && a.max === b.max && a.cadence === b.cadence
    && a.data.length === b.data.length && a.data.every((point, index) => point.t === b.data[index].t && point.v === b.data[index].v);
}

// Retain sample identity while the time window moves. Outgoing samples stay
// until clipped off the left; incoming samples enter from the right. Matching
// array indexes would change historical values and flatten/rebuild every peak.
function chartTransition(from, to, drawn, view = from) {
  if (!from || from.data.length < 2 || to.data.length < 2 || from.height !== to.height
      || to.start < from.start || to.end < from.end) return null;
  const previous = new Map(drawn.map(point => [point.t, point]));
  if (!to.data.some(point => previous.has(point.t))) return null;
  const firstVisible = drawn.findIndex(point => point.x >= 5);
  const outgoing = drawn.slice(Math.max(0, firstVisible - 1)).filter(point => point.t < to.start);
  const points = outgoing.map(point => ({ t: point.t, from: point.v, to: point.v }));
  for (const point of to.data) points.push({ t: point.t, from: previous.get(point.t)?.v ?? point.v, to: point.v });
  return fraction => {
    const current = {};
    for (const key of ["start", "end", "height", "min", "max"]) current[key] = view[key] + (to[key] - view[key]) * fraction;
    const samples = points.map(point => ({ t: point.t, v: point.from + (point.to - point.from) * fraction }));
    return { view: current, vertices: chartVertices(samples, current, to.cadence) };
  };
}

function chartRightEdge(vertices, step) {
  let previous = null;
  for (const point of vertices) {
    if (point.x > 395) {
      if (!previous || point.start) return previous;
      const fraction = (395 - previous.x) / (point.x - previous.x);
      return { x: 395, y: step ? previous.y : previous.y + (point.y - previous.y) * fraction };
    }
    if (point.x >= 5) previous = point;
  }
  return previous;
}

function chartPaths(vertices, height, step = false) {
  let line = "", area = "", start = null, last = null;
  const base = height - 5;
  for (const point of vertices) {
    const x = point.x.toFixed(2), y = point.y.toFixed(2);
    if (point.start) {
      if (last) area += " L" + last.x.toFixed(2) + "," + base + " Z";
      start = point;
      area += " M" + x + "," + base + " L" + x + "," + y;
      line += " M" + x + "," + y;
    } else if (step) {
      line += " H" + x + " V" + y;
      area += " L" + x + "," + last.y.toFixed(2) + " L" + x + "," + y;
    } else { line += " L" + x + "," + y; area += " L" + x + "," + y; }
    last = point;
  }
  if (last) area += " L" + last.x.toFixed(2) + "," + base + " Z";
  return { line: line.trim(), area: area.trim() };
}
