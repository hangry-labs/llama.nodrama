const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests/browser',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:39190', browserName: 'chromium', trace: 'retain-on-failure' },
  webServer: {
    command: 'go run . --server http://127.0.0.1:1 --listen 127.0.0.1:39190',
    url: 'http://127.0.0.1:39190/api/health',
    timeout: 120000,
    reuseExistingServer: false,
  },
});
