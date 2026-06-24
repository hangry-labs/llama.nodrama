"use strict";

function modelFromSnapshot(m) {
  if (!m || typeof m !== "object") return null;
  const meta = Object.assign({}, m.meta || {});
  if (m.size !== undefined && meta.size === undefined) meta.size = m.size;
  if (m.params !== undefined && meta.n_params === undefined) meta.n_params = m.params;
  return {
    id: m.id || m.name || m.model || "model",
    aliases: m.aliases || [],
    owned_by: m.owned_by || m.ownedBy || "",
    object: m.object || "",
    family: m.family || "",
    format: m.format || "",
    meta,
  };
}

function propsFromSnapshot(p) {
  if (!p || typeof p !== "object") return null;
  return {
    model_path: p.model_path || p.modelPath || "",
    model_alias: p.model_alias || p.modelAlias || "",
    build_info: p.build_info || p.buildInfo || "",
    total_slots: p.total_slots || p.totalSlots || 0,
    n_ctx: p.n_ctx || p.contextTokens || 0,
    n_ctx_train: p.n_ctx_train || p.contextTrain || 0,
    modalities: p.modalities || {},
    default_generation_settings: p.default_generation_settings || p.samplerDefaults || {},
    is_sleeping: p.is_sleeping || false,
    chat_template: p.chat_template || "",
  };
}

function isSlotProcessing(slot) {
  return !!(slot && (slot.isProcessing || slot.is_processing));
}

function slotContextTokens(slot) {
  return (slot && (slot.contextTokens || slot.n_ctx)) || 0;
}

function slotContextEstimateTokens(slot) {
  if (slot && typeof slot.contextEstimateTokens === "number") return slot.contextEstimateTokens;
  const prompt = slot && typeof slot.promptTokens === "number" ? slot.promptTokens : num(slot && slot.n_prompt_tokens, 0);
  const processed = slot && typeof slot.promptProcessedTokens === "number" ? slot.promptProcessedTokens : num(slot && slot.n_prompt_tokens_processed, 0);
  const cache = slot && typeof slot.promptCacheTokens === "number" ? slot.promptCacheTokens : num(slot && slot.n_prompt_tokens_cache, 0);
  return Math.max(prompt, processed, cache) + slotDecodedTokens(slot);
}

function promptCacheUsedTokensEstimate(cacheState) {
  if (!cacheState || !cacheState.cacheUsedMiB || !cacheState.cacheLimitMiB) return 0;
  const tokenLimit = cacheState.cacheEstTokens || cacheState.cacheLimitTokens || 0;
  if (tokenLimit <= 0) return 0;
  return Math.round(Math.max(0, Math.min(1, cacheState.cacheUsedMiB / cacheState.cacheLimitMiB)) * tokenLimit);
}

function latestPromptCacheState() {
  const events = Array.isArray(state.events) ? state.events : [];
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event && event.cacheLimitTokens) return event;
  }
  const lines = logState && Array.isArray(logState.lines) ? logState.lines : [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const parsed = parseCacheStateLine(lines[i]);
    if (parsed) return parsed;
  }
  return null;
}

function parseCacheStateLine(line) {
  const m = String(line || "").match(/cache state:\s*(\d+)\s+prompts,\s*([0-9]+(?:\.[0-9]+)?)\s+MiB\s*\(limits:\s*([0-9]+(?:\.[0-9]+)?)\s+MiB,\s*(\d+)\s+tokens,\s*(\d+)\s+est\)/);
  if (!m) return null;
  return {
    cachePrompts: parseInt(m[1], 10),
    cacheUsedMiB: parseFloat(m[2]),
    cacheLimitMiB: parseFloat(m[3]),
    cacheLimitTokens: parseInt(m[4], 10),
    cacheEstTokens: parseInt(m[5], 10),
    source: "log tail",
  };
}

function slotPromptTokens(slot) {
  if (slot && typeof slot.promptTokens === "number") return slot.promptTokens;
  return num(slot && slot.n_prompt_tokens, 0);
}

function slotPromptProcessedTokens(slot) {
  if (slot && typeof slot.promptProcessedTokens === "number") return slot.promptProcessedTokens;
  return num(slot && slot.n_prompt_tokens_processed, 0);
}

function slotPromptCacheTokens(slot) {
  if (slot && typeof slot.promptCacheTokens === "number") return slot.promptCacheTokens;
  return num(slot && slot.n_prompt_tokens_cache, 0);
}

function slotTaskID(slot) {
  return (slot && (slot.taskId || slot.id_task)) || 0;
}

function slotDecodedTokens(slot) {
  if (slot && typeof slot.decodedTokens === "number") return slot.decodedTokens;
  const next = rawNextToken(slot);
  return num(next.n_decoded, 0);
}

function slotRemainingTokens(slot) {
  if (slot && typeof slot.remainingTokens === "number") return slot.remainingTokens;
  const next = rawNextToken(slot);
  return num(next.n_remain, NaN);
}

function rawNextToken(slot) {
  if (!slot) return {};
  if (Array.isArray(slot.next_token)) return slot.next_token[0] || {};
  return slot.next_token || {};
}

function applySnapshot(snapshot, opts) {
  const o = opts || {};
  state.snapshot = snapshot || null;
  state.mode = snapshot && snapshot.mode === "router" ? "router" : "single";
  state.props = propsFromSnapshot(snapshot && snapshot.props);
  state.v1models = ((snapshot && snapshot.models) || []).map(modelFromSnapshot).filter(Boolean);
  state.models = state.mode === "router" && Array.isArray(snapshot && snapshot.routerModels)
    ? snapshot.routerModels
    : [];
  state.loraAdapters = Array.isArray(snapshot && snapshot.loraAdapters) ? snapshot.loraAdapters : [];
  state.metrics = (snapshot && snapshot.rawMetrics) || {};
  state.metricFacts = (snapshot && snapshot.metricFacts) || {};
  state.slots = Array.isArray(snapshot && snapshot.slots) ? snapshot.slots : [];
  state.queries = Array.isArray(snapshot && snapshot.queries) ? snapshot.queries : [];
  state.promptCache = (snapshot && snapshot.promptCache) || null;
  state.events = Array.isArray(snapshot && snapshot.events) ? snapshot.events : [];
  state.history = (snapshot && snapshot.history) || emptyHistory();
  state.suggestions = Array.isArray(snapshot && snapshot.suggestions) ? snapshot.suggestions : null;
  if (snapshot && snapshot.server) {
    $("#server-display").textContent = snapshot.server;
    $("#server-display").title = snapshot.server;
  }
  setBuildDisplay(snapshot && snapshot.build, snapshot && snapshot.update);

  if (state.mode === "router") {
    if (!state.selectedModel) {
      const loaded = state.models.find((x) => x.status && x.status.value === "loaded");
      const first = state.models[0];
      state.selectedModel = (loaded && loaded.id) || (first && first.id) || null;
    }
  } else {
    state.selectedModel = null;
  }

  state.healthy = !!(snapshot && snapshot.overview && snapshot.overview.online);
  state.lastUpdate = Date.parse(snapshot && snapshot.updatedAt) || Date.now();
  clearBanner("snapshot");
  clearBanner("metrics-disabled");
  clearBanner("slots-disabled");
  if (!state.paused) setStatus(state.healthy ? "online" : "offline",
    state.healthy ? "header.status.online" : "header.status.offline");

  if (o.render !== false) {
    renderMetrics(state.metrics, state.history.metrics, state.metricFacts);
    renderPromptCache(state.promptCache);
    renderSlots(state.slots);
    renderQueries(state.queries);
    const supportSignature = JSON.stringify({
      mode: state.mode,
      selectedModel: state.selectedModel,
      props: state.props,
      v1models: state.v1models,
      models: state.models,
      loraAdapters: state.loraAdapters,
    });
    if (o.force || supportSignature !== state.ui.supportSignature) {
      state.ui.supportSignature = supportSignature;
      renderBootSummary();
    }
    renderGuidance();
    updateChatTokenSlider();
    updateChatSlotOptions();
  }
}

function setBuildDisplay(build, update) {
  const node = $("#version-display");
  if (!node) return;
  const version = build && build.version ? String(build.version) : "dev";
  const buildTime = formatBuildTimestamp(build && build.date);
  const versionText = buildTime ? "[" + buildTime + "] " + version : version;
  const repoURL = (update && update.repoUrl) || "https://github.com/hangry-labs/llama.nodrama";
  const latestVersion = update && update.latestVersion ? String(update.latestVersion) : "";
  const latestURL = (update && update.latestUrl) || repoURL;
  const available = !!(update && update.available && latestVersion);
  node.classList.toggle("update-available", available);
  node.href = available ? latestURL : repoURL;
  if (available) {
    node.textContent = versionText + " · " + t("update.available");
  } else {
    node.textContent = versionText;
  }
  const details = [];
  if (build && build.commit) details.push("commit " + build.commit);
  if (build && build.date) details.push("built " + build.date);
  if (available) {
    details.push(t("update.open_release", { version: latestVersion }));
  } else if (latestVersion) {
    details.push(t("update.latest", { version: latestVersion }));
  } else if (update && update.error) {
    details.push(t("update.check_failed") + ": " + update.error);
  } else {
    details.push(t("update.repo"));
  }
  node.title = details.length ? details.join(" · ") : "local development build";
}

function formatBuildTimestamp(value) {
  if (!value) return "";
  const d = new Date(value);
  if (!isFinite(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return pad(d.getDate()) + "." + pad(d.getMonth() + 1) + "." + d.getFullYear() + " " +
         pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
}

async function refreshSnapshot(opts) {
  const snapshot = await fetchJSON("/api/snapshot", Object.assign({
    withModel: false,
    timeout: 6000,
  }, opts || {}));
  applySnapshot(snapshot, { render: true });
  return snapshot;
}

