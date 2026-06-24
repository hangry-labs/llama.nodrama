"use strict";

/* ──────────────────────────────────────────────────────────────────────
 *  SVG sparkline. No external deps. Returns an <svg> node.
 *  - data: array of {t, v}
 *  - opts: { min, max, height, interactive, formatValue, formatTime }
 * ──────────────────────────────────────────────────────────────────── */
function sparkline(data, opts) {
  const W = 200, H = (opts && opts.height) || 36;
  const pad = 1;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 " + W + " " + H);
  svg.setAttribute("preserveAspectRatio", "none");
  if (!data || data.length < 2) {
    /* render an empty axis so the layout doesn't jump */
    const g = document.createElementNS("http://www.w3.org/2000/svg", "line");
    g.setAttribute("x1", 0); g.setAttribute("x2", W);
    g.setAttribute("y1", H - pad); g.setAttribute("y2", H - pad);
    g.setAttribute("class", "spark-grid");
    svg.appendChild(g);
    return svg;
  }
  /* x scale = real time so gaps/holes show as gaps */
  const t0 = data[0].t, t1 = data[data.length - 1].t;
  const span = Math.max(1, t1 - t0);
  let vMin = (opts && opts.min !== undefined) ? opts.min : Infinity;
  let vMax = (opts && opts.max !== undefined) ? opts.max : -Infinity;
  if (opts && opts.min === undefined) for (const p of data) if (p.v < vMin) vMin = p.v;
  if (opts && opts.max === undefined) for (const p of data) if (p.v > vMax) vMax = p.v;
  if (!isFinite(vMin)) vMin = 0;
  if (!isFinite(vMax)) vMax = 1;
  if (vMax - vMin < 1e-9) { vMax = vMin + 1; }
  const sx = (t) => ((t - t0) / span) * W;
  const sy = (v) => H - pad - ((v - vMin) / (vMax - vMin)) * (H - 2 * pad);
  const points = data.map((p) => sx(p.t).toFixed(1) + "," + sy(p.v).toFixed(1)).join(" ");
  /* baseline rule */
  const base = document.createElementNS("http://www.w3.org/2000/svg", "line");
  base.setAttribute("x1", 0); base.setAttribute("x2", W);
  base.setAttribute("y1", H - pad); base.setAttribute("y2", H - pad);
  base.setAttribute("class", "spark-grid");
  svg.appendChild(base);
  /* filled area */
  const area = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
  area.setAttribute("points",
    "0," + (H - pad) + " " + points + " " + W + "," + (H - pad));
  area.setAttribute("class", "spark-area");
  svg.appendChild(area);
  /* line */
  const line = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
  line.setAttribute("points", points);
  line.setAttribute("class", "spark-line");
  svg.appendChild(line);
  if (opts && opts.interactive) {
    const markerLine = document.createElementNS("http://www.w3.org/2000/svg", "line");
    markerLine.setAttribute("class", "spark-marker-line");
    markerLine.setAttribute("y1", pad);
    markerLine.setAttribute("y2", H - pad);
    markerLine.setAttribute("hidden", "hidden");
    svg.appendChild(markerLine);

    const marker = document.createElementNS("http://www.w3.org/2000/svg", "ellipse");
    marker.setAttribute("class", "spark-marker");
    marker.setAttribute("hidden", "hidden");
    svg.appendChild(marker);

    const formatValue = opts.formatValue || ((v) => fmtNumber(v));
    const formatTime = opts.formatTime || fmtTime;
    const hideMarker = () => {
      marker.setAttribute("hidden", "hidden");
      markerLine.setAttribute("hidden", "hidden");
      hideSparkTooltip();
    };
    svg.addEventListener("mousemove", (e) => {
      const rect = svg.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const targetT = t0 + ratio * span;
      const p = nearestHistoryPoint(data, targetT);
      if (!p) return;
      const x = sx(p.t).toFixed(1);
      const y = sy(p.v).toFixed(1);
      const radiusPx = opts.pointPixelRadius || 4;
      const rx = (radiusPx * W / rect.width).toFixed(2);
      const ry = (radiusPx * H / rect.height).toFixed(2);
      markerLine.setAttribute("x1", x);
      markerLine.setAttribute("x2", x);
      markerLine.removeAttribute("hidden");
      marker.setAttribute("cx", x);
      marker.setAttribute("cy", y);
      marker.setAttribute("rx", rx);
      marker.setAttribute("ry", ry);
      marker.removeAttribute("hidden");
      showSparkTooltip(formatTime(p.t) + " · " + formatValue(p.v), e.clientX, e.clientY);
    });
    svg.addEventListener("mouseleave", hideMarker);
    svg.addEventListener("blur", hideMarker);
  }
  return svg;
}

function nearestHistoryPoint(data, targetT) {
  if (!data || !data.length) return null;
  let lo = 0, hi = data.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (data[mid].t < targetT) lo = mid + 1;
    else hi = mid;
  }
  const prev = lo > 0 ? data[lo - 1] : null;
  const cur = data[lo];
  if (!prev) return cur;
  if (!cur) return prev;
  return Math.abs(prev.t - targetT) <= Math.abs(cur.t - targetT) ? prev : cur;
}

function sparkTooltipNode() {
  let node = $("#spark-tooltip");
  if (!node) {
    node = el("div", { id: "spark-tooltip", class: "spark-tooltip", hidden: true }, "");
    document.body.appendChild(node);
  }
  return node;
}

function showSparkTooltip(text, x, y) {
  const node = sparkTooltipNode();
  node.textContent = text;
  node.hidden = false;
  node.style.left = Math.min(window.innerWidth - 260, x + 12) + "px";
  node.style.top = Math.max(8, y - 34) + "px";
}

function hideSparkTooltip() {
  const node = $("#spark-tooltip");
  if (node) node.hidden = true;
}

