const { test, expect } = require('@playwright/test');

// Synthetic blue square; no user photographs, prompts or local paths.
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAI0lEQVR4nGPUmHaHgRTARJJqhlENxAEmItXBwagGYgDJoQQAGBMButBMGzgAAAAASUVORK5CYII=', 'base64');
const image = { name: 'synthetic.png', mimeType: 'image/png', buffer: pixel };

async function pasteImage(page) {
  await page.locator('#chat-input').evaluate((input, data) => {
    const clipboard = new DataTransfer();
    clipboard.items.add(new File([Uint8Array.from(atob(data), c => c.charCodeAt(0))], 'pasted.png', { type: 'image/png' }));
    input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }));
  }, pixel.toString('base64'));
}

test('paste images and attach text files with compact previews, payloads and history', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?demo=1');
  await page.locator('.nav-chat').click();
  await pasteImage(page);
  await expect(page.locator('.chat-attachment img')).toHaveCount(1);
  await expect(page.locator('#chat-attachment-status')).toContainText('does not support images');
  await page.locator('#chat-files').setInputFiles({ name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from('Synthetic attachment text') });
  await expect(page.locator('.chat-attachment')).toHaveCount(2);
  // Demo does not claim real vision support. Capture outgoing payload at fetch.
  await page.evaluate(() => {
    stopAllPollers();
    state.props.modalities.vision = true;
    state.mode = 'single';
    const original = window.fetch;
    window.sent = [];
    window.fetch = async (url, options) => {
      if (String(url).includes('/api/chat/completions')) {
        window.sent.push(JSON.parse(options.body));
        return new Response('data: {"choices":[{"delta":{"content":"Synthetic reply"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          { headers: { 'Content-Type': 'text/event-stream' } });
      }
      return original(url, options);
    };
  });
  await page.locator('#chat-input').fill('Review attachments');
  await page.locator('#chat-send').click();
  await expect.poll(() => page.evaluate(() => !!chat.inflight)).toBe(false);
  const parts = await page.evaluate(() => window.sent[0].messages[0].content);
  expect(parts[0].text).toContain('Synthetic attachment text');
  expect(parts[1].type).toBe('image_url');
  expect(parts[1].image_url.url).toMatch(/^data:image\/(png|jpeg);base64,/);
  await expect(page.locator('.chat-msg.user img')).toHaveCount(1);
  await expect(page.locator('.chat-msg.user')).toContainText('notes.md');
  await expect(page.locator('#chat-attachments')).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('#chat-input').fill('Continue');
  await page.locator('#chat-send').click();
  await expect.poll(() => page.evaluate(() => window.sent.length)).toBe(2);
  expect(await page.evaluate(() => window.sent[1].messages[0].content)).toEqual(parts);
});

test('picker, removal, file drop and unsupported files preserve the draft', async ({ page }) => {
  await page.goto('/?demo=1');
  await page.locator('.nav-chat').click();
  await page.locator('#chat-input').fill('Keep my draft');
  await page.locator('#chat-files').setInputFiles(image);
  await expect(page.locator('.chat-attachment img')).toHaveCount(1);
  await page.getByRole('button', { name: 'Remove synthetic.png', exact: true }).click();
  await expect(page.locator('#chat-attachments')).toBeHidden();
  await page.locator('.chat-composer').evaluate(composer => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File(['{"synthetic":true}'], 'data.json', { type: 'application/json' }));
    composer.dispatchEvent(new DragEvent('drop', { dataTransfer, bubbles: true, cancelable: true }));
  });
  await expect(page.locator('.chat-attachment')).toContainText('data.json');
  await page.locator('#chat-files').setInputFiles({ name: 'unsupported.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-synthetic') });
  await expect(page.locator('#chat-attachment-status')).toContainText('not supported');
  await expect(page.locator('.chat-attachment')).toHaveCount(1);
  await expect(page.locator('#chat-input')).toHaveValue('Keep my draft');
});

test('failed attachment requests restore previews and plain text paste stays untouched', async ({ page }) => {
  await page.goto('/?demo=1');
  await page.locator('.nav-chat').click();
  const normalPaste = await page.locator('#chat-input').evaluate(input => {
    const clipboard = new DataTransfer(); clipboard.setData('text/plain', 'ordinary paste');
    const event = new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true });
    input.dispatchEvent(event); return !event.defaultPrevented;
  });
  expect(normalPaste).toBe(true);
  await page.locator('#chat-files').setInputFiles({ name: 'example.txt', mimeType: 'text/plain', buffer: Buffer.from('synthetic context') });
  await expect(page.locator('.chat-attachment')).toHaveCount(1);
  await page.evaluate(() => {
    const original = window.fetch;
    window.fetch = (url, options) => String(url).includes('/api/chat/completions')
      ? Promise.resolve(new Response('synthetic unavailable', { status: 503 })) : original(url, options);
  });
  await page.locator('#chat-input').fill('Retry me');
  await page.locator('#chat-send').click();
  await expect.poll(() => page.evaluate(() => !!chat.inflight)).toBe(false);
  await expect(page.locator('#chat-input')).toHaveValue('Retry me');
  await expect(page.locator('.chat-attachment')).toContainText('example.txt');
  expect(await page.evaluate(() => chat.messages.length)).toBe(0);
});
