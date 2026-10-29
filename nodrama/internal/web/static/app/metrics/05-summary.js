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

function chartGeometry(points, options = {}) {
  const data = (points || []).filter(point => Number.isFinite(point.t) && Number.isFinite(point.v))
    .slice().sort((a, b) => a.t - b.t);
  const width = 400, height = options.height || 64, pad = 5;
  const values = data.map(point => point.v);
  const min = Number.isFinite(options.min) ? options.min : (values.length ? Math.min(...values) : 0);
  const max = Number.isFinite(options.max) ? options.max : (values.length ? Math.max(...values) : 1);
  const ceiling = max > min ? max : min + Math.max(1, Math.abs(min) * 0.1);
  const start = data[0]?.t || 0, end = data[data.length - 1]?.t || start;
  const intervals = data.slice(1).map((point, index) => point.t - data[index].t).filter(value => value > 0).sort((a, b) => a - b);
  const cadence = intervals[Math.floor(intervals.length / 2)] || 1000;
  const vertices = data.map((point, index) => ({
    x: pad + (point.t - start) / Math.max(1, end - start) * (width - pad * 2),
    y: height - pad - Math.max(0, Math.min(1, (point.v - min) / (ceiling - min))) * (height - pad * 2),
    start: index === 0 || point.t - data[index - 1].t > cadence * 3,
  }));
  return { data, vertices, width, height, min, max: ceiling };
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
