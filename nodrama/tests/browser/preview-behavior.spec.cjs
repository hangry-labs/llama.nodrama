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
  await expect(page.locator('#status-text #server-uptime-value')).not.toHaveText('—');
  await expect(page.locator('#server-uptime')).not.toContainText('llama.cpp');
  await expect(page.locator('.nav-chat')).not.toHaveAttribute('aria-current', 'location');
  await page.locator('.nav-chat').click();
  await expect(page.locator('.nav-chat')).toHaveAttribute('aria-current', 'location');
  await page.locator('a[href="#metrics-section"]').click();
  await expect(page.locator('a[href="#metrics-section"]')).toHaveAttribute('aria-current', 'location');
  await expect(page.locator('.nav-chat')).not.toHaveAttribute('aria-current', 'location');
});

test('updates check only on refresh, highlight versions and install only on Update now', async ({ page }) => {
  let installs = 0, checks = 0;
  await page.route('**/api/update/check*', route => { checks++; return route.fulfill({ json: {
    channel: 'stable', version: 'v0.6.1', available: true,
    asset: { bytes: 123 },
  } }); });
  await page.route('**/api/update/install', route => { installs++; return route.fulfill({ status: 400, body: 'Synthetic verification failure' }); });
  await page.goto('/');
  await expect(page.locator('#version-display')).toHaveText('v0.6.0-SNAPSHOT');
  await expect(page.locator('#version-display')).not.toHaveAttribute('title', /built|commit|\d\d:\d\d/);
  await expect(page.locator('#update-now')).toBeHidden();
  await page.locator('#version-display').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('[role=status]')).toContainText('Click refresh');
  await expect(dialog.getByRole('combobox')).toHaveCount(0);
  expect(checks).toBe(0);
  expect(installs).toBe(0);
  await expect(dialog).toContainText('history and peaks reset');
  await dialog.getByRole('button', { name: /Check for updates/ }).click();
  await expect(dialog.locator('[role=status]')).toContainText('v0.6.1');
  await expect(page.locator('#version-display')).toHaveClass(/update-available/);
  await expect(page.locator('#update-now')).toBeVisible();
  expect(checks).toBe(1);
  expect(installs).toBe(0);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await page.locator('#version-display').click();
  await expect(dialog.locator('[role=status]')).toContainText('v0.6.1');
  expect(checks).toBe(1);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await page.setViewportSize({ width: 320, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('#update-now').click();
  await expect(dialog.locator('[role=status]')).toContainText('Synthetic verification failure');
  expect(installs).toBe(1);
  expect(checks).toBe(1);
});

test('refresh checks regular releases and clears the highlight when up to date', async ({ page }) => {
  let checks = 0;
  await page.route('**/api/update/check*', route => {
    checks++;
    return route.fulfill({ json: { channel: 'stable', version: 'v0.6.1', available: checks === 1 } });
  });
  await page.goto('/');
  await page.locator('#update-check').click();
  const dialog = page.getByRole('dialog');
  await expect(page.locator('#version-display')).toHaveClass(/update-available/);
  await expect(dialog.getByRole('combobox')).toHaveCount(0);
  expect(checks).toBe(1);
  await dialog.getByRole('button', { name: /Check for updates/ }).click();
  await expect(dialog.locator('[role=status]')).toContainText('Up to date');
  await expect(page.locator('#update-now')).toBeHidden();
  await expect(page.locator('#version-display')).not.toHaveClass(/update-available/);
  expect(checks).toBe(2);
  await expect(dialog.getByRole('button', { name: 'Update now', exact: true })).toBeHidden();
});

test('long history explains peak sampling and retains the current value', async ({ page }) => {
  const t = Date.now();
  const points = Array.from({ length: 121 }, (_, i) => ({ t: t - 600000 + i * 5000, v: i === 70 ? 72 : 5 }));
  points.push({ t: t + 250, v: 0.2 });
  await page.route('**/api/history/metrics?**', route => route.fulfill({ json: { points, explicitGaps: true, aggregation: 'peak', pointSec: 5 } }));
  await page.goto('/');
  await page.locator('#metric-container_cpu .metric-open').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('.metric-history-modal > [role=status]')).toContainText('5s peak samples');
  await expect(dialog.locator('.history-stat').first()).toContainText('0.20');
  await expect(dialog.locator('.history-stat').nth(1)).toContainText('Sample average');
  expect(await dialog.locator('svg').evaluate(svg => svg.chartModel.geometry.vertices.filter(v => v.start).length)).toBe(1);
});
