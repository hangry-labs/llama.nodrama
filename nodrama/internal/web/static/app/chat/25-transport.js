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

// Demultiplex byte-exact upstream streams from one HTTP response. Monitoring
// keeps its own browser connections even when all eight requests are queued.
function openChatBatch(url, payload, signal, count) {
  const controller = new AbortController();
  const channels = Array.from({ length: count }, () => {
    const channel = { closed: false, headers: false };
    channel.response = new Promise((resolve, reject) => { channel.resolve = resolve; channel.reject = reject; });
    channel.body = new ReadableStream({
      start(stream) { channel.stream = stream; },
      cancel() {
        channel.closed = true;
        if (channels.every(item => item.closed)) controller.abort();
      },
    });
    return channel;
  });
  const fail = (channel, error) => {
    if (channel.closed) return;
    channel.closed = true;
    if (!channel.headers) channel.reject(error);
    channel.stream.error(error);
  };
  const abort = () => controller.abort(signal.reason);
  if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  const receive = frame => {
    if (!Number.isInteger(frame.index) || frame.index < 0 || frame.index >= count) throw new Error('Invalid chat batch index');
    const channel = channels[frame.index];
    if (channel.closed) return;
    if (frame.type === 'headers' && !channel.headers) {
      const headers = { 'Content-Type': frame.contentType || '' };
      const response = new Response([204, 205, 304].includes(frame.status) ? null : channel.body, { status: frame.status, headers });
      channel.headers = true;
      channel.resolve(response);
    } else if (frame.type === 'data' && channel.headers) {
      const bytes = Uint8Array.from(atob(frame.data || ''), value => value.charCodeAt(0));
      channel.stream.enqueue(bytes);
    } else if (frame.type === 'done' && channel.headers) {
      channel.closed = true; channel.stream.close();
    } else if (frame.type === 'error') fail(channel, new Error(frame.error || 'Chat stream interrupted'));
    else throw new Error('Invalid chat batch frame');
  };
  void (async () => {
    let reader;
    try {
      const response = await fetch(url + '/batch?count=' + count, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
        body: JSON.stringify(payload), signal: controller.signal,
      });
      if (!response.ok) throw new Error('HTTP ' + response.status + ': ' + (await response.text()).slice(0, 200));
      if (!response.body || !(response.headers.get('content-type') || '').startsWith('application/x-ndjson')) throw new Error('Expected a chat batch stream');
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (channels.some(channel => !channel.closed)) {
        const { value, done } = await reader.read();
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        if (buffer.length > 1024 * 1024) throw new Error('Chat batch frame exceeds limit');
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          if (line.trim()) receive(JSON.parse(line));
        }
        if (done) break;
      }
      if (channels.some(channel => !channel.closed)) throw new Error('Chat batch ended before completion');
    } catch (error) {
      for (const channel of channels) fail(channel, error);
    } finally {
      signal.removeEventListener('abort', abort);
      if (reader) { try { await reader.cancel(); } catch (_) {} reader.releaseLock(); }
      controller.abort();
    }
  })();
  return { responses: channels.map(channel => channel.response), close: () => controller.abort() };
}
