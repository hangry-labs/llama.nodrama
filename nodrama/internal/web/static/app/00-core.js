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
  const normalize = (value) => {
    const lang = String(value || "").toLowerCase();
    if (!lang) return "";
    if (supported.includes(value)) return value;
    if (lang.startsWith("ko")) return "ko";
    if (lang.startsWith("ja")) return "ja";
    if (lang.startsWith("zh")) return "zh-CN";
    if (lang.startsWith("es")) return "es";
    if (lang.startsWith("en")) return "en";
    return "";
  };
  const requestedLang = normalize(requested);
  if (requestedLang) return requestedLang;
  const navLang = normalize(navigator.language || "en");
  if (navLang) return navLang;
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
  txt.classList.remove("online", "warn", "offline", "error");
  if (state_ === "online")  led.classList.add("on");
  if (state_ === "warn")    led.classList.add("warn");
  if (state_ === "offline") led.classList.add("bad");
  if (state_ === "error")   led.classList.add("bad");
  if (state_ === "online" || state_ === "warn" || state_ === "offline" || state_ === "error") {
    txt.classList.add(state_);
  }
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

