"use strict";


/* Resolve a key for the active language, fallback to English. */
function t(key, vars) {
  const dict = I18N[state.lang] || {};
  let s = dict[key];
  if (s === undefined) s = I18N.en[key];
  if (s === undefined) s = key;
  if (vars) {
    s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m));
  }
  return s;
}

/* ──────────────────────────────────────────────────────────────────────
 *  URL parameter parser. All settings live here — no localStorage.
 * ──────────────────────────────────────────────────────────────────── */
function parseParams() {
  const u = new URL(window.location.href);
  const q = u.searchParams;
  return {
    server: (q.get("server") || "").trim(),
    model:  (q.get("model")  || "").trim(),
    poll:   clampInt(q.get("poll"), 1000, 200, 60_000),
    log:    q.has("log") ? q.get("log") : null,   /* null = auto-detect */
    lang:   (q.get("lang") || "").trim(),
    prompt: q.get("prompt") || "",                /* prefill chat input */
    demo:   demoMode(q.get("demo")),              /* "", "1", or "router" */
  };
}
function clampInt(s, fallback, min, max) {
  const n = parseInt(s, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
function demoMode(v) {
  /* Only "1" (single) and "router" enable the mock; anything else stays
   * live so a typo like ?demo=true doesn't silently swap real metrics. */
  const s = (v || "").trim();
  return s === "1" || s === "router" ? s : "";
}

/* Pick a UI language from ?lang, then navigator.language, then 'en'. */
function pickLang(requested) {
  const supported = Object.keys(I18N);
  if (requested && supported.includes(requested)) return requested;
  const nav = (navigator.language || "en").toLowerCase();
  if (nav.startsWith("ko")) return "ko";
  if (nav.startsWith("ja")) return "ja";
  if (nav.startsWith("zh")) return "zh-CN";
  if (nav.startsWith("es")) return "es";
  return "en";
}

/* ──────────────────────────────────────────────────────────────────────
 *  Global state. One object, no hidden globals.
 * ──────────────────────────────────────────────────────────────────── */
const params = parseParams();
function emptyHistory() {
  return { metrics: {}, slots: {} };
}

const state = {
  params,
  lang: pickLang(params.lang),
  serverBase: deriveServerBase(params.server),
  /* set in later phases */
  mode: null,           /* "single" | "router" */
  selectedModel: params.model || null,
  props: null,
  v1models: [],
  models: [],
  loraAdapters: [],
  metrics: null,
  metricFacts: {},
  slots: [],
  queries: [],
  events: [],
  snapshot: null,
  history: emptyHistory(),
  suggestions: null,
  paused: false,
  /* `healthy` flips true only when /props came back at least once.
   * The status LED reads this — never `lastUpdate` alone — so a
   * pause/resume or visibility toggle can't lie about server state. */
  healthy: false,
  pollers: [],          /* {name, abort, timer} */
  errors: [],           /* visible error banners */
  lastUpdate: null,
  ui: {
    bootDone: false,
    logEnabled: false,
    supportSignature: "",
  },
};

function deriveServerBase(raw) {
  if (!raw) return window.location.origin;
  try {
    const url = new URL(raw, window.location.href);
    /* Whitelist http(s) only — javascript:, data:, file: etc. would either
     * fail in fetch or behave surprisingly. Better to surface early. */
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return window.location.origin;
    }
    return url.origin + (url.pathname.replace(/\/+$/, ""));
  } catch (_e) {
    /* report at boot time, fall back to current origin */
    return window.location.origin;
  }
}

/* ──────────────────────────────────────────────────────────────────────
 *  Tiny DOM helpers
 * ──────────────────────────────────────────────────────────────────── */
function $(sel, root) { return (root || document).querySelector(sel); }
function $$(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }
function el(tag, attrs, children) {
  const node = document.createElement(tag);
  if (attrs) for (const k in attrs) {
    if (k === "class") node.className = attrs[k];
    else if (k === "style") node.style.cssText = attrs[k];
    else if (k.startsWith("on") && typeof attrs[k] === "function") {
      node.addEventListener(k.slice(2), attrs[k]);
    } else if (k === "data") {
      for (const dk in attrs.data) node.dataset[dk] = attrs.data[dk];
    } else if (attrs[k] !== undefined && attrs[k] !== null) {
      node.setAttribute(k, attrs[k]);
    }
  }
  if (children !== undefined) {
    if (Array.isArray(children)) {
      for (const c of children) {
        if (c == null) continue;
        node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
      }
    } else if (typeof children === "string") {
      node.textContent = children;
    } else {
      node.appendChild(children);
    }
  }
  return node;
}

/* Render every element with data-i18n="key" using the current language. */
function applyI18n(root) {
  const scope = root || document;
  scope.querySelectorAll("[data-i18n]").forEach((n) => {
    n.textContent = t(n.dataset.i18n);
  });
}

/* ──────────────────────────────────────────────────────────────────────
 *  Header wiring
 * ──────────────────────────────────────────────────────────────────── */
function initHeader() {
  $("#server-display").textContent = state.serverBase;
  $("#server-display").title = state.serverBase;
  setBuildDisplay(null, null);
  const settingsButton = $("#settings-button");
  if (settingsButton) {
    settingsButton.title = t("header.settings");
    settingsButton.setAttribute("aria-label", t("header.settings"));
    settingsButton.addEventListener("click", openSettingsModal);
  }
  const sel = $("#lang-select");
  sel.value = state.lang;
  sel.addEventListener("change", () => {
    const u = new URL(window.location.href);
    u.searchParams.set("lang", sel.value);
    window.location.href = u.toString();
  });
  document.documentElement.lang = state.lang;
  applyI18n();
}

/* Status LED: 'connecting' | 'online' | 'warn' | 'offline' | 'error' */
function setStatus(state_, textKey) {
  const led = $("#status-led");
  const txt = $("#status-text");
  led.classList.remove("on", "warn", "bad");
  if (state_ === "online")  led.classList.add("on");
  if (state_ === "warn")    led.classList.add("warn");
  if (state_ === "offline") led.classList.add("bad");
  if (state_ === "error")   led.classList.add("bad");
  txt.dataset.i18n = textKey;
  txt.textContent = t(textKey);
}

/* Push / clear an error banner. id de-duplicates. */
function showBanner(id, message, severity) {
  const wrap = $("#banners");
  let n = wrap.querySelector('[data-id="' + cssEscape(id) + '"]');
  if (!n) {
    n = el("div", { class: "banner" + (severity === "warn" ? " warn" : ""), data: { id } });
    wrap.appendChild(n);
  } else {
    n.className = "banner" + (severity === "warn" ? " warn" : "");
  }
  n.textContent = message;
}
function clearBanner(id) {
  const wrap = $("#banners");
  const n = wrap.querySelector('[data-id="' + cssEscape(id) + '"]');
  if (n) n.remove();
}
function cssEscape(s) { return String(s).replace(/[^\w-]/g, "_"); }

/* ──────────────────────────────────────────────────────────────────────
 *  Networking — every fetch is wrapped, surfaces an error if it fails,
 *  and is abortable so we can cancel in flight when the page unloads
 *  or the model selection changes.
 * ──────────────────────────────────────────────────────────────────── */
function endpoint(path, withModel) {
  const base = window.location.origin;
  let url = base + path;
  if (withModel && state.mode === "router" && state.selectedModel) {
    const sep = url.includes("?") ? "&" : "?";
    url += sep + "model=" + encodeURIComponent(state.selectedModel);
  }
  return url;
}

/* ──────────────────────────────────────────────────────────────────────
 *  Demo mode — installs a fetch shim that returns synthetic responses
 *  shaped exactly like real llama-server. Activated by ?demo=1 (single
 *  mode) or ?demo=router (router mode). Lets the dashboard run on
 *  static hosting (e.g. GitHub Pages) without any backend.
 *
 *  Real fetch is preserved for cross-origin requests we don't simulate
 *  (e.g. external link previews — we don't make any, but defensively).
 * ──────────────────────────────────────────────────────────────────── */
function installDemoShim(mode) {
  const realFetch = window.fetch.bind(window);
  const t0 = Date.now();
  const matchesServer = (url) => {
    try {
      const u = new URL(url, window.location.href);
      return u.origin === window.location.origin;
    } catch (_e) { return false; }
  };

  /* Counters that grow over time so cumulative cards animate. */
  const counters = () => {
    const sec = (Date.now() - t0) / 1000;
    return {
      prompt_tokens_total:        Math.floor(120 + sec * 14),
      tokens_predicted_total:     Math.floor(80 + sec * 27),
      prompt_seconds_total:       (sec * 0.18).toFixed(3),
      tokens_predicted_seconds_total: (sec * 0.62).toFixed(3),
      n_decode_total:             Math.floor(40 + sec * 5),
      n_tokens_max:               512 + Math.floor(sec / 30) * 64,
      n_busy_slots_per_decode:    (1.4 + Math.sin(sec / 8) * 0.6).toFixed(2),
    };
  };

  /* Gauges that oscillate. */
  const gauges = () => {
    const sec = (Date.now() - t0) / 1000;
    const wave = (period, amp, base) => base + Math.sin(sec / period) * amp;
    return {
      prompt_tokens_seconds:     Math.max(0, wave(11, 60, 95)).toFixed(2),
      predicted_tokens_seconds:  Math.max(0, wave(7, 22, 58)).toFixed(2),
      requests_processing:       Math.max(0, Math.round(wave(13, 1.4, 1.5))),
      requests_deferred:         Math.max(0, Math.round(wave(19, 1.1, 0.3))),
    };
  };

  const renderRawMetrics = () => {
    const c = counters(), g = gauges();
    return {
      "llamacpp:prompt_tokens_total": Number(c.prompt_tokens_total),
      "llamacpp:prompt_seconds_total": Number(c.prompt_seconds_total),
      "llamacpp:tokens_predicted_total": Number(c.tokens_predicted_total),
      "llamacpp:tokens_predicted_seconds_total": Number(c.tokens_predicted_seconds_total),
      "llamacpp:n_decode_total": Number(c.n_decode_total),
      "llamacpp:n_tokens_max": Number(c.n_tokens_max),
      "llamacpp:n_busy_slots_per_decode": Number(c.n_busy_slots_per_decode),
      "llamacpp:prompt_tokens_seconds": Number(g.prompt_tokens_seconds),
      "llamacpp:predicted_tokens_seconds": Number(g.predicted_tokens_seconds),
      "llamacpp:requests_processing": Number(g.requests_processing),
      "llamacpp:requests_deferred": Number(g.requests_deferred),
      "nodrama:prompt_tokens_rate": Number(g.prompt_tokens_seconds),
      "nodrama:tokens_predicted_rate": Number(g.predicted_tokens_seconds),
    };
  };

  const sampleParams = {
    n_predict: 400, seed: 42, temperature: 0.7, dynatemp_range: 0,
    dynatemp_exponent: 1, top_k: 40, top_p: 0.95, min_p: 0.05,
    typical_p: 1, xtc_probability: 0, xtc_threshold: 0.1,
    repeat_last_n: 64, repeat_penalty: 1.05, presence_penalty: 0,
    frequency_penalty: 0, dry_multiplier: 0, dry_base: 1.75,
    mirostat: 0, mirostat_tau: 5, mirostat_eta: 0.1,
    samplers: ["dry", "top_k", "typ_p", "top_p", "min_p", "xtc", "temperature"],
  };

  const renderSlots = () => {
    const sec = (Date.now() - t0) / 1000;
    const out = [];
    for (let i = 0; i < 4; i++) {
      const isProc = ((Math.sin((sec + i * 1.7) / 4) + 1) / 2) > 0.55;
      const slot = {
        id: i, n_ctx: 1024, speculative: false, is_processing: isProc,
      };
      if (isProc) {
        slot.id_task = 1000 + i;
        slot.params = sampleParams;
        slot.next_token = {
          has_next_token: true, has_new_line: false,
          n_remain: Math.floor(400 - ((sec * 8) % 380)),
          n_decoded: Math.floor((sec * 8) % 380),
        };
      }
      out.push(slot);
    }
    return out;
  };

  const propsResp = {
    default_generation_settings: { ...sampleParams },
    total_slots: 4,
    model_path: mode === "router" ? "/models/qwen2.5-1.5b-instruct-q4_0.gguf"
                                  : "/opt/models/demo-model.gguf",
    chat_template: "{% for message in messages %}<|im_start|>{{ message.role }}\n{{ message.content }}<|im_end|>\n{% endfor %}<|im_start|>assistant\n",
    chat_template_caps: { tools: false, vision: false },
    modalities: { vision: false, audio: false },
    media_marker: "<__media__>",
    build_info: { build_number: "demo-9999", commit: "0000000" },
    is_sleeping: false,
  };

  const v1ModelsResp = {
    object: "list",
    data: [{
      id: mode === "router" ? "ggml-org/qwen2.5-1.5b-instruct-gguf:Q4_0" : "demo-model",
      object: "model",
      created: Math.floor(t0 / 1000),
      owned_by: "llamacpp",
      meta: {
        n_vocab: 151936, n_ctx_train: 32768, n_embd: 1536,
        n_params: 1543714304, size: 932512384,
      },
    }],
  };

  const modelsResp = mode === "router" ? [
    {
      id: "ggml-org/qwen2.5-1.5b-instruct-gguf:Q4_0",
      in_cache: true,
      path: "/cache/qwen2.5-1.5b-instruct-q4_0.gguf",
      status: { value: "loaded",
                args: ["-m", "/cache/qwen2.5-1.5b-instruct-q4_0.gguf",
                       "-c", "4096", "--parallel", "4", "--metrics"],
                failed: false, exit_code: null },
    },
    {
      id: "ggml-org/llama-3.2-1b-instruct-gguf:Q4_K_M",
      in_cache: true,
      path: "/cache/llama-3.2-1b.gguf",
      status: { value: "unloaded", args: [], failed: false, exit_code: null },
    },
    {
      id: "ggml-org/qwen2.5-7b-instruct-gguf:Q4_K_M",
      in_cache: false,
      path: null,
      status: { value: "failed",
                args: ["-m", "/cache/qwen2.5-7b.gguf", "-ngl", "99"],
                failed: true, exit_code: 137 },
    },
  ] : null;

  const cannedReplies = [
    `# Demo response\n\nThis dashboard is running in **demo mode** — every endpoint is synthetic. The real one talks to a [llama.cpp](https://github.com/ggml-org/llama.cpp) server.\n\n## What works\n\n- Streaming with throttled re-render\n- Markdown: lists, tables, code\n- Cancel mid-stream\n\n\`\`\`js\n// example\nfunction hello(name) {\n  return \`Hello, \${name}!\`;\n}\n\`\`\`\n\n| Metric | Source |\n|---|---|\n| tok/s | \`/metrics\` |\n| slots | \`/slots\` |\n| model | \`/v1/models\` |\n\n> Try clicking ⓘ on any card.`,
    `Sure — quick rundown of the relevant flags:\n\n1. **\`--metrics\`** turns on \`/metrics\` (Prometheus).\n2. **\`--parallel N\`** sets concurrent slots; KV memory ≈ N × ctx_size × hidden_dim × 2.\n3. **\`-ngl L\`** offloads L layers to GPU. Set to 99 to offload everything when VRAM allows.\n4. **\`--ctx-size C\`** is total context shared across slots in single mode.\n\n*This is the demo response — no real model behind it.*`,
    `Here's a small table of common sampling presets:\n\n| Preset | temp | top_p | repeat_penalty |\n|--------|------|-------|----------------|\n| chat   | 0.7  | 0.95  | 1.05           |\n| code   | 0.2  | 0.95  | 1.0            |\n| creative | 1.0 | 0.95 | 1.1            |\n\nUse \`temperature = 0\` for deterministic output (greedy). Setting \`mirostat\` to 1 or 2 ignores top_p / top_k entirely.`,
  ];

  const streamingChat = (body) => {
    const replyIdx = (chat.messages.length / 2) | 0;
    const text = cannedReplies[replyIdx % cannedReplies.length];
    const tokens = text.split(/(\s+)/).filter(Boolean);
    let signal = body && body.signal;
    const stream = new ReadableStream({
      async start(controller) {
        const enc = new TextEncoder();
        try {
          for (let i = 0; i < tokens.length; i++) {
            if (signal && signal.aborted) {
              controller.close(); return;
            }
            const chunk = { choices: [{ delta: { content: tokens[i] } }] };
            controller.enqueue(enc.encode("data: " + JSON.stringify(chunk) + "\n\n"));
            await new Promise((r) => setTimeout(r, 30 + Math.random() * 50));
          }
          const usage = {
            prompt_tokens: 24 + Math.floor(Math.random() * 30),
            completion_tokens: tokens.length,
            total_tokens: 0,
          };
          usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
          controller.enqueue(enc.encode("data: " + JSON.stringify({ usage }) + "\n\n"));
          controller.enqueue(enc.encode("data: [DONE]\n\n"));
          controller.close();
        } catch (e) {
          controller.error(e);
        }
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  };

  const json = (obj, status) =>
    new Response(JSON.stringify(obj),
      { status: status || 200, headers: { "Content-Type": "application/json" } });
  const notFound = () => new Response("not found", { status: 404 });

  window.fetch = function (input, init) {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    if (!matchesServer(url)) return realFetch(input, init);

    let path;
    try { path = new URL(url, window.location.href).pathname; }
    catch (_e) { return realFetch(input, init); }
    /* normalize: strip serverBase prefix path */
    try {
      const baseP = new URL(state.serverBase, window.location.href).pathname.replace(/\/+$/, "");
      if (baseP && path.startsWith(baseP)) path = path.slice(baseP.length) || "/";
    } catch (_e) {}

    const method = (init && init.method) || (typeof input !== "string" ? input.method : "GET") || "GET";

    if (path === "/api/health") return Promise.resolve(json({ status: "ok", app: "llama.nodrama" }));
    if (path === "/api/settings") return Promise.resolve(json({
      server: "demo",
      listen: "static demo",
      logPath: "",
      rawProxy: false,
      pollIntervalMs: state.params.poll,
      timeoutMs: 5000,
    }));
    if (path === "/api/snapshot") return Promise.resolve(json({
      app: "llama.nodrama",
      build: { version: "demo", commit: "demo", date: new Date(t0).toISOString() },
      update: { currentVersion: "demo", repoUrl: "https://github.com/hangry-labs/llama.nodrama", latestUrl: "https://github.com/hangry-labs/llama.nodrama/releases/latest", available: false },
      mode: mode === "router" ? "router" : "single",
      server: "demo",
      pollIntervalMs: state.params.poll,
      startedAt: new Date(t0).toISOString(),
      updatedAt: new Date().toISOString(),
      endpoints: {},
      overview: { online: true },
      props: propsResp,
      models: v1ModelsResp.data,
      routerModels: modelsResp || [],
      loraAdapters: [],
      slots: renderSlots(),
      rawMetrics: renderRawMetrics(),
      history: { metrics: {}, slots: {} },
      suggestions: [],
      requests: [],
      warnings: [],
    }));
    if (path === "/api/chat/completions" && method.toUpperCase() === "POST") {
      return Promise.resolve(streamingChat(init || {}));
    }
    /* slot save/restore/erase, model load/unload — pretend success */
    if (path.startsWith("/api/slots/")
        || path.startsWith("/api/models/load") || path.startsWith("/api/models/unload")
        || path === "/api/history/reset") {
      return Promise.resolve(json({ success: true, demo: true }));
    }
    if (path.startsWith("/api/logs/tail")) {
      return Promise.resolve(json({ enabled: false }));
    }
    /* legacy server.log — return 404 so log panel hides cleanly */
    return Promise.resolve(notFound());
  };

  /* Surface the demo state to the user. Banner uses i18n key. */
  const showDemoBanner = () => {
    const wrap = $("#banners");
    if (!wrap) return;
    const key = mode === "router" ? "demo.banner_router" : "demo.banner_single";
    const node = el("div", { class: "banner", data: { id: "demo-mode" } }, t(key));
    wrap.appendChild(node);
  };
  /* applyI18n hasn't run yet — defer to next microtask */
  Promise.resolve().then(showDemoBanner);
}

async function fetchJSON(path, opts) {
  return fetchEndpoint(path, opts, "json");
}
async function fetchText(path, opts) {
  return fetchEndpoint(path, opts, "text");
}
async function fetchEndpoint(path, opts, kind) {
  const o = opts || {};
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), o.timeout || 8000);
  try {
    const res = await fetch(endpoint(path, o.withModel !== false), {
      method: o.method || "GET",
      headers: Object.assign(
        { "Accept": kind === "json" ? "application/json" : "text/plain" },
        o.headers || {}
      ),
      body: o.body,
      signal: o.signal || ctrl.signal,
      cache: "no-store",
    });
    clearTimeout(timer);
    if (!res.ok) {
      const errBody = await safeReadBody(res);
      /* Strip HTML responses (e.g. a CDN / static-host 404 page) from the
       * user-facing error message — printing raw markup is ugly and tells
       * the user nothing useful. Keep the first ~80 chars for non-HTML. */
      const looksHtml = /^\s*<(!doctype|html|head)/i.test(errBody || "");
      const tail = (errBody && !looksHtml) ? " — " + errBody.replace(/\s+/g, " ").slice(0, 80) : "";
      const e = new Error("HTTP " + res.status + tail);
      e.status = res.status;
      e.body = errBody;
      throw e;
    }
    if (kind === "json") return await res.json();
    if (kind === "text") return await res.text();
    return res;
  } catch (e) {
    clearTimeout(timer);
    if (e.name === "AbortError") {
      const ae = new Error("aborted"); ae.aborted = true; throw ae;
    }
    throw e;
  }
}
async function safeReadBody(res) {
  try { return await res.text(); } catch (_) { return ""; }
}

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
  const repoURL = (update && update.repoUrl) || "https://github.com/hangry-labs/llama.nodrama";
  const latestVersion = update && update.latestVersion ? String(update.latestVersion) : "";
  const latestURL = (update && update.latestUrl) || repoURL;
  const available = !!(update && update.available && latestVersion);
  node.classList.toggle("update-available", available);
  node.href = available ? latestURL : repoURL;
  if (available) {
    node.textContent = "version " + version + " · " + t("update.available");
  } else {
    node.textContent = "version " + version;
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

async function refreshSnapshot(opts) {
  const snapshot = await fetchJSON("/api/snapshot", Object.assign({
    withModel: false,
    timeout: 6000,
  }, opts || {}));
  applySnapshot(snapshot, { render: true });
  return snapshot;
}

/* ──────────────────────────────────────────────────────────────────────
 *  Polling engine. setTimeout chain with backoff + AbortController.
 *  Never setInterval — that allows requests to stack when the server
 *  is slow.
 * ──────────────────────────────────────────────────────────────────── */
function startPoller(name, intervalMs, taskFn) {
  let timer = null;
  let aborter = null;
  let stopped = false;
  let backoff = 0;       /* extra ms added on consecutive failures */
  const MAX_BACKOFF = 10_000;

  async function tick() {
    if (stopped) return;
    if (state.paused) {
      timer = setTimeout(tick, intervalMs);
      return;
    }
    aborter = new AbortController();
    try {
      await taskFn(aborter.signal);
      backoff = 0;
      clearBanner("poll-" + name);
    } catch (e) {
      if (e.aborted || e.name === "AbortError") {
        /* swallowed */
      } else {
        backoff = Math.min(MAX_BACKOFF, Math.max(1000, backoff ? backoff * 2 : 1000));
        showBanner(
          "poll-" + name,
          name + ": " + (e.message || t("error.fetch_failed")),
          "warn"
        );
      }
    }
    if (!stopped) timer = setTimeout(tick, intervalMs + backoff);
  }

  const handle = {
    name,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (aborter) try { aborter.abort(); } catch (_) {}
    },
  };
  state.pollers.push(handle);
  /* fire first tick on next microtask to avoid stacking inside boot() */
  Promise.resolve().then(tick);
  return handle;
}

function stopAllPollers() {
  for (const p of state.pollers) p.stop();
  state.pollers = [];
}

/* Pause / resume hook for keyboard shortcut (Phase 9). */
function setPaused(v) {
  state.paused = !!v;
  if (state.paused) {
    setStatus("warn", "common.pause");
  } else if (state.healthy) {
    setStatus("online", "header.status.online");
  } else if (state.ui.bootDone) {
    setStatus("offline", "header.status.offline");
  } else {
    setStatus("connecting", "header.status.connecting");
  }
}

/* When the tab is hidden, abort in-flight requests and pause —
 * resume on visibility. Cheap battery / server-load saver. */
document.addEventListener("visibilitychange", () => {
  if (document.hidden) setPaused(true);
  else setPaused(false);
});

/* ──────────────────────────────────────────────────────────────────────
 *  Boot sequence. Discovers single-model vs router mode, picks the
 *  active model in router mode, and hands control to the poller setup
 *  function (defined in later phases). Phase 2 only verifies wiring.
 * ──────────────────────────────────────────────────────────────────── */
async function boot() {
  /* Install the demo fetch shim before initHeader / any fetch fires.
   * ?demo=1 → single-mode synthetic; ?demo=router → router-mode. */
  if (state.params.demo) {
    installDemoShim(state.params.demo === "router" ? "router" : "single");
  }

  initHeader();
  ensureRootScaffold();
  setStatus("connecting", "header.status.connecting");

  if (state.params.server && state.serverBase === window.location.origin
      && state.params.server !== window.location.origin) {
    /* deriveServerBase fell back; show the user. */
    showBanner("bad-url", t("error.bad_url") + ": " + state.params.server, "warn");
  }

  try {
    await refreshSnapshot({ timeout: 8000 });
  } catch (e) {
    setStatus("error", "header.status.error");
    showBanner("snapshot", t("error.fetch_failed") + ": /api/snapshot — " + e.message);
    renderMetricsDisabled();
    renderSlotsDisabled();
  }

  state.ui.bootDone = true;
  state.bootedAt = Date.now();

  renderBootSummary();
  renderChatPanel();
  renderGuidance();
  startCorePollers();
  startSecondaryPollers();
  /* fire-and-forget log detection — never blocks the dashboard */
  startLogPoller().catch(() => {});
}

/* Bare minimum scaffold so later phases have stable mount points to
 * write into. Each phase adds detail to one of these slots. */
function ensureRootScaffold() {
  const root = $("#root");
  root.innerHTML = "";
  root.appendChild(el("div", { id: "metrics-section", class: "full",
                               style: "display: contents;" }));
  root.appendChild(el("div", { id: "slots-section", class: "full",
                               style: "display: contents;" }));
  root.appendChild(el("div", { id: "queries-section", class: "full",
                               style: "display: contents;" }));
  root.appendChild(el("div", { id: "chat-section", class: "full",
                               style: "display: contents;" }));
  root.appendChild(el("div", { id: "models-section", class: "full",
                               style: "display: contents;" }));
  root.appendChild(el("div", { id: "config-section", class: "full",
                               style: "display: contents;" }));
  root.appendChild(el("div", { id: "lora-section", class: "full",
                               style: "display: contents;" }));
  root.appendChild(el("div", { id: "log-section", class: "full",
                               style: "display: contents;" }));
  root.appendChild(el("div", { id: "guidance-section", class: "full",
                               style: "display: contents;" }));
}

/* Render Models, Server config, and LoRA cards. Re-callable; on each call
 * we rebuild the section content. Cheap because it's not on the hot path. */
function renderBootSummary() {
  renderModelsCard();
  renderServerConfigCard();
  renderLoraCard();
}

function findV1Meta(modelId) {
  if (!Array.isArray(state.v1models)) return null;
  return state.v1models.find((m) => m && (m.id === modelId)) || null;
}

function renderModelsCard() {
  const sec = $("#models-section");
  sec.innerHTML = "";
  const card = el("div", { class: "card full" }, [
    el("h2", null, t("models.title")),
  ]);
  sec.appendChild(card);

  if (state.mode === "router") {
    /* selector + per-model cards */
    const sel = el("select", { id: "model-selector",
                               style: "max-width: 100%; min-width: 200px;",
                               onchange: () => onModelSelect($("#model-selector").value) });
    sel.appendChild(el("option", { value: "" }, "— " + t("models.selector") + " —"));
    for (const m of state.models) {
      sel.appendChild(el("option", {
        value: m.id,
        selected: m.id === state.selectedModel ? "selected" : null,
      }, m.id));
    }
    card.appendChild(el("div", { class: "row-actions" }, [
      el("span", { class: "sub" }, t("models.selector") + ":"),
      sel,
    ]));

    if (state.models.length === 0) {
      card.appendChild(el("div", { class: "sub" }, t("models.no_models")));
    } else {
      const list = el("div", { class: "model-list" });
      for (const m of state.models) list.appendChild(routerModelCard(m));
      card.appendChild(list);
    }
  } else {
    /* single-model: show the active model's metadata.
     * If neither /v1/models nor /props came back, render a "no data"
     * note instead of a fake card with a placeholder name like "model"
     * and a green "loaded" badge. */
    const id = (state.v1models[0] && state.v1models[0].id)
            || (state.props && state.props.model_path)
            || null;
    if (!id) {
      card.appendChild(el("div", { class: "sub" }, t("models.no_data")));
      return;
    }
    const meta = findV1Meta(id) || state.v1models[0] || null;
    card.appendChild(singleModelCard(id, meta));
  }
}

function routerModelCard(m) {
  const status = (m.status && m.status.value) || "unknown";
  const isActive = m.id === state.selectedModel;
  const meta = findV1Meta(m.id);
  const node = el("div", { class: "model-card" + (isActive ? " active" : "") }, [
    el("div", { class: "name" }, m.id),
    el("div", { class: "row-actions" }, [
      el("span", { class: "badge status-" + status }, t("models.status." + status)
        || t("models.status.unknown")),
      m.in_cache ? el("span", { class: "badge" }, t("models.cached")) : null,
      (m.status && m.status.failed && m.status.exit_code !== undefined && m.status.exit_code !== null)
        ? el("span", { class: "badge status-failed" },
            t("models.exit_code") + " " + m.status.exit_code)
        : null,
    ].filter(Boolean)),
    m.path ? el("div", { class: "sub" },
      el("span", { class: "badge" }, t("model.path")) )
      : null,
    m.path ? el("div", { class: "sub", style: "word-break: break-all;" }, m.path) : null,
  ]);
  if (meta && meta.meta) {
    node.appendChild(metaKVTable(meta.meta));
  }
  if (m.status && Array.isArray(m.status.args) && m.status.args.length) {
    const argsTxt = m.status.args.join(" ");
    const block = el("div", { class: "args-block" }, argsTxt);
    node.appendChild(block);
    node.appendChild(el("div", { class: "row-actions" }, [
      el("button", {
        onclick: (e) => copyToClipboard(argsTxt, e.currentTarget),
      }, t("common.copy")),
    ]));
  }
  /* load / unload buttons */
  const actions = el("div", { class: "row-actions" }, []);
  if (status === "loaded" || status === "sleeping") {
    actions.appendChild(el("button", {
      onclick: () => confirmAction(
        t("models.confirm.unload", { name: m.id }),
        () => callLoadOrUnload("/api/models/unload", m.id, "unload")
      ),
    }, t("models.actions.unload")));
  } else {
    actions.appendChild(el("button", {
      onclick: () => confirmAction(
        t("models.confirm.load", { name: m.id }),
        () => callLoadOrUnload("/api/models/load", m.id, "load")
      ),
    }, t("models.actions.load")));
  }
  node.appendChild(actions);
  return node;
}

function singleModelCard(id, meta) {
  const props = state.props || {};
  const card = el("div", { class: "model-card" }, [
    el("div", { class: "name" }, id),
    el("div", { class: "row-actions" }, [
      props.is_sleeping
        ? el("span", { class: "badge status-sleeping" }, t("models.status.sleeping"))
        : el("span", { class: "badge status-loaded" }, t("models.status.loaded")),
    ]),
  ]);
  if (props.model_path) {
    card.appendChild(el("div", { class: "kv-table" }, [
      el("div", { class: "k" }, t("model.path")),
      el("div", { class: "v" }, props.model_path),
    ]));
  }
  if (meta && meta.meta) card.appendChild(metaKVTable(meta.meta));
  return card;
}

function metaKVTable(meta) {
  const rows = [];
  function row(labelKey, val) {
    rows.push(el("div", { class: "k" }, t(labelKey)));
    rows.push(el("div", { class: "v" }, val == null ? "—" : String(val)));
  }
  if (meta.n_vocab !== undefined)      row("model.n_vocab",     meta.n_vocab);
  if (meta.n_ctx_train !== undefined)  row("model.n_ctx_train", meta.n_ctx_train);
  if (meta.n_embd !== undefined)       row("model.n_embd",      meta.n_embd);
  if (meta.n_params !== undefined)     row("model.n_params",    fmtNumber(meta.n_params));
  if (meta.size !== undefined)         row("model.size",        fmtBytes(meta.size));
  return el("div", { class: "kv-table" }, rows);
}

function fmtBytes(n) {
  if (!isFinite(n) || n == null) return "—";
  if (n >= 1024 * 1024 * 1024) return (n / (1024 * 1024 * 1024)).toFixed(2) + " GB";
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(2) + " MB";
  if (n >= 1024) return (n / 1024).toFixed(1) + " KB";
  return n + " B";
}

const CONFIG_OPTION_HELP = {
  "--slot-prompt-similarity": "Minimum prompt similarity required before llama.cpp assigns a request to an existing slot for prompt-cache reuse. Higher values are stricter; 0 disables similarity matching.",
  "-sps": "Short form of --slot-prompt-similarity.",
  "--parallel": "Number of parallel server slots. More slots can improve concurrency, but each slot needs context/KV capacity.",
  "-np": "Short form commonly used for parallel slot count.",
  "--ctx-size": "Context size available to the server/model. This is the main token-window budget.",
  "-c": "Short form of --ctx-size.",
  "--metrics": "Enables the /metrics endpoint. llama.nodrama needs it for throughput, queue, and decode metric cards.",
  "--slots": "Enables slot visibility. llama.nodrama needs /slots for per-slot activity and context estimates.",
  "--no-slots": "Disables slot visibility. This makes the main slot diagnostics unavailable.",
  "--slot-save-path": "Directory used by llama.cpp for slot save/restore checkpoint files.",
  "--cache-prompt": "Enables prompt-prefix cache reuse for compatible completion-style requests.",
  "--n-gpu-layers": "Number of model layers offloaded to GPU. Higher values usually improve speed until VRAM is exhausted.",
  "-ngl": "Short form of --n-gpu-layers.",
  "--threads": "CPU threads used for generation/eval work.",
  "-t": "Short form of --threads.",
  "--threads-batch": "CPU threads used for batch/prompt processing.",
  "-tb": "Short form of --threads-batch.",
  "--model": "Path or model identifier loaded by llama-server.",
  "-m": "Short form of --model.",
  "--host": "Address llama-server binds to.",
  "--port": "Port llama-server listens on.",
  "--sleep-idle-seconds": "Idle time before llama.cpp unloads the model. Sleeping frees resources but the next request pays reload latency.",
  "prompt_cache_limit_tokens": "Shared prompt/KV cache token ceiling. This is the practical budget for cached prompts/checkpoints when shared prompt cache is enabled.",
  "prompt_cache_used_tokens_est": "Estimated shared prompt/KV cache occupancy in tokens. This is derived from memory occupancy, so treat it as a capacity signal rather than an exact token count.",
  "prompt_cache_limit_mib": "Memory budget reserved for shared prompt/KV cache checkpoints.",
  "prompt_cache_used_mib": "Memory currently occupied by shared prompt/KV cache checkpoints.",
  "prompt_cache_prompts": "Number of prompts/checkpoint chains currently retained in the shared prompt cache.",
  "prompt_cache_est_tokens": "Estimated token capacity of the shared prompt cache.",
  "model_path": "Model file currently loaded by the server.",
  "model_alias": "Name clients can use to address the loaded model.",
  "total_slots": "Number of concurrent request slots. This is the upper bound for simultaneous active requests before queueing starts.",
  "n_ctx": "Context capacity available to this deployment. Larger context allows longer prompts/conversations but increases KV/cache memory pressure.",
  "n_ctx_train": "Training context length from model metadata. This is model metadata, not necessarily the launched context.",
  "is_sleeping": "Whether the model is currently unloaded due to sleep-on-idle.",
  "chat_template": "Chat template used to convert messages into the final prompt string.",
  "build_info": "llama.cpp build identifier. Useful when comparing behavior across server versions.",
  "modalities": "Input/output modalities the model/server advertises, such as text, vision, or audio.",
  "backend_sampling": "Controls where sampling is performed. For normal OpenAI-style chat/completions, leaving this off means request sampling parameters drive token choice in the usual server path. Turning it on is an advanced mode for backend-managed sampling behavior; change only if you know a client/workflow expects it.",
  "chat_format": "How streamed chat deltas are shaped. Content-only means visible assistant text is emitted as normal content; reasoning may be separate or omitted depending on the template/model.",
  "dry_allowed_length": "DRY anti-repetition ignores repeats shorter than this length. Higher values make DRY less aggressive on short repeated phrases.",
  "dry_base": "Base multiplier used by DRY anti-repetition. Higher values make repeat suppression ramp more strongly after a repeat is detected.",
  "dry_multiplier": "Strength of DRY anti-repetition. 0 disables DRY. Moderate values reduce loops without punishing all repeated words like repeat_penalty can.",
  "dry_penalty_last_n": "How far back DRY looks for repeated sequences. -1 usually means use the whole current context.",
  "dynatemp_exponent": "Curve shape for dynamic temperature. It only matters when dynatemp_range is above 0.",
  "dynatemp_range": "Dynamic temperature adjustment range. 0 disables dynamic temperature. Higher values let temperature move around the base temperature during generation.",
  "frequency_penalty": "Penalizes tokens based on how often they already appeared. Higher values reduce repeated wording, but too high can hurt code and structured output.",
  "generation_prompt": "Extra text/template suffix inserted before assistant generation. Empty means no extra generation marker beyond the chat template.",
  "ignore_eos": "If enabled, the model ignores end-of-sequence tokens and keeps generating until another stop condition. Useful for some tests, risky for normal chat.",
  "lora": "LoRA adapters applied by default. Empty means no adapter is active by default.",
  "min_keep": "Minimum number of candidate tokens preserved by probability filters. 0 means no extra minimum. Raising it can prevent samplers from becoming too narrow.",
  "temperature": "Sampling randomness. 0 is deterministic; higher values produce more varied output.",
  "top_k": "Limits sampling to the top K candidate tokens.",
  "top_p": "Nucleus sampling threshold; keeps tokens whose cumulative probability reaches this value.",
  "min_p": "Drops tokens below a probability relative to the most likely token.",
  "mirostat": "Mirostat sampling mode. 0 disables it. When enabled, it targets a desired surprise/entropy level and changes how top_p/top_k should be interpreted.",
  "mirostat_eta": "Mirostat learning rate. Higher values adapt faster but can oscillate more.",
  "mirostat_tau": "Mirostat target entropy/surprise. Higher values allow more varied output.",
  "n_discard": "Context-shift discard amount. When context fills and shifting is allowed, this influences how much old context can be dropped.",
  "n_keep": "Number of initial prompt tokens to preserve during context shifting. Useful for keeping system prompts/instructions anchored.",
  "repeat_penalty": "Penalty applied to repeated tokens.",
  "repeat_last_n": "How many previous tokens repeat_penalty considers. Larger windows reduce long-range repetition but can affect style and structured text.",
  "n_predict": "Default maximum generated tokens for completion-style requests.",
  "max_tokens": "Default maximum generated tokens for OpenAI-compatible requests.",
  "n_probs": "Number of token probabilities to return for each generated token. 0 disables probability output. Higher values add diagnostic data but increase response size.",
  "post_sampling_probs": "If enabled, reported token probabilities are taken after sampler filtering. If disabled, probabilities reflect the pre/post path used by the server default.",
  "presence_penalty": "Penalizes tokens that have appeared at least once. Higher values encourage new topics/words; too high can make output drift.",
  "reasoning_format": "How llama.cpp parses or exposes reasoning/thinking content for compatible models/templates.",
  "reasoning_in_content": "Whether reasoning is emitted inside normal content instead of a separate reasoning field.",
  "samplers": "Sampler chain order. Tokens pass through these filters/transforms before final selection. Order matters for advanced tuning.",
  "seed": "Random seed. A fixed seed improves reproducibility; the max unsigned value usually means random seed.",
  "speculative.types": "Speculative decoding mode. 'none' means no draft/speculative model path is active.",
  "stream": "Default streaming behavior. Requests can still override this. Streaming sends tokens incrementally instead of waiting for the full response.",
  "timings_per_token": "If enabled, timing details can be reported per token. Useful for diagnostics, but adds overhead/noise.",
  "top_n_sigma": "Top-n-sigma sampler threshold. Negative values disable it. When enabled, it keeps tokens within a probability/logit band around the best token.",
  "typical_p": "Typical sampling threshold. Values below 1 filter unlikely or overly surprising tokens based on local entropy.",
  "xtc_probability": "XTC sampler activation probability. 0 disables it. Higher values more often apply XTC filtering for creative variation.",
  "xtc_threshold": "XTC filtering threshold. It only matters when xtc_probability is above 0.",
};

function defaultOptionHelp(key) {
  const specific = CONFIG_OPTION_HELP[key] || "No detailed explanation is known yet.";
  return specific + "\n\nDefault means this is the server fallback used when a request does not send '" + key + "'. If a request overrides it, that request value wins; this row still shows the fallback default.";
}

function configHelpFor(option) {
  const key = option.key || option.label;
  if (option.isDefault) return defaultOptionHelp(key);
  if (CONFIG_OPTION_HELP[key]) return CONFIG_OPTION_HELP[key];
  return "Runtime or launch option. No detailed explanation is known yet.";
}

function configOptionCard(option) {
  const label = option.displayLabel || option.label;
  const help = option.help || configHelpFor(option);
  const title = option.source ? (help + " Source: " + option.source) : help;
  const open = () => showModal({
    title: label,
    bodyNode: el("div", null, [
      el("div", null, help),
      option.source ? el("div", { class: "sub", style: "margin-top: 8px;" }, "Source: " + option.source) : null,
    ]),
    okLabel: t("common.close"),
    onOk: () => {},
  });
  return el("div", {
    class: "option-card",
    title,
    role: "button",
    tabindex: "0",
    onclick: open,
    onkeydown: (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        open();
      }
    },
  }, [
    el("div", { class: "option-head" }, [
      el("span", null, label),
    ]),
    el("div", { class: "option-value" }, formatConfigValue(option.value)),
    option.source ? el("div", { class: "option-source" }, option.source) : null,
  ]);
}

function formatConfigValue(value) {
  if (value === undefined || value === null || value === "") return "—";
  if (typeof value === "boolean") return value ? t("common.yes") : t("common.no");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function configOptionGrid(options) {
  const grid = el("div", { class: "option-grid" });
  for (const option of options) {
    if (option.value === undefined || option.value === null || option.value === "") continue;
    grid.appendChild(configOptionCard(option));
  }
  return grid;
}

function parseLaunchArgs(args) {
  const out = [];
  if (!Array.isArray(args)) return out;
  for (let i = 0; i < args.length; i++) {
    const token = String(args[i]);
    if (!token.startsWith("-")) continue;
    let label = token;
    let value = true;
    const eq = token.indexOf("=");
    if (eq > 0) {
      label = token.slice(0, eq);
      value = token.slice(eq + 1);
    } else if (i + 1 < args.length && !String(args[i + 1]).startsWith("-")) {
      value = String(args[i + 1]);
      i++;
    }
    out.push({ label, value, source: "CLI args" });
  }
  return out;
}

function effectiveConfigOptions(props, meta) {
  const options = [];
  function add(label, value, source, help, extra) {
    if (value === undefined || value === null || value === "") return;
    options.push(Object.assign({ label, value, source, help, key: label }, extra || {}));
  }
  add("model_path", props.model_path, "/props");
  add("model_alias", props.model_alias, "/props");
  add("total_slots", props.total_slots, "/props");
  add("n_ctx", props.n_ctx, "/props");
  add("n_ctx_train", props.n_ctx_train || meta.n_ctx_train, "/props / /v1/models");
  add("modalities", props.modalities && Object.keys(props.modalities).filter((k) => props.modalities[k]).join(", "), "/props");
  add("chat_template", props.chat_template ? props.chat_template.split("\n").slice(0, 3).join(" / ").slice(0, 220) : "", "/props");
  add("build_info", props.build_info, "/props");
  if (props.is_sleeping !== undefined) add("is_sleeping", props.is_sleeping, "/props");
  const cacheState = latestPromptCacheState();
  if (cacheState) {
    add("prompt_cache_limit_tokens", cacheState.cacheLimitTokens, "llama.cpp logs");
    add("prompt_cache_used_tokens_est", promptCacheUsedTokensEstimate(cacheState), "llama.cpp logs");
    add("prompt_cache_est_tokens", cacheState.cacheEstTokens, "llama.cpp logs");
    add("prompt_cache_limit_mib", cacheState.cacheLimitMiB, "llama.cpp logs");
    add("prompt_cache_used_mib", cacheState.cacheUsedMiB, "llama.cpp logs");
    add("prompt_cache_prompts", cacheState.cachePrompts, "llama.cpp logs");
  }
  const defaults = props.default_generation_settings || {};
  for (const key of Object.keys(defaults).sort()) {
    add(key, defaults[key], "request default", null, {
      displayLabel: key + " (default)",
      isDefault: true,
    });
  }
  return options;
}

/* ──────────────────────────────────────────────────────────────────────
 *  Server config card. Router shows the actual CLI args; single mode
 *  shows what /props exposes plus a clear note that args are not
 *  available from the server.
 * ──────────────────────────────────────────────────────────────────── */
function renderServerConfigCard() {
  const sec = $("#config-section");
  sec.innerHTML = "";
  const card = el("div", { class: "card full" }, [
    el("h2", null, t("config.title")),
  ]);
  sec.appendChild(card);

  if (state.mode === "router") {
    card.appendChild(el("div", { class: "sub" }, t("config.router_args")));
    if (!state.models.length) {
      card.appendChild(el("div", { class: "sub" }, t("models.no_models")));
      return;
    }
    const list = el("div", { class: "model-list" });
    for (const m of state.models) {
      const rawArgs = (m.status && Array.isArray(m.status.args)) ? m.status.args : [];
      const args = rawArgs.length ? rawArgs.join(" ") : "";
      const parsedOptions = parseLaunchArgs(rawArgs);
      const block = el("div", { class: "model-card" }, [
        el("div", { class: "name" }, m.id),
        parsedOptions.length ? configOptionGrid(parsedOptions) : null,
        args ? el("div", { class: "args-block" }, args)
             : el("div", { class: "sub" }, t("common.empty")),
        args ? el("div", { class: "row-actions" }, [
          el("button", {
            onclick: (e) => copyToClipboard(args, e.currentTarget),
          }, t("common.copy")),
        ]) : null,
      ].filter(Boolean));
      list.appendChild(block);
    }
    card.appendChild(list);
  } else {
    /* If /props never came back, don't fake an "effective config" with
     * default-derived booleans (e.g. is_sleeping=No is meaningless when
     * we never reached the server). */
    if (!state.props) {
      card.appendChild(el("div", { class: "sub" }, t("config.no_data")));
      return;
    }
    card.appendChild(el("div", { class: "sub" }, t("config.effective_subset")));
    const props = state.props;
    const meta = (state.v1models[0] && state.v1models[0].meta) || {};
    card.appendChild(configOptionGrid(effectiveConfigOptions(props, meta)));
    card.appendChild(el("div", { class: "sub warn",
      style: "color: var(--warn);"
    }, t("config.effective_note")));
  }
}

function renderLoraCard() {
  const sec = $("#lora-section");
  sec.innerHTML = "";
  const adapters = Array.isArray(state.loraAdapters) ? state.loraAdapters : [];
  const card = el("div", { class: "card full" }, [
    el("h2", null, t("lora.title")),
  ]);
  sec.appendChild(card);
  if (!adapters.length) {
    card.appendChild(el("div", { class: "sub" }, t("lora.empty")));
    return;
  }
  const tbl = el("div", { class: "kv-table" }, [
    el("div", { class: "k" }, t("lora.id")),
    el("div", { class: "k" }, t("lora.path")),
    el("div", { class: "k" }, t("lora.scale")),
  ]);
  /* shift to a 3-column layout */
  tbl.style.gridTemplateColumns = "max-content 1fr max-content";
  for (const a of adapters) {
    tbl.appendChild(el("div", { class: "v" }, String(a.id)));
    tbl.appendChild(el("div", { class: "v" }, String(a.path || "—")));
    tbl.appendChild(el("div", { class: "v" }, fmtParam(a.scale)));
  }
  card.appendChild(tbl);
}

/* ──────────────────────────────────────────────────────────────────────
 *  Router: switching active model. Updates URL (?model=) so the view
 *  is shareable, restarts pollers so subsequent GETs use the new model,
 *  and re-renders the model section.
 * ──────────────────────────────────────────────────────────────────── */
function onModelSelect(id) {
  state.selectedModel = id || null;
  const u = new URL(window.location.href);
  if (id) u.searchParams.set("model", id);
  else u.searchParams.delete("model");
  window.history.replaceState({}, "", u.toString());
  resetHistories();
  startCorePollers();
  renderModelsCard();
}

/* ──────────────────────────────────────────────────────────────────────
 *  Modal / confirmation.
 *  We never call window.confirm so we can show formatted body and avoid
 *  the browser-native dialog blocking the event loop.
 * ──────────────────────────────────────────────────────────────────── */
function showModal({ title, bodyNode, okLabel, onOk, mutating }) {
  const back = el("div", { class: "modal-backdrop", role: "dialog", "aria-modal": "true" });
  let onKey;
  const errorNode = el("div", { class: "error", hidden: true }, "");
  const close = () => {
    back.remove();
    if (onKey) document.removeEventListener("keydown", onKey);
  };
  const ok = el("button", { class: "primary", onclick: async () => {
    ok.disabled = true;
    errorNode.hidden = true;
    try {
      await onOk();
      close();
    } catch (e) {
      errorNode.textContent = e && e.message ? e.message : String(e);
      errorNode.hidden = false;
      ok.disabled = false;
    }
  }}, okLabel || t("common.confirm"));
  const cancel = el("button", { onclick: close }, t("common.cancel"));
  /* mutating modals get a "this changes server state" warning; informational
   * modals (like the log help dialog) skip it. */
  const warnNode = mutating
    ? el("div", { class: "warn" }, "⚠ " + t(state.mode === "router"
        ? "modal.warn_router" : "modal.warn_server"))
    : null;
  const m = el("div", { class: "modal" }, [
    el("h3", null, title),
    el("div", { class: "body" }, bodyNode),
    warnNode,
    errorNode,
    el("div", { class: "actions" }, [cancel, ok]),
  ].filter(Boolean));
  back.appendChild(m);
  back.addEventListener("click", (e) => { if (e.target === back) close(); });
  document.body.appendChild(back);
  /* Esc closes — listen on document so focus position doesn't matter */
  onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  ok.focus();
}

function confirmAction(message, onOk) {
  showModal({
    title: t("common.confirm"),
    bodyNode: el("div", null, message),
    mutating: true,
    onOk,
  });
}

async function openSettingsModal() {
  const body = el("div", { class: "settings-form" }, t("common.loading"));
  let loaded = null;
  const fields = {};

  const render = (settings) => {
    loaded = settings || {};
    body.innerHTML = "";
    fields.server = el("input", { type: "url", value: loaded.server || "", placeholder: "http://127.0.0.1:8080" });
    fields.logPath = el("input", { type: "text", value: loaded.logPath || "", placeholder: "/path/to/llama.cpp.log" });
    fields.poll = el("input", { type: "number", min: "200", max: "60000", step: "50", value: String(loaded.pollIntervalMs || 1000) });
    fields.timeout = el("input", { type: "number", min: "250", max: "120000", step: "250", value: String(loaded.timeoutMs || 5000) });
    body.append(
      el("label", null, [t("settings.server"), fields.server]),
      el("label", null, [t("settings.log_path"), fields.logPath]),
      el("label", null, [t("settings.poll"), fields.poll]),
      el("label", null, [t("settings.timeout"), fields.timeout]),
      el("div", { class: "readonly" }, [
        el("div", { class: "k" }, t("settings.listen")),
        el("div", null, (loaded.listen || "—") + " · " + t("settings.startup_only")),
        el("div", { class: "k" }, t("settings.raw_proxy")),
        el("div", null, (loaded.rawProxy ? t("common.enabled") : t("common.disabled")) + " · " + t("settings.startup_only")),
      ]),
      el("div", { class: "sub" }, t("settings.note"))
    );
  };

  showModal({
    title: t("settings.title"),
    bodyNode: body,
    okLabel: t("settings.save"),
    mutating: true,
    onOk: async () => {
      if (!loaded) throw new Error(t("common.loading"));
      const payload = {
        server: fields.server.value.trim(),
        logPath: fields.logPath.value.trim(),
        pollIntervalMs: clampInt(fields.poll.value, loaded.pollIntervalMs || 1000, 200, 60000),
        timeoutMs: clampInt(fields.timeout.value, loaded.timeoutMs || 5000, 250, 120000),
      };
      const saved = await fetchJSON("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        withModel: false,
        timeout: 8000,
      });
      state.params.poll = saved.pollIntervalMs || payload.pollIntervalMs;
      $("#server-display").textContent = saved.server || payload.server;
      $("#server-display").title = saved.server || payload.server;
      showBanner("settings-saved", t("settings.saved"), "warn");
      setTimeout(() => clearBanner("settings-saved"), 2500);
      await refreshSnapshot({ timeout: 8000 });
      startCorePollers();
    },
  });

  try {
    render(await fetchJSON("/api/settings", { withModel: false, timeout: 8000 }));
  } catch (e) {
    body.textContent = t("error.fetch_failed") + ": /api/settings — " + e.message;
  }
}

async function copyToClipboard(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    if (btn) {
      const old = btn.textContent;
      btn.textContent = t("common.copied");
      setTimeout(() => { btn.textContent = old; }, 1200);
    }
  } catch (e) {
    showBanner("clipboard", e.message || "clipboard error", "warn");
  }
}

/* ──────────────────────────────────────────────────────────────────────
 *  POST handlers
 * ──────────────────────────────────────────────────────────────────── */
async function callLoadOrUnload(path, modelId, kind) {
  try {
    await fetchJSON(path, {
      method: "POST",
      withModel: false,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: modelId }),
      timeout: 60_000,
    });
    /* refresh /models so status updates */
    refreshRouterModels();
  } catch (e) {
    showBanner("post-" + kind, kind + ": " + e.message);
  }
}

async function refreshRouterModels() {
  if (state.mode !== "router") return;
  try {
    await refreshSnapshot({ timeout: 6000 });
  } catch (e) {
    showBanner("models-refresh", "/api/snapshot: " + e.message, "warn");
  }
}

/* Real slot action (replaces the Phase 4 stub). */
async function slotAction(id, action) {
  const confirmKey = "slots.confirm." + action;
  const message = t(confirmKey, { id });
  const fileNode = el("div", null, [
    el("div", null, message),
    action !== "erase" ? el("div", { style: "margin-top: 8px;" }, [
      "filename: ",
      el("input", { id: "slot-fname", value: "slot_" + id + ".bin",
                    style: "min-width: 200px;" }),
    ]) : null,
  ].filter(Boolean));
  showModal({
    title: t("common.confirm"),
    bodyNode: fileNode,
    onOk: async () => {
      const body = action === "erase" ? null : JSON.stringify({
        filename: ($("#slot-fname") && $("#slot-fname").value) || ("slot_" + id + ".bin"),
      });
      try {
        await fetchJSON("/api/slots/" + id + "/" + action, {
          method: "POST",
          withModel: false,
          headers: action === "erase" ? {} : { "Content-Type": "application/json" },
          body,
          timeout: 30_000,
        });
      } catch (e) {
        showBanner("slot-" + action, "slot " + id + " " + action + ": " + e.message);
      }
    },
  });
}

/* ──────────────────────────────────────────────────────────────────────
 *  Guidance rendering. Suggestions are produced by the Go backend and
 *  carried in /api/snapshot; the browser only renders them.
 * ──────────────────────────────────────────────────────────────────── */
function evaluateGuidance() {
  return Array.isArray(state.suggestions) ? state.suggestions : [];
}

function renderGuidance() {
  const sec = $("#guidance-section");
  if (!sec) return;
  if (sec.dataset.built !== "1") {
    sec.dataset.built = "1";
    sec.innerHTML = "";
    sec.appendChild(el("div", { class: "card full" }, [
      el("h2", null, t("guidance.title")),
      el("div", { class: "guidance-list", id: "guidance-list" }),
    ]));
  }
  const list = $("#guidance-list");
  const suggestions = evaluateGuidance();
  list.innerHTML = "";
  if (!suggestions.length) {
    /* "No suggestions" can mean two very different things:
     *   1. Server is reachable and looks healthy → keep the existing copy.
     *   2. We can't reach the server at all → stop pretending it's healthy.
     * Distinguish by whether anything came back. */
    const noData = !state.props && !state.metrics
                   && (!state.slots || !state.slots.length);
    list.appendChild(el("div", { class: "sub" },
      t(noData ? "guidance.no_data" : "guidance.empty")));
    return;
  }
  for (const s of suggestions) {
    const item = el("div", { class: "suggestion severity-" + s.severity }, [
      el("div", { class: "head" }, [
        el("span", { class: "sev-badge " + s.severity },
          t("guidance.severity." + s.severity)),
        el("span", null, s.title),
        s.context && s.context.value
          ? el("span", { class: "sub" }, "— " + s.context.value)
          : null,
      ].filter(Boolean)),
      el("div", { class: "body" }, [
        el("div", null, s.explain),
        el("div", { style: "margin-top: 4px;" }, [
          el("strong", null, "→ "),
          s.suggest,
        ]),
      ]),
    ]);
    list.appendChild(item);
  }
}

/* Re-evaluate guidance whenever the data that feeds it changes. */
function bumpGuidance() {
  /* Throttle so a fast metrics poll doesn't spam re-render. */
  if (bumpGuidance._t) return;
  bumpGuidance._t = setTimeout(() => {
    bumpGuidance._t = null;
    renderGuidance();
  }, 250);
}

/* ──────────────────────────────────────────────────────────────────────
 *  Log tail (Phase 6). The browser reads a bounded JSON tail from
 *  /api/logs/tail. The backend only enables it when launched with --log.
 * ──────────────────────────────────────────────────────────────────── */
const LOG_TAIL_BYTES = 65536;
const LOG_MAX_LINES = 2000;
const logState = {
  url: null,
  enabled: false,
  totalSize: 0,
  lastModified: null,
  lines: [],
  follow: true,
  hideIdle: true,
  filter: "",
  cacheSignature: "",
};

async function detectLog() {
  try {
    const payload = await fetchJSON("/api/logs/tail?bytes=1&lines=1", {
      withModel: false,
      timeout: 4000,
    });
    logState.enabled = !!(payload && payload.enabled);
    logState.totalSize = payload && payload.size ? payload.size : 0;
    return logState.enabled;
  } catch (_e) { return false; }
}

async function fetchLogTail() {
  if (!logState.enabled) return null;
  const payload = await fetchJSON("/api/logs/tail?bytes=" + LOG_TAIL_BYTES + "&lines=" + LOG_MAX_LINES, {
    withModel: false,
    timeout: 8000,
  });
  if (!payload || !payload.enabled) return null;
  const marker = String(payload.updatedAt || "") + ":" + String(payload.size || 0);
  if (marker === logState.lastModified) return null;
  logState.lastModified = marker;
  logState.totalSize = payload.size || 0;
  return payload;
}

/* Minimal ANSI SGR renderer — color/bold codes only, anything else
 * is dropped. Returns a fragment of <span>s. */
function ansiToFragment(line) {
  const frag = document.createDocumentFragment();
  const parts = line.split(/\x1b\[([\d;]*)m/);
  /* parts: [text, code, text, code, text, ...] */
  let activeClasses = [];
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      if (!parts[i]) continue;
      if (activeClasses.length === 0) {
        frag.appendChild(document.createTextNode(parts[i]));
      } else {
        const span = document.createElement("span");
        span.className = activeClasses.join(" ");
        span.textContent = parts[i];
        frag.appendChild(span);
      }
    } else {
      const code = parts[i];
      if (code === "" || code === "0") {
        activeClasses = [];
        continue;
      }
      const codes = code.split(";").map((s) => parseInt(s, 10));
      for (const c of codes) {
        if (c === 0) activeClasses = [];
        else if (c === 1) activeClasses.push("ansi-bold");
        else if ((c >= 30 && c <= 37) || (c >= 90 && c <= 97)) {
          activeClasses = activeClasses.filter((cl) => !cl.match(/^ansi-\d/));
          activeClasses.push("ansi-" + c);
        }
      }
    }
  }
  return frag;
}

function renderLogLines(replace) {
  const view = $("#log-view");
  if (!view) return;
  if (replace) view.innerHTML = "";
  const start = replace ? 0 : view.childNodes.length;
  for (let i = start; i < logState.lines.length; i++) {
    const line = logState.lines[i];
    const ln = el("span", { class: "ln" });
    ln.appendChild(ansiToFragment(line));
    if (!shouldShowLogLine(line)) {
      ln.classList.add("hidden");
    }
    view.appendChild(ln);
  }
  if (logState.follow) view.scrollTop = view.scrollHeight;
}

function shouldShowLogLine(line) {
  const lower = String(line || "").toLowerCase();
  const filter = logState.filter.toLowerCase();
  if (logState.hideIdle && lower.includes("update_slots: all slots are idle")) return false;
  return !filter || lower.indexOf(filter) !== -1;
}

function refreshLogVisibility() {
  const view = $("#log-view");
  if (!view) return;
  for (let i = 0; i < logState.lines.length && i < view.childNodes.length; i++) {
    view.childNodes[i].classList.toggle("hidden", !shouldShowLogLine(logState.lines[i]));
  }
}

function selectionInsideLogView() {
  const view = $("#log-view");
  const sel = window.getSelection && window.getSelection();
  if (!view || !sel || sel.rangeCount === 0 || sel.isCollapsed) return false;
  for (let i = 0; i < sel.rangeCount; i++) {
    const range = sel.getRangeAt(i);
    if (view.contains(range.startContainer) || view.contains(range.endContainer)) return true;
  }
  return false;
}

function logTailOverlap(oldLines, newLines) {
  const max = Math.min(oldLines.length, newLines.length);
  for (let n = max; n > 0; n--) {
    let ok = true;
    for (let i = 0; i < n; i++) {
      if (oldLines[oldLines.length - n + i] !== newLines[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return n;
  }
  return 0;
}

function applyLogPayload(payload) {
  if (payload == null) return;
  let lines;
  let truncated = false;
  if (typeof payload === "string") {
    lines = payload.split(/\r?\n/);
  } else {
    lines = Array.isArray(payload.lines) ? payload.lines.slice() : [];
    truncated = !!payload.truncated;
  }
  /* Only byte-truncated tails need the first partial line removed. */
  if (truncated && lines.length > 1) lines.shift();
  /* trailing empty line from "...\n" */
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  lines = lines.slice(-LOG_MAX_LINES);

  const oldLines = logState.lines;
  const overlap = logTailOverlap(oldLines, lines);
  if (oldLines.length && overlap > 0) {
    const added = lines.slice(overlap);
    const merged = oldLines.concat(added);
    const view = $("#log-view");
    const removed = Math.max(0, merged.length - LOG_MAX_LINES);
    const selected = selectionInsideLogView();
    logState.lines = selected ? merged : merged.slice(-LOG_MAX_LINES);
    if (view && removed > 0 && !selected) {
      for (let i = 0; i < removed && view.firstChild; i++) view.removeChild(view.firstChild);
    }
    renderLogLines(false);
    refreshConfigForCacheState();
    return;
  }

  if (selectionInsideLogView()) {
    logState.lines = lines;
    refreshConfigForCacheState();
    return;
  }
  logState.lines = lines;
  renderLogLines(true);
  refreshConfigForCacheState();
}

function refreshConfigForCacheState() {
  const cacheState = latestPromptCacheState();
  const signature = cacheState
    ? [cacheState.cachePrompts, cacheState.cacheUsedMiB, cacheState.cacheLimitMiB, cacheState.cacheLimitTokens, cacheState.cacheEstTokens].join(":")
    : "";
  if (signature === logState.cacheSignature) return;
  logState.cacheSignature = signature;
  renderServerConfigCard();
}

function ensureLogSection() {
  const sec = $("#log-section");
  if (sec.dataset.built === "1") return;
  sec.dataset.built = "1";
  sec.innerHTML = "";
  if (!logState.enabled) return;
  const card = el("div", { class: "card full log-card" }, [
    el("h2", null, [
      t("log.title") + " ",
      el("button", { class: "info-btn", title: t("log.setup_help_title"),
                     onclick: () => showLogHelp() }, "ⓘ"),
    ]),
    el("div", { class: "log-toolbar" }, [
      el("label", null, [
        el("input", { type: "checkbox", id: "log-follow", checked: "checked",
                      onchange: () => { logState.follow = $("#log-follow").checked; }}),
        " " + t("log.follow"),
      ]),
      el("label", null, [
        el("input", { type: "checkbox", id: "log-hide-idle",
                      checked: logState.hideIdle ? "checked" : null,
                      onchange: () => { logState.hideIdle = $("#log-hide-idle").checked; refreshLogVisibility(); }}),
        " " + t("log.hide_idle"),
      ]),
      el("input", { type: "search", placeholder: t("log.search"),
                    oninput: (e) => { logState.filter = e.target.value; refreshLogVisibility(); }}),
      el("span", { class: "sub", id: "log-status" }, ""),
    ]),
    el("div", { class: "log-view", id: "log-view",
                onscroll: (e) => {
                  /* user scrolled away from bottom → stop autoscrolling */
                  const v = e.target;
                  const atBottom = (v.scrollTop + v.clientHeight + 4) >= v.scrollHeight;
                  if (!atBottom && logState.follow) {
                    logState.follow = false;
                    const cb = $("#log-follow"); if (cb) cb.checked = false;
                  }
                }}, t("log.empty")),
  ]);
  sec.appendChild(card);
}

function showLogHelp() {
  showModal({
    title: t("log.setup_help_title"),
    bodyNode: el("div", null, t("log.setup_help")),
    okLabel: t("common.close"),
    onOk: () => {},
  });
}

async function startLogPoller() {
  const ok = await detectLog();
  if (!ok) {
    logState.enabled = false;
    return;
  }
  ensureLogSection();
  /* immediate first fetch */
  try {
    const txt = await fetchLogTail();
    if (txt != null) applyLogPayload(txt);
  } catch (e) {
    showBanner("log-init", "log: " + e.message, "warn");
  }
  startPoller("log", 5000, async () => {
    const txt = await fetchLogTail();
    if (txt != null) applyLogPayload(txt);
  });
}

/* Secondary read-side polling is now owned by the backend snapshot. */
function startSecondaryPollers() {
}

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
 *  - opts: { min, max, height }
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
  return svg;
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
    metric: "nodrama:tokens_predicted_rate", unit: "tok/s", min: 0,
    help: "Live aggregate generation throughput derived by llama.nodrama from the change in llamacpp:tokens_predicted_total over the poll interval. If three slots each produce about 40 tok/s at the same time, this should trend near 120 tok/s." },
  { id: "prompt_tps",    titleKey: "metrics.prompt_tps",
    metric: "nodrama:prompt_tokens_rate",    unit: "tok/s", min: 0,
    help: "Live aggregate prompt-processing throughput derived by llama.nodrama from the change in llamacpp:prompt_tokens_total over the poll interval. It is a current server-wide rate, not a per-slot average." },
  { id: "processing",    titleKey: "metrics.processing",
    metric: "llamacpp:requests_processing",      unit: "",      min: 0,
    help: "Number of requests currently being processed by llama.cpp. This should roughly track active slots." },
  { id: "deferred",      titleKey: "metrics.deferred",
    metric: "llamacpp:requests_deferred",        unit: "",      min: 0,
    warnAt: 1, badAt: 5,
    help: "Number of requests waiting because no slot is currently available. Sustained values > 0 indicate queueing latency." },
  { id: "busy_slots",    titleKey: "metrics.busy_slots",
    metric: "llamacpp:n_busy_slots_per_decode",  unit: "",      min: 0,
    help: "llama.cpp's average number of slots included in decode batches. It helps show batching efficiency/parallelism: near 1 means mostly single-slot decode; higher values mean decode calls often batch work from several slots. It is not the exact current busy-slot count." },
  { id: "context_used", titleKey: "metrics.context_used",
    metric: "nodrama:context_active_tokens", unit: "tok", min: 0, contextUsed: true,
    capacityMetric: "nodrama:context_active_capacity_tokens",
    ratioMetric: "nodrama:context_active_ratio",
    warnRatio: 0.80, badRatio: 0.90, peakNote: true,
    help: "Active slot context estimate. llama.nodrama sums context currently used by active slots and compares it with the server context capacity from cache-state startup/log data when available, otherwise visible slot capacity. Cached idle prompts are not counted as active slot context." },
  { id: "n_tokens_max",  titleKey: "metrics.n_tokens_max",
    metric: "llamacpp:n_tokens_max",             unit: "tok",   min: 0,
    peakNote: true,
    help: "Raw llama.cpp metric. Largest token batch/working set observed by llama.cpp decode metrics since server start. The timestamp shown is when llama.nodrama first observed the current peak, not necessarily the exact internal llama.cpp moment." },
  { id: "prompt_total",  titleKey: "metrics.prompt_total",
    metric: "llamacpp:prompt_tokens_total",      unit: "tok",   min: 0, cumulative: true,
    help: "Cumulative number of prompt tokens processed since the llama.cpp server started." },
  { id: "predicted_total", titleKey: "metrics.predicted_total",
    metric: "llamacpp:tokens_predicted_total",   unit: "tok",   min: 0, cumulative: true,
    help: "Cumulative number of generated output tokens since the llama.cpp server started." },
  { id: "decode_total", titleKey: "metrics.decode_total",
    metric: "llamacpp:n_decode_total",           unit: "",      min: 0, cumulative: true,
    help: "Raw llama.cpp counter. Cumulative calls into llama_decode(). One decode call can process prompt tokens, generated tokens, and sometimes batched work from multiple slots, so it is a workload/batching counter rather than a request count." },
  { id: "prompt_seconds_total", titleKey: "metrics.prompt_seconds_total",
    metric: "llamacpp:prompt_seconds_total",     unit: "",     min: 0, cumulative: true, duration: true,
    help: "Cumulative wall time spent processing prompts since server start." },
  { id: "predicted_seconds_total", titleKey: "metrics.predicted_seconds_total",
    metric: "llamacpp:tokens_predicted_seconds_total", unit: "", min: 0, cumulative: true, duration: true,
    help: "Cumulative wall time spent generating output tokens since server start." },
];

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

function ensureMetricCards() {
  const sec = $("#metrics-section");
  if (sec.dataset.built === "1") return;
  sec.dataset.built = "1";
  sec.innerHTML = "";
  for (const c of METRIC_CARDS) {
    const card = el("div", { class: "card metric-card", id: "metric-" + c.id }, [
      el("div", { class: "metric-title" }, [
        el("h2", null, t(c.titleKey)),
        el("button", {
          class: "info-btn",
          type: "button",
          title: c.help,
          "aria-label": t(c.titleKey) + ": " + c.help,
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
    bodyNode: el("div", null, card.help),
    okLabel: t("common.close"),
    onOk: () => {},
  });
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
      note.textContent = c.contextUsed && capacity > 0
        ? (fmtNumber(ratio, { percent: true }) + "% · " +
           (fact && fact.peakAt ? "peak " + fmtTokensCompact(fact.peakValue) + " at " + fmtTime(fact.peakAt) : "peak —"))
        : c.peakNote && fact && fact.peakAt
        ? ("peak " + fmtNumber(fact.peakValue) + " at " + fmtTime(fact.peakAt))
        : "";
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
    }));
  }
  state.metrics = parsed;
  state.lastUpdate = Date.now();
  bumpGuidance();
}

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

  /* slot KV actions placeholder — Phase 5 wires the POST handlers. */
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

/* slotAction is defined in Phase 5 (confirm + POST). */

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
 *  Polish (Phase 9): keyboard shortcuts, last-update ticker.
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

/* ──────────────────────────────────────────────────────────────────────
 *  Chat panel — calls POST /api/chat/completions with streaming SSE.
 *
 *  Design notes:
 *  - History lives only in this module's `chat` state object. There is
 *    no localStorage by project rule, so reloads wipe the conversation.
 *  - The markdown renderer below builds DOM directly (createElement +
 *    textContent). User and server text are NEVER inserted via
 *    innerHTML — every visible string goes through textContent.
 *  - Streaming uses fetch + ReadableStream; AbortController lets the
 *    user cancel a generation mid-flight.
 * ──────────────────────────────────────────────────────────────────── */
const CHAT_HISTORY_MAX_TURNS = 40;   /* cap to bound payload + memory */
const chat = {
  open: false,
  messages: [],          /* {role, content, stats?} */
  systemPrompt: "",
  inflight: null,        /* AbortController */
  params: {
    temperature: 0.7,
    top_p: 0.95,
    max_tokens: 512,
    fanout: 1,
    thinking: "auto",
    keepThinking: false,
    cachePrompt: true,
    slot: -1,
  },
};

/* Keep the most recent turns. A turn is one user + one assistant message,
 * so we cap at 2 * CHAT_HISTORY_MAX_TURNS entries. Drop from the front so
 * the assistant still sees the most recent context. */
function trimChatHistory() {
  const cap = CHAT_HISTORY_MAX_TURNS * 2;
  if (chat.messages.length > cap) {
    chat.messages.splice(0, chat.messages.length - cap);
  }
}

function chatMaxTokenLimit() {
  const props = state.props || {};
  const defaults = props.default_generation_settings || {};
  const contextLimit = num(props.n_ctx, 0);
  const defaultPredict = num(defaults.n_predict !== undefined ? defaults.n_predict : defaults.max_tokens, 0);
  const limit = Math.max(4096, contextLimit, defaultPredict, chat.params.max_tokens || 0);
  return Math.min(Math.max(limit, 4096), 1048576);
}

function updateChatTokenSlider() {
  const range = $("#chat-p-max");
  const value = $("#chat-p-max-v");
  if (!range || !value) return;
  const max = chatMaxTokenLimit();
  if (String(max) !== range.max) range.max = String(max);
  if ((chat.params.max_tokens || 0) > max) {
    chat.params.max_tokens = max;
    range.value = String(max);
  }
  value.textContent = String(Math.round(chat.params.max_tokens || Number(range.value) || 0));
}

function updateChatSlotOptions() {
  const select = $("#chat-slot");
  if (!select) return;
  const current = String(chat.params.slot);
  const options = [el("option", { value: "-1" }, t("chat.slot_auto"))];
  for (const slot of state.slots) {
    options.push(el("option", { value: String(slot.id) }, "slot " + slot.id));
  }
  select.innerHTML = "";
  for (const option of options) select.appendChild(option);
  const stillExists = Array.from(select.options).some((option) => option.value === current);
  if (stillExists) {
    select.value = current;
  } else {
    chat.params.slot = -1;
    select.value = "-1";
  }
}

function chatHistoryContent(message) {
  if (!message || message.role !== "assistant") return message ? message.content : "";
  if (!chat.params.keepThinking || !message.reasoning) return message.content || "";
  const content = message.content || "";
  const reasoning = message.reasoning || "";
  return "<think>\n" + reasoning + "\n</think>" + (content ? "\n\n" + content : "");
}

/* ── Markdown → DOM renderer ────────────────────────────────────────── */
/* Block grammar handled: ATX headings, fenced code, GFM tables, lists
 * (-, *, +, 1.), blockquotes, horizontal rules, paragraphs.
 * Inline grammar: code spans, bold, italic, links (http(s) only). */
function renderMarkdown(src) {
  const frag = document.createDocumentFragment();
  const lines = String(src).split(/\r?\n/);
  let i = 0;

  const isHr = (l) => /^ {0,3}([-*_])(\s*\1){2,}\s*$/.test(l);
  const isBlank = (l) => /^\s*$/.test(l);

  while (i < lines.length) {
    let line = lines[i];

    /* skip blanks */
    if (isBlank(line)) { i++; continue; }

    /* fenced code block */
    let m = line.match(/^ {0,3}(```|~~~)(.*)$/);
    if (m) {
      const fence = m[1];
      const lang = m[2].trim();
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].startsWith(fence)) {
        buf.push(lines[i]); i++;
      }
      if (i < lines.length) i++; /* skip closing fence */
      const pre = el("pre");
      const code = el("code", lang ? { class: "lang-" + lang.replace(/[^\w-]/g, "") } : null);
      code.textContent = buf.join("\n");
      pre.appendChild(code);
      frag.appendChild(pre);
      continue;
    }

    /* horizontal rule */
    if (isHr(line)) { frag.appendChild(el("hr")); i++; continue; }

    /* ATX heading */
    m = line.match(/^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (m) {
      const h = el("h" + m[1].length);
      renderInlineInto(m[2], h);
      frag.appendChild(h);
      i++;
      continue;
    }

    /* table — needs a delimiter row immediately after a pipe-row */
    if (line.includes("|") && i + 1 < lines.length &&
        /^ {0,3}\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(lines[i + 1])) {
      const headers = splitTableRow(line);
      const aligns = splitTableRow(lines[i + 1]).map((c) => {
        const left = /^:/.test(c.trim()), right = /:$/.test(c.trim());
        if (left && right) return "center";
        if (right) return "right";
        if (left) return "left";
        return null;
      });
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes("|") && !isBlank(lines[i])) {
        rows.push(splitTableRow(lines[i]));
        i++;
      }
      const table = el("table");
      const thead = el("thead");
      const trh = el("tr");
      headers.forEach((h, idx) => {
        const th = el("th", aligns[idx] ? { style: "text-align:" + aligns[idx] } : null);
        renderInlineInto(h, th);
        trh.appendChild(th);
      });
      thead.appendChild(trh); table.appendChild(thead);
      const tbody = el("tbody");
      for (const r of rows) {
        const tr = el("tr");
        for (let idx = 0; idx < headers.length; idx++) {
          const td = el("td", aligns[idx] ? { style: "text-align:" + aligns[idx] } : null);
          renderInlineInto(r[idx] || "", td);
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      frag.appendChild(table);
      continue;
    }

    /* blockquote */
    if (/^ {0,3}>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^ {0,3}>/.test(lines[i])) {
        buf.push(lines[i].replace(/^ {0,3}>\s?/, ""));
        i++;
      }
      const bq = el("blockquote");
      const inner = renderMarkdown(buf.join("\n"));
      bq.appendChild(inner);
      frag.appendChild(bq);
      continue;
    }

    /* list */
    const liMatch = line.match(/^ {0,3}([-*+]|\d+\.)\s+(.*)$/);
    if (liMatch) {
      const ordered = /\d+\./.test(liMatch[1]);
      const list = el(ordered ? "ol" : "ul");
      while (i < lines.length) {
        const lm = lines[i].match(/^ {0,3}([-*+]|\d+\.)\s+(.*)$/);
        if (!lm) break;
        const buf = [lm[2]];
        i++;
        while (i < lines.length &&
               !isBlank(lines[i]) &&
               !/^ {0,3}([-*+]|\d+\.)\s+/.test(lines[i]) &&
               !/^ {0,3}#{1,6}\s/.test(lines[i]) &&
               !/^ {0,3}(```|~~~)/.test(lines[i])) {
          buf.push(lines[i].replace(/^ {1,4}/, ""));
          i++;
        }
        const li = el("li");
        renderInlineInto(buf.join(" "), li);
        list.appendChild(li);
        if (i < lines.length && isBlank(lines[i])) { i++; break; }
      }
      frag.appendChild(list);
      continue;
    }

    /* paragraph — gather contiguous non-blank, non-block lines */
    const buf = [line];
    i++;
    while (i < lines.length && !isBlank(lines[i]) &&
           !/^ {0,3}#{1,6}\s/.test(lines[i]) &&
           !/^ {0,3}(```|~~~)/.test(lines[i]) &&
           !/^ {0,3}>/.test(lines[i]) &&
           !/^ {0,3}([-*+]|\d+\.)\s+/.test(lines[i]) &&
           !isHr(lines[i])) {
      buf.push(lines[i]); i++;
    }
    const p = el("p");
    renderInlineInto(buf.join("\n"), p);
    frag.appendChild(p);
  }

  return frag;
}

function splitTableRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|"))  s = s.slice(0, -1);
  /* split on unescaped pipes */
  const out = []; let cur = "";
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (c === "\\" && s[k + 1] === "|") { cur += "|"; k++; continue; }
    if (c === "|") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim());
}

/* Tokenize-and-render inline markdown into `target`. We walk the string
 * with a small state machine — never use innerHTML. Order matters:
 * code spans win first (their contents are literal). */
function renderInlineInto(src, target) {
  let i = 0; const n = src.length;
  while (i < n) {
    const c = src[i];
    /* inline code */
    if (c === "`") {
      const end = src.indexOf("`", i + 1);
      if (end !== -1) {
        const code = el("code");
        code.textContent = src.slice(i + 1, end);
        target.appendChild(code);
        i = end + 1; continue;
      }
    }
    /* bold ** ** */
    if (c === "*" && src[i + 1] === "*") {
      const end = src.indexOf("**", i + 2);
      if (end !== -1) {
        const strong = el("strong");
        renderInlineInto(src.slice(i + 2, end), strong);
        target.appendChild(strong);
        i = end + 2; continue;
      }
    }
    /* italic * * or _ _ */
    if ((c === "*" || c === "_") && src[i + 1] !== c) {
      const end = src.indexOf(c, i + 1);
      if (end !== -1 && /\S/.test(src.slice(i + 1, end))) {
        const em = el("em");
        renderInlineInto(src.slice(i + 1, end), em);
        target.appendChild(em);
        i = end + 1; continue;
      }
    }
    /* link [text](url) — only http(s) URLs are honored, others dropped to text */
    if (c === "[") {
      const close = src.indexOf("]", i + 1);
      if (close !== -1 && src[close + 1] === "(") {
        const paren = src.indexOf(")", close + 2);
        if (paren !== -1) {
          const url = src.slice(close + 2, paren).trim();
          const safe = /^https?:\/\//i.test(url);
          if (safe) {
            const a = el("a", { href: url, target: "_blank", rel: "noopener noreferrer" });
            renderInlineInto(src.slice(i + 1, close), a);
            target.appendChild(a);
            i = paren + 1; continue;
          }
        }
      }
    }
    /* line break (two trailing spaces + \n) */
    if (c === "\n") {
      target.appendChild(document.createTextNode("\n"));
      i++; continue;
    }
    /* plain text run — find next markdown trigger */
    const next = nextInlineTrigger(src, i);
    target.appendChild(document.createTextNode(src.slice(i, next)));
    i = next;
  }
}

function nextInlineTrigger(src, from) {
  for (let k = from + 1; k < src.length; k++) {
    const c = src[k];
    if (c === "`" || c === "*" || c === "_" || c === "[" || c === "\n") return k;
  }
  return src.length;
}

/* ── Chat panel rendering ──────────────────────────────────────────── */
function renderChatPanel() {
  const sec = $("#chat-section");
  if (!sec) return;
  /* Build once; later updates touch only message list */
  if (sec.dataset.built === "1") return;
  sec.dataset.built = "1";

  const head = el("div", { class: "chat-head", role: "button",
                            "aria-expanded": String(chat.open),
                            onclick: toggleChat,
                            onkeydown: (e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault(); toggleChat();
                              }
                            },
                            tabindex: "0" }, [
    el("h2", null, t("chat.title")),
    el("span", { class: "pill", id: "chat-toggle-pill" },
       chat.open ? t("chat.collapse") : t("chat.expand")),
    el("span", { class: "grow" }),
    el("span", { class: "chat-typing", id: "chat-stats" }, ""),
  ]);

  const msgs = el("div", { class: "chat-msgs", id: "chat-msgs", role: "log",
                            "aria-live": "polite",
                            onwheel: handleChatWheel });
  if (chat.params && state.params.prompt) {
    /* honor ?prompt= by prefilling input — no auto-send to avoid surprises */
  }
  msgs.appendChild(el("div", { class: "chat-empty", id: "chat-empty" },
                       t("chat.empty")));

  const ta = el("textarea", {
    id: "chat-input",
    placeholder: t("chat.placeholder"),
    rows: "1",
    "aria-label": t("chat.placeholder"),
    onkeydown: (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault(); sendChat();
      }
    },
    oninput: (e) => {
      const tEl = e.target;
      tEl.style.height = "auto";
      tEl.style.height = Math.min(tEl.scrollHeight, 200) + "px";
    },
  });
  if (state.params.prompt) ta.value = state.params.prompt;

  const sendBtn = el("button", { id: "chat-send", class: "primary",
                                  onclick: sendChat,
                                  "aria-label": t("chat.send") },
                     t("chat.send"));
  const stopBtn = el("button", { id: "chat-stop", class: "danger",
                                  onclick: stopChat,
                                  "aria-label": t("chat.stop"),
                                  hidden: true },
                     t("chat.stop"));
  const inputRow = el("div", { class: "chat-input-row", id: "chat-input-row",
                                hidden: !chat.open },
                      [ta, sendBtn, stopBtn]);

  const main = el("div", { class: "chat-main" }, [msgs, inputRow]);

  /* Side panel — params */
  const sysTa = el("textarea", { id: "chat-system",
                                  placeholder: t("chat.system_placeholder"),
                                  rows: "3",
                                  oninput: (e) => { chat.systemPrompt = e.target.value; } });
  const thinkingMode = el("select", {
    id: "chat-thinking-mode",
    onchange: (e) => { chat.params.thinking = e.target.value; },
  }, [
    el("option", { value: "auto" }, t("chat.thinking_auto")),
    el("option", { value: "think" }, t("chat.thinking_on")),
    el("option", { value: "no_think" }, t("chat.thinking_off")),
  ]);
  thinkingMode.value = chat.params.thinking;
  const cachePrompt = el("input", {
    type: "checkbox",
    id: "chat-cache-prompt",
    checked: chat.params.cachePrompt ? "checked" : null,
    onchange: (e) => { chat.params.cachePrompt = !!e.target.checked; },
  });
  const keepThinking = el("input", {
    type: "checkbox",
    id: "chat-keep-thinking",
    checked: chat.params.keepThinking ? "checked" : null,
    onchange: (e) => { chat.params.keepThinking = !!e.target.checked; },
  });
  const slotSelect = el("select", {
    id: "chat-slot",
    onchange: (e) => { chat.params.slot = parseInt(e.target.value, 10); },
  }, [
    el("option", { value: "-1" }, t("chat.slot_auto")),
    ...state.slots.map((s) => el("option", { value: String(s.id) }, "slot " + s.id)),
  ]);
  slotSelect.value = String(chat.params.slot);
  const tempRange = paramSlider("chat-p-temp", "chat.temperature",
                                 chat.params.temperature, 0, 2, 0.05,
                                 (v) => chat.params.temperature = v);
  const topPRange = paramSlider("chat-p-topp", "chat.top_p",
                                 chat.params.top_p, 0, 1, 0.01,
                                 (v) => chat.params.top_p = v);
  const maxTok    = paramSlider("chat-p-max", "chat.max_tokens",
                                 chat.params.max_tokens, 16, chatMaxTokenLimit(), 16,
                                 (v) => chat.params.max_tokens = v);
  const fanout    = paramSlider("chat-p-fanout", "chat.fanout",
                                 chat.params.fanout, 1, 8, 1,
                                 (v) => chat.params.fanout = v);
  const clearBtn  = el("button", { onclick: clearChat }, t("chat.clear"));

  const side = el("div", { class: "chat-side", id: "chat-side", hidden: !chat.open }, [
    el("label", null, [t("chat.system_prompt"), sysTa]),
    el("label", null, [t("chat.thinking_mode"), thinkingMode]),
    el("label", null, [t("chat.slot"), slotSelect]),
    el("label", null, [cachePrompt, " " + t("chat.cache_prompt")]),
    el("label", null, [keepThinking, " " + t("chat.keep_thinking")]),
    tempRange, topPRange, maxTok, fanout,
    clearBtn,
  ]);

  const body = el("div", { class: "chat-body", id: "chat-body", hidden: !chat.open },
                  [main, side]);
  /* `.full` makes the card span the main grid (grid-column: 1 / -1).
   * Without it the card becomes one column and the inner 1fr 280px
   * chat body collapses (message column ~120px, code blocks clipped). */
  const card = el("div", { class: "card full chat-card" }, [head, body]);
  sec.innerHTML = "";
  sec.appendChild(card);

  /* sync open state */
  applyChatOpenState();
}

function paramSlider(id, labelKey, initial, min, max, step, onChange) {
  const normalized = Math.max(min, Math.min(max, initial));
  if (normalized !== initial) onChange(normalized);
  const valSpan = el("span", { class: "v", id: id + "-v" }, step >= 1 ? String(Math.round(normalized)) : normalized.toFixed(2));
  const range = el("input", {
    type: "range", id: id, min: String(min), max: String(max),
    step: String(step), value: String(normalized),
    oninput: (e) => {
      const v = parseFloat(e.target.value);
      onChange(v);
      valSpan.textContent = step >= 1 ? String(Math.round(v)) : v.toFixed(2);
    },
  });
  return el("label", null, [
    t(labelKey),
    el("div", { class: "row" }, [range, valSpan]),
  ]);
}

function toggleChat() {
  chat.open = !chat.open;
  applyChatOpenState();
}

function applyChatOpenState() {
  const body = $("#chat-body");
  const inputRow = $("#chat-input-row");
  const side = $("#chat-side");
  const pill = $("#chat-toggle-pill");
  const head = $(".chat-head");
  if (body) body.hidden = !chat.open;
  if (inputRow) inputRow.hidden = !chat.open;
  if (side) side.hidden = !chat.open;
  if (pill) pill.textContent = chat.open ? t("chat.collapse") : t("chat.expand");
  if (head) head.setAttribute("aria-expanded", String(chat.open));
  if (chat.open) {
    const ta = $("#chat-input");
    if (ta) ta.focus();
  }
}

function clearChat() {
  if (chat.inflight) return;  /* refuse while a request is in flight */
  chat.messages = [];
  const msgs = $("#chat-msgs");
  if (msgs) {
    while (msgs.firstChild) msgs.removeChild(msgs.firstChild);
    msgs.appendChild(el("div", { class: "chat-empty", id: "chat-empty" },
                         t("chat.empty")));
  }
}

function appendChatMessage(role, content, opts) {
  const empty = $("#chat-empty");
  if (empty) empty.remove();
  const msgs = $("#chat-msgs");
  if (!msgs) return null;
  const body = el("div", { class: "body" });
  body.appendChild(renderMarkdown(content || ""));
  const stats = el("div", { class: "stats" }, opts && opts.stats ? opts.stats : "");
  const label = role === "user" ? t("chat.you") : (role === "thinking" ? t("chat.thinking") : t("chat.assistant"));
  const node = el("div", { class: "chat-msg " + role },
                  [el("span", { class: "who" }, label),
                   body, stats]);
  msgs.appendChild(node);
  msgs.scrollTop = msgs.scrollHeight;
  return { body, stats, node };
}

function appendAssistantTarget(opts) {
  const thinking = appendChatMessage("thinking", "", { stats: "" });
  if (thinking && thinking.node) thinking.node.hidden = true;
  const assistant = appendChatMessage("assistant", "", opts);
  if (!assistant) return null;
  return {
    body: assistant.body,
    stats: assistant.stats,
    node: assistant.node,
    thinkingBody: thinking ? thinking.body : null,
    thinkingNode: thinking ? thinking.node : null,
  };
}

function updateMarkdownBody(body, content) {
  if (!body) return;
  while (body.firstChild) body.removeChild(body.firstChild);
  body.appendChild(renderMarkdown(content || ""));
}

function scrollChatIfNearBottom() {
  const msgs = $("#chat-msgs");
  if (msgs && (msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight) < 80) {
    msgs.scrollTop = msgs.scrollHeight;
  }
}

function handleChatWheel(e) {
  const node = e.currentTarget;
  if (!node) return;
  const atTop = node.scrollTop <= 0;
  const atBottom = Math.ceil(node.scrollTop + node.clientHeight) >= node.scrollHeight;
  const wantsUp = e.deltaY < 0;
  const wantsDown = e.deltaY > 0;
  if ((wantsUp && atTop) || (wantsDown && atBottom)) {
    e.preventDefault();
    window.scrollBy({ top: e.deltaY, left: 0, behavior: "auto" });
  }
}

function applyThinkingMode(payload, mode) {
  if (mode === "think") {
    payload.chat_template_kwargs = { enable_thinking: true };
  } else if (mode === "no_think") {
    payload.chat_template_kwargs = { enable_thinking: false };
  }
}

function setChatStats(s) {
  const node = $("#chat-stats");
  if (node) node.textContent = s || "";
}

function setSendingUI(sending) {
  const send = $("#chat-send");
  const stop = $("#chat-stop");
  const ta   = $("#chat-input");
  if (send) send.hidden = !!sending;
  if (stop) stop.hidden = !sending;
  if (ta) ta.disabled = !!sending;
}

async function sendChat() {
  if (chat.inflight) return;
  const ta = $("#chat-input");
  const text = ta ? ta.value.trim() : "";
  if (!text) return;
  ta.value = ""; ta.style.height = "auto";

  /* push user message */
  chat.messages.push({ role: "user", content: text });
  trimChatHistory();
  appendChatMessage("user", text);

  /* fan-out N parallel requests for stress test mode */
  const n = Math.max(1, Math.min(8, chat.params.fanout | 0));
  const targets = [];
  for (let k = 0; k < n; k++) {
    targets.push(appendAssistantTarget(
      { stats: n > 1 ? "#" + (k + 1) + "/" + n + " — …" : "…" }));
  }

  /* assemble messages payload — system prompt only if non-empty */
  const payload = {
    model: state.selectedModel
      || (state.models[0] && state.models[0].id)
      || (state.v1models[0] && state.v1models[0].id)
      || "default",
    messages: [],
    stream: true,
    temperature: chat.params.temperature,
    top_p: chat.params.top_p,
    max_tokens: chat.params.max_tokens | 0,
    cache_prompt: !!chat.params.cachePrompt,
  };
  if ((chat.params.slot | 0) >= 0) {
    payload.id_slot = chat.params.slot | 0;
  }
  if (chat.systemPrompt && chat.systemPrompt.trim()) {
    payload.messages.push({ role: "system", content: chat.systemPrompt.trim() });
  }
  for (const m of chat.messages) payload.messages.push({ role: m.role, content: chatHistoryContent(m) });
  applyThinkingMode(payload, chat.params.thinking);

  const ctrl = new AbortController();
  chat.inflight = ctrl;
  setSendingUI(true);
  setChatStats(t("chat.streaming"));

  const t0 = Date.now();
  try {
    const url = endpoint("/api/chat/completions", false);
    /* Each fanout target gets its own fetch so we exercise parallel slots. */
    const tasks = targets.map((target, idx) => streamOne(url, payload, ctrl.signal, target, t0, idx, n));
    const results = await Promise.allSettled(tasks);
    /* collapse the user-facing assistant history into the first successful response */
    const first = results.find((r) => r.status === "fulfilled" && r.value);
    if (first) {
      chat.messages.push({
        role: "assistant",
        content: first.value.content,
        reasoning: first.value.reasoning || "",
      });
      trimChatHistory();
    }
    setChatStats("");
  } catch (e) {
    setChatStats(t("chat.error") + ": " + (e && e.message ? e.message : String(e)));
  } finally {
    chat.inflight = null;
    setSendingUI(false);
  }
}

async function streamOne(url, payload, signal, target, t0, idx, total) {
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (e) {
    if (e && e.name === "AbortError") {
      target.stats.textContent = t("chat.cancelled");
      return null;
    }
    target.stats.textContent = t("chat.error") + ": " + e.message;
    throw e;
  }
  if (!res.ok) {
    let body = "";
    try { body = await res.text(); } catch (_e) {}
    target.stats.textContent = t("chat.error") + " " + res.status +
                               (body ? ": " + body.slice(0, 200) : "");
    throw new Error("HTTP " + res.status);
  }
  if (!res.body) {
    target.stats.textContent = t("chat.error") + ": no body";
    throw new Error("no body");
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let acc = "";
  let thinkingAcc = "";
  let usage = null;
  let nTokens = 0;

  let pendingAnswerReflow = false;
  let pendingThinkingReflow = false;
  const doAnswerReflow = () => {
    pendingAnswerReflow = false;
    /* full re-render — content is small, and the renderer builds DOM
     * directly so this is safe and cheaper than diffing partial deltas. */
    updateMarkdownBody(target.body, acc);
    scrollChatIfNearBottom();
  };
  const doThinkingReflow = () => {
    pendingThinkingReflow = false;
    if (target.thinkingNode) target.thinkingNode.hidden = !thinkingAcc;
    updateMarkdownBody(target.thinkingBody, thinkingAcc);
    scrollChatIfNearBottom();
  };
  /* throttle to ~60ms — re-rendering whole markdown every token is O(n²);
   * 60ms feels live without burning the main thread on long responses. */
  const reflowAnswer = () => {
    if (pendingAnswerReflow) return;
    pendingAnswerReflow = true;
    setTimeout(doAnswerReflow, 60);
  };
  const reflowThinking = () => {
    if (pendingThinkingReflow) return;
    pendingThinkingReflow = true;
    setTimeout(doThinkingReflow, 60);
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        let json;
        try { json = JSON.parse(data); } catch (_e) { continue; }
        if (json.usage) usage = json.usage;
        const delta = json.choices && json.choices[0] && json.choices[0].delta;
        const answerPiece = delta && typeof delta.content === "string" ? delta.content : "";
        const thinkingPiece = delta && typeof delta.reasoning_content === "string" ? delta.reasoning_content : "";
        if (thinkingPiece) {
          thinkingAcc += thinkingPiece;
          nTokens++;
          reflowThinking();
        }
        if (answerPiece) {
          acc += answerPiece;
          nTokens++;
          reflowAnswer();
        }
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        const rate = nTokens > 0 ? (nTokens / Math.max(0.001, (Date.now() - t0) / 1000)).toFixed(1) : "0.0";
        const prefix = total > 1 ? "#" + (idx + 1) + "/" + total + " — " : "";
        target.stats.textContent = prefix + elapsed + "s · " + nTokens + " " +
                                    t("chat.tok") + " · " + rate + " " + t("chat.tok_per_s");
      }
    }
  } catch (e) {
    if (e && e.name === "AbortError") {
      target.stats.textContent = t("chat.cancelled") + " · " + (acc.length + thinkingAcc.length) + " " + t("chat.chars");
      return null;
    }
    target.stats.textContent = t("chat.error") + ": " + e.message;
    throw e;
  }

  /* flush any throttled reflow so the message body is final when we return */
  doThinkingReflow();
  doAnswerReflow();

  /* Final stats from server usage if provided */
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  let stats = elapsed + "s · " + nTokens + " " + t("chat.tok");
  if (usage) {
    const pt = usage.prompt_tokens || 0;
    const ct = usage.completion_tokens || nTokens;
    const rate = ct > 0 ? (ct / Math.max(0.001, (Date.now() - t0) / 1000)).toFixed(1) : "0.0";
    stats = elapsed + "s · " + pt + " in / " + ct + " out · " + rate + " " + t("chat.tok_per_s");
  }
  if (total > 1) stats = "#" + (idx + 1) + "/" + total + " — " + stats;
  target.stats.textContent = stats;

  return { content: acc || thinkingAcc, reasoning: thinkingAcc };
}

function stopChat() {
  if (chat.inflight) chat.inflight.abort();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  /* parser already past DOMContentLoaded — schedule on the next tick so
   * any synchronous code below this point still runs first. */
  Promise.resolve().then(boot);
}

