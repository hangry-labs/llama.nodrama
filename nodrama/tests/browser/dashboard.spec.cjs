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
  for (const width of [320, 390, 900, 1440]) {
    test(`demo ${mode} renders charts, cache and readable options at ${width}px`, async ({ page }) => {
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/?demo=' + mode);
      await expect(page.locator('header.app .diagnostics-nav')).toHaveCount(1);
      await expect(page.locator('main .diagnostics-nav')).toHaveCount(0);
      await expect(page.locator('#status-text')).toHaveText('Demo');
      await expect(page.locator('[data-id="demo-mode"]')).toHaveCount(0);
      await expect(page.locator('#status-text')).toHaveAttribute('title', /synthetic/);
      await expect(page.locator('#metric-predicted_tps .spark-line')).toHaveCount(1);
      await expect(page.locator('.metric-card:visible')).toHaveCount(15);
      const groups = await page.locator('.metric-group').evaluateAll(nodes => nodes.map(node =>
        [...node.querySelectorAll('.metric-card')].map(card => card.id.replace('metric-', ''))));
      expect(groups).toEqual([
        ['predicted_tps', 'predicted_total', 'predicted_seconds_total', 'decode_total'],
        ['prompt_tps', 'prompt_total', 'prompt_seconds_total', 'prompt_cached_total'],
        ['processing', 'deferred', 'busy_slots'],
        ['context_used', 'n_tokens_max', 'container_cpu', 'server_uptime'],
      ]);
      if (width < 1150) {
        const hierarchy = await page.evaluate(() => ({
          primaryBottom: Math.max(...[...document.querySelectorAll('.metric-primary')].map(n => n.getBoundingClientRect().bottom)),
          relatedTop: Math.min(...[...document.querySelectorAll('.metric-related')].map(n => n.getBoundingClientRect().top)),
        }));
        expect(hierarchy.primaryBottom).toBeLessThanOrEqual(hierarchy.relatedTop);
      }
      await expect(page.locator('#metric-predicted_tps .metric-note')).toContainText('5m');
      if (width === 1440) {
        const overview = await page.locator('#metrics-section').boundingBox();
        expect(overview.height).toBeLessThan(500);
      }
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
  await page.locator('#metric-predicted_tps .metric-open').click();
  await expect(page.locator('[role=dialog] .spark-line')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('[role=dialog]')).toHaveCount(0);
  await page.locator('#metric-predicted_tps .info-btn').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('[role=dialog]')).toHaveCount(1);
  await expect(page.locator('[role=dialog] .metric-history-chart')).toHaveCount(0);
});

test('highlighted Chat link opens the panel and focuses its composer', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?demo=router');
  await expect(page.locator('#chat-body')).toBeHidden();
  await page.locator('header.app .nav-chat').click();
  await expect(page.locator('#chat-body')).toBeVisible();
  await expect(page.locator('#chat-input')).toBeFocused();
  await expect(page.locator('.chat-description')).toContainText('diagnostics');
  await page.locator('#settings-button').click();
  await expect(page.locator('.settings-storage')).toContainText('Demo settings');
});

test('settings show the server storage path without making it editable', async ({ page }) => {
  await page.route('**/api/settings', route => route.fulfill({ json: {
    server: 'http://127.0.0.1:8080', listen: ':39080', logPath: '', rawProxy: false,
    pollIntervalMs: 1000, timeoutMs: 5000, settingsPath: '/example/config/llama-nodrama/settings.json',
  } }));
  await page.goto('/');
  await page.locator('#settings-button').click();
  await expect(page.locator('.settings-storage code')).toHaveText('/example/config/llama-nodrama/settings.json');
  await expect(page.locator('.settings-storage input')).toHaveCount(0);
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

test('top-bar links clear the sticky header and live mode retains Online status', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?demo=1');
  const snapshot = await page.evaluate(async () => (await fetch('/api/snapshot')).json());
  await page.locator('header.app .diagnostics-nav a[href="#slots-section"]').click();
  await expect.poll(() => page.locator('#slots-section .card').evaluate(element => Math.round(element.getBoundingClientRect().top))).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => {
    const card = document.querySelector('#slots-section .card').getBoundingClientRect();
    const header = document.querySelector('header.app').getBoundingClientRect();
    return card.top >= header.bottom - 1 && card.top <= header.bottom + 20;
  })).toBe(true);
  await page.route('**/api/snapshot', route => route.fulfill({ json: { ...snapshot, server: 'http://127.0.0.1:8080' } }));
  await page.goto('/');
  await expect(page.locator('#status-text')).toHaveText('Online');
  await expect(page.locator('#status-text')).not.toHaveClass(/demo/);
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

test('chart, cache and query focus survive telemetry updates', async ({ page }) => {
  await page.goto('/?demo=router');
  const chart = page.locator('#metric-predicted_tps svg');
  await chart.focus();
  await page.keyboard.press('ArrowLeft');
  const selected = await chart.getAttribute('aria-valuetext');
  const before = await page.evaluate(() => {
    window.testChart = document.querySelector('#metric-predicted_tps svg');
    window.testCache = document.querySelector('.cache-segment[data-cache-key="demo-cache-0"]');
    window.testQuery = document.querySelector('.query-card[data-query-id="demo-query-0"]');
    return state.lastUpdate;
  });
  await expect.poll(() => page.evaluate(() => state.lastUpdate)).not.toBe(before);
  expect(await page.evaluate(() => window.testChart === document.querySelector('#metric-predicted_tps svg'))).toBe(true);
  await expect(chart).toBeFocused();
  await expect(chart).toHaveAttribute('aria-valuetext', selected);
  await expect(page.locator('#spark-tooltip')).toBeVisible();
  await page.locator('.cache-segment[data-cache-key="demo-cache-0"]').focus();
  const second = await page.evaluate(() => state.lastUpdate);
  await expect.poll(() => page.evaluate(() => state.lastUpdate)).not.toBe(second);
  expect(await page.evaluate(() => document.activeElement === window.testCache)).toBe(true);
  await page.locator('.query-card[data-query-id="demo-query-0"]').focus();
  const third = await page.evaluate(() => state.lastUpdate);
  await expect.poll(() => page.evaluate(() => state.lastUpdate)).not.toBe(third);
  expect(await page.evaluate(() => document.activeElement === window.testQuery)).toBe(true);
});

test('live chart peaks scroll steadily without rebuilding their shape', async ({ page }) => {
  await page.goto('/?demo=1');
  await page.clock.install();
  await page.evaluate(() => stopAllPollers());
  await page.clock.pauseAt(await page.evaluate(() => new Date(Date.now() + 1000).toISOString()));
  await page.evaluate(() => {
    stopAllPollers();
    window.motionHost = el('div', { style: 'position:fixed;top:140px;left:20px;width:400px;height:80px;z-index:99' });
    document.body.appendChild(window.motionHost);
    window.motionOptions = { min: 0, max: 10, height: 80, interactive: true };
    // Four 250ms backend samples arrive together on a 1s browser poll.
    const samples = start => Array.from({ length: 9 }, (_, index) => ({
      t: start + index * 250, v: start + index * 250 === 2000 ? 10 : 0,
    }));
    window.motionData = samples(2000);
    updateSparkline(window.motionHost, samples(1000), window.motionOptions);
    window.motionSVG = window.motionHost.querySelector('svg');
    window.motionSVG.chartModel.changedAt = performance.now() - 1000;
    updateSparkline(window.motionHost, window.motionData, window.motionOptions);
    window.motionSVG.focus();
  });
  const peak = () => page.evaluate(() => {
    const model = window.motionSVG.chartModel;
    const vertex = model.drawn.find(point => point.t === 2000);
    return { x: vertex.x, y: vertex.y, v: vertex.v, active: model.frame !== null,
      marker: Number(model.marker.getAttribute('cx')) };
  });
  await page.keyboard.press('Home');
  await page.clock.runFor(250);
  const first = await peak();
  await page.clock.runFor(250);
  const second = await peak();
  await page.clock.runFor(250);
  const third = await peak();
  for (const frame of [first, second, third]) {
    expect(frame.y).toBe(5);
    expect(frame.v).toBe(10);
    expect(frame.active).toBe(true);
    expect(frame.marker).toBeCloseTo(frame.x, 5);
  }
  expect(first.x).toBeGreaterThan(second.x);
  expect(second.x).toBeGreaterThan(third.x);
  expect(Math.abs((first.x - second.x) - (second.x - third.x))).toBeLessThan(5);
  expect(await page.evaluate(() => {
    const frame = window.motionSVG.chartModel.frame;
    updateSparkline(window.motionHost, window.motionData, window.motionOptions);
    return frame === window.motionSVG.chartModel.frame && window.motionSVG === window.motionHost.querySelector('svg');
  })).toBe(true);
  await page.getByRole('button', { name: 'Pause updates', exact: true }).click();
  expect(await page.evaluate(() => window.motionSVG.chartModel.frame)).toBe(null);
  const paused = await page.evaluate(() => window.motionSVG.chartModel.line.getAttribute('d'));
  await page.clock.runFor(1000);
  expect(await page.evaluate(() => window.motionSVG.chartModel.line.getAttribute('d'))).toBe(paused);
});

test('switching to reduced motion settles an active chart immediately', async ({ page }) => {
  await page.goto('/?demo=1');
  await page.clock.install();
  await page.evaluate(() => stopAllPollers());
  await page.clock.pauseAt(await page.evaluate(() => new Date(Date.now() + 1000).toISOString()));
  await page.evaluate(() => {
    stopAllPollers();
    window.motionHost = el('div', { style: 'position:fixed;top:140px;left:20px;width:400px;height:80px;z-index:99' });
    document.body.appendChild(window.motionHost);
    const points = [{ t: 1000, v: 0 }, { t: 2000, v: 10 }, { t: 3000, v: 0 }];
    updateSparkline(window.motionHost, points, { min: 0 });
    window.motionSVG = window.motionHost.querySelector('svg');
    window.motionSVG.chartModel.changedAt = performance.now() - 1000;
    updateSparkline(window.motionHost, [...points, { t: 4000, v: 2 }], { min: 0 });
  });
  await page.clock.runFor(250);
  expect(await page.evaluate(() => window.motionSVG.chartModel.frame !== null)).toBe(true);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.runFor(20);
  expect(await page.evaluate(() => {
    const model = window.motionSVG.chartModel;
    return model.frame === null && JSON.stringify(model.drawn) === JSON.stringify(model.geometry.vertices);
  })).toBe(true);
});

test('history windows, sample statistics and keyboard inspection are usable', async ({ page }) => {
  await page.goto('/?demo=1');
  await page.locator('#metric-predicted_tps .metric-open').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('.history-stat')).toHaveCount(3);
  await expect(dialog.locator('.history-axis')).not.toBeEmpty();
  await expect(dialog.locator('.history-y-axis > span')).toHaveCount(3);
  await dialog.getByRole('button', { name: '1h', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '1h', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(dialog.locator('[role=status]')).toContainText('samples');
  const chart = dialog.getByRole('slider');
  await chart.focus();
  await page.keyboard.press('Home');
  await expect(chart).toHaveAttribute('aria-valuenow', '0');
  await expect(page.locator('#spark-tooltip')).toBeVisible();
  await page.keyboard.press('End');
  expect(Number(await chart.getAttribute('aria-valuenow'))).toBeGreaterThan(0);
  await page.keyboard.press('Escape');
  await expect(page.locator('#spark-tooltip')).toBeHidden();
});

test('320px localized layout and reduced-motion charts remain usable', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/?demo=1&lang=es');
  const chart = page.locator('#metric-predicted_tps svg');
  await expect(chart).toHaveCount(1);
  await chart.focus();
  await page.keyboard.press('Home');
  const tooltip = await page.locator('#spark-tooltip').boundingBox();
  expect(tooltip.x).toBeGreaterThanOrEqual(0);
  expect(tooltip.x + tooltip.width).toBeLessThanOrEqual(320);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const before = await page.evaluate(() => state.lastUpdate);
  await expect.poll(() => page.evaluate(() => state.lastUpdate)).not.toBe(before);
  expect(await chart.evaluate(element => element.chartModel.frame)).toBe(null);
  await expect(page.locator('#metric-processing')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('pause and telemetry-loss states do not claim to be live', async ({ page }) => {
  await page.goto('/?demo=1');
  await page.getByRole('button', { name: 'Pause updates', exact: true }).click();
  await expect(page.locator('#diagnostics-state')).toHaveText('Updates paused');
  const before = await page.evaluate(() => state.lastUpdate);
  await page.waitForTimeout(1200);
  expect(await page.evaluate(() => state.lastUpdate)).toBe(before);
  await page.getByRole('button', { name: 'Resume updates', exact: true }).click();
  await expect.poll(() => page.evaluate(() => state.lastUpdate)).not.toBe(before);
  await page.evaluate(() => {
    window.workingDemoFetch = window.fetch;
    window.fetch = async () => { throw new Error('Synthetic connection loss'); };
  });
  await expect(page.locator('#diagnostics-state')).toHaveText('Telemetry unavailable');
  await expect(page.locator('#metric-predicted_tps .metric-note')).toContainText('Last observed');
  await page.evaluate(() => { window.fetch = window.workingDemoFetch; });
  await expect(page.locator('#diagnostics-state')).toHaveText('Live telemetry');
});

test('unknown prompt totals and unlimited generation do not show false progress', async ({ page }) => {
  await page.goto('/?demo=1');
  const result = await page.evaluate(() => {
    const node = makeSlotNode({ id: 99 });
    updateSlotNode(node, { id: 99, isProcessing: true, contextTokens: 8192,
      promptTokens: 0, promptProgress: 0, decodedTokens: 50, remainingTokens: -1, generationProgress: 0 });
    return ['prompt', 'generation'].map(phase => ({
      value: node.querySelector('[data-phase="' + phase + '"]').getAttribute('aria-valuenow'),
      text: node.querySelector('[data-phase-value="' + phase + '"]').textContent,
    }));
  });
  expect(result).toEqual([{ value: null, text: '—' }, { value: null, text: '—' }]);
});

test.describe('touch inspection', () => {
  test.use({ hasTouch: true });
  test('a tapped sample stays readable until another control is touched', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/?demo=1');
    const chart = page.locator('#metric-predicted_tps svg');
    const bounds = await chart.boundingBox();
    await page.touchscreen.tap(bounds.x + bounds.width * 0.5, bounds.y + bounds.height * 0.5);
    await expect(page.locator('#spark-tooltip')).toBeVisible();
    await expect(chart).toBeFocused();
    await page.getByRole('button', { name: 'Pause updates' }).tap();
    await expect(page.locator('#spark-tooltip')).toBeHidden();
  });
});
