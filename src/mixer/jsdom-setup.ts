// JSDOM bootstrap for bun:test. Import this BEFORE
// @testing-library/react in any test that calls `renderHook` or `render`.
// Bun's test runner runs in Node-only mode, so without this the React
// runtime has no `window` / `document` to render into.

import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/',
})
const w = dom.window
const g = globalThis as unknown as Record<string, unknown>
g.window = w
g.document = w.document
g.navigator = w.navigator
g.HTMLElement = w.HTMLElement
g.Element = w.Element
g.Node = w.Node
g.getComputedStyle = w.getComputedStyle
g.requestAnimationFrame = w.requestAnimationFrame
g.cancelAnimationFrame = w.cancelAnimationFrame
