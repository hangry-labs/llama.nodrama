"use strict";

function ensureMetricCards() {
  const section = $("#metrics-section");
  if (section.dataset.built === "1") return;
  section.dataset.built = "1";
  const grid = el("div", { class: "metrics-grid" });
  section.replaceChildren(grid);
  const tones = { predicted_tps: "teal", prompt_tps: "blue", deferred: "amber", context_used: "violet" };
  for (const group of METRIC_GROUPS) {
    const column = el("div", { class: "metric-group metric-" + group.id, role: "group", "aria-label": t(group.labelKey) });
    const cells = el("div", { class: "metric-group-grid" });
    column.append(el("h2", { class: "metric-group-label" }, t(group.labelKey)), cells);
    grid.appendChild(column);
    for (const id of group.ids) {
      const metric = METRIC_CARDS.find(card => card.id === id);
      const featured = Object.hasOwn(tones, metric.id);
      const summaryCard = metric.cumulative || metric.uptime;
      const open = () => openMetricHistory(metric);
      const card = el("div", {
        class: "card metric-card" + (featured ? " metric-featured" : "") + (metric.cumulative ? " metric-related" : " metric-primary")
          + (metric.cumulative ? " metric-counter" : metric.uptime ? " metric-uptime" : ""), id: "metric-" + metric.id,
        role: "group", "aria-label": t(metric.titleKey), data: { tone: tones[metric.id] || "blue" },
        onclick: event => { if (!event.target.closest("button, svg")) open(); },
      }, [
        el("div", { class: "metric-title" }, [
          el("h2", null, el("button", { class: "metric-open", onclick: open, title: t("metrics.history_hint") }, [
            t(metric.titleKey), summaryCard ? el("span", { class: "metric-open-arrow", "aria-hidden": "true" }, " ↗") : null,
          ].filter(Boolean))),
          el("button", { class: "info-btn", type: "button", title: metricHelp(metric),
            "aria-label": t(metric.titleKey) + ": " + metricHelp(metric), onclick: () => showMetricHelp(metric) }, "?"),
        ]),
        el("div", { class: "row" }, [
          el("div", { class: "value", id: "metric-" + metric.id + "-value" }, "—"),
          el("div", { class: "unit", id: "metric-" + metric.id + "-unit" }, metric.unit || ""),
        ]),
        el("div", { class: "metric-note", id: "metric-" + metric.id + "-note" }),
        metric.cumulative ? el("div", { class: "counter-intervals" }, [60, 300, 3600].map(seconds =>
          el("div", { class: "counter-interval", data: { seconds } }, [
            el("span", { class: "counter-window" }, fmtDuration(seconds)), el("strong", null, "—"),
          ]))) : null,
        ...(!summaryCard ? [el("div", { class: "spark", id: "metric-" + metric.id + "-spark" }),
        el("div", { class: "metric-scale" }, [
          el("span", { id: "metric-" + metric.id + "-scale" }),
          el("span", { class: "metric-history-link" }, t("diagnostics.history") + " ↗"),
        ])] : []),
      ].filter(Boolean));
      cells.appendChild(card);
    }
  }
}

function showMetricHelp(metric) {
  showModal({ title: t(metric.titleKey), bodyNode: el("div", null, metricHelp(metric)), okLabel: t("common.close") });
}

function openMetricHistory(metric) {
  let controller = null, closed = false;
  const summaryMetric = metric.cumulative || metric.uptime;
  const body = el("div", { class: "metric-history-modal" + (summaryMetric ? " metric-history-counter" : "") });
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
      const change = payload?.change;
      const increase = change ? change.delta : stats.delta === null || points.some(p => p.resetAt > stats.first.t) ? null : stats.delta;
      const summaries = metric.cumulative ? [["diagnostics.latest", formatMetricHistoryValue(metric, change?.to ? change.current : stats.latest.v)],
        ["metrics.counter_increase", increase === null ? t(change?.status === "gap" ? "metrics.counter_gap"
          : change?.status === "collecting" ? "diagnostics.collecting" : "diagnostics.counter_reset")
          : "+" + formatMetricHistoryValue(metric, increase)],
        ["metrics.counter_coverage", fmtDuration(change ? change.observedMs / 1000 : stats.duration)]]
        : metric.uptime ? [["diagnostics.latest", fmtDuration(stats.latest.v)], ["metrics.counter_coverage", fmtDuration(stats.duration)],
          ["metrics.server_started_label", state.snapshot?.overview?.serverStartedAt ? fmtDateTime(state.snapshot.overview.serverStartedAt) : "—"]]
        : [["diagnostics.latest", formatMetricValue(metric, stats.latest.v)],
          ["diagnostics.average", formatMetricValue(metric, stats.average)], ["diagnostics.peak", formatMetricValue(metric, stats.max)]];
      for (const [label, value] of summaries) {
        summary.appendChild(el("div", { class: "history-stat" }, [
          el("span", null, t(label)), el("strong", null, value),
        ]));
      }
      updateSparkline(chart, points, { min: summaryMetric ? undefined : metric.min, max: metric.max, step: metric.step, height: 180, interactive: true,
        label: t(metric.titleKey) + ". " + t("diagnostics.chart_hint"), formatValue: value => formatMetricHistoryValue(metric, value) });
      const geometry = chart.querySelector("svg").chartModel.geometry;
      for (const value of [geometry.max, (geometry.max + geometry.min) / 2, geometry.min]) {
        yAxis.appendChild(el("span", null, summaryMetric ? formatMetricHistoryValue(metric, value, false) : metric.duration ? fmtDuration(value) : fmtNumber(value)));
      }
      axis.append(el("span", null, fmtDateTime(stats.first.t)), el("span", null, fmtDateTime(stats.latest.t)));
      status.textContent = t("diagnostics.samples", { count: stats.count }) + " · " + t("diagnostics.range") + ": "
        + formatMetricHistoryValue(metric, stats.min) + " – " + formatMetricHistoryValue(metric, stats.max)
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

function renderHeaderUptime(parsed = state.metrics || {}) {
  const button = $("#server-uptime"), valueNode = $("#server-uptime-value");
  if (!button || !valueNode) return;
  const metric = METRIC_CARDS.find(metric => metric.uptime);
  const value = parsed[metric.metric], available = Number.isFinite(value);
  const overview = state.snapshot?.overview || {};
  const stale = state.ui.snapshotStale || !state.healthy;
  const duration = available ? fmtDuration(value) : "—";
  valueNode.textContent = duration;
  button.disabled = !available && !state.history?.metrics?.[metric.metric]?.length;
  button.dataset.state = !available ? "unavailable" : stale ? "stale" : state.paused ? "paused" : "live";
  const details = [t(metric.titleKey) + ": " + duration];
  if (!available) details.push(t("metrics.no_data"));
  if (overview.serverStartedAt) details.push(t("metrics.server_started", { time: fmtDateTime(overview.serverStartedAt) }));
  if (overview.serverUptimeSource) details.push(t("metrics.server_uptime_source", { source: overview.serverUptimeSource }));
  if (stale && state.lastUpdate) details.push(t("diagnostics.observed") + " " + fmtTime(state.lastUpdate));
  if (state.paused) details.push(t("diagnostics.paused"));
  details.push(t("metrics.history_hint"));
  button.title = details.join(" · ");
  button.setAttribute("aria-label", button.title);
}

function renderCounterSummary(card, metric, changes, available) {
  for (const cell of card.querySelectorAll(".counter-interval")) {
    const seconds = Number(cell.dataset.seconds), change = changes.find(item => item.windowSeconds === seconds);
    const status = available ? change?.status || "collecting" : "unavailable";
    cell.dataset.status = status;
    const window = fmtDuration(seconds);
    const duration = (change?.observedMs || 0) / 1000;
    const coverage = duration < 60 ? Math.floor(duration) + "s" : Math.floor(duration / 60) + "m";
    cell.querySelector(".counter-window").textContent = status === "partial" ? coverage + " / " + window : window;
    cell.querySelector("strong").textContent = status === "reset" ? t("metrics.counter_reset_short")
      : status === "gap" ? t("metrics.counter_gap_short")
      : available && Number.isFinite(change?.delta) ? "+" + (metric.duration
        ? change.delta > 0 && change.delta < 1 ? fmtNumber(change.delta * 1000) + "ms"
          : change.delta < 60 ? fmtNumber(change.delta) + "s" : fmtDuration(change.delta)
        : fmtNumber(change.delta)) : "—";
    const description = status === "partial" ? t("metrics.counter_partial", { observed: fmtDuration(duration), window })
      : status === "reset" ? t("diagnostics.counter_reset") : status === "gap" ? t("metrics.counter_gap")
      : status === "collecting" ? t("diagnostics.collecting") : status === "unavailable" ? t("metrics.no_data") : t("metrics.counter_increase");
    cell.title = window + " · " + description + (Number.isFinite(change?.delta) ? " · +" + formatMetricHistoryValue(metric, change.delta) : "")
      + (change?.observedMs ? " · " + fmtDateTime(change.from) + " → " + fmtDateTime(change.to) : "");
    cell.setAttribute("aria-label", cell.title);
  }
}

function renderMetrics(parsed, metricHistory, metricFacts = {}) {
  ensureMetricCards();
  clearBanner("metrics-disabled");
  renderDiagnosticStatus();
  renderHeaderUptime(parsed);
  for (const metric of METRIC_CARDS) {
    if (metric.uptime) continue;
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
    if (metric.cumulative) {
      const changes = fact?.changes || summarizeCounterChanges(points);
      const observed = Math.max(0, ...changes.map(change => change.observedMs || 0)) / 1000;
      renderCounterSummary(card, metric, changes, available);
      note.textContent = !available ? t("metrics.no_data") : observed ? t("metrics.counter_observed", { duration: fmtDuration(observed) }) : t("diagnostics.collecting");
      if (state.ui.snapshotStale && stats) note.textContent = t("diagnostics.observed") + " " + fmtTime(stats.latest.t);
      continue;
    }
    if (!stats) note.textContent = t(available ? "diagnostics.collecting" : "metrics.no_data");
    else if (!available || state.ui.snapshotStale) note.textContent = t("diagnostics.observed") + " " + fmtTime(stats.latest.t);
    else if (metric.peakNote && fact && (fact.peak5mAt || fact.peakAt)) {
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
