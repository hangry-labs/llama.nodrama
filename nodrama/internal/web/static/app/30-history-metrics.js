"use strict";

/* ──────────────────────────────────────────────────────────────────────
 *  Backend-owned time series. The UI only normalizes and renders points
 *  returned by /api/snapshot so history survives browser refreshes.
 * ──────────────────────────────────────────────────────────────────── */
function normalizeHistoryPoints(points) {
  if (!Array.isArray(points)) return [];
  const out = [];
  for (const p of points) {
    if (!p || p.v === undefined || p.v === null) continue;
    const t = typeof p.t === "number" ? p.t : Date.parse(p.t);
    const v = Number(p.v);
    if (!isFinite(t) || !isFinite(v)) continue;
    out.push({ t, v });
  }
  return out;
}

async function resetHistories() {
  state.history = emptyHistory();
  state.metricFacts = {};
  if (state.metrics) renderMetrics(state.metrics, state.history.metrics, state.metricFacts);
  try {
    await fetchJSON("/api/history/reset", {
      method: "POST",
      withModel: false,
      timeout: 4000,
    });
    await refreshSnapshot({ timeout: 6000 });
    clearBanner("history-reset");
  } catch (e) {
    showBanner("history-reset", "history reset: " + e.message, "warn");
  }
}

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

/* ──────────────────────────────────────────────────────────────────────
 *  Metrics rendering. We build a fixed set of cards once, then update
 *  values + sparkline in place to avoid layout jitter.
 *
 *  Metrics emitted by current llama.cpp master (/metrics endpoint):
 *    counter: prompt_tokens_total, prompt_seconds_total,
 *             tokens_predicted_total, tokens_predicted_seconds_total,
 *             n_decode_total, n_tokens_max, n_busy_slots_per_decode
 *    gauge:   prompt_tokens_seconds, predicted_tokens_seconds,
 *             requests_processing, requests_deferred
 *
 *  The first two top cards are derived locally from counter deltas so they
 *  represent aggregate live server throughput over the current poll window.
 *
 *  kv_cache_usage_ratio and kv_cache_tokens were removed upstream — we
 *  derive nothing from them here.
 * ──────────────────────────────────────────────────────────────────── */
const METRIC_CARDS = [
  { id: "predicted_tps", titleKey: "metrics.gen_tps",
    metric: "nodrama:tokens_predicted_rate", unit: "tok/s", min: 0, peakNote: true,
    helpKey: "metrics.help.predicted_tps" },
  { id: "prompt_tps",    titleKey: "metrics.prompt_tps",
    metric: "nodrama:prompt_tokens_rate",    unit: "tok/s", min: 0, peakNote: true,
    helpKey: "metrics.help.prompt_tps" },
  { id: "processing",    titleKey: "metrics.processing",
    metric: "llamacpp:requests_processing",      unit: "",      min: 0, peakNote: true,
    helpKey: "metrics.help.processing" },
  { id: "deferred",      titleKey: "metrics.deferred",
    metric: "llamacpp:requests_deferred",        unit: "",      min: 0,
    warnAt: 1, badAt: 5, peakNote: true,
    helpKey: "metrics.help.deferred" },
  { id: "busy_slots",    titleKey: "metrics.busy_slots",
    metric: "llamacpp:n_busy_slots_per_decode",  unit: "",      min: 0, peakNote: true,
    helpKey: "metrics.help.busy_slots" },
  { id: "context_used", titleKey: "metrics.context_used",
    metric: "nodrama:context_active_tokens", unit: "tok", min: 0, contextUsed: true,
    capacityMetric: "nodrama:context_active_capacity_tokens",
    ratioMetric: "nodrama:context_active_ratio",
    warnRatio: 0.80, badRatio: 0.90, peakNote: true,
    helpKey: "metrics.help.context_used" },
  { id: "container_cpu", titleKey: "metrics.container_cpu",
    metric: "nodrama:container_cpu_percent", unit: "%", min: 0,
    warnAt: 80, badAt: 95, peakNote: true,
    helpKey: "metrics.help.container_cpu" },
  { id: "n_tokens_max",  titleKey: "metrics.n_tokens_max",
    metric: "llamacpp:n_tokens_max",             unit: "tok",   min: 0,
    peakNote: true,
    helpKey: "metrics.help.n_tokens_max" },
  { id: "prompt_total",  titleKey: "metrics.prompt_total",
    metric: "llamacpp:prompt_tokens_total",      unit: "tok",   min: 0, cumulative: true,
    helpKey: "metrics.help.prompt_total" },
  { id: "predicted_total", titleKey: "metrics.predicted_total",
    metric: "llamacpp:tokens_predicted_total",   unit: "tok",   min: 0, cumulative: true,
    helpKey: "metrics.help.predicted_total" },
  { id: "decode_total", titleKey: "metrics.decode_total",
    metric: "llamacpp:n_decode_total",           unit: "",      min: 0, cumulative: true,
    helpKey: "metrics.help.decode_total" },
  { id: "prompt_seconds_total", titleKey: "metrics.prompt_seconds_total",
    metric: "llamacpp:prompt_seconds_total",     unit: "",     min: 0, cumulative: true, duration: true,
    helpKey: "metrics.help.prompt_seconds_total" },
  { id: "predicted_seconds_total", titleKey: "metrics.predicted_seconds_total",
    metric: "llamacpp:tokens_predicted_seconds_total", unit: "", min: 0, cumulative: true, duration: true,
    helpKey: "metrics.help.predicted_seconds_total" },
];

function metricHelp(card) {
  return t(card.helpKey || "metrics.help.unknown");
}

function fmtNumber(n, opts) {
  if (n === undefined || n === null || !isFinite(n)) return "—";
  const o = opts || {};
  if (o.percent) return (n * 100).toFixed(n < 0.1 ? 2 : 1);
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "G";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(2) + "k";
  if (Number.isInteger(n)) return String(n);
  if (n >= 100) return n.toFixed(0);
  if (n >= 10)  return n.toFixed(1);
  return n.toFixed(2);
}

function fmtTokensCompact(n) {
  if (n === undefined || n === null || !isFinite(n)) return "—";
  const value = Math.max(0, Math.round(n));
  if (value >= 1e9) return Math.round(value / 1e9) + "G";
  if (value >= 1e6) return Math.round(value / 1e6) + "M";
  if (value >= 1e3) return Math.round(value / 1e3) + "k";
  return String(value);
}

function fmtDuration(seconds) {
  if (seconds === undefined || seconds === null || !isFinite(seconds)) return "—";
  const units = [
    ["w", 7 * 24 * 3600],
    ["d", 24 * 3600],
    ["h", 3600],
    ["m", 60],
    ["s", 1],
  ];
  let remaining = Math.max(0, seconds);
  const out = [];
  for (const [label, size] of units) {
    const value = Math.floor(remaining / size);
    if (!value && out.length === 0 && label !== "s") continue;
    if (value) {
      out.push(value + label);
      remaining -= value * size;
    }
    if (out.length >= 2) break;
  }
  return out.length ? out.join(" ") : "0s";
}

function fmtTime(ts) {
  const tMs = typeof ts === "number" ? ts : Date.parse(ts);
  if (!isFinite(tMs)) return "—";
  return new Date(tMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function fmtDateTime(ts) {
  const tMs = typeof ts === "number" ? ts : Date.parse(ts);
  if (!isFinite(tMs)) return "—";
  return new Date(tMs).toLocaleString([], {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatMetricValue(card, value) {
  if (card.contextUsed || card.unit === "tok") return fmtTokensCompact(value);
  if (card.duration) return fmtDuration(value);
  if (card.percent) return fmtNumber(value, { percent: true }) + "%";
  const formatted = fmtNumber(value);
  return card.unit ? (formatted + " " + card.unit) : formatted;
}

function metricPeakNote(card, fact) {
  if (!fact) return [];
  const parts = [];
  if (fact.peak5mAt) {
    parts.push(formatMetricValue(card, fact.peak5mValue) + " (5m at " + fmtTime(fact.peak5mAt) + ")");
  }
  if (fact.peakAt) {
    parts.push(formatMetricValue(card, fact.peakValue) + " (max at " + fmtTime(fact.peakAt) + ")");
  }
  return parts;
}

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

