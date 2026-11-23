const { test, expect } = require('@playwright/test');

test('long history windows draw mixed-rate samples and retain explicit collection gaps', async ({ page }) => {
  await page.route('**/api/history/metrics?**', route => {
    const hours = Number(new URL(route.request().url()).searchParams.get('hours'));
    const start = Date.now() - hours * 3600000;
    const points = Array.from({ length: 12 }, (_, i) => ({ t: start + i * 110000, v: i % 3 ? 30 : 0,
      ...(i === 6 ? { gapBefore: true } : {}) }));
    for (let i = 1; i <= 40; i++) points.push({ t: start + 1210000 + i * 250, v: i % 4 });
    return route.fulfill({ json: { points, explicitGaps: true } });
  });
  await page.goto('/');
  await page.locator('#metric-predicted_tps .metric-open').click();
  for (const hours of [24, 6, 1]) {
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: hours + 'h', exact: true }).click();
    await expect(dialog.locator('[role=status]')).toContainText('52 samples');
    const geometry = await dialog.locator('svg').evaluate(svg => ({
      breaks: svg.chartModel.geometry.vertices.filter(p => p.start).length,
      line: svg.querySelector('.spark-line').getAttribute('d'),
    }));
    expect(geometry.breaks).toBe(2);
    expect((geometry.line.match(/L/g) || []).length).toBeGreaterThan(40);
  }
});
