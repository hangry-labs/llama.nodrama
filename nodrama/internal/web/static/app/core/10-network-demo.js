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
 *  using normalized dashboard snapshots. Activated by ?demo=1 (single
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

  const sampleParams = {
    n_predict: 512, seed: 42, temperature: 0.7, dynatemp_range: 0,
    dynatemp_exponent: 1, top_k: 40, top_p: 0.95, min_p: 0.05,
    typical_p: 1, xtc_probability: 0, xtc_threshold: 0.1,
    repeat_last_n: 64, repeat_penalty: 1.05, presence_penalty: 0,
    frequency_penalty: 0, dry_multiplier: 0, dry_base: 1.75,
    mirostat: 0, mirostat_tau: 5, mirostat_eta: 0.1,
    samplers: ["dry", "top_k", "typ_p", "top_p", "min_p", "xtc", "temperature"],
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

  const demo = createDemoData(mode, propsResp, modelsResp, v1ModelsResp.data);

  const cannedReplies = [
    `# Demo response\n\nThis dashboard is running in **demo mode** — every endpoint is synthetic. The real one talks to a [llama.cpp](https://github.com/ggml-org/llama.cpp) server.\n\n## What works\n\n- Streaming with throttled re-render\n- Markdown: lists, tables, code\n- Cancel mid-stream\n\n\`\`\`js\n// example\nfunction hello(name) {\n  return \`Hello, \${name}!\`;\n}\n\`\`\`\n\n| Metric | Source |\n|---|---|\n| tok/s | \`/metrics\` |\n| slots | \`/slots\` |\n| model | \`/v1/models\` |\n\n> Try clicking ⓘ on any card.`,
    `Sure — quick rundown of the relevant flags:\n\n1. **\`--metrics\`** turns on \`/metrics\` (Prometheus).\n2. **\`--parallel N\`** sets concurrent slots; KV memory ≈ N × ctx_size × hidden_dim × 2.\n3. **\`-ngl L\`** offloads L layers to GPU. Set to 99 to offload everything when VRAM allows.\n4. **\`--ctx-size C\`** is total context shared across slots in single mode.\n\n*This is the demo response — no real model behind it.*`,
    `Here's a small table of common sampling presets:\n\n| Preset | temp | top_p | repeat_penalty |\n|--------|------|-------|----------------|\n| chat   | 0.7  | 0.95  | 1.05           |\n| code   | 0.2  | 0.95  | 1.0            |\n| creative | 1.0 | 0.95 | 1.1            |\n\nUse \`temperature = 0\` for deterministic output (greedy). Setting \`mirostat\` to 1 or 2 ignores top_p / top_k entirely.`,
  ];

  const streamingChat = (options) => {
    const text = cannedReplies[Math.floor(chat.messages.length / 2) % cannedReplies.length];
    const pieces = text.split(/(\s+)/).filter(Boolean);
    const signal = options.signal;
    let timer, cleanup = () => {};
    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        let index = 0, closed = false;
        cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); closed = true; };
        const abort = () => { if (!closed) { cleanup(); controller.error(new DOMException("Stopped", "AbortError")); } };
        const send = value => controller.enqueue(enc.encode("data: " + (typeof value === "string" ? value : JSON.stringify(value)) + "\n\n"));
        function pump() {
          if (closed) return;
          if (index < pieces.length) {
            send({ choices: [{ delta: { content: pieces[index++] } }] });
            timer = setTimeout(pump, 35);
          } else {
            send({ choices: [{ delta: {}, finish_reason: "stop" }], usage: {
              prompt_tokens: 32, completion_tokens: pieces.length, total_tokens: pieces.length + 32 } });
            send("[DONE]"); cleanup(); controller.close();
          }
        }
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort(); else pump();
      },
      cancel() { cleanup(); },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
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
    const requestBody = () => JSON.parse((init && init.body) || "{}");
    if (path === "/api/settings") {
      if (method.toUpperCase() === "POST") {
        const update = requestBody();
        demo.settings.pollIntervalMs = Math.max(200, Math.min(60000, Number(update.pollIntervalMs) || 1000));
        demo.settings.timeoutMs = Math.max(250, Math.min(120000, Number(update.timeoutMs) || 5000));
      }
      return Promise.resolve(json(demo.settings));
    }
    if (path === "/api/snapshot") return Promise.resolve(json(demo.snapshot()));
    if (path === "/api/history/metrics") {
      return Promise.resolve(json(demo.metricHistory(new URL(url, window.location.href).searchParams.get("metric"))));
    }
    if (path === "/api/events") return Promise.resolve(json(demo.snapshot().events));
    if (path === "/api/queries") return Promise.resolve(json(demo.snapshot().queries));
    if (path === "/api/chat/completions" && method.toUpperCase() === "POST") {
      return Promise.resolve(streamingChat(init || {}));
    }
    try {
      if (path === "/api/models/load" || path === "/api/models/unload") {
        demo.modelAction(requestBody().model, path.endsWith("/load") ? "load" : "unload");
        return Promise.resolve(json({ success: true, demo: true }));
      }
      const slot = path.match(/^\/api\/slots\/(\d+)\/(save|restore|erase)$/);
      if (slot) {
        demo.slotAction(Number(slot[1]), slot[2]);
        return Promise.resolve(json({ success: true, demo: true }));
      }
      if (path === "/api/history/reset") {
        demo.resetHistory();
        return Promise.resolve(json({ success: true, demo: true }));
      }
    } catch (error) { return Promise.resolve(json({ error: error.message }, 400)); }
    if (path === "/api/logs/tail") return Promise.resolve(json(demo.logs()));
    /* legacy server.log — return 404 so log panel hides cleanly */
    return Promise.resolve(notFound());
  };


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
  const abort = () => ctrl.abort();
  if (o.signal?.aborted) abort();
  else o.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, o.timeout || 8000);
  try {
    const res = await fetch(endpoint(path, o.withModel !== false), {
      method: o.method || "GET",
      headers: Object.assign(
        { "Accept": kind === "json" ? "application/json" : "text/plain" },
        o.headers || {}
      ),
      body: o.body,
      signal: ctrl.signal,
      cache: "no-store",
    });
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
    if (e.name === "AbortError") {
      const ae = new Error("aborted"); ae.aborted = true; throw ae;
    }
    throw e;
  } finally {
    clearTimeout(timer);
    o.signal?.removeEventListener("abort", abort);
  }
}
async function safeReadBody(res) {
  try { return await res.text(); } catch (_) { return ""; }
}

