"use strict";

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
