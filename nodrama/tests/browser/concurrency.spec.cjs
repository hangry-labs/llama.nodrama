const { test, expect } = require('@playwright/test');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { execFileSync, spawn } = require('node:child_process');

// Use real sockets: Playwright route mocks cannot reproduce the HTTP/1
// connection pool that originally let six chat streams block monitoring.
test('eight chat requests queue behind three slots without starving snapshots', async ({ page }) => {
  test.setTimeout(60000);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nodrama-concurrency-'));
  const binary = path.join(directory, process.platform === 'win32' ? 'dashboard.exe' : 'dashboard');
  let app, active = 0, seen = 0, released = false;
  const queue = [], jobs = new Set();
  const json = (res, value) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
  const event = value => 'data: ' + JSON.stringify(value) + '\n\n';
  function drain() {
    while (active < 3 && queue.length) {
      const job = queue.shift();
      if (job.closed) continue;
      job.active = true; active++;
      job.res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      job.res.write(event({ choices: [{ delta: { content: 'started ' } }] }));
      if (released) finish(job);
    }
  }
  function close(job) {
    if (job.closed) return;
    job.closed = true; jobs.delete(job);
    if (job.active) active--;
    const index = queue.indexOf(job);
    if (index >= 0) queue.splice(index, 1);
    drain();
  }
  function finish(job) {
    if (job.closed || !job.active) return;
    job.res.end(event({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }) + 'data: [DONE]\n\n');
    close(job);
  }
  const upstream = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      req.resume();
      req.on('end', () => {
        seen++;
        const job = { res, active: false, closed: false };
        jobs.add(job); queue.push(job);
        res.on('close', () => close(job));
        drain();
      });
    } else if (req.url === '/health') json(res, { status: 'ok' });
    else if (req.url === '/props') json(res, { model_alias: 'synthetic', n_ctx: 3072, total_slots: 3 });
    else if (req.url === '/v1/models') json(res, { data: [{ id: 'synthetic' }] });
    else if (req.url === '/slots') json(res, Array.from({ length: 3 }, (_, id) => ({ id, n_ctx: 1024, is_processing: id < active })));
    else if (req.url === '/metrics') {
      res.setHeader('Content-Type', 'text/plain');
      res.end(`llamacpp:requests_processing ${active}\nllamacpp:requests_deferred ${queue.length}\n`);
    } else { res.statusCode = 404; res.end('not available'); }
  });
  let logs = '';
  try {
    upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
    const reserve = net.createServer().listen(0, '127.0.0.1'); await once(reserve, 'listening');
    const port = reserve.address().port;
    await new Promise(resolve => reserve.close(resolve));
    execFileSync('go', ['build', '-o', binary, '.'], { cwd: path.join(__dirname, '../..'), stdio: 'pipe' });
    app = spawn(binary, ['--config-dir', 'none', '--server', `http://127.0.0.1:${upstream.address().port}`,
      '--listen', `127.0.0.1:${port}`, '--poll', '200ms'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [app.stdout, app.stderr]) stream.on('data', chunk => { logs = (logs + chunk).slice(-12000); });
    await expect.poll(async () => {
      try { return (await fetch(`http://127.0.0.1:${port}/api/health`)).ok; } catch { return false; }
    }, { timeout: 10000 }).toBe(true);
    await page.goto(`http://127.0.0.1:${port}/`);
    await expect(page.locator('#status-text')).toHaveText('Online');
    await page.locator('.nav-chat').click();
    await page.locator('#chat-p-fanout').fill('8');
    await page.locator('#chat-p-fanout').dispatchEvent('input');
    await page.locator('#chat-input').fill('Synthetic concurrency check');
    await page.locator('#chat-send').click();
    await expect.poll(() => active).toBe(3);
    const before = await page.evaluate(() => state.lastUpdate);
    await expect.poll(() => page.evaluate(() => state.lastUpdate), { timeout: 8500,
      message: 'Monitoring must remain responsive while all chat streams are held open' }).not.toBe(before);
    await expect.poll(() => seen).toBe(8);
    await expect.poll(() => page.evaluate(() => state.metrics['llamacpp:requests_deferred'])).toBe(5);
    // Hold longer than the old six-second snapshot deadline.
    await page.waitForTimeout(6500);
    await expect(page.locator('#diagnostics-state')).toHaveText('Live telemetry');
    await expect(page.locator('[data-id=snapshot]')).toHaveCount(0);
    released = true;
    for (const job of [...jobs]) finish(job);
    await expect.poll(() => page.evaluate(() => !!chat.inflight)).toBe(false);
    expect(await page.evaluate(() => chat.messages.at(-1).status)).toBe('complete');
    await expect(page.locator('.chat-msg.assistant')).toHaveCount(8);

    released = false;
    await page.locator('#chat-input').fill('Synthetic cancellation check');
    await page.locator('#chat-send').click();
    await expect.poll(() => seen).toBe(16);
    await page.locator('#chat-stop').click();
    await expect.poll(() => page.evaluate(() => !!chat.inflight)).toBe(false);
    await expect.poll(() => jobs.size).toBe(0);
    await expect.poll(async () => {
      const snapshot = await (await page.request.get(`http://127.0.0.1:${port}/api/snapshot`)).json();
      return snapshot.requests.filter(request => request.endedAt).length;
    }).toBe(16);
  } catch (error) {
    error.message += `\nSynthetic upstream: seen=${seen} active=${active} queued=${queue.length}\n${logs}`;
    throw error;
  } finally {
    if (app && app.exitCode === null) { const exited = once(app, 'exit'); app.kill(); await exited; }
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
    if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith('nodrama-concurrency-')) throw new Error('Unexpected test directory');
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
