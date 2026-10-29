"use strict";

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
  attachments: [],
  attachmentLoading: false,
  attachmentError: '',
  systemPrompt: "",
  inflight: null,        /* AbortController */
  autoScroll: true,
  params: {
    temperature: 0.7,
    top_p: 0.95,
    max_tokens: 512,
    fanout: 1,
    thinking: "auto",
    thinkingEffort: "medium",
    keepThinking: false,
    cachePrompt: true,
    slot: -1,
  },
};

/* Evict whole turns, including when the newest user is still awaiting a reply. */
function trimChatHistory() {
  const starts = [];
  chat.messages.forEach((message, index) => {
    if (message.role === "user") starts.push(index);
  });
  const first = starts[Math.max(0, starts.length - CHAT_HISTORY_MAX_TURNS)];
  if (first === undefined) chat.messages = [];
  else if (first > 0) chat.messages.splice(0, first);
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
  if (!message || message.role !== "assistant") return message ? chatUserContent(message) : "";
  if (!chat.params.keepThinking || !message.reasoning) return message.content || "";
  const content = message.content || "";
  const reasoning = message.reasoning || "";
  return "<think>\n" + reasoning + "\n</think>" + (content ? "\n\n" + content : "");
}

