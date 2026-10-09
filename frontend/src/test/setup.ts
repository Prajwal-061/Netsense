import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

// React Flow measures its container and nodes with browser APIs that jsdom
// does not have. These stand-ins let the map mount in tests; real geometry
// (and so the drawn links) still needs a real browser.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver
class DOMMatrixStub {
  m22 = 1
  constructor(transform?: string) {
    const scale = transform?.match(/scale\(([\d.]+)\)/)?.[1]
    if (scale) this.m22 = Number(scale)
  }
}
globalThis.DOMMatrixReadOnly ??= DOMMatrixStub as unknown as typeof DOMMatrixReadOnly
