"use strict";

/* Read SSE events independently of rendering. A closed connection is not a
 * completion unless the server sent a finish reason or [DONE]. */
async function readChatStream(body, onUpdate) {
  const result = { content: "", reasoning: "", usage: null, complete: false };
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "", data = [], event = "", ended = false;

  function dispatch() {
    const payload = data.join("\n");
    const eventType = event;
    data = []; event = "";
    if (!payload) return;
    if (payload.trim() === "[DONE]") {
      result.complete = true;
      ended = true;
      return;
    }
    let value;
    try { value = JSON.parse(payload); }
    catch (_) { throw new Error("Invalid JSON in chat stream"); }
    if (value.error || eventType === "error") {
      const error = value.error || value;
      throw new Error(typeof error === "string" ? error : error.message || "Chat stream failed");
    }
    if (value.usage) result.usage = value.usage;
    const choice = value.choices && value.choices[0];
    const delta = choice && choice.delta;
    if (delta && typeof delta.content === "string") result.content += delta.content;
    if (delta && typeof delta.reasoning_content === "string") result.reasoning += delta.reasoning_content;
    if (choice && choice.finish_reason != null) result.complete = true;
    onUpdate(result);
  }

  function line(text) {
    if (!text) { dispatch(); return; }
    const colon = text.indexOf(":");
    const field = colon < 0 ? text : text.slice(0, colon);
    let value = colon < 0 ? "" : text.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
    if (field === "event") event = value;
  }

  function drain(final) {
    let match;
    while (!ended && (match = /\r\n|\r|\n/.exec(buffer))) {
      // Hold a trailing CR until we know whether the next chunk starts with LF.
      if (!final && match[0] === "\r" && match.index === buffer.length - 1) break;
      const text = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      line(text);
    }
    if (final && !ended) {
      if (buffer) line(buffer);
      buffer = "";
      dispatch();
    }
  }

  try {
    while (!ended) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      drain(done);
      if (done) break;
    }
    if (!result.complete) throw new Error("Chat stream ended before completion");
    return result;
  } finally {
    // Release the connection on [DONE], malformed input and server errors alike.
    try { await reader.cancel(); } catch (_) {}
    reader.releaseLock();
  }
}
