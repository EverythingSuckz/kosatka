// Minimal type shim for the `jsdom` module, only the surface our tests
// touch. The real package ships no types and we don't depend on its
// public shape.
declare module 'jsdom' {
  export class JSDOM {
    constructor(html?: string, opts?: Record<string, unknown>)
    window: Window & typeof globalThis
  }
}
