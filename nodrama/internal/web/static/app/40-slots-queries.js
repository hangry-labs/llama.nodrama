"use strict";

/* ──────────────────────────────────────────────────────────────────────
 *  Slots — per-slot card with sampling parameters expander.
 *  Slot object shape (subset we use):
 *    id, id_task, n_ctx, is_processing, next_token { n_decoded, n_remain }
 *    params: { temperature, top_k, top_p, min_p, repeat_penalty,
 *              presence_penalty, frequency_penalty, mirostat,
 *              mirostat_tau, mirostat_eta, dry_multiplier, dry_base,
 *              dry_allowed_length, samplers, seed, n_predict, lora, ... }
 * ──────────────────────────────────────────────────────────────────── */

/* Sampling-parameter keys we surface in the expander, in display order. */
const SAMPLER_KEYS = [
  "temperature", "dynatemp_range", "dynatemp_exponent",
  "top_k", "top_p", "min_p", "typical_p",
  "xtc_probability", "xtc_threshold",
  "repeat_last_n", "repeat_penalty",
  "presence_penalty", "frequency_penalty",
  "dry_multiplier", "dry_base", "dry_allowed_length", "dry_penalty_last_n",
  "mirostat", "mirostat_tau", "mirostat_eta",
  "n_predict", "n_keep", "n_discard", "max_tokens",
  "ignore_eos", "stream", "n_probs", "min_keep",
  "samplers", "seed", "lora",
  "speculative.n_max", "speculative.n_min", "speculative.p_min",
];

function getDeep(obj, path) {
  const parts = path.split(".");
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

function fmtParam(v) {
  if (v === undefined || v === null) return "—";
  if (typeof v === "number") {
    if (Number.isInteger(v)) return String(v);
    return v.toFixed(3).replace(/\.?0+$/, "") || "0";
  }
  if (typeof v === "boolean") return v ? t("common.yes") : t("common.no");
  if (Array.isArray(v)) return v.length === 0 ? t("common.empty") : v.map(fmtParam).join(", ");
  if (typeof v === "object") {
    try { return JSON.stringify(v); } catch (_) { return String(v); }
  }
  return String(v);
}

function ensureSlotsSection() {
  const sec = $("#slots-section");
  if (sec.dataset.built === "1") return;
  sec.dataset.built = "1";
  sec.innerHTML = "";
  sec.appendChild(el("div", { class: "card full" }, [
    el("h2", null, t("slots.title")),
    el("div", { class: "slot-grid", id: "slot-grid" }),
    el("div", { class: "sub", id: "slots-empty",
                style: "display: none;", "data-i18n": "slots.disabled" }, t("slots.disabled")),
  ]));
}

function renderSlotsDisabled() {
  ensureSlotsSection();
  $("#slot-grid").innerHTML = "";
  $("#slots-empty").style.display = "";
  $("#slots-empty").textContent = t("slots.disabled");
}

function renderSlots(slots) {
  ensureSlotsSection();
  $("#slots-empty").style.display = "none";
  const grid = $("#slot-grid");
  /* keyed update — keep DOM nodes per slot id, only patch what changed. */
  const seen = new Set();
  for (const s of slots) {
    seen.add(String(s.id));
    let node = grid.querySelector('[data-slot="' + s.id + '"]');
    if (!node) {
      node = makeSlotNode(s);
      grid.appendChild(node);
    }
    updateSlotNode(node, s);
  }
  /* drop nodes for slots that vanished (rare, but possible after reload) */
  $$('[data-slot]', grid).forEach((n) => {
    if (!seen.has(n.dataset.slot)) n.remove();
  });
  /* sort slots by id ascending so the layout is stable */
  const items = $$('[data-slot]', grid)
    .sort((a, b) => Number(a.dataset.slot) - Number(b.dataset.slot));
  for (const n of items) grid.appendChild(n);
  state.slots = slots;
  bumpGuidance();
}

function makeSlotNode(s) {
  const node = el("div", { class: "slot", data: { slot: String(s.id) } }, [
    el("div", { class: "slot-head" }, [
      el("span", { class: "id" }, "slot " + s.id),
      el("span", { class: "badge", "data-role": "state" }, t("slots.idle")),
      el("span", { class: "grow" }),
      el("span", { class: "badge rate", "data-role": "pp-rate", title: "prompt processing tok/s" }, "pp —"),
    ]),
    el("div", { class: "progress", "data-role": "progress" }, [
      el("div", { class: "pct-bar" }, el("span", { style: "width: 0%" })),
      el("div", { "data-role": "ratio" }, "—"),
    ]),
    el("div", { class: "sub", "data-role": "ctx" }, "—"),
    el("div", { class: "spark", "data-role": "slot-history" }),
    el("div", { class: "slot-actions", "data-role": "actions" }, []),
    el("details", null, [
      el("summary", null, t("slots.show_params")),
      el("div", { class: "params", "data-role": "params" }, []),
    ]),
  ]);
  return node;
}

function updateSlotNode(node, s) {
  const isActive = isSlotProcessing(s);
  node.classList.toggle("active", isActive);
  node.classList.toggle("idle", !isActive);

  const stateBadge = node.querySelector('[data-role="state"]');
  stateBadge.textContent = isActive ? (s.state || t("slots.active")) : t("slots.idle");
  stateBadge.classList.toggle("active", isActive);

  const p = isActive ? (s.params || {}) : {};
  const nDecoded = isActive ? slotDecodedTokens(s) : 0;
  const contextCapacity = slotContextTokens(s);
  const contextEstimate = isActive ? slotContextEstimateTokens(s) : 0;
  const promptTokens = isActive ? slotPromptTokens(s) : 0;
  const promptProcessed = isActive ? slotPromptProcessedTokens(s) : 0;
  const promptCache = isActive ? slotPromptCacheTokens(s) : 0;
  const historyPoints = state.history && state.history.slots && state.history.slots[String(s.id)];
  const latestHistory = latestSlotHistoryPoint(historyPoints);
  const promptRate = latestHistory ? Number(latestHistory.promptTokensPerSec || 0) : 0;
  const ppRate = node.querySelector('[data-role="pp-rate"]');
  if (ppRate) {
    ppRate.hidden = !isActive;
    ppRate.textContent = isActive && promptRate > 0 ? ("pp " + fmtNumber(promptRate) + " tok/s") : "pp —";
  }

  const progress = node.querySelector('[data-role="progress"]');
  progress.hidden = !isActive;
  const pctSpan = node.querySelector('.pct-bar > span');
  const pct = contextCapacity > 0 ? Math.max(0, Math.min(100, (contextEstimate / contextCapacity) * 100)) : 0;
  pctSpan.style.width = pct.toFixed(1) + "%";
  node.querySelector('[data-role="ratio"]').textContent =
    isActive ? (t("slots.context_bar") + ": " + contextEstimate + " / " + (contextCapacity || "?") + " (" + pct.toFixed(1) + "%)") : "—";

  const ctx = node.querySelector('[data-role="ctx"]');
  ctx.textContent = isActive
    ? (t("slots.context_used") + ": prompt " + promptProcessed + "/" + (promptTokens || "?") +
       " · cache " + promptCache + " · gen " + nDecoded)
    : (t("slots.context_used") + ": " + (contextCapacity || "?"));

  const historyHost = node.querySelector('[data-role="slot-history"]');
  if (historyHost) {
    const points = normalizeSlotHistoryPoints(historyPoints);
    historyHost.innerHTML = "";
    historyHost.appendChild(sparkline(points, { min: 0 }));
  }

  /* params expander — re-render only when open or first time, since it's
   * cheap enough for ~30 keys. */
  const details = node.querySelector("details");
  details.hidden = !isActive;
  if (!isActive) details.open = false;
  const params = node.querySelector('[data-role="params"]');
  if (params) {
    params.innerHTML = "";
    for (const k of SAMPLER_KEYS) {
      const v = getDeep(p, k);
      if (v === undefined) continue;
      params.appendChild(el("div", { class: "k" }, k));
      params.appendChild(el("div", { class: "v" }, fmtParam(v)));
    }
    /* show any keys we didn't enumerate, so nothing is hidden */
    for (const k in p) {
      if (SAMPLER_KEYS.includes(k)) continue;
      if (typeof p[k] === "object" && p[k] !== null && !Array.isArray(p[k])) {
        for (const sub in p[k]) {
          const fullKey = k + "." + sub;
          if (SAMPLER_KEYS.includes(fullKey)) continue;
          params.appendChild(el("div", { class: "k" }, fullKey));
          params.appendChild(el("div", { class: "v" }, fmtParam(p[k][sub])));
        }
      } else {
        params.appendChild(el("div", { class: "k" }, k));
        params.appendChild(el("div", { class: "v" }, fmtParam(p[k])));
      }
    }
  }

  /* Slot KV actions call the shell action module. */
  const actions = node.querySelector('[data-role="actions"]');
  if (actions && actions.dataset.built !== "1") {
    actions.dataset.built = "1";
    actions.appendChild(el("button", {
      onclick: () => slotAction(s.id, "save"),
    }, t("slots.actions.save")));
    actions.appendChild(el("button", {
      onclick: () => slotAction(s.id, "restore"),
    }, t("slots.actions.restore")));
    actions.appendChild(el("button", {
      onclick: () => slotAction(s.id, "erase"),
    }, t("slots.actions.erase")));
  }
}
function num(v, fb) { return (typeof v === "number" && isFinite(v)) ? v : fb; }

function normalizeSlotHistoryPoints(points) {
  if (!Array.isArray(points)) return [];
  const out = [];
  for (const p of points) {
    if (!p) continue;
    const t = typeof p.t === "number" ? p.t : Date.parse(p.t);
    if (!isFinite(t)) continue;
    const gen = Number(p.generationTokensPerSec || 0);
    const v = Math.max(0, isFinite(gen) ? gen : 0);
    out.push({ t, v });
  }
  return out;
}

function latestSlotHistoryPoint(points) {
  if (!Array.isArray(points) || !points.length) return null;
  for (let i = points.length - 1; i >= 0; i--) {
    if (points[i]) return points[i];
  }
  return null;
}

function ensureQueriesSection() {
  const sec = $("#queries-section");
  if (sec.dataset.built === "1") return;
  sec.dataset.built = "1";
  sec.innerHTML = "";
  sec.appendChild(el("div", { class: "card full" }, [
    el("h2", null, t("queries.title")),
    el("div", { class: "sub", id: "queries-empty" }, t("queries.empty")),
    el("div", { class: "query-grid", id: "query-grid" }),
  ]));
}

function renderQueries(queries) {
  ensureQueriesSection();
  const list = Array.isArray(queries) ? queries : [];
  const empty = $("#queries-empty");
  const grid = $("#query-grid");
  if (!grid || !empty) return;
  grid.innerHTML = "";
  empty.style.display = list.length ? "none" : "";
  for (const q of list) {
    grid.appendChild(renderQueryCard(q));
  }
}

function renderQueryCard(q) {
  const status = q.status || "complete";
  const tokens = [
    num(q.promptTokens, 0),
    num(q.completionTokens, 0),
    num(q.totalTokens, 0),
  ].join(" / ");
  const slot = Array.isArray(q.slotIds) && q.slotIds.length ? q.slotIds.join(", ") : "—";
  const task = Array.isArray(q.taskIds) && q.taskIds.length ? q.taskIds.join(", ") : "—";
  const cacheParts = [];
  if (q.cacheReuseCount) cacheParts.push("reuse x" + q.cacheReuseCount);
  if (!q.cacheReuseCount && q.lastCacheAction && q.lastCacheAction !== "save" && q.lastCacheAction !== "invalidate") {
    cacheParts.push(q.lastCacheAction);
  }
  if (q.cacheRestoredTokens) {
    const restored = String(q.cacheRestoredTokens) + (q.promptTokens ? "/" + String(q.promptTokens) : "") + " tok";
    cacheParts.push("restored " + restored);
  }
  if (q.promptCacheTokens) cacheParts.push(String(q.promptCacheTokens) + " tok");
  const cache = cacheParts.length ? cacheParts.join(" · ") : "—";
  const rate = q.currentTokensPerSec ? fmtNumber(q.currentTokensPerSec) + " tok/s" : "—";
  const duration = q.durationMs ? (q.durationMs / 1000).toFixed(1) + "s" : (status === "running" ? "active" : status === "queued" ? "queued" : "—");
  const isCached = !!q.cacheCached;
  const badgeText = status === "complete" && isCached ? t("queries.status.cached") : t("queries.status." + status);
  const badgeClass = status === "complete" && isCached ? "cached" : status;
  return el("div", { class: "query-card " + status + (isCached ? " cached" : " uncached"), title: q.id || "" }, [
    el("div", { class: "query-head" }, [
      el("span", { class: "query-id" }, q.id || "query"),
      el("span", { class: "badge " + badgeClass }, badgeText),
    ]),
    el("div", { class: "query-details" }, [
      el("div", { class: "k" }, t("queries.slot")), el("div", { class: "v" }, slot),
      el("div", { class: "k" }, t("queries.task")), el("div", { class: "v" }, task),
      el("div", { class: "k" }, t("queries.tokens")), el("div", { class: "v" }, tokens),
      el("div", { class: "k" }, t("queries.cache")), el("div", { class: "v" }, cache),
      el("div", { class: "k" }, t("queries.rate")), el("div", { class: "v" }, rate),
      el("div", { class: "k" }, t("queries.duration")), el("div", { class: "v" }, duration),
    ]),
  ]);
}

/* slotAction is defined in the shell action module. */

/* Boot wiring → one backend snapshot poller. */
function startCorePollers() {
  stopAllPollers();
  ensureMetricCards();
  ensureSlotsSection();
  ensureQueriesSection();

  startPoller("snapshot", state.params.poll, async () => {
    try {
      await refreshSnapshot();
    } catch (e) {
      setStatus("error", "header.status.error");
      showBanner("snapshot", t("error.fetch_failed") + ": /api/snapshot — " + e.message);
      throw e;
    }
  });
}

/* ──────────────────────────────────────────────────────────────────────
 *  Keyboard shortcuts and last-update ticker.
 * ──────────────────────────────────────────────────────────────────── */
document.addEventListener("keydown", (e) => {
  /* don't steal keys when the user is typing in an input/select/etc. */
  const tag = (e.target && e.target.tagName) || "";
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag)) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  if (e.key === " " || e.code === "Space") {
    e.preventDefault();
    setPaused(!state.paused);
  } else if (e.key === "r" || e.key === "R") {
    void resetHistories();
  }
});

function tickLastUpdate() {
  const node = $("#last-update");
  if (!node) return;
  if (!state.lastUpdate) { node.textContent = ""; return; }
  const ageSec = Math.max(0, Math.round((Date.now() - state.lastUpdate) / 1000));
  node.textContent = t("header.last_update") + ": " + ageSec + "s";
}
setInterval(tickLastUpdate, 1000);
/* one allowed setInterval — read-only DOM update, no fetch involved,
 * so the "no setInterval for fetches" rule still holds. */

