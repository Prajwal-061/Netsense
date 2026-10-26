import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { defineConfig } from '@playwright/test'
import { FAKE_API_URL } from './e2e/settings.ts'

// Browser tests: the real dashboard in headless Chromium, with the API faked
// inside the browser (e2e/fakeApi.ts), so no backend or lab is needed.

const PORT = 5179

// Chromium's system libraries, unpacked without root by scripts/chromium-libs.sh.
const libs = join(homedir(), '.cache/netsense-chromium-libs/root/usr/lib/x86_64-linux-gnu')
const env = existsSync(libs)
  ? { ...process.env, LD_LIBRARY_PATH: [libs, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') }
  : undefined

export default defineConfig({
  testDir: 'e2e',
  outputDir: 'test-results',
  fullyParallel: true,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    browserName: 'chromium',
    viewport: { width: 1440, height: 900 },
    // No colour transitions or pulses mid-check: axe reads the final colours.
    reducedMotion: 'reduce',
    launchOptions: env ? { env } : {},
  },
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    env: { VITE_API_URL: FAKE_API_URL },
    reuseExistingServer: false,
  },
})
