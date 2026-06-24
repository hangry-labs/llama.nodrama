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

