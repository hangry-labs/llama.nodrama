"use strict";

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

