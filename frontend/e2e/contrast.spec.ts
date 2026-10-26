// Every page, in both themes, checked by axe-core for text whose contrast
// with its background is below WCAG AA (4.5:1, or 3:1 for large text).
// Dark-theme screenshots are saved to test-results/screenshots/ for a look.

import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { overlappedContrastProblems } from './contrast'
import { HttpError, ROUTES, fakeApi } from './fakeApi'

interface PageCase {
  name: string
  path: string
  /** Extra steps that bring more of the page on screen (tabs, open views). */
  prepare?: (page: Page) => Promise<void>
}

const PAGES: PageCase[] = [
  { name: 'overview', path: '/' },
  { name: 'topology', path: '/topology' },
  { name: 'devices', path: '/devices' },
  { name: 'device-detail', path: '/devices/2' },
  {
    name: 'device-config',
    path: '/devices/2',
    prepare: async (page) => {
      await page.getByRole('tab', { name: 'Config backups' }).click()
      await expect(page.getByText('hostname SW1')).toBeVisible()
    },
  },
  {
    name: 'device-config-diff',
    path: '/devices/2',
    prepare: async (page) => {
      await page.getByRole('tab', { name: 'Config backups' }).click()
      await page.getByRole('button', { name: 'Show what changed' }).click()
      await expect(page.getByText('name SERVERS').first()).toBeVisible()
    },
  },
  { name: 'scans', path: '/scans' },
  { name: 'scan-detail', path: '/scans/3' },
  { name: 'scan-failed', path: '/scans/5' },
  { name: 'collections', path: '/collections' },
  { name: 'network-health', path: '/network-health' },
  {
    name: 'command-palette',
    path: '/',
    prepare: async (page) => {
      await page.keyboard.press('Control+k')
      await expect(page.getByRole('dialog')).toBeVisible()
    },
  },
]

for (const theme of ['dark', 'light'] as const) {
  test.describe(`${theme} theme`, () => {
    for (const item of PAGES) {
      test(`${item.name} meets WCAG AA contrast`, async ({ page }) => {
        await page.addInitScript((value) => localStorage.setItem('netsense-theme', value), theme)
        const missing = await fakeApi(page)
        await page.goto(item.path)
        await settle(page)
        await item.prepare?.(page)
        await settle(page)
        // Collapsed sections (finding diffs) count too.
        await page.locator('details').evaluateAll((all) => all.forEach((el) => ((el as HTMLDetailsElement).open = true)))

        expect(await page.locator('html').getAttribute('data-theme')).toBe(theme)
        if (theme === 'dark') await screenshot(page, item.name)

        const results = await new AxeBuilder({ page }).withRules(['color-contrast']).analyze()
        const problems = results.violations.flatMap((violation) =>
          violation.nodes.map((node) => `${node.target.join(' ')}: ${node.any[0]?.message ?? violation.help}`),
        )
        problems.push(...(await overlappedContrastProblems(page, results)))
        expect(missing, 'API requests the fake API has no answer for').toEqual([])
        expect(problems).toEqual([])
      })
    }

    test('login page meets WCAG AA contrast', async ({ page }) => {
      await page.addInitScript((value) => localStorage.setItem('netsense-theme', value), theme)
      await fakeApi(page, { 'GET /health': ROUTES['GET /health'], 'GET /auth/me': new HttpError(401, 'Not logged in') })
      await page.goto('/login')
      await expect(page.getByRole('button', { name: 'Log in' })).toBeVisible()
      if (theme === 'dark') await screenshot(page, 'login')
      const results = await new AxeBuilder({ page }).withRules(['color-contrast']).analyze()
      expect(results.violations.flatMap((violation) => violation.nodes.map((node) => node.target.join(' ')))).toEqual([])
    })
  })
}

/** Waits until loading placeholders are gone and the network is quiet. */
async function settle(page: Page) {
  await page.waitForLoadState('networkidle')
  await expect(page.locator('.skeleton')).toHaveCount(0)
}

/** The whole page: the content scrolls inside <main>, so grow the window to fit it. */
async function screenshot(page: Page, name: string) {
  const height = await page.evaluate(() => {
    const main = document.querySelector('main')
    return main ? main.scrollHeight + main.getBoundingClientRect().top : document.body.scrollHeight
  })
  const size = page.viewportSize()!
  await page.setViewportSize({ width: size.width, height: Math.max(size.height, Math.ceil(height)) })
  await page.screenshot({ path: `test-results/screenshots/${name}.png` })
  await page.setViewportSize(size)
}
