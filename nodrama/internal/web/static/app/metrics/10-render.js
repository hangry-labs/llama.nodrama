"use strict";

function ensureMetricCards() {
  const section = $("#metrics-section");
  if (section.dataset.built === "1") return;
  section.dataset.built = "1";
  const grid = el("div", { class: "metrics-grid" });
  section.replaceChildren(grid);
  const tones = { predicted_tps: "teal", prompt_tps: "blue", deferred: "amber", context_used: "violet" };
  for (const metric of METRIC_CARDS) {
    const featured = Object.hasOwn(tones, metric.id);
    const open = () => openMetricHistory(metric);
    const card = el("div", {
      class: "card metric-card" + (featured ? " metric-featured" : ""), id: "metric-" + metric.id,
      role: "group", "aria-label": t(metric.titleKey), data: { tone: tones[metric.id] || "blue" },
      onclick: event => { if (!event.target.closest("button, svg")) open(); },
    }, [
      el("div", { class: "metric-title" }, [
        el("h2", null, el("button", { class: "metric-open", onclick: open, title: t("metrics.history_hint") }, t(metric.titleKey))),
        el("button", { class: "info-btn", type: "button", title: metricHelp(metric),
          "aria-label": t(metric.titleKey) + ": " + metricHelp(metric), onclick: () => showMetricHelp(metric) }, "?"),
      ]),
      el("div", { class: "row" }, [
        el("div", { class: "value", id: "metric-" + metric.id + "-value" }, "—"),
        el("div", { class: "unit", id: "metric-" + metric.id + "-unit" }, metric.unit || ""),
      ]),
      el("div", { class: "metric-note", id: "metric-" + metric.id + "-note" }),
      el("div", { class: "spark", id: "metric-" + metric.id + "-spark" }),
      el("div", { class: "metric-scale" }, [
        el("span", { id: "metric-" + metric.id + "-scale" }),
        el("span", { class: "metric-history-link" }, t("diagnostics.history") + " ↗"),
      ]),
    ]);
    grid.appendChild(card);
  }
}

function showMetricHelp(metric) {
  showModal({ title: t(metric.titleKey), bodyNode: el("div", null, metricHelp(metric)), okLabel: t("common.close") });
}

function openMetricHistory(metric) {
  let controller = null, closed = false;
  const body = el("div", { class: "metric-history-modal" });
  const chart = el("div", { class: "metric-history-chart" });
  const yAxis = el("div", { class: "history-y-axis", "aria-hidden": "true" });
  const plot = el("div", { class: "history-plot" }, [yAxis, chart]);
  const summary = el("div", { class: "metric-history-summary" });
  const axis = el("div", { class: "history-axis" });
  const toolbar = el("div", { class: "history-toolbar" });
  const status = el("div", { class: "sub", role: "status" });
  const buttons = [];
  for (const hours of [1, 6, 24]) {
    const button = el("button", { onclick: () => load(hours), "aria-pressed": String(hours === 24) }, hours + "h");
    buttons.push({ hours, button }); toolbar.appendChild(button);
  }
  body.append(toolbar, summary, plot, axis, status);
  showModal({ title: t(metric.titleKey), bodyNode: body, okLabel: t("common.close"), wide: true,
    onClose: () => { closed = true; controller?.abort(); } });

  async function load(hours) {
    controller?.abort();
    const request = controller = new AbortController();
    for (const item of buttons) item.button.setAttribute("aria-pressed", String(item.hours === hours));
    status.textContent = t("common.loading");
    body.classList.add("is-loading");
    try {
      const payload = await fetchJSON("/api/history/metrics?metric=" + encodeURIComponent(metric.metric) + "&hours=" + hours + "&max=2000",
        { withModel: false, timeout: 12000, signal: request.signal });
      if (closed || request !== controller) return;
      const points = normalizeHistoryPoints(payload?.points);
      const stats = summarizeMetricHistory(points);
      summary.replaceChildren(); axis.replaceChildren(); yAxis.replaceChildren();
      if (!stats) { chart.replaceChildren(); status.textContent = t("metrics.no_data"); return; }
      for (const [label, value] of [["metrics.history_latest", formatMetricValue(metric, stats.latest.v)],
        ["diagnostics.average", formatMetricValue(metric, stats.average)], ["diagnostics.peak", formatMetricValue(metric, stats.max)]]) {
        summary.appendChild(el("div", { class: "history-stat" }, [
          el("span", null, label === "metrics.history_latest" ? t("diagnostics.latest") : t(label)), el("strong", null, value),
        ]));
      }
      updateSparkline(chart, points, { min: metric.min, max: metric.max, step: metric.step, height: 180, interactive: true,
        label: t(metric.titleKey) + ". " + t("diagnostics.chart_hint"), formatValue: value => formatMetricValue(metric, value) });
      const geometry = chart.querySelector("svg").chartModel.geometry;
      for (const value of [geometry.max, (geometry.max + geometry.min) / 2, geometry.min]) {
        yAxis.appendChild(el("span", null, metric.duration ? fmtDuration(value) : fmtNumber(value)));
      }
      axis.append(el("span", null, fmtDateTime(stats.first.t)), el("span", null, fmtDateTime(stats.latest.t)));
      status.textContent = t("diagnostics.samples", { count: stats.count }) + " · " + t("diagnostics.range") + ": "
        + formatMetricValue(metric, stats.min) + " – " + formatMetricValue(metric, stats.max)
        + " · " + t("diagnostics.window") + ": " + fmtDuration(stats.duration);
    } catch (error) {
      if (!closed && request === controller && !request.signal.aborted) status.textContent = t("error.fetch_failed") + ": " + error.message;
    } finally { if (!closed && request === controller) body.classList.remove("is-loading"); }
  }
  void load(24);
}

function peakHistoryPoint(points) {
  return (points || []).reduce((peak, point) => !peak || point.v >= peak.v ? point : peak, null);
}

function renderMetricsDisabled() {
  ensureMetricCards();
  renderMetrics({}, {}, {});
  showBanner("metrics-disabled", t("error.metrics_disabled"), "warn");
}

function renderMetrics(parsed, metricHistory, metricFacts = {}) {
  ensureMetricCards();
  clearBanner("metrics-disabled");
  renderDiagnosticStatus();
  for (const metric of METRIC_CARDS) {
    const value = parsed[metric.metric];
    const available = Number.isFinite(value);
    const ratio = metric.ratioMetric ? parsed[metric.ratioMetric] || 0 : value;
    const capacity = metric.capacityMetric ? parsed[metric.capacityMetric] || 0 : 0;
    const points = normalizeHistoryPoints(metricHistory?.[metric.metric]);
    const stats = summarizeMetricHistory(points);
    const card = $("#metric-" + metric.id);
    card.classList.toggle("disabled", !available);
    card.classList.toggle("warn", (metric.warnRatio !== undefined && ratio >= metric.warnRatio) || (metric.warnAt !== undefined && value >= metric.warnAt));
    card.classList.toggle("bad", (metric.badRatio !== undefined && ratio >= metric.badRatio) || (metric.badAt !== undefined && value >= metric.badAt));
    $("#metric-" + metric.id + "-value").textContent = metric.contextUsed
      ? available && capacity > 0 ? fmtTokensCompact(value) + " / " + fmtTokensCompact(capacity) : "—"
      : metric.duration && available ? fmtDuration(value) : fmtNumber(value, { percent: metric.percent });
    $("#metric-" + metric.id + "-unit").textContent = metric.contextUsed && capacity > 0
      ? (ratio * 100).toFixed(1) + "%" : metric.unit || "";
    const note = $("#metric-" + metric.id + "-note");
    const fact = metricFacts[metric.metric];
    note.title = "";
    if (!stats) note.textContent = t(available ? "diagnostics.collecting" : "metrics.no_data");
    else if (!available || state.ui.snapshotStale) note.textContent = t("diagnostics.observed") + " " + fmtTime(stats.latest.t);
    else if (metric.cumulative) note.textContent = stats.delta === null ? t("diagnostics.counter_reset")
      : t("diagnostics.change", { value: "+" + formatMetricValue(metric, stats.delta), duration: fmtDuration(stats.duration) });
    else if (metric.uptime) {
      const overview = state.snapshot?.overview || {};
      note.replaceChildren(el("span", null, overview.serverStartedAt ? fmtTime(overview.serverStartedAt) : t("diagnostics.since_start")),
        el("span", null, overview.serverUptimeSource ? t("metrics.server_uptime_source", { source: overview.serverUptimeSource }) : ""));
      note.title = overview.serverStartedAt ? t("metrics.server_started", { time: fmtDateTime(overview.serverStartedAt) }) : "";
    } else if (metric.peakNote && fact && (fact.peak5mAt || fact.peakAt)) {
      const peaks = [];
      if (fact.peak5mAt) peaks.push(el("span", null, "5m " + t("diagnostics.max") + " " + formatMetricValue(metric, fact.peak5mValue ?? 0)));
      if (fact.peakAt) peaks.push(el("span", null, t("diagnostics.max") + " " + formatMetricValue(metric, fact.peakValue ?? 0)));
      note.replaceChildren(...peaks);
      note.title = metricPeakNote(metric, fact).join("\n") + "\n" + t("diagnostics.average") + " " + formatMetricValue(metric, stats.average);
    } else note.replaceChildren(el("span", null, t("diagnostics.average") + " " + formatMetricValue(metric, stats.average)),
      el("span", null, t("diagnostics.peak") + " " + formatMetricValue(metric, stats.max)));
    const scale = $("#metric-" + metric.id + "-scale");
    scale.textContent = stats ? t("diagnostics.window") + " · " + fmtDuration(stats.duration) : "—";
    scale.title = stats ? t("diagnostics.range") + ": " + formatMetricValue(metric, stats.min) + " – " + formatMetricValue(metric, stats.max) : "";
    updateSparkline($("#metric-" + metric.id + "-spark"), points, { min: metric.min, max: metric.max, step: metric.step,
      height: 40, interactive: true,
      label: t(metric.titleKey) + ". " + t("diagnostics.chart_hint"), formatValue: v => formatMetricValue(metric, v) });
  }
  state.metrics = parsed;
  bumpGuidance();
}
