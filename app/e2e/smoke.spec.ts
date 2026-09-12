import { test, expect } from '@playwright/test'
import { _electron as electron } from 'playwright'
import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Smoke: launches the built app in an isolated user-data dir, waits for first
// paint, takes PNG + JPEG screenshots into the HTML report, and logs timings.
// Proves Playwright+Electron works and measures screenshot cost per run.
// eslint-disable-next-line no-empty-pattern
test('smoke: launch + screenshot', async ({}, testInfo) => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'agento-e2e-'))
  const t0 = performance.now()

  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userDataDir}`],
    timeout: 60000,
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: '0' } as Record<string, string>
  })
  const tLaunched = performance.now()

  const page = await app.firstWindow({ timeout: 60000 })
  const tWindow = performance.now()

  // Let React paint before shooting.
  await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {})
  await page.waitForTimeout(2000)
  const tReady = performance.now()

  const pngPath = testInfo.outputPath('agento-smoke.png')
  const tPng0 = performance.now()
  await page.screenshot({ path: pngPath, type: 'png', animations: 'disabled' })
  const tPng1 = performance.now()

  const jpegPath = testInfo.outputPath('agento-smoke.jpeg')
  const tJpeg0 = performance.now()
  await page.screenshot({ path: jpegPath, type: 'jpeg', quality: 80, animations: 'disabled' })
  const tJpeg1 = performance.now()

  // Second PNG back-to-back = steady-state cost (caches warm).
  const png2Path = testInfo.outputPath('agento-smoke-2.png')
  const tPng20 = performance.now()
  await page.screenshot({ path: png2Path, type: 'png', animations: 'disabled' })
  const tPng21 = performance.now()

  const pngBytes = statSync(pngPath).size
  const jpegBytes = statSync(jpegPath).size

  testInfo.attachments.push({ name: 'agento-smoke-png', path: pngPath, contentType: 'image/png' })
  testInfo.attachments.push({
    name: 'agento-smoke-jpeg',
    path: jpegPath,
    contentType: 'image/jpeg'
  })

  console.log(
    'E2E_TIMINGS ' +
      JSON.stringify({
        launchMs: Math.round(tLaunched - t0),
        firstWindowMs: Math.round(tWindow - tLaunched),
        paintWaitMs: Math.round(tReady - tWindow),
        totalToReadyMs: Math.round(tReady - t0),
        pngMs: Math.round(tPng1 - tPng0),
        jpegMs: Math.round(tJpeg1 - tJpeg0),
        pngSteadyMs: Math.round(tPng21 - tPng20),
        pngBytes,
        jpegBytes,
        title: await page.title().catch(() => '(no title)')
      })
  )

  await expect(page.locator('body')).toBeVisible({ timeout: 15000 })
  await app.close()
})
