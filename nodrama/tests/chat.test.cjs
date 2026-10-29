const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const chatDir = path.join(__dirname, '../internal/web/static/app/chat');
const encode = value => new TextEncoder().encode(value);
const event = value => 'data: ' + JSON.stringify(value) + '\n\n';
const delta = content => event({ choices: [{ delta: { content } }] });
const done = 'data: [DONE]\n\n';
const plain = value => JSON.parse(JSON.stringify(value));

function harness(fetchImpl) {
  const input = { value: '', style: {}, focus() {} };
  const targets = [], calls = [], headers = [];
  const context = vm.createContext({
    TextDecoder, Response, ReadableStream, AbortController, DOMException,
    setTimeout, clearTimeout, Date, console,
    state: { selectedModel: 'synthetic-model', models: [], v1models: [] },
    $: selector => selector === '#chat-input' ? input : null,
    t: key => key,
    endpoint: value => value,
    setSendingUI: value => headers.push(value),
    setChatStats: value => { context.stats = value; },
    appendChatMessage: () => ({ stats: {} }),
    appendAssistantTarget: () => {
      const target = { body: {}, stats: {}, thinkingBody: {}, thinkingNode: {} };
      targets.push(target);
      return target;
    },
    updateMarkdownBody: (body, text) => { if (body) body.text = text; },
    scrollChatIfNearBottom() {},
    applyThinkingMode() {},
    fetch: async (url, options) => {
      calls.push(JSON.parse(options.body));
      return fetchImpl(url, options, calls.length - 1);
    },
  });
  for (const file of ['00-state.js', '25-transport.js', '30-stream.js']) {
    vm.runInContext(fs.readFileSync(path.join(chatDir, file), 'utf8'), context, { filename: file });
  }
  const run = source => vm.runInContext(source, context);
  return { context, input, targets, calls, headers, run, chat: run('chat') };
}

function body(chunks, onCancel = () => {}) {
  return new ReadableStream({
    start(controller) {
      chunks.forEach(chunk => controller.enqueue(typeof chunk === 'string' ? encode(chunk) : chunk));
      controller.close();
    },
    cancel: onCancel,
  });
}

function response(text) {
  return new Response(text, { headers: { 'Content-Type': 'text/event-stream' } });
}

test('SSE survives every UTF-8 byte boundary, CRLF, comments and multiple data lines', async () => {
  const h = harness();
  const text = ': keepalive\r\nevent: message\r\ndata: {"choices":\r\ndata: [{"delta":{"content":"héllo 🦙"}}]}\r\n\r\n' + done;
  const bytes = encode(text);
  for (let split = 1; split < bytes.length; split++) {
    h.context.body = body([bytes.slice(0, split), bytes.slice(split)]);
    const result = await h.run('readChatStream(body, () => {})');
    assert.equal(result.content, 'héllo 🦙', 'split ' + split);
    assert.equal(result.complete, true);
  }
});

test('standalone CR delimiters and finish reason without DONE are accepted', async () => {
  const h = harness();
  h.context.body = body([delta('ok').replaceAll('\n', '\r')
    + event({ choices: [{ delta: {}, finish_reason: 'length' }] }).replaceAll('\n', '\r')]);
  const result = await h.run('readChatStream(body, () => {})');
  assert.equal(result.content, 'ok');
  assert.equal(result.complete, true);
});

test('DONE cancels a stream without waiting for the server to close', async () => {
  const h = harness();
  let cancelled = false;
  h.context.body = new ReadableStream({
    start(controller) { controller.enqueue(encode(delta('ok') + done)); },
    cancel() { cancelled = true; },
  });
  assert.equal((await h.run('readChatStream(body, () => {})')).content, 'ok');
  assert.equal(cancelled, true);
});

test('server errors, malformed JSON and premature EOF never complete a reply', async t => {
  for (const [name, text, message] of [
    ['error envelope', event({ error: { message: 'synthetic failure' } }), /synthetic failure/],
    ['named error', 'event: error\ndata: {"message":"synthetic failure"}\n\n', /synthetic failure/],
    ['malformed JSON', 'data: {broken}\n\n' + done, /Invalid JSON/],
    ['truncated', delta('partial'), /before completion/],
  ]) {
    await t.test(name, async () => {
      const h = harness();
      h.context.body = body([text]);
      await assert.rejects(h.run('readChatStream(body, () => {})'), message);
    });
  }
});

test('reasoning-only output is separate and included at most once when opted in', async () => {
  const h = harness(() => response(event({ choices: [{ delta: { reasoning_content: 'thinking' } }] }) + done));
  h.input.value = 'prompt';
  await h.run('sendChat()');
  assert.equal(h.chat.messages[1].content, '');
  assert.equal(h.chat.messages[1].reasoning, 'thinking');
  assert.equal(h.run('chatHistoryContent(chat.messages[1])'), '');
  h.chat.params.keepThinking = true;
  assert.equal(h.run('chatHistoryContent(chat.messages[1])'), '<think>\nthinking\n</think>');
  assert.equal(h.targets[0].thinkingBody.text, 'thinking');
});

test('history keeps complete turns and reserves the pending user turn', () => {
  const h = harness();
  for (let i = 0; i < 40; i++) h.chat.messages.push({ role: 'user', content: String(i) }, { role: 'assistant', content: String(i) });
  h.chat.messages.push({ role: 'user', content: 'next' });
  h.run('trimChatHistory()');
  assert.equal(h.chat.messages.length, 79);
  assert.equal(h.chat.messages[0].role, 'user');
  assert.equal(h.chat.messages[0].content, '1');
});

test('failed and truncated turns are labelled, excluded from payload history and retryable', async t => {
  for (const [name, makeResponse] of [
    ['stream error', () => response(event({ error: { message: 'synthetic failure' } }))],
    ['truncation', () => response(delta('partial'))],
    ['HTTP error', () => new Response('unavailable', { status: 503 })],
    ['wrong content type', () => new Response('{"error":"failure"}')],
    ['network failure', () => { throw new Error('offline'); }],
  ]) {
    await t.test(name, async () => {
      const h = harness((_url, _opts, index) => index === 0 ? makeResponse() : response(delta('ok') + done));
      h.input.value = 'failed prompt';
      await h.run('sendChat()');
      assert.equal(h.chat.messages.length, 0);
      assert.equal(h.input.value, 'failed prompt');
      assert.match(h.targets[0].stats.textContent, /chat.error/);
      assert.equal(h.chat.inflight, null);
      assert.deepEqual(h.headers, [true, false]);
      h.input.value = 'next prompt';
      await h.run('sendChat()');
      assert.deepEqual(h.calls[1].messages, [{ role: 'user', content: 'next prompt' }]);
    });
  }
});

test('stopped partial replies are flushed and retained in next-request history', async () => {
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  const h = harness((_url, options, index) => index ? response(delta('next') + done) : new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encode(delta('partial answer')));
      options.signal.addEventListener('abort', () => controller.error(new DOMException('Stopped', 'AbortError')));
      ready();
    },
  }), { headers: { 'Content-Type': 'text/event-stream' } }));
  h.input.value = 'first';
  const pending = h.run('sendChat()');
  await started;
  // Let the queued chunk reach the parser, without waiting for its render timer.
  await new Promise(resolve => setImmediate(resolve));
  h.run('stopChat()');
  await pending;
  assert.equal(h.targets[0].body.text, 'partial answer');
  assert.equal(h.chat.messages[1].status, 'cancelled');
  assert.match(h.targets[0].stats.textContent, /chat.partial_history/);
  h.input.value = 'continue';
  await h.run('sendChat()');
  assert.equal(h.calls[1].messages[1].content, 'partial answer');
});

test('abort before response restores prompt without an empty assistant entry', async () => {
  const h = harness((_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')));
  }));
  h.input.value = 'try again';
  const pending = h.run('sendChat()');
  h.run('stopChat()');
  await pending;
  assert.equal(h.chat.messages.length, 0);
  assert.equal(h.input.value, 'try again');
  assert.match(h.targets[0].stats.textContent, /chat.cancelled/);
});

test('fanout uses lowest-index success despite failures and completion order', async () => {
  const h = harness(async (_url, _opts, index) => {
    if (index === 0) throw new Error('offline');
    if (index === 1) await new Promise(resolve => setTimeout(resolve, 10));
    return response(delta('reply ' + index) + done);
  });
  h.chat.params.fanout = 3;
  h.input.value = 'parallel prompt';
  await h.run('sendChat()');
  assert.equal(h.chat.messages[1].content, 'reply 1');
  assert.match(h.targets[1].stats.textContent, /chat.history_reply/);
  assert.equal(h.calls.length, 3);
  assert.deepEqual(h.calls[0], h.calls[2]);
  assert.equal(h.calls[0].stream_options.include_usage, true);
});

test('stats use server tokens including zero, otherwise labelled character counts', async () => {
  const h = harness(() => response(delta('many words')
    + event({ usage: { prompt_tokens: 12, completion_tokens: 0 } }) + done));
  h.input.value = 'prompt';
  await h.run('sendChat()');
  assert.match(h.targets[0].stats.textContent, /12 in \/ 0 out/);
  assert.match(h.run('chatStreamStats({ content: "abc", reasoning: "de" }, Date.now())'), /5 chat.chars/);
  assert.doesNotMatch(h.run('chatStreamStats({ content: "abc", reasoning: "" }, Date.now())'), /tok/);
});

test('a second send cannot start while a response is inflight', async () => {
  let finish;
  const h = harness(() => new Promise(resolve => { finish = resolve; }));
  h.input.value = 'first';
  const pending = h.run('sendChat()');
  h.input.value = 'second';
  await h.run('sendChat()');
  assert.equal(h.calls.length, 1);
  finish(response(delta('ok') + done));
  await pending;
  assert.equal(plain(h.chat.messages)[0].content, 'first');
});

test('a failed pending turn does not evict the oldest retained successful turn', async () => {
  const h = harness(() => response(delta('truncated')));
  for (let i = 0; i < 40; i++) h.chat.messages.push(
    { role: 'user', content: 'user ' + i }, { role: 'assistant', content: 'answer ' + i });
  const before = plain(h.chat.messages);
  h.input.value = 'new failed turn';
  await h.run('sendChat()');
  assert.deepEqual(plain(h.chat.messages), before);
});

test('only the selected stopped fanout reply is labelled as kept in history', async () => {
  let count = 0, ready;
  const started = new Promise(resolve => { ready = resolve; });
  const h = harness((_url, options, index) => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encode(delta('partial ' + index)));
      options.signal.addEventListener('abort', () => controller.error(new DOMException('Stopped', 'AbortError')));
      if (++count === 2) ready();
    },
  }), { headers: { 'Content-Type': 'text/event-stream' } }));
  h.chat.params.fanout = 2;
  h.input.value = 'parallel';
  const pending = h.run('sendChat()');
  await started;
  await new Promise(resolve => setImmediate(resolve));
  h.run('stopChat()');
  await pending;
  assert.equal(h.chat.messages[1].content, 'partial 0');
  assert.match(h.targets[0].stats.textContent, /chat.partial_history/);
  assert.doesNotMatch(h.targets[1].stats.textContent, /chat.partial_history/);
  assert.match(h.targets[1].stats.textContent, /chat.excluded/);
});
