"use strict";

let sparklineSequence = 0;

function sparkline(data, options = {}) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("preserveAspectRatio", "none");
  const part = (tag, className, parent = svg) => {
    const node = document.createElementNS(svg.namespaceURI, tag);
    node.setAttribute("class", className); parent.appendChild(node); return node;
  };
  const grid = part("path", "spark-grid");
  const defs = part("defs", "spark-defs");
  const clip = part("clipPath", "spark-clip", defs);
  clip.id = "spark-clip-" + (++sparklineSequence);
  const clipRect = part("rect", "spark-clip-rect", clip);
  clipRect.setAttribute("x", "5"); clipRect.setAttribute("width", "390");
  const trace = part("g", "spark-trace");
  trace.setAttribute("clip-path", "url(#" + clip.id + ")");
  const area = part("path", "spark-area", trace);
  const line = part("path", "spark-line", trace);
  const latest = part("circle", "spark-latest");
  latest.setAttribute("r", "2.5");
  const markerLine = part("path", "spark-marker-line");
  const marker = part("ellipse", "spark-marker");
  const model = svg.chartModel = { grid, area, line, latest, markerLine, marker, clipRect, frame: null, selectedTime: null };
  const hide = () => {
    model.selectedTime = null; model.pointer = null;
    marker.setAttribute("hidden", ""); markerLine.setAttribute("hidden", ""); hideSparkTooltip();
  };
  const inspect = (index, pointer) => {
    const point = model.geometry.data[index];
    const vertex = point && model.drawn.find(vertex => vertex.t === point.t);
    if (!point || !vertex) return;
    model.selectedTime = point.t;
    const bounds = svg.getBoundingClientRect();
    const x = Math.max(5, Math.min(395, vertex.x));
    marker.setAttribute("cx", x); marker.setAttribute("cy", vertex.y);
    marker.setAttribute("rx", 4 * 400 / Math.max(1, bounds.width));
    marker.setAttribute("ry", 4 * model.geometry.height / Math.max(1, bounds.height));
    markerLine.setAttribute("d", "M" + x + ",5 V" + (model.geometry.height - 5));
    marker.removeAttribute("hidden"); markerLine.removeAttribute("hidden");
    const text = (model.options.formatTime || fmtTime)(point.t) + " · " + (model.options.formatValue || fmtNumber)(point.v);
    svg.setAttribute("aria-valuenow", index); svg.setAttribute("aria-valuetext", text);
    showSparkTooltip(text, pointer?.x ?? bounds.left + x / 400 * bounds.width,
      pointer?.y ?? bounds.top + vertex.y / model.geometry.height * bounds.height);
  };
  model.refreshInspection = () => {
    if (model.pointer) {
      const bounds = svg.getBoundingClientRect();
      const fraction = Math.max(0, Math.min(1, ((model.pointer.x - bounds.left) / Math.max(1, bounds.width) * 400 - 5) / 390));
      const points = model.geometry.data;
      if (!points.length) return hide();
      const target = model.view.start + fraction * (model.view.end - model.view.start);
      const nearest = nearestHistoryPoint(points, target);
      inspect(points.indexOf(nearest), model.pointer);
    } else if (model.selectedTime !== null) {
      const point = nearestHistoryPoint(model.geometry.data, model.selectedTime);
      if (point) inspect(model.geometry.data.indexOf(point)); else hide();
    }
  };
  const pointer = event => {
    if (!model.options.interactive) return;
    model.pointerType = event.pointerType;
    if (event.pointerType === "touch") svg.focus({ preventScroll: true });
    model.pointer = { x: event.clientX, y: event.clientY };
    model.refreshInspection();
  };
  svg.addEventListener("pointermove", pointer);
  svg.addEventListener("pointerdown", pointer);
  svg.addEventListener("pointerleave", () => { if (model.pointerType !== "touch") hide(); });
  svg.addEventListener("pointercancel", hide);
  svg.addEventListener("blur", hide);
  svg.addEventListener("focus", () => { if (model.options.interactive) inspect(model.geometry.data.length - 1); });
  svg.addEventListener("keydown", event => {
    if (!model.options.interactive || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const points = model.geometry.data;
    let index = points.indexOf(nearestHistoryPoint(points, model.selectedTime ?? points[points.length - 1]?.t));
    if (event.key === "Home") index = 0;
    else if (event.key === "End") index = points.length - 1;
    else index = Math.max(0, Math.min(points.length - 1, index + (event.key === "ArrowLeft" ? -1 : 1)));
    model.pointer = null; inspect(index);
  });
  updateSparklineSVG(svg, data, options);
  return svg;
}

function updateSparkline(host, data, options = {}) {
  let svg = host.querySelector("svg");
  if (!svg || !svg.chartModel) {
    host.replaceChildren(sparkline(data, options));
  } else updateSparklineSVG(svg, data, options);
}

function updateSparklineSVG(svg, data, options) {
  const model = svg.chartModel;
  const previous = model.geometry;
  const previousStep = model.options?.step;
  const geometry = chartGeometry(data, options);
  model.geometry = geometry; model.options = options;
  svg.setAttribute("viewBox", "0 0 400 " + geometry.height);
  svg.setAttribute("role", options.interactive ? "slider" : "img");
  svg.setAttribute("aria-label", options.label || t("diagnostics.chart_hint"));
  if (options.interactive) {
    svg.setAttribute("tabindex", geometry.data.length ? "0" : "-1");
    svg.setAttribute("aria-disabled", String(!geometry.data.length));
    svg.setAttribute("aria-valuemin", "0");
    svg.setAttribute("aria-valuemax", Math.max(0, geometry.data.length - 1));
    svg.setAttribute("aria-valuenow", Math.max(0, geometry.data.length - 1));
    const latest = geometry.data[geometry.data.length - 1];
    svg.setAttribute("aria-valuetext", latest ? (options.formatTime || fmtTime)(latest.t) + " · " + (options.formatValue || fmtNumber)(latest.v) : t("metrics.no_data"));
  }
  model.grid.setAttribute("d", [5, geometry.height / 2, geometry.height - 5].map(y => "M5," + y + " H395").join(" "));
  model.clipRect.setAttribute("height", geometry.height);
  const motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");
  const reducedMotion = () => motionPreference.matches;
  // A repeated snapshot must not cancel/restart a transition in progress.
  if (sameChartGeometry(previous, geometry) && previousStep === options.step && !reducedMotion()) {
    if (model.selectedTime !== null || model.pointer) model.refreshInspection();
    return;
  }
  const draw = (vertices, view) => {
    const paths = chartPaths(vertices, geometry.height, options.step);
    model.line.setAttribute("d", paths.line); model.area.setAttribute("d", paths.area);
    model.drawn = vertices; model.view = view;
    const last = chartRightEdge(vertices, options.step);
    if (last) { model.latest.setAttribute("cx", last.x); model.latest.setAttribute("cy", last.y); model.latest.removeAttribute("hidden"); }
    else model.latest.setAttribute("hidden", "");
    if (model.selectedTime !== null || model.pointer) model.refreshInspection();
  };
  if (model.frame !== null) cancelAnimationFrame(model.frame);
  model.finish = () => {
    if (model.frame !== null) cancelAnimationFrame(model.frame);
    model.frame = null;
    draw(geometry.vertices, geometry);
  };
  const rect = svg.getBoundingClientRect();
  const transition = previous && previousStep === options.step
    && chartTransition(previous, geometry, model.drawn, model.view);
  const animate = transition && !reducedMotion() && !document.hidden && rect.bottom > 0 && rect.top < innerHeight;
  const now = performance.now();
  // Linear motion over the observed update interval avoids the old 220ms
  // burst-and-stop on every poll. Late updates have a bounded catch-up time.
  const duration = Math.max(80, Math.min(1500, now - (model.changedAt ?? now)));
  model.changedAt = now;
  if (animate) {
    const started = performance.now();
    const tick = time => {
      const fraction = Math.max(0, Math.min(1, (time - started) / duration));
      if (fraction >= 1 || !svg.isConnected || document.hidden || reducedMotion()) { model.finish(); return; }
      const frame = transition(fraction);
      draw(frame.vertices, frame.view);
      model.frame = requestAnimationFrame(tick);
    };
    model.frame = requestAnimationFrame(tick);
  } else model.finish();
  if (model.selectedTime !== null || model.pointer) model.refreshInspection();
  else { model.marker.setAttribute("hidden", ""); model.markerLine.setAttribute("hidden", ""); }
}

function finishSparklineAnimations() {
  for (const svg of $$("svg")) svg.chartModel?.finish?.();
}

function nearestHistoryPoint(data, target) {
  if (!data?.length) return null;
  let low = 0, high = data.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (data[middle].t < target) low = middle + 1; else high = middle;
  }
  const before = data[Math.max(0, low - 1)], after = data[low];
  return Math.abs(before.t - target) <= Math.abs(after.t - target) ? before : after;
}

function showSparkTooltip(text, x, y) {
  let node = $("#spark-tooltip");
  if (!node) { node = el("div", { id: "spark-tooltip", class: "spark-tooltip", role: "status", hidden: true }); document.body.appendChild(node); }
  node.textContent = text; node.hidden = false;
  const bounds = node.getBoundingClientRect();
  node.style.left = Math.max(8, Math.min(innerWidth - bounds.width - 8, x + 12)) + "px";
  node.style.top = Math.max(8, Math.min(innerHeight - bounds.height - 8, y - bounds.height - 12)) + "px";
}

function hideSparkTooltip() {
  const node = $("#spark-tooltip");
  if (node) node.hidden = true;
}

document.addEventListener("pointerdown", event => {
  const chart = event.target.closest?.("svg");
  if (chart?.chartModel?.options.interactive) return;
  hideSparkTooltip();
  if (document.activeElement?.chartModel) document.activeElement.blur();
});
