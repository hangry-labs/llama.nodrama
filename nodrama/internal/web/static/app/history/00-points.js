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

