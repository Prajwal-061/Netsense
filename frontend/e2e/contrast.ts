// Contrast for text axe-core could not judge because another element overlaps
// it (React Flow's map, the command palette's backdrop). Measured from the
// element's own ancestors: their backgrounds are blended from the page down,
// then the text colour on top, and the ratio compared with WCAG AA.

import type { Page } from '@playwright/test'
import type { AxeResults } from 'axe-core'

export async function overlappedContrastProblems(page: Page, results: AxeResults): Promise<string[]> {
  const targets = results.incomplete
    .filter((rule) => rule.id === 'color-contrast')
    .flatMap((rule) => rule.nodes)
    .filter((node) => /overlap/.test(node.any[0]?.message ?? ''))
    .map((node) => node.target.join(' '))
  if (targets.length === 0) return []

  return page.evaluate((selectors) => {
    type RGBA = [number, number, number, number]
    const probe = document.createElement('canvas').getContext('2d')!
    // The canvas normalises any CSS colour (rgb, color(srgb ...), oklab) to rgba.
    const parse = (css: string): RGBA => {
      probe.clearRect(0, 0, 1, 1)
      probe.fillStyle = '#000'
      probe.fillStyle = css
      probe.fillRect(0, 0, 1, 1)
      const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data
      return [r, g, b, a / 255]
    }
    const over = (top: RGBA, bottom: RGBA): RGBA => {
      const a = top[3]
      return [0, 1, 2].map((i) => top[i] * a + bottom[i] * (1 - a)).concat(1) as RGBA
    }
    const luminance = ([r, g, b]: RGBA) =>
      [r, g, b]
        .map((c) => c / 255)
        .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
        .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0)

    const problems: string[] = []
    for (const selector of selectors) {
      const element = document.querySelector(selector)
      if (!element) continue
      const chain: Element[] = []
      for (let node: Element | null = element; node; node = node.parentElement) chain.unshift(node)
      let background: RGBA = [255, 255, 255, 1]
      let opacity = 1
      for (const node of chain) {
        const style = getComputedStyle(node)
        opacity *= Number(style.opacity)
        const fill = parse(style.backgroundColor)
        background = over([fill[0], fill[1], fill[2], fill[3] * opacity], background)
      }
      const style = getComputedStyle(element)
      const colour = parse(style.color)
      const text = over([colour[0], colour[1], colour[2], colour[3] * opacity], background)
      const [hi, lo] = [luminance(text), luminance(background)].sort((x, y) => y - x)
      const ratio = (hi + 0.05) / (lo + 0.05)
      const size = parseFloat(style.fontSize)
      const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700)
      if (ratio < (large ? 3 : 4.5)) problems.push(`${selector}: overlapped text, contrast ${ratio.toFixed(2)}:1`)
    }
    return problems
  }, targets)
}
