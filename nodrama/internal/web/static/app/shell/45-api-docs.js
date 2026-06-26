"use strict";

const API_DOC_GROUPS = [
  {
    title: "Read-only dashboard API",
    items: [
      ["GET", "/api/health", "Small health/build/settings summary. Good for monitoring whether llama.nodrama is alive."],
      ["GET", "/api/snapshot", "Full dashboard snapshot: overview, metrics, slots, cache, queries, events, GPU, warnings, and update state."],
      ["GET", "/shortInfo", "Plain-text operational summary intended for local agents and scripts that only need availability and queue pressure."],
      ["GET", "/api/shortInfo", "Same plain-text agent summary as /shortInfo, kept under the API namespace."],
      ["GET", "/api/events", "Structured recent llama.cpp log events parsed by llama.nodrama."],
      ["GET", "/api/queries", "Tracked recent queries, including running/queued/completed state and cache reuse details when available."],
      ["GET", "/api/history/metrics?metric=nodrama:tokens_predicted_rate&hours=24&max=2000", "Long metric history. Required query: metric. Optional: hours 1-24, max 100-20000."],
      ["GET", "/api/settings", "Current runtime settings: upstream server URL, log path, poll interval, timeout, listen address, and proxy mode."],
      ["GET", "/api/logs/tail?bytes=65536&lines=2000", "Tail of the configured llama.cpp log file. Optional: bytes 1-1048576, lines 1-10000."],
      ["GET", "/server.log?bytes=65536&lines=2000", "Compatibility log-tail endpoint using the same response shape as /api/logs/tail."],
    ],
  },
  {
    title: "Mutating llama.nodrama API",
    items: [
      ["POST", "/api/settings", "Update runtime server URL, log path, poll interval, or upstream timeout. JSON body."],
      ["POST", "/api/history/reset", "Clear in-memory metric, slot, prompt-cache, event, and query history."],
    ],
  },
  {
    title: "Tracked llama.cpp proxy API",
    items: [
      ["POST", "/api/chat/completions", "Proxy to llama.cpp /v1/chat/completions. Requests are tracked so they appear in Queries."],
      ["POST", "/api/models/load", "Proxy to llama.cpp /models/load."],
      ["POST", "/api/models/unload", "Proxy to llama.cpp /models/unload."],
      ["POST", "/api/slots/{id}/save", "Proxy slot action=save for one slot."],
      ["POST", "/api/slots/{id}/restore", "Proxy slot action=restore for one slot."],
      ["POST", "/api/slots/{id}/erase", "Proxy slot action=erase for one slot."],
    ],
  },
  {
    title: "Optional raw llama.cpp proxy",
    note: "Only available when llama.nodrama is started with raw proxy support enabled.",
    items: [
      ["ANY", "/health", "Raw proxy to llama.cpp health endpoint."],
      ["ANY", "/props", "Raw proxy to llama.cpp props endpoint."],
      ["ANY", "/slots", "Raw proxy to llama.cpp slots endpoint."],
      ["ANY", "/metrics", "Raw proxy to llama.cpp Prometheus metrics endpoint."],
      ["ANY", "/v1/models", "Raw proxy to llama.cpp OpenAI-compatible models endpoint."],
      ["ANY", "/v1/chat/completions", "Raw proxy to llama.cpp OpenAI-compatible chat completions endpoint."],
      ["ANY", "/models", "Raw proxy to llama.cpp model management endpoint."],
      ["ANY", "/lora-adapters", "Raw proxy to llama.cpp LoRA adapter endpoint."],
      ["ANY", "/completion", "Raw proxy to llama.cpp legacy completion endpoint."],
    ],
  },
];

function openApiDocsModal() {
  const base = window.location.origin;
  const baseNode = el("code", null, base);
  const body = el("div", { class: "api-docs" }, [
    el("p", null, t("api_docs.intro")),
    el("div", { class: "api-base" }, [
      el("span", null, t("api_docs.base_url") + ": "),
      baseNode,
      el("button", { onclick: () => copyToClipboard(base, null) }, t("common.copy")),
    ]),
    ...API_DOC_GROUPS.map((group) => renderApiDocGroup(group, base)),
  ]);

  showModal({
    title: t("api_docs.title"),
    bodyNode: body,
    okLabel: t("common.close"),
    wide: true,
  });
}

function renderApiDocGroup(group, base) {
  return el("section", { class: "api-group" }, [
    el("h4", null, group.title),
    group.note ? el("p", { class: "api-note" }, group.note) : null,
    el("div", { class: "api-table" }, group.items.map((item) => renderApiDocRow(item, base))),
  ].filter(Boolean));
}

function renderApiDocRow(item, base) {
  const method = item[0];
  const path = item[1];
  const description = item[2];
  return el("div", { class: "api-row" }, [
    el("span", { class: "api-method " + method.toLowerCase() }, method),
    el("code", { class: "api-path" }, path),
    el("span", { class: "api-desc" }, description),
    el("button", {
      class: "api-copy",
      onclick: () => copyToClipboard(apiCopyValue(base, method, path), null),
    }, t("common.copy")),
  ]);
}

function apiCopyValue(base, method, path) {
  if (method === "GET" || method === "ANY") {
    return base + path;
  }
  return method + " " + base + path;
}
