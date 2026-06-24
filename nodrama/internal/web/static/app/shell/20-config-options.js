"use strict";

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

