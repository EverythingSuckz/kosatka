import { describe, expect, test } from 'bun:test'

import { decodeHashState, encodeHashState } from './hash-state'

describe('hash-state encode/decode round-trip', () => {
  test('preserves pair on/off, gain, pan, master', () => {
    const state = {
      m: [1, 0, 1, 1, 0, 0, 1, 0],
      g: [100, 80, 120, 100, 100, 100, 60, 100],
      p: [-100, 100, -50, 50, 0, 0, -100, 100],
      M: 90,
    }
    const enc = encodeHashState(state)
    const dec = decodeHashState(enc)
    expect(dec).toEqual(state)
  })

  test('decodes with #s= prefix tolerated', () => {
    const state = { m: [1, 1], g: [100, 100], p: [-100, 100], M: 100 }
    const enc = encodeHashState(state)
    const dec = decodeHashState(`#s=${enc}`)
    expect(dec).toEqual(state)
  })

  test('returns null on garbage input', () => {
    expect(decodeHashState('not-base64!!!')).toBeNull()
    expect(decodeHashState('')).toBeNull()
    expect(decodeHashState(btoa('{}'))).toBeNull()
    expect(decodeHashState(btoa('[]'))).toBeNull()
  })

  test('coerces non-numeric ints sensibly', () => {
    const enc = btoa(
      JSON.stringify({ m: [1, 0], g: ['x', 50], p: [0, 0], M: 100 }),
    )
    const dec = decodeHashState(enc)
    expect(dec?.g).toEqual([100, 50])
  })
})

describe('hash-state keyframe automation round-trip', () => {
  test('omits the `a` field when no pair has keyframes', () => {
    const state = {
      m: [1, 1],
      g: [100, 100],
      p: [-100, 100],
      M: 100,
    }
    const enc = encodeHashState(state)
    const json = atob(enc + '='.repeat((4 - (enc.length % 4)) % 4))
    expect(json.includes('"a"')).toBe(false)
  })

  test('round-trips keyframe lists', () => {
    const state = {
      m: [1, 0, 1],
      g: [100, 100, 100],
      p: [-100, 100, 0],
      M: 100,
      a: [
        [
          { time: 0, gain: 0, easing: 'linear' as const },
          { time: 12.34, gain: 1, easing: 'linear' as const },
          { time: 30.7, gain: 0.5, easing: 'hold' as const },
        ],
        null,
        [{ time: 5, gain: 0.8, easing: 'linear' as const }],
      ],
    }
    const enc = encodeHashState(state)
    const dec = decodeHashState(enc)
    expect(dec?.a).toEqual([
      [
        { time: 0, gain: 0, easing: 'linear' },
        { time: 12.34, gain: 1, easing: 'linear' },
        { time: 30.7, gain: 0.5, easing: 'hold' },
      ],
      null,
      [{ time: 5, gain: 0.8, easing: 'linear' }],
    ])
  })

  test('encodes pairs with no keyframes as 0 (compact)', () => {
    const state = {
      m: [1, 1],
      g: [100, 100],
      p: [0, 0],
      M: 100,
      a: [[{ time: 1, gain: 1, easing: 'linear' as const }], null],
    }
    const enc = encodeHashState(state)
    const json = atob(enc + '='.repeat((4 - (enc.length % 4)) % 4))
    expect(json.includes('[100,100,0],0')).toBe(true)
  })

  test('decodes old hashes without `a` field as no automation', () => {
    const enc = btoa(
      JSON.stringify({ m: [1, 0], g: [100, 100], p: [0, 0], M: 100 }),
    )
    const dec = decodeHashState(enc)
    expect(dec).not.toBeNull()
    expect(dec?.a).toBeUndefined()
    expect(dec?.legacyAutomationDropped).toBeUndefined()
  })

  test('flags legacy segment hashes with -1 sentinel as dropped', () => {
    const legacy = {
      m: [1, 1],
      g: [100, 100],
      p: [-100, 100],
      M: 100,
      a: [[-1, 100, 500, 30, 30], null],
    }
    const enc = btoa(JSON.stringify(legacy))
    const dec = decodeHashState(enc)
    expect(dec).not.toBeNull()
    expect(dec?.legacyAutomationDropped).toBe(true)
    // The pair with legacy data is decoded as no keyframes.
    expect(dec?.a?.[0]).toBeNull()
    expect(dec?.a?.[1]).toBeNull()
  })

  test('flags legacy 2-int-per-segment hashes as dropped', () => {
    // Length 2 is divisible by 2 but not 3 → recognized as legacy.
    const legacy = {
      m: [1],
      g: [100],
      p: [0],
      M: 100,
      a: [[123, 456]],
    }
    const enc = btoa(JSON.stringify(legacy))
    const dec = decodeHashState(enc)
    expect(dec?.legacyAutomationDropped).toBe(true)
    expect(dec?.a?.[0]).toBeNull()
  })

  test('round-trip is idempotent across encode→decode→encode', () => {
    const state = {
      m: [1, 1],
      g: [100, 80],
      p: [50, 50],
      M: 100,
      a: [
        [
          { time: 0.5, gain: 0.25, easing: 'linear' as const },
          { time: 2, gain: 1.5, easing: 'hold' as const },
        ],
        null,
      ],
    }
    const enc1 = encodeHashState(state)
    const dec1 = decodeHashState(enc1)
    const enc2 = encodeHashState(dec1!)
    expect(enc1).toBe(enc2)
  })

  test('clamps out-of-range gain on decode', () => {
    const state = {
      m: [1],
      g: [100],
      p: [0],
      M: 100,
      a: [[100, 200, 0]], // gain encoded as 200/100 = 2.0, > GAIN_MAX (1.5)
    }
    const enc = btoa(JSON.stringify(state))
    const dec = decodeHashState(enc)
    expect(dec?.a?.[0]?.[0]?.gain).toBe(1.5)
  })

  test('decodes v1 hash with keyframes and flags legacyV1Automation', () => {
    // v1 hashes (missing `v` field) carried envelope-multiplier semantics
    // for keyframe gain, v2 carries absolute gain. The wire shape is
    // identical, so we keep values as-is and flag for the route.
    const legacy = {
      m: [1],
      g: [100],
      p: [0],
      M: 100,
      // pair 0: one keyframe at t=1s, gain=0.8, linear easing
      a: [[100, 80, 0]],
    }
    const enc = btoa(JSON.stringify(legacy))
    const dec = decodeHashState(enc)
    expect(dec?.legacyV1Automation).toBe(true)
    // Values preserved unchanged.
    expect(dec?.a?.[0]).toEqual([{ time: 1, gain: 0.8, easing: 'linear' }])
  })

  test('does NOT flag v1 hashes that have no keyframes', () => {
    // No `a` field → no automation → nothing to be ambiguous about.
    const v1 = { m: [1], g: [100], p: [0], M: 100 }
    const enc = btoa(JSON.stringify(v1))
    const dec = decodeHashState(enc)
    expect(dec?.legacyV1Automation).toBeUndefined()
  })

  test('v2 hashes (with `v: 2`) do NOT flag legacyV1Automation', () => {
    const v2 = {
      v: 2,
      m: [1],
      g: [100],
      p: [0],
      M: 100,
      a: [[100, 80, 0]],
    }
    const enc = btoa(JSON.stringify(v2))
    const dec = decodeHashState(enc)
    expect(dec?.legacyV1Automation).toBeUndefined()
  })

  test('encodeHashState stamps the current version', () => {
    const enc = encodeHashState({
      m: [1],
      g: [100],
      p: [0],
      M: 100,
    })
    const json = atob(enc + '='.repeat((4 - (enc.length % 4)) % 4))
    expect(json.includes('"v":2')).toBe(true)
  })

  test('zero (no-keyframes-for-pair) and null both decode to null', () => {
    const state = {
      m: [1, 1, 1],
      g: [100, 100, 100],
      p: [0, 0, 0],
      M: 100,
      a: [[1, 2, 3], 0, null],
    }
    const enc = btoa(JSON.stringify(state))
    const dec = decodeHashState(enc)
    expect(dec?.a?.[0]).toEqual([{ time: 0.01, gain: 0.02, easing: 'linear' }])
    expect(dec?.a?.[1]).toBeNull()
    expect(dec?.a?.[2]).toBeNull()
  })
})
