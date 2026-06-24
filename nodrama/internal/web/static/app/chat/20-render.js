"use strict";

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

