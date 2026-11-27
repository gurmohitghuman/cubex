import { defineConfig, devices } from '@playwright/test'

// Tests boot the production server (built artifacts) on a non-default port to avoid colliding
// with a dev server. The test always runs against a freshly-reset DB.
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  // On CI a test that fails is tried twice more, never locally (n8n's playwright config); one that passes then shows
  // as flaky in the summary: a bug to fix (WORKFLOW.md 7).
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: 'list',
  use: {
    // The harness sets E2E_BASE to its E2E_PORT, so relative page.request URLs follow it.
    baseURL: process.env.E2E_BASE || 'http://localhost:3099',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})
