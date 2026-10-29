"use strict";

function sparkline(data, options = {}) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("preserveAspectRatio", "none");
  const part = (tag, className) => {
    const node = document.createElementNS(svg.namespaceURI, tag);
    node.setAttribute("class", className); svg.appendChild(node); return node;
  };
  const grid = part("path", "spark-grid");
  const area = part("path", "spark-area");
  const line = part("path", "spark-line");
  const latest = part("circle", "spark-latest");
  latest.setAttribute("r", "2.5");
  const markerLine = part("path", "spark-marker-line");
  const marker = part("ellipse", "spark-marker");
  const model = svg.chartModel = { grid, area, line, latest, markerLine, marker, frame: null, selectedTime: null };
  const hide = () => {
    model.selectedTime = null; model.pointer = null;
    marker.setAttribute("hidden", ""); markerLine.setAttribute("hidden", ""); hideSparkTooltip();
  };
  const inspect = (index, pointer) => {
    const point = model.geometry.data[index], vertex = model.geometry.vertices[index];
    if (!point || !vertex) return;
    model.selectedTime = point.t;
    const bounds = svg.getBoundingClientRect();
    marker.setAttribute("cx", vertex.x); marker.setAttribute("cy", vertex.y);
    marker.setAttribute("rx", 4 * 400 / Math.max(1, bounds.width));
    marker.setAttribute("ry", 4 * model.geometry.height / Math.max(1, bounds.height));
    markerLine.setAttribute("d", "M" + vertex.x + ",5 V" + (model.geometry.height - 5));
    marker.removeAttribute("hidden"); markerLine.removeAttribute("hidden");
    const text = (model.options.formatTime || fmtTime)(point.t) + " · " + (model.options.formatValue || fmtNumber)(point.v);
    svg.setAttribute("aria-valuenow", index); svg.setAttribute("aria-valuetext", text);
    showSparkTooltip(text, pointer?.x ?? bounds.left + vertex.x / 400 * bounds.width,
      pointer?.y ?? bounds.top + vertex.y / model.geometry.height * bounds.height);
  };
  model.refreshInspection = () => {
    if (model.pointer) {
      const bounds = svg.getBoundingClientRect();
      const fraction = Math.max(0, Math.min(1, (model.pointer.x - bounds.left) / Math.max(1, bounds.width)));
      const points = model.geometry.data;
      if (!points.length) return hide();
      const target = points[0].t + fraction * (points[points.length - 1].t - points[0].t);
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
  const old = model.drawn;
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
  const draw = vertices => {
    const paths = chartPaths(vertices, geometry.height, options.step);
    model.line.setAttribute("d", paths.line); model.area.setAttribute("d", paths.area);
    model.drawn = vertices;
    const last = vertices[vertices.length - 1];
    if (last) { model.latest.setAttribute("cx", last.x); model.latest.setAttribute("cy", last.y); model.latest.removeAttribute("hidden"); }
    else model.latest.setAttribute("hidden", "");
  };
  if (model.frame !== null) cancelAnimationFrame(model.frame);
  const rect = svg.getBoundingClientRect();
  const animate = old && old.length === geometry.vertices.length && old.every((point, i) => point.start === geometry.vertices[i].start)
    && !window.matchMedia("(prefers-reduced-motion: reduce)").matches && rect.bottom > 0 && rect.top < innerHeight;
  if (animate && geometry.vertices.length) {
    const started = performance.now();
    const tick = now => {
      const fraction = Math.min(1, (now - started) / 220);
      const ease = 1 - Math.pow(1 - fraction, 3);
      draw(geometry.vertices.map((point, i) => ({ ...point,
        x: old[i].x + (point.x - old[i].x) * ease, y: old[i].y + (point.y - old[i].y) * ease })));
      if (fraction < 1 && svg.isConnected) model.frame = requestAnimationFrame(tick);
      else model.frame = null;
    };
    model.frame = requestAnimationFrame(tick);
  } else { draw(geometry.vertices); model.frame = null; }
  if (model.selectedTime !== null || model.pointer) model.refreshInspection();
  else { model.marker.setAttribute("hidden", ""); model.markerLine.setAttribute("hidden", ""); }
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
