const { test, expect } = require('@playwright/test');

test('returning to a tab snaps the chart before normal scrolling resumes', async ({ page }) => {
  await page.goto('/?demo=1');
  await page.clock.install();
  await page.evaluate(() => {
    stopAllPollers();
    window.resumeHost = el('div', { style: 'position:fixed;top:160px;left:10px;width:400px;height:80px' });
    document.body.appendChild(resumeHost);
    window.resumeData = start => [0, 1, 2].map(i => ({ t: start + i * 1000, v: i }));
    updateSparkline(resumeHost, resumeData(1000), { min: 0, max: 3 });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
    resumeHost.querySelector('svg').chartModel.changedAt = performance.now() - 1000;
    updateSparkline(resumeHost, resumeData(2000), { min: 0, max: 3 });
  });
  expect(await page.evaluate(() => {
    const model = resumeHost.querySelector('svg').chartModel;
    return model.frame === null && JSON.stringify(model.drawn) === JSON.stringify(model.geometry.vertices);
  })).toBe(true);
  await page.clock.runFor(1000);
  expect(await page.evaluate(() => {
    updateSparkline(resumeHost, resumeData(3000), { min: 0, max: 3 });
    return resumeHost.querySelector('svg').chartModel.frame !== null;
  })).toBe(true);
});

test('expanded history refreshes the selected window and stops on close', async ({ page }) => {
  const windows = [];
  await page.route('**/api/history/metrics?**', route => {
    windows.push(new URL(route.request().url()).searchParams.get('hours'));
    const t = Date.now();
    return route.fulfill({ json: { explicitGaps: true, points: [{ t: t - 1000, v: 0 }, { t, v: windows.length }] } });
  });
  await page.goto('/');
  await page.locator('#metric-predicted_tps .metric-open').click();
  const dialog = page.getByRole('dialog');
  await expect.poll(() => windows.length).toBeGreaterThan(1);
  await dialog.getByRole('button', { name: '6h', exact: true }).click();
  await expect.poll(() => windows.filter(w => w === '6').length).toBeGreaterThan(1);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  const count = windows.length;
  await page.waitForTimeout(1300);
  expect(windows.length).toBe(count);
});

test('header shows both uptimes and highlights the visible section', async ({ page }) => {
  await page.goto('/?demo=1');
  await expect(page.locator('#dashboard-uptime-value')).not.toHaveText('—');
  await expect(page.locator('#server-uptime > span')).toHaveText('llama.cpp');
  await expect(page.locator('.nav-chat')).not.toHaveAttribute('aria-current', 'location');
  await page.locator('.nav-chat').click();
  await expect(page.locator('.nav-chat')).toHaveAttribute('aria-current', 'location');
  await page.locator('a[href="#metrics-section"]').click();
  await expect(page.locator('a[href="#metrics-section"]')).toHaveAttribute('aria-current', 'location');
  await expect(page.locator('.nav-chat')).not.toHaveAttribute('aria-current', 'location');
});

test('update dialog checks preview identity and keeps installation explicit', async ({ page }) => {
  let installs = 0;
  await page.route('**/api/update/check?**', route => route.fulfill({ json: {
    channel: 'preview', version: 'v0.6.0-SNAPSHOT', commit: 'a'.repeat(40), available: true,
    asset: { bytes: 123 },
  } }));
  await page.route('**/api/update/install', route => { installs++; return route.fulfill({ status: 400, body: 'Synthetic verification failure' }); });
  await page.goto('/');
  await page.locator('#version-display').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('[role=status]')).toContainText('aaaaaaaa');
  expect(installs).toBe(0);
  await expect(dialog).toContainText('history and peaks reset');
  await dialog.getByRole('button', { name: 'Update and restart', exact: true }).click();
  await expect(dialog.locator('[role=status]')).toContainText('Synthetic verification failure');
  expect(installs).toBe(1);
});
