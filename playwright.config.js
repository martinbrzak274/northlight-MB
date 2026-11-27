// Playwright settings. The tests are in tests/e2e.
//
//   SITE_URL    the address of the site to test, for example https://example.github.io/northlight-MB/
//               When it is not set, a small local server (tools/serve.js) is started and used.
//   PORT        the port of that local server (default 4173)
//   PW_CHANNEL  use an installed browser instead of Playwright's own, for example msedge or chrome
const { defineConfig, devices } = require('@playwright/test');

const port = Number(process.env.PORT) || 4173;
const localUrl = 'http://127.0.0.1:' + port + '/';
// A trailing slash keeps a path such as /northlight-MB/ when the tests open 'index.html'.
const baseURL = (process.env.SITE_URL || localUrl).replace(/\/*$/, '/');
const useLocalServer = !process.env.SITE_URL;

module.exports = defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  // The pages are graphical (blur, gradients, animation). Many browsers at once on one machine starve each other
  // and tests time out while loading, so keep the number small.
  workers: process.env.CI ? 2 : 4,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    // The pages animate (ambient light, scroll reveals, floating shapes). The tests check what the pages do, not
    // how they move, so they run with reduced motion, which the pages honour. tests/e2e/motion.spec.js turns
    // motion back on to check the animated side.
    reducedMotion: 'reduce',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  projects: [
    {
      name: 'chromium',
      testIgnore: /secrets\.spec\.js/,
      use: { ...devices['Desktop Chrome'], channel: process.env.PW_CHANNEL || undefined }
    },
    {
      // Checks the files in the repository. It needs no browser.
      name: 'repo',
      testMatch: /secrets\.spec\.js/
    }
  ],
  webServer: useLocalServer
    ? {
        command: 'node tools/serve.js',
        url: localUrl,
        env: { PORT: String(port) },
        reuseExistingServer: !process.env.CI,
        timeout: 15000
      }
    : undefined
});
