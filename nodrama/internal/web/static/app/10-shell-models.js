"use strict";

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
  "backend_sampling": "Controls where sampling is performed.\n\nCommon values: false/off = normal OpenAI-style requests choose tokens through the regular server path using request sampling parameters; true/on = advanced backend-managed sampling behavior.\n\nMost deployments should leave this off unless a specific client or experiment expects backend sampling.",
  "chat_format": "How streamed chat deltas are shaped for chat clients.\n\nCommon shapes you may see: content-only = assistant text is emitted as normal content; reasoning-aware = thinking/reasoning may be emitted separately from visible content; template/tool specific = the server/model template controls extra fields.\n\nChange this only when a client expects a different streaming shape or you are debugging reasoning output.",
  "dry_allowed_length": "DRY anti-repetition ignores repeats shorter than this length. Higher values make DRY less aggressive on short repeated phrases.",
  "dry_base": "Base multiplier used by DRY anti-repetition. Higher values make repeat suppression ramp more strongly after a repeat is detected.",
  "dry_multiplier": "Strength of DRY anti-repetition. 0 disables DRY. Moderate values reduce loops without punishing all repeated words like repeat_penalty can.",
  "dry_penalty_last_n": "How far back DRY looks for repeated sequences. -1 usually means use the whole current context.",
  "dynatemp_exponent": "Curve shape for dynamic temperature. It only matters when dynatemp_range is above 0.",
  "dynatemp_range": "Dynamic temperature adjustment range. 0 disables dynamic temperature. Higher values let temperature move around the base temperature during generation.",
  "frequency_penalty": "Penalizes tokens based on how often they already appeared. Higher values reduce repeated wording, but too high can hurt code and structured output.",
  "generation_prompt": "Extra text/template suffix inserted before assistant generation. Empty means no extra generation marker beyond the chat template.",
  "ignore_eos": "Whether end-of-sequence tokens are respected.\n\nCommon values: false = stop normally when the model emits EOS; true = ignore EOS and continue until max tokens or another stop condition.\n\nTrue is useful for stress tests, but risky for normal chat because generations can run longer than expected.",
  "lora": "LoRA adapters applied by default. Empty means no adapter is active by default.",
  "min_keep": "Minimum number of candidate tokens preserved by probability filters. 0 means no extra minimum. Raising it can prevent samplers from becoming too narrow.",
  "temperature": "Sampling randomness. 0 is deterministic; higher values produce more varied output.",
  "top_k": "Limits sampling to the top K candidate tokens.",
  "top_p": "Nucleus sampling threshold; keeps tokens whose cumulative probability reaches this value.",
  "min_p": "Drops tokens below a probability relative to the most likely token.",
  "mirostat": "Adaptive sampling mode that tries to keep output surprise/entropy near a target.\n\nCommon values: 0 = disabled; 1 = original Mirostat; 2 = Mirostat v2.\n\nWhen enabled, tune mirostat_tau and mirostat_eta; top_p/top_k become less central than in normal sampling.",
  "mirostat_eta": "Mirostat learning rate. Higher values adapt faster but can oscillate more.",
  "mirostat_tau": "Mirostat target entropy/surprise. Higher values allow more varied output.",
  "n_discard": "Context-shift discard amount. When context fills and shifting is allowed, this influences how much old context can be dropped.",
  "n_keep": "Number of initial prompt tokens to preserve during context shifting. Useful for keeping system prompts/instructions anchored.",
  "repeat_penalty": "Penalty applied to repeated tokens.",
  "repeat_last_n": "How many previous tokens repeat_penalty considers. Larger windows reduce long-range repetition but can affect style and structured text.",
  "n_predict": "Default maximum generated tokens for completion-style requests.",
  "max_tokens": "Default maximum generated tokens for OpenAI-compatible requests.",
  "n_probs": "Number of token probabilities to return for each generated token. 0 disables probability output. Higher values add diagnostic data but increase response size.",
  "post_sampling_probs": "Controls which probabilities are reported when n_probs/logprobs are requested.\n\nCommon values: false = report probabilities before final sampler filtering path; true = report probabilities after sampler filtering.\n\nUse true when you want diagnostics closer to what the sampler actually selected from.",
  "presence_penalty": "Penalizes tokens that have appeared at least once. Higher values encourage new topics/words; too high can make output drift.",
  "reasoning_format": "How thinking/reasoning text is parsed or exposed for compatible models/templates.\n\nCommon modes depend on the server build and template: none/disabled = do not treat reasoning specially; separate = expose reasoning in a separate reasoning field; content = include reasoning in normal assistant content.\n\nUse separate when a UI should show thinking apart from the final answer.",
  "reasoning_in_content": "Whether reasoning text is included inside normal assistant content.\n\nCommon values: false = keep reasoning separate when the server/template supports it; true = put reasoning in the visible content stream.\n\nFor chat UIs, false is usually cleaner because thinking can be rendered as its own bubble.",
  "samplers": "Sampler chain order. Tokens pass through these filters/transforms before final selection.\n\nCommon sampler names include penalties, dry, top_k, typical_p, top_p, min_p, temperature, xtc, and top_n_sigma. Removing, adding, or reordering samplers changes generation style and can make output more deterministic, more creative, or more repetitive.\n\nOnly tune this when you are intentionally changing sampling behavior.",
  "seed": "Random seed used for sampling.\n\nCommon values: a fixed integer = more reproducible output with the same prompt/settings; 4294967295 or similar max unsigned value = choose a random seed.\n\nUse a fixed seed for debugging; use random for normal chat variety.",
  "speculative.types": "Speculative decoding mode. 'none' means no draft/speculative model path is active.",
  "stream": "Default streaming behavior.\n\nCommon values: false = return the full response only when complete; true = send tokens incrementally as they are generated.\n\nRequests can override this. Streaming is better for chat UX and live diagnostics.",
  "timings_per_token": "Whether timing details are reported per generated token.\n\nCommon values: false = normal compact timing output; true = detailed per-token timing diagnostics.\n\nEnable only when investigating latency because it can add overhead and log/API noise.",
  "top_n_sigma": "Top-n-sigma sampler threshold. Negative values disable it. When enabled, it keeps tokens within a probability/logit band around the best token.",
  "typical_p": "Typical sampling threshold. Values below 1 filter unlikely or overly surprising tokens based on local entropy.",
  "xtc_probability": "XTC sampler activation probability. 0 disables it. Higher values more often apply XTC filtering for creative variation.",
  "xtc_threshold": "XTC filtering threshold. It only matters when xtc_probability is above 0.",
};

function configOptionHelpKey(key) {
  return "config.help." + String(key || "unknown").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function configHelpText(key) {
  const translated = t(configOptionHelpKey(key));
  if (translated !== configOptionHelpKey(key)) return translated;
  return CONFIG_OPTION_HELP[key] || t("config.help.unknown");
}

function defaultOptionHelp(key) {
  return configHelpText(key) + "\n\n" + t("config.help.default_note").replace("{key}", key);
}

function configHelpFor(option) {
  const key = option.key || option.label;
  if (option.isDefault) return defaultOptionHelp(key);
  return configHelpText(key);
}

function configOptionCard(option) {
  const label = option.displayLabel || option.label;
  const help = option.help || configHelpFor(option);
  const sourceLabel = t("config.help.source");
  const title = option.source ? (help + " " + sourceLabel + ": " + option.source) : help;
  const open = () => showModal({
    title: label,
    bodyNode: el("div", null, [
      el("div", { style: "white-space: pre-line;" }, help),
      option.source ? el("div", { class: "sub", style: "margin-top: 8px;" }, sourceLabel + ": " + option.source) : null,
    ]),
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
  const showHelp = () => showModal({
    title: t("lora.help_title"),
    bodyNode: el("div", { style: "white-space: pre-line;" }, t("lora.help")),
    okLabel: t("common.close"),
  });
  const card = el("div", { class: "card full" }, [
    el("h2", { class: "section-title-row" }, [
      t("lora.title"),
      el("button", {
        class: "info-btn",
        title: t("lora.help_title"),
        "aria-label": t("lora.help_title"),
        onclick: showHelp,
      }, "?"),
    ]),
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
function showModal({ title, bodyNode, okLabel, onOk, mutating, wide }) {
  const back = el("div", { class: "modal-backdrop", role: "dialog", "aria-modal": "true" });
  let onKey;
  const errorNode = el("div", { class: "error", hidden: true }, "");
  const close = () => {
    back.remove();
    if (onKey) document.removeEventListener("keydown", onKey);
  };
  const isAction = typeof onOk === "function";
  const ok = el("button", { class: isAction ? "primary" : "", onclick: async () => {
    if (!isAction) {
      close();
      return;
    }
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
  }}, okLabel || (isAction ? t("common.confirm") : t("common.close")));
  const cancel = isAction ? el("button", { onclick: close }, t("common.cancel")) : null;
  /* mutating modals get a "this changes server state" warning; informational
   * modals (like the log help dialog) skip it. */
  const warnNode = mutating
    ? el("div", { class: "warn" }, "⚠ " + t(state.mode === "router"
        ? "modal.warn_router" : "modal.warn_server"))
    : null;
  const m = el("div", { class: wide ? "modal wide" : "modal" }, [
    el("h3", null, title),
    el("div", { class: "body" }, bodyNode),
    warnNode,
    errorNode,
    el("div", { class: "actions" }, [cancel, ok].filter(Boolean)),
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

