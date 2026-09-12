import { defineConfig } from '@playwright/test'

// Electron e2e home: Playwright drives the built app (out/main via package.json
// main), screenshots attach to the HTML report. No browser download needed for
// Electron mode — the installed Electron binary is the target.
export default defineConfig({
  testDir: './e2e',
  timeout: 120000,
  workers: 1,
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: {
    screenshot: 'only-on-failure',
    trace: 'off',
    video: 'off'
  }
})
