const { test, expect } = require('@playwright/test');

const pageErrors = new WeakMap();
test.beforeEach(async ({ page }) => {
  const errors = [];
  pageErrors.set(page, errors);
  page.on('pageerror', error => errors.push(error.message));
});
test.afterEach(async ({ page }) => {
  expect(pageErrors.get(page)).toEqual([]);
});

for (const mode of ['1', 'router']) {
  for (const width of [390, 900, 1440]) {
    test(`demo ${mode} renders charts, cache and readable options at ${width}px`, async ({ page }) => {
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/?demo=' + mode);
      await expect(page.locator('#metric-predicted_tps .spark-line')).toHaveCount(1);
      await expect(page.locator('#cache-bar')).toBeVisible();
      await expect(page.locator('#cache-bar .cache-segment.entry')).toHaveCount(3);
      await expect(page.locator('#query-grid .query-card').first()).toBeVisible();
      const layout = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth > innerWidth,
        hiddenVisible: [...document.querySelectorAll('[hidden]')].filter(element => getComputedStyle(element).display !== 'none').length,
        optionHeights: [...document.querySelectorAll('#config-section .option-card')].map(element => element.getBoundingClientRect().height),
        narrowValues: [...document.querySelectorAll('#config-section .option-value')].filter(element => element.getBoundingClientRect().width < 70).length,
      }));
      expect(layout.overflow).toBe(false);
      expect(layout.hiddenVisible).toBe(0);
      expect(Math.max(...layout.optionHeights)).toBeLessThan(150);
      expect(layout.narrowValues).toBe(0);
      const before = await page.evaluate(() => state.slots.map(slot => slot.contextEstimateTokens));
      await expect.poll(() => page.evaluate(() => state.slots.map(slot => slot.contextEstimateTokens))).not.toEqual(before);
      expect(errors).toEqual([]);
    });
  }
}

test('chart history and help dialogs work with mouse and keyboard', async ({ page }) => {
  await page.goto('/?demo=router');
  await page.locator('#metric-predicted_tps').click();
  await expect(page.locator('[role=dialog] .spark-line')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('[role=dialog]')).toHaveCount(0);
  await page.locator('#metric-predicted_tps .info-btn').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('[role=dialog]')).toHaveCount(1);
  await expect(page.locator('[role=dialog] .metric-history-chart')).toHaveCount(0);
});

test('cache segments highlight linked slots and queries; erase/restore updates occupancy', async ({ page }) => {
  await page.goto('/?demo=router');
  await page.locator('.cache-segment[data-cache-key="demo-cache-0"]').hover();
  await expect(page.locator('.slot[data-slot="0"]')).toHaveClass(/cache-highlight/);
  await expect(page.locator('.query-card[data-cache-key="demo-cache-0"]')).toHaveClass(/cache-match-highlight/);
  await page.locator('.slot[data-slot="0"]').getByRole('button', { name: 'Erase KV' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.locator('.cache-segment[data-cache-key="demo-cache-0"]')).toHaveCount(0);
  await page.locator('.slot[data-slot="0"]').getByRole('button', { name: 'Restore KV' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.locator('.cache-segment[data-cache-key="demo-cache-0"]')).toHaveCount(1);
});

test('model actions and settings preserve live log polling', async ({ page }) => {
  await page.goto('/?demo=router');
  await expect(page.locator('#log-view')).toContainText('[demo]');
  const cards = page.locator('#models-section .model-card');
  await cards.nth(1).getByRole('button', { name: 'Load', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(cards.nth(1).locator('.badge.status-loaded')).toHaveCount(1);
  const secondModel = await page.locator('#model-selector option').nth(2).getAttribute('value');
  await page.locator('#model-selector').selectOption(secondModel);
  await expect.poll(() => page.evaluate(() => state.selectedModel)).toBe(secondModel);
  await expect.poll(() => page.evaluate(() => state.pollers.map(poller => poller.name).sort())).toEqual(['log', 'snapshot']);
  await page.locator('#settings-button').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('input[type=url]')).toBeDisabled();
  await dialog.locator('input[type=number]').first().fill('500');
  await dialog.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => state.params.poll)).toBe(500);
  await expect.poll(() => page.evaluate(() => state.pollers.map(poller => poller.name).sort())).toEqual(['log', 'snapshot']);
});

test('chat visibility, reasoning controls and cancellation work on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?demo=1');
  await expect(page.locator('#chat-body')).toBeHidden();
  await page.locator('.chat-head').click();
  await expect(page.locator('#chat-body')).toBeVisible();
  await expect(page.locator('#chat-thinking-effort-label')).toBeHidden();
  await page.locator('#chat-thinking-mode').selectOption('effort');
  await expect(page.locator('#chat-thinking-effort-label')).toBeVisible();
  await page.locator('#chat-input').fill('Synthetic browser cancellation check');
  await page.locator('#chat-send').click();
  await expect(page.locator('#chat-stop')).toBeVisible();
  await expect(page.locator('#chat-send')).toBeHidden();
  await expect(page.locator('.chat-msg.assistant .body')).not.toBeEmpty();
  await page.locator('#chat-stop').click();
  await expect(page.locator('#chat-stop')).toBeHidden();
  await expect(page.locator('#chat-input')).toBeEnabled();
  await expect(page.locator('.chat-msg.assistant .stats')).toContainText('Partial reply kept in history');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('offline mode hides the empty cache bar and reports unavailable upstream', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#status-text')).toHaveText('Offline');
  await expect(page.locator('#cache-bar')).toBeHidden();
  await expect(page.locator('#config-section')).toContainText('No');
  await expect(page.locator('#config-section .option-card')).toHaveCount(0);
});

test('short-screen dialogs keep actions accessible and keyboard focus inside', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 400 });
  await page.goto('/?demo=1');
  await page.locator('#settings-button').click();
  const dialog = page.getByRole('dialog');
  const bounds = await dialog.locator('.modal').boundingBox();
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(400);
  const save = dialog.getByRole('button', { name: 'Save settings' });
  await expect(save).toBeInViewport();
  await save.focus();
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => !!document.activeElement.closest('[role=dialog]'))).toBe(true);
  await page.keyboard.press('Space');
  expect(await page.evaluate(() => state.paused)).toBe(false);
});

test('history reset and log filtering work without breaking pollers', async ({ page }) => {
  await page.goto('/?demo=1');
  await expect(page.locator('#log-view')).toContainText('[demo]');
  await page.locator('#log-section input[type=search]').fill('cache state');
  await expect(page.locator('#log-view .ln:not(.hidden)')).toHaveCount(1);
  await expect(page.locator('#log-view .ln:not(.hidden)')).toContainText('cache state');
  await page.locator('#log-section input[type=search]').fill('');
  await expect(page.locator('#log-view .ln:not(.hidden)')).toHaveCount(5);
  // Keyboard history reset is ignored while editing; leave focus on the body.
  await page.locator('#log-section input[type=search]').blur();
  await page.keyboard.press('r');
  await expect.poll(() => page.evaluate(() => state.history.metrics['nodrama:tokens_predicted_rate'].length)).toBeLessThan(5);
  expect(await page.evaluate(() => state.pollers.map(p => p.name).sort())).toEqual(['log', 'snapshot']);
});
