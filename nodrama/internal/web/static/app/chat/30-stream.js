"use strict";

async function sendChat() {
  if (chat.inflight || chat.attachmentLoading) return;
  const ta = $("#chat-input");
  const text = ta ? ta.value.trim() : "";
  const attachments = chat.attachments.slice();
  if (!text && !attachments.length) return;
  if (chatImageSupport() === false && (attachments.some(item => item.kind === 'image')
      || chat.messages.some(message => message.attachments?.some(item => item.kind === 'image')))) {
    setChatStats(t('chat.attachment_no_vision')); return;
  }

  const ctrl = new AbortController();
  chat.inflight = ctrl;
  chat.attachments = [];
  chat.attachmentError = '';
  setSendingUI(true);
  setChatStats(t("chat.streaming"));
  ta.value = ""; ta.style.height = "auto";
  const previousMessages = chat.messages.slice();
  const user = { role: "user", content: text, attachments };
  chat.messages.push(user);
  trimChatHistory();
  const userTarget = appendChatMessage("user", text, { attachments });
  const n = Math.max(1, Math.min(8, chat.params.fanout | 0));
  const targets = [];
  let batch;

  try {
    const payload = {
      model: state.selectedModel
        || (state.models[0] && state.models[0].id)
        || (state.v1models[0] && state.v1models[0].id)
        || "default",
      messages: [],
      stream: true,
      stream_options: { include_usage: true },
      temperature: chat.params.temperature,
      top_p: chat.params.top_p,
      max_tokens: chat.params.max_tokens | 0,
      cache_prompt: !!chat.params.cachePrompt,
    };
    if ((chat.params.slot | 0) >= 0) payload.id_slot = chat.params.slot | 0;
    if (chat.systemPrompt.trim()) payload.messages.push({ role: "system", content: chat.systemPrompt.trim() });
    for (const message of chat.messages) payload.messages.push({ role: message.role, content: chatHistoryContent(message) });
    applyThinkingMode(payload, chat.params.thinking);
    if (new TextEncoder().encode(JSON.stringify(payload)).length > CHAT_REQUEST_MAX_BYTES) {
      throw new Error(t('chat.attachment_request_size'));
    }
    for (let k = 0; k < n; k++) {
      targets.push(appendAssistantTarget({ stats: n > 1 ? "#" + (k + 1) + "/" + n + " — …" : "…" }));
    }

    const url = endpoint("/api/chat/completions", false);
    const t0 = Date.now();
    if (n > 1 && !state.params?.demo) batch = openChatBatch(url, payload, ctrl.signal, n);
    const results = await Promise.allSettled(targets.map((target, index) =>
      streamOne(url, payload, ctrl.signal, target, t0, index, n, batch?.responses[index])));
    // Fanout history is deterministic: prefer the lowest-index completed reply,
    // then a stopped partial reply. Failed/interrupted output stays out of history.
    let selectedIndex = results.findIndex(r => r.status === "fulfilled" && r.value.status === "complete");
    if (selectedIndex < 0) selectedIndex = results.findIndex(r => r.status === "fulfilled"
      && r.value.status === "cancelled" && (r.value.content || r.value.reasoning));
    const selected = selectedIndex < 0 ? null : results[selectedIndex].value;
    if (selected) {
      chat.messages.push({ role: "assistant", content: selected.content,
        reasoning: selected.reasoning, status: selected.status });
      trimChatHistory();
      if (n > 1) targets[selectedIndex].stats.textContent += " · " + t("chat.history_reply");
      if (selected.status === "cancelled") targets[selectedIndex].stats.textContent += " · " + t("chat.partial_history");
    } else {
      // A failed turn can be retried; do not silently send an unanswered user
      // message from a failed request as context for the next conversation turn.
      chat.messages = previousMessages;
      chat.attachments = attachments;
      ta.value = text;
      if (userTarget) userTarget.stats.textContent = t("chat.excluded");
    }
    results.forEach((result, index) => {
      if (index !== selectedIndex && result.status === "fulfilled"
          && (result.value.status === "complete" || result.value.status === "cancelled")) {
        targets[index].stats.textContent += " · " + t("chat.excluded");
      }
    });
    const failed = results.some(r => r.status === "rejected" || r.value.status === "failed");
    setChatStats(failed ? t("chat.error") : ctrl.signal.aborted ? t("chat.cancelled") : "");
  } catch (error) {
    chat.messages = previousMessages;
    chat.attachments = attachments;
    ta.value = text;
    if (userTarget) userTarget.stats.textContent = t("chat.excluded");
    setChatStats(t("chat.error") + ": " + error.message);
  } finally {
    batch?.close();
    chat.inflight = null;
    setSendingUI(false);
    if (chat.open) ta.focus();
  }
}

function chatStreamStats(reply, t0) {
  const seconds = Math.max(0.001, (Date.now() - t0) / 1000);
  const elapsed = seconds.toFixed(1) + "s";
  const usage = reply.usage;
  if (usage && Number.isFinite(usage.completion_tokens)) {
    const count = usage.completion_tokens;
    return elapsed + " · " + (usage.prompt_tokens ?? "?") + " in / " + count + " out · "
      + (count / seconds).toFixed(1) + " " + t("chat.tok_per_s");
  }
  return elapsed + " · " + (reply.content.length + reply.reasoning.length) + " " + t("chat.chars");
}

async function streamOne(url, payload, signal, target, t0, index, total, batchResponse) {
  let reply = { content: "", reasoning: "", usage: null };
  let timer = null;
  const prefix = total > 1 ? "#" + (index + 1) + "/" + total + " — " : "";
  const render = () => {
    timer = null;
    updateMarkdownBody(target.body, reply.content);
    if (target.thinkingNode) target.thinkingNode.hidden = !reply.reasoning;
    updateMarkdownBody(target.thinkingBody, reply.reasoning);
    scrollChatIfNearBottom();
  };
  try {
    const response = await (batchResponse || fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(payload), signal,
    }));
    if (!response.ok) {
      const body = await response.text();
      throw new Error("HTTP " + response.status + (body ? ": " + body.slice(0, 200) : ""));
    }
    if (!response.body) throw new Error("Chat response has no body");
    if (!(response.headers.get("content-type") || "").toLowerCase().startsWith("text/event-stream")) {
      await response.body.cancel();
      throw new Error("Expected a chat event stream");
    }
    reply = await readChatStream(response.body, update => {
      reply = update;
      if (timer === null) timer = setTimeout(render, 60);
      target.stats.textContent = prefix + chatStreamStats(reply, t0);
    });
    target.stats.textContent = prefix + chatStreamStats(reply, t0);
    return { ...reply, status: "complete" };
  } catch (error) {
    const cancelled = signal.aborted || error.name === "AbortError";
    const status = cancelled ? "cancelled" : "failed";
    target.stats.textContent = prefix + (cancelled ? t("chat.cancelled") : t("chat.error") + ": " + error.message)
      + " · " + (reply.content.length + reply.reasoning.length) + " " + t("chat.chars");
    if (!cancelled) target.stats.textContent += " · " + t("chat.excluded");
    return { ...reply, status };
  } finally {
    if (timer !== null) clearTimeout(timer);
    render();
  }
}

function stopChat() {
  if (chat.inflight) chat.inflight.abort();
}
