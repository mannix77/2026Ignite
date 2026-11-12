// Real-rendering layout checks for the two iPhone sizes named in issue #145 (issue #145):
// overflow, tap targets and safe-area handling that a DOM-only (jsdom) test can't see, since
// jsdom never computes layout. Dev-only: the app itself still ships with zero dependencies.
import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['line'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
  },
  webServer: {
    command: `python3 -m http.server ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 20_000,
    stdout: 'ignore',
    stderr: 'ignore',
  },
  // Chromium only: WebKit (the real iPhone engine) needs system libraries this sandbox can't
  // install (no sudo). CI, with sudo, can add a WebKit project via `npx playwright install-deps
  // webkit` for a closer match; these overflow/tap-target checks are layout bugs, not engine
  // quirks, so Chromium's mobile emulation still catches them everywhere this repo runs tests.
  projects: [
    {
      name: 'iPhone 16e',
      use: {
        ...devices['iPhone 13'],   // same 390x844 @3x viewport as the 16e; only the name differs
        browserName: 'chromium',
        viewport: { width: 390, height: 844 },
      },
    },
    {
      name: 'iPhone 18 Pro Max',
      use: {
        ...devices['iPhone 13'],
        browserName: 'chromium',
        viewport: { width: 440, height: 956 },
        deviceScaleFactor: 3,
      },
    },
  ],
});
