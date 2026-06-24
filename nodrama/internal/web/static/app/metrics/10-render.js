"use strict";

function ensureMetricCards() {
  const sec = $("#metrics-section");
  if (sec.dataset.built === "1") return;
  sec.dataset.built = "1";
  sec.innerHTML = "";
  for (const c of METRIC_CARDS) {
    const help = metricHelp(c);
    const card = el("div", {
      class: "card metric-card",
      id: "metric-" + c.id,
      role: "button",
      tabindex: "0",
      title: t("metrics.history_hint"),
      onclick: (e) => {
        if (e.target && e.target.closest && e.target.closest("button")) return;
        openMetricHistory(c);
      },
      onkeydown: (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        openMetricHistory(c);
      },
    }, [
      el("div", { class: "metric-title" }, [
        el("h2", null, t(c.titleKey)),
        el("button", {
          class: "info-btn",
          type: "button",
          title: help,
          "aria-label": t(c.titleKey) + ": " + help,
          onclick: () => showMetricHelp(c),
        }, "?"),
      ]),
      el("div", { class: "row" }, [
        el("div", { class: "value", id: "metric-" + c.id + "-value" }, "—"),
        el("div", { class: "unit" }, c.unit || ""),
      ]),
      (c.percent || c.contextUsed)
        ? el("div", { class: "pct-bar", id: "metric-" + c.id + "-bar" },
            el("span", { style: "width: 0%" }))
        : null,
      el("div", { class: "metric-note", id: "metric-" + c.id + "-note" }, ""),
      el("div", { class: "spark", id: "metric-" + c.id + "-spark" }),
    ]);
    sec.appendChild(card);
  }
}

function showMetricHelp(card) {
  showModal({
    title: t(card.titleKey),
    bodyNode: el("div", null, metricHelp(card)),
    okLabel: t("common.close"),
  });
}

function openMetricHistory(card) {
  const body = el("div", { class: "metric-history-modal" }, t("common.loading"));
  showModal({
    title: t(card.titleKey) + " · " + t("metrics.history_window", { hours: 24 }),
    bodyNode: body,
    okLabel: t("common.close"),
    wide: true,
  });

  fetchJSON("/api/history/metrics?metric=" + encodeURIComponent(card.metric) + "&hours=24&max=2000", {
    withModel: false,
    timeout: 12000,
  }).then((payload) => {
    const points = normalizeHistoryPoints(payload && payload.points);
    body.innerHTML = "";
    if (!points.length) {
      body.appendChild(el("div", { class: "sub" }, t("metrics.no_data")));
      return;
    }
    const peak = peakHistoryPoint(points);
    const latest = points[points.length - 1];
    body.appendChild(el("div", { class: "metric-history-summary" }, [
      el("span", null, t("metrics.history_points", { count: points.length })),
      el("span", null, t("metrics.history_latest", { value: formatMetricValue(card, latest.v), time: fmtDateTime(latest.t) })),
      peak ? el("span", null, t("metrics.history_peak", { value: formatMetricValue(card, peak.v), time: fmtDateTime(peak.t) })) : null,
    ].filter(Boolean)));
    const chart = el("div", { class: "metric-history-chart" });
    chart.appendChild(sparkline(points, {
      min: card.min !== undefined ? card.min : undefined,
      max: card.max !== undefined ? card.max : undefined,
      height: 160,
      interactive: true,
      interactiveLimit: 2000,
      pointPixelRadius: 4,
      formatValue: (v) => formatMetricValue(card, v),
    }));
    body.appendChild(chart);
  }).catch((e) => {
    body.innerHTML = "";
    body.appendChild(el("div", { class: "error" }, e && e.message ? e.message : String(e)));
  });
}

function peakHistoryPoint(points) {
  if (!points || !points.length) return null;
  let peak = points[0];
  for (const point of points.slice(1)) {
    if (point.v >= peak.v) peak = point;
  }
  return peak;
}

function renderMetricsDisabled() {
  ensureMetricCards();
  for (const c of METRIC_CARDS) {
    const card = $("#metric-" + c.id);
    if (!card) continue;
    card.classList.add("disabled");
    $("#metric-" + c.id + "-value").textContent = "—";
    $("#metric-" + c.id + "-spark").innerHTML = "";
  }
  showBanner("metrics-disabled", t("error.metrics_disabled"), "warn");
}

function renderMetrics(parsed, metricHistory, metricFacts) {
  ensureMetricCards();
  clearBanner("metrics-disabled");
  const historyByMetric = metricHistory || {};
  const factsByMetric = metricFacts || {};
  for (const c of METRIC_CARDS) {
    const v = parsed[c.metric];
    const ratio = c.ratioMetric ? (parsed[c.ratioMetric] || 0) : v;
    const capacity = c.capacityMetric ? (parsed[c.capacityMetric] || 0) : 0;
    const points = normalizeHistoryPoints(historyByMetric[c.metric]);

    const card = $("#metric-" + c.id);
    card.classList.remove("warn", "bad", "disabled");
    if (c.warnRatio !== undefined && ratio >= c.warnRatio) card.classList.add("warn");
    if (c.badRatio  !== undefined && ratio >= c.badRatio)  { card.classList.remove("warn"); card.classList.add("bad"); }
    if (c.warnAt !== undefined && v >= c.warnAt) card.classList.add("warn");
    if (c.badAt  !== undefined && v >= c.badAt)  { card.classList.remove("warn"); card.classList.add("bad"); }

    $("#metric-" + c.id + "-value").textContent = c.contextUsed
      ? (capacity > 0 ? (fmtTokensCompact(v) + " / " + fmtTokensCompact(capacity)) : "—")
      : (c.duration ? fmtDuration(v) : fmtNumber(v, { percent: c.percent }));

    const note = $("#metric-" + c.id + "-note");
    if (note) {
      const fact = factsByMetric[c.metric];
      note.innerHTML = "";
      if (c.contextUsed && capacity > 0) {
        note.appendChild(el("div", null, fmtNumber(ratio, { percent: true }) + "% used"));
        const lines = metricPeakNote(c, fact);
        if (lines.length) {
          for (const line of lines) note.appendChild(el("div", null, line));
        } else {
          note.appendChild(el("div", null, "peak —"));
        }
      } else if (c.peakNote) {
        for (const line of metricPeakNote(c, fact)) note.appendChild(el("div", null, line));
      }
    }

    if (c.percent || c.contextUsed) {
      const bar = $("#metric-" + c.id + "-bar");
      const span = bar.querySelector("span");
      const pct = Math.max(0, Math.min(100, (ratio || 0) * 100));
      span.style.width = pct.toFixed(1) + "%";
      bar.classList.remove("warn", "bad");
      if (c.warnRatio !== undefined && ratio >= c.warnRatio) bar.classList.add("warn");
      if (c.badRatio  !== undefined && ratio >= c.badRatio)  { bar.classList.remove("warn"); bar.classList.add("bad"); }
      if (c.warnAt !== undefined && v >= c.warnAt) bar.classList.add("warn");
      if (c.badAt  !== undefined && v >= c.badAt)  { bar.classList.remove("warn"); bar.classList.add("bad"); }
    }

    const sparkHost = $("#metric-" + c.id + "-spark");
    sparkHost.innerHTML = "";
    sparkHost.appendChild(sparkline(points, {
      min: c.min !== undefined ? c.min : undefined,
      max: c.max !== undefined ? c.max : undefined,
      interactive: true,
      formatValue: (value) => formatMetricValue(c, value),
    }));
  }
  state.metrics = parsed;
  state.lastUpdate = Date.now();
  bumpGuidance();
}

