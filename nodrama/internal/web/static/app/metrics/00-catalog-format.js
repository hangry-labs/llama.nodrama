"use strict";

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
  { id: "server_uptime", titleKey: "metrics.server_uptime",
    metric: "nodrama:server_uptime_seconds",     unit: "",      min: 0,
    duration: true, uptime: true,
    helpKey: "metrics.help.server_uptime" },
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
  const d = new Date(tMs);
  return pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
}

function fmtDateTime(ts) {
  const tMs = typeof ts === "number" ? ts : Date.parse(ts);
  if (!isFinite(tMs)) return "—";
  const d = new Date(tMs);
  return pad2(d.getDate()) + "." + pad2(d.getMonth() + 1) + "." + d.getFullYear() + " " +
         pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
}

function fmtTimeDate(ts) {
  const tMs = typeof ts === "number" ? ts : Date.parse(ts);
  if (!isFinite(tMs)) return "—";
  const d = new Date(tMs);
  return pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds()) + " " +
         pad2(d.getDate()) + "." + pad2(d.getMonth() + 1) + "." + d.getFullYear();
}

function pad2(value) {
  return String(value).padStart(2, "0");
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
    const value = fact.peak5mValue === undefined ? 0 : fact.peak5mValue;
    parts.push(formatMetricValue(card, value) + " (5m at " + fmtTime(fact.peak5mAt) + ")");
  }
  if (fact.peakAt) {
    const value = fact.peakValue === undefined ? 0 : fact.peakValue;
    parts.push(formatMetricValue(card, value) + " (max at " + fmtTimeDate(fact.peakAt) + ")");
  }
  return parts;
}

