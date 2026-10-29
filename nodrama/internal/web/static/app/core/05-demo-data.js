"use strict";

/* Synthetic backend snapshots use the same normalized contract as Go. Keep the
 * simulation clock injectable so progress, history and actions are testable. */
function createDemoData(mode, props, models, v1models, now = () => Date.now()) {
  const started = now() - 120000;
  const history = { metrics: {}, slots: {} };
  const overrides = new Map();
  const cacheSlots = new Set([0, 1, 2]);
  const settings = { server: "demo", listen: "static demo", logPath: "demo.log",
    rawProxy: false, pollIntervalMs: state.params.poll, timeoutMs: 5000 };
  let lastSample = Math.floor(now() / 1000) * 1000 - 120000;
  const iso = time => new Date(time).toISOString();
  const selected = () => mode === "router"
    ? models.find(model => model.id === state.selectedModel) || models[0] : null;

  function slotsAt(time) {
    const model = selected();
    return Array.from({ length: 4 }, (_, id) => {
      const seconds = (time - started) / 1000 + id * 6;
      const phase = seconds % 24;
      const active = phase < 20 && (!model || model.status.value === "loaded");
      const taskId = 1000 + Math.floor(seconds / 24) * 4 + id;
      const override = overrides.get(id);
      const promptCacheTokens = override === "erase" ? 0 : 1536;
      const promptProcessedTokens = active ? Math.round(2048 * Math.min(1, phase / 5)) : 0;
      const decodedTokens = active ? Math.round(512 * Math.max(0, (phase - 5) / 15)) : 0;
      return { id, taskId: active ? taskId : 0, contextTokens: 8192,
        isProcessing: active,
        state: !active ? "idle" : phase < 1 && promptCacheTokens ? "cache-restore"
          : phase < 5 ? "prompt-processing" : "generating",
        promptTokens: active ? 2048 : 0, promptProcessedTokens,
        promptCacheTokens: active ? promptCacheTokens : 0, decodedTokens,
        remainingTokens: active ? 512 - decodedTokens : 0,
        contextEstimateTokens: active ? Math.max(promptProcessedTokens, promptCacheTokens) + decodedTokens : 0,
        generationProgress: decodedTokens / 512,
        promptProgress: promptProcessedTokens / 2048,
        params: active ? { ...props.default_generation_settings } : {},
      };
    });
  }

  function frame(time) {
    const seconds = (time - started) / 1000;
    const slots = slotsAt(time);
    const promptRate = slots.filter(slot => slot.state === "prompt-processing").length * (380 + 60 * Math.sin(seconds / 4));
    const generationRate = slots.filter(slot => slot.state === "generating").length * (34 + 6 * Math.sin(seconds / 6));
    const used = slots.reduce((sum, slot) => sum + slot.contextEstimateTokens, 0);
    const busy = slots.filter(slot => slot.isProcessing).length;
    const metrics = {
      "llamacpp:prompt_tokens_total": Math.floor(12000 + seconds * 140),
      "llamacpp:prompt_tokens_cached_total": Math.floor(8000 + seconds * 90),
      "llamacpp:prompt_seconds_total": seconds * 0.18,
      "llamacpp:tokens_predicted_total": Math.floor(8000 + seconds * 27),
      "llamacpp:tokens_predicted_seconds_total": seconds * 0.62,
      "llamacpp:n_decode_total": Math.floor(4000 + seconds * 5),
      "llamacpp:n_tokens_max": 4096,
      "llamacpp:n_busy_slots_per_decode": busy,
      "llamacpp:requests_processing": busy,
      "llamacpp:requests_deferred": seconds % 32 > 26 ? 2 : 0,
      "llamacpp:prompt_tokens_seconds": promptRate,
      "llamacpp:predicted_tokens_seconds": generationRate,
      "nodrama:prompt_tokens_rate": promptRate,
      "nodrama:tokens_predicted_rate": generationRate,
      "nodrama:server_uptime_seconds": seconds,
      "nodrama:context_active_tokens": used,
      "nodrama:context_active_capacity_tokens": 32768,
      "nodrama:context_active_ratio": used / 32768,
      "nodrama:container_cpu_percent": 24 + 12 * Math.sin(seconds / 11),
    };
    return { slots, metrics };
  }

  function record(time, current) {
    for (const [name, value] of Object.entries(current.metrics)) {
      const points = history.metrics[name] ||= [];
      points.push({ t: time, v: value });
      if (points.length > 120) points.shift();
    }
    for (const slot of current.slots) {
      const points = history.slots[slot.id] ||= [];
      points.push({ t: time, ...slot,
        promptTokensPerSec: slot.state === "prompt-processing" ? current.metrics["nodrama:prompt_tokens_rate"] : 0,
        generationTokensPerSec: slot.state === "generating" ? current.metrics["nodrama:tokens_predicted_rate"] / Math.max(1, current.slots.filter(s => s.state === "generating").length) : 0 });
      if (points.length > 120) points.shift();
    }
  }

  function snapshot() {
    const time = now(), end = Math.floor(time / 1000) * 1000;
    for (let at = Math.max(lastSample + 1000, end - 119000); at <= end; at += 1000) record(at, frame(at));
    lastSample = end;
    const { slots, metrics } = frame(time);
    const entries = slots.filter(slot => cacheSlots.has(slot.id)).map(slot => ({
      key: "demo-cache-" + slot.id, tokens: 12000 + slot.id * 4096,
      mib: 512 + slot.id * 256 + 40 * Math.sin((time - started) / 14000 + slot.id),
      checkpoints: 2 + slot.id, lastSlotId: slot.id,
      lastTaskId: slot.taskId || 1000 + slot.id, lastUsedAt: iso(time),
    }));
    const usedMiB = entries.reduce((sum, entry) => sum + entry.mib, 0) + 384;
    const cache = { available: true, detailsAvailable: true, source: "demo",
      updatedAt: iso(time), reusedTokensTotal: metrics["llamacpp:prompt_tokens_cached_total"],
      promptCount: entries.length + 1, observedEntries: entries.length, complete: false,
      usedMiB, limitMiB: 8192, limitTokens: 131072, estTokens: 131072,
      usedTokensEstimate: Math.round(usedMiB / 8192 * 131072), topEntries: entries,
      untrackedMiB: 384, unusedMiB: 8192 - usedMiB };
    const model = selected();
    const modelId = model ? model.id : v1models[0].id;
    const queries = slots.map(slot => ({
      id: "demo-query-" + slot.id, status: slot.isProcessing ? "running" : "complete",
      model: modelId, slotIds: [slot.id], taskIds: [slot.taskId || 1000 + slot.id],
      promptTokens: 2048, completionTokens: slot.decodedTokens, totalTokens: 2048 + slot.decodedTokens,
      promptCacheTokens: slot.promptCacheTokens, cacheRestoredTokens: slot.promptCacheTokens,
      cacheKey: entries.some(entry => entry.lastSlotId === slot.id) ? "demo-cache-" + slot.id : "",
      cacheCached: entries.some(entry => entry.lastSlotId === slot.id),
      cacheReuseCount: slot.promptCacheTokens ? 1 : 0,
      durationMs: 1000 + ((time - started + slot.id * 6000) % 24000),
      currentTokensPerSec: slot.state === "generating" ? 34 : 0,
    }));
    if (metrics["llamacpp:requests_deferred"]) queries.push({ id: "demo-queued", status: "queued", model: modelId });
    const metricFacts = Object.fromEntries(Object.entries(history.metrics).map(([name, points]) => {
      const peak = points.reduce((best, point) => point.v > best.v ? point : best);
      return [name, { peakValue: peak.v, peakAt: iso(peak.t), peak5mValue: peak.v, peak5mAt: iso(peak.t) }];
    }));
    const effectiveProps = { ...props, n_ctx: 32768, n_ctx_train: 32768, model_alias: modelId,
      model_path: model?.path || props.model_path };
    return { app: "llama.nodrama", build: { version: "demo", commit: "demo", date: iso(started) },
      update: { currentVersion: "demo", repoUrl: "https://github.com/hangry-labs/llama.nodrama", available: false },
      mode, server: "demo", startedAt: iso(started), updatedAt: iso(time), pollIntervalMs: settings.pollIntervalMs,
      endpoints: Object.fromEntries(["health", "props", "metrics", "slots"].map(key => [key, { ok: true, status: 200 }])),
      overview: { online: true, busySlots: metrics["llamacpp:requests_processing"], totalSlots: 4,
        serverStartedAt: iso(started), serverUptimeSeconds: (time - started) / 1000, serverUptimeSource: "demo",
        contextUsedTokens: metrics["nodrama:context_active_tokens"], contextCapacityTokens: 32768 },
      props: effectiveProps, models: [{ ...v1models[0], id: modelId }], routerModels: models || [],
      loraAdapters: [], slots, rawMetrics: metrics, promptCache: cache, history, metricFacts,
      queries, requests: [], warnings: [], suggestions: [], events: [{ kind: "cache", at: iso(time),
        cachePrompts: entries.length, cacheUsedMiB: usedMiB, cacheLimitMiB: 8192,
        cacheLimitTokens: 131072, cacheEstTokens: 131072 }] };
  }

  return { snapshot, settings,
    resetHistory() {
      history.metrics = {}; history.slots = {};
      lastSample = Math.floor(now() / 1000) * 1000 - 1000;
    },
    metricHistory(metric) { snapshot(); return { metric, hours: 24, points: history.metrics[metric] || [] }; },
    modelAction(id, action) {
      const model = models?.find(model => model.id === id);
      if (!model) throw new Error("Unknown demo model");
      model.status = { ...model.status, value: action === "load" ? "loaded" : "unloaded", failed: false, exit_code: null };
    },
    slotAction(id, action) {
      if (!Number.isInteger(id) || id < 0 || id > 3) throw new Error("Unknown demo slot");
      overrides.set(id, action);
      if (action === "erase") cacheSlots.delete(id);
      else cacheSlots.add(id);
    },
    logs() {
      const current = snapshot(), time = now();
      const lines = current.slots.map(slot => "[demo] slot update_slots: id " + slot.id + " | task " + slot.taskId + " | " + slot.state
        + ", prompt = " + slot.promptProcessedTokens + "/" + slot.promptTokens + ", decoded = " + slot.decodedTokens);
      lines.push("[demo] srv update: - cache state: " + current.promptCache.promptCount + " prompts, " + current.promptCache.usedMiB.toFixed(3)
        + " MiB (limits: 8192.000 MiB, 131072 tokens, 131072 est)");
      return { enabled: true, size: Math.max(1, Math.floor((time - started) / 1000)) * 256,
        updatedAt: iso(time), lines };
    },
  };
}
