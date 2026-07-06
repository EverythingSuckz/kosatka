/**
 * Timeline pure-helper tests. The timeline component itself binds to React +
 * DOM gestures and needs a browser to exercise, so we cover the framework-
 * agnostic logic here.
 */

import { describe, expect, test } from 'bun:test'

import {
  buildEnvelopePathD,
  clampMultiDragDelta,
  defaultNewKeyframe,
  multiDragFingerprint,
} from './timeline'

describe('defaultNewKeyframe', () => {
  // Keyframes carry ABSOLUTE gain in the new semantics, the pair slider is
  // ignored on automated pairs. Defaulting to 1.0 means "play at unity"
  // regardless of where the slider sits, a non-destructive starting point.
  test('always defaults gain to 1.0 regardless of click time', () => {
    expect(defaultNewKeyframe(0).gain).toBe(1)
    expect(defaultNewKeyframe(12.5).gain).toBe(1)
    expect(defaultNewKeyframe(1000).gain).toBe(1)
  })

  test('carries the click time through unchanged', () => {
    expect(defaultNewKeyframe(0).time).toBe(0)
    expect(defaultNewKeyframe(42.42).time).toBe(42.42)
  })

  test('defaults easing to linear', () => {
    // First-keyframe-on-pair case: the engine treats linear-into-the-first
    // as a setValueAtTime anyway, and the inspector visually disables the
    // option. Non-first case: the user usually wants a ramp by default.
    expect(defaultNewKeyframe(0).easing).toBe('linear')
  })
})

describe('clampMultiDragDelta', () => {
  // Clamps the live drag delta so no selected kf escapes [0, duration]. The
  // bounds are determined by the SMALLEST and LARGEST selected kf time, so
  // the entire group moves together.
  test('returns delta unchanged when within bounds', () => {
    expect(clampMultiDragDelta([10, 20, 30], 5, 100)).toBe(5)
    expect(clampMultiDragDelta([10, 20, 30], -5, 100)).toBe(-5)
  })

  test('clamps positive delta so the latest kf stays under duration', () => {
    // max kf is 30, dur is 35 → maxDelta = 5. Asking for 10 → clamped to 5.
    expect(clampMultiDragDelta([10, 20, 30], 10, 35)).toBe(5)
  })

  test('clamps negative delta so the earliest kf stays at 0', () => {
    // min kf is 10, so minDelta = -10. Asking for -20 → clamped to -10.
    expect(clampMultiDragDelta([10, 20, 30], -20, 100)).toBe(-10)
  })

  test('clamps to exactly the bound when sitting at the bound', () => {
    // Note: JS distinguishes -0 from 0 for `Object.is` / `toBe`, but they
    // compare equal under `==` / `===`. The mathematical bound is 0 either
    // way, so assert via numeric equality.
    expect(clampMultiDragDelta([0, 50], -1, 100) === 0).toBe(true)
    expect(clampMultiDragDelta([0, 100], 1, 100) === 0).toBe(true)
  })

  test('empty selection returns 0', () => {
    expect(clampMultiDragDelta([], 5, 100)).toBe(0)
  })

  test('zero or negative duration returns 0', () => {
    expect(clampMultiDragDelta([10], 5, 0)).toBe(0)
    expect(clampMultiDragDelta([10], 5, -1)).toBe(0)
  })

  test('group of one behaves identically to single-kf clamping', () => {
    expect(clampMultiDragDelta([50], 100, 75)).toBe(25)
    expect(clampMultiDragDelta([50], -100, 75)).toBe(-50)
  })
})

describe('multiDragFingerprint', () => {
  // Stable across ordering. Same selection produces the same key regardless
  // of how the items are listed. This makes "release + pick up same set"
  // gestures coalesce into one history entry.
  test('same set in different order produces the same fingerprint', () => {
    const a = multiDragFingerprint([
      { pairIndex: 2, keyframeIndex: 1 },
      { pairIndex: 1, keyframeIndex: 0 },
    ])
    const b = multiDragFingerprint([
      { pairIndex: 1, keyframeIndex: 0 },
      { pairIndex: 2, keyframeIndex: 1 },
    ])
    expect(a).toBe(b)
  })

  test('different sets produce different fingerprints', () => {
    const a = multiDragFingerprint([{ pairIndex: 1, keyframeIndex: 0 }])
    const b = multiDragFingerprint([{ pairIndex: 1, keyframeIndex: 1 }])
    expect(a).not.toBe(b)
  })

  test('empty set is its own fingerprint (legal, though unused)', () => {
    expect(multiDragFingerprint([])).toBe('kf-multi-drag-')
  })
})

describe('buildEnvelopePathD', () => {
  test('empty keyframes returns empty paths', () => {
    expect(buildEnvelopePathD([], 60)).toEqual({ pathD: '', fillD: '' })
  })

  test('zero duration returns empty paths', () => {
    expect(
      buildEnvelopePathD([{ time: 0, gain: 1, easing: 'linear' }], 0),
    ).toEqual({ pathD: '', fillD: '' })
  })

  test('single keyframe at unity sits at top (y≈33.3) and left edge (x=0)', () => {
    const { pathD } = buildEnvelopePathD(
      [{ time: 0, gain: 1, easing: 'linear' }],
      60,
    )
    // gain 1 / GAIN_MAX 1.5 = 0.6667, y = 100 - 66.67 = 33.33 (±epsilon).
    const match = /^M0,([0-9.]+)$/.exec(pathD)
    if (!match) throw new Error(`unexpected pathD: ${pathD}`)
    expect(parseFloat(match[1]!)).toBeCloseTo(33.333, 2)
  })

  test('two-kf linear segment draws a straight line', () => {
    const { pathD } = buildEnvelopePathD(
      [
        { time: 0, gain: 0, easing: 'linear' },
        { time: 60, gain: 1, easing: 'linear' },
      ],
      60,
    )
    // x0 0, y0 100 (gain 0 → bottom), x1 100, y1 ≈33.33 (gain 1, GAIN_MAX 1.5).
    expect(pathD.startsWith('M0,100')).toBe(true)
    expect(/L100,33\.\d+/.test(pathD)).toBe(true)
  })

  test('hold easing renders a horizontal step into the kf', () => {
    const { pathD } = buildEnvelopePathD(
      [
        { time: 0, gain: 1, easing: 'linear' },
        { time: 30, gain: 0, easing: 'hold' },
      ],
      60,
    )
    // Should hold at y of prev kf (gain 1 → y≈33.33) until x of next kf
    // (x=50), then snap down to y of next kf (gain 0 → y=100). Pattern:
    // M0,33.33L50,33.33L50,100, both y's must be equal (the "hold").
    const m = /^M0,([0-9.]+)L50,([0-9.]+)L50,100$/.exec(pathD)
    if (!m) throw new Error(`unexpected pathD: ${pathD}`)
    expect(parseFloat(m[1]!)).toBeCloseTo(33.333, 2)
    expect(parseFloat(m[2]!)).toBeCloseTo(33.333, 2)
    expect(m[1]).toBe(m[2]) // hold ⇒ identical y values
  })

  test('fillD closes the path down to y=100 at both ends', () => {
    const { fillD } = buildEnvelopePathD(
      [
        { time: 0, gain: 1, easing: 'linear' },
        { time: 60, gain: 1, easing: 'linear' },
      ],
      60,
    )
    // Must end at L0,100 Z so the SVG fill region clips to the bottom.
    expect(fillD).toContain('L100,100')
    expect(fillD).toContain('L0,100')
    expect(fillD.endsWith('Z')).toBe(true)
  })
})

describe('multi-drag behavioural specs (synthesized from helpers)', () => {
  // These tests exercise the user-facing requirements via the pure helpers
  // rather than mounting React + jsdom. The timeline component's pointerdown
  // path is glue code on top of these primitives.

  test('group shift: every selected kf moves by the same delta', () => {
    // Simulates "drag the kf at t=20 by +5 seconds when 10, 20, 30 are all
    // selected", each kf shifts by +5, none drop or get scaled.
    const startTimes = [10, 20, 30]
    const dur = 60
    // User intends +5, clamp leaves it alone because max+5 = 35 ≤ 60.
    const delta = clampMultiDragDelta(startTimes, 5, dur)
    expect(delta).toBe(5)
    const after = startTimes.map((t) => t + delta)
    expect(after).toEqual([15, 25, 35])
  })

  test('group shift: extreme positive delta clamps to "latest kf at duration"', () => {
    const startTimes = [10, 20, 30]
    const dur = 35
    // User asks for +20, max kf at 30, dur 35 → clamp to +5. After clamp,
    // the latest kf lands EXACTLY at the duration (30 + 5 = 35).
    const delta = clampMultiDragDelta(startTimes, 20, dur)
    expect(delta).toBe(5)
    const after = startTimes.map((t) => t + delta)
    expect(after).toEqual([15, 25, 35])
    expect(after[after.length - 1]).toBe(dur)
  })

  test('group shift: extreme negative delta clamps to "earliest kf at 0"', () => {
    const startTimes = [10, 20, 30]
    const dur = 100
    // User asks for -25, min kf at 10 → clamp to -10.
    const delta = clampMultiDragDelta(startTimes, -25, dur)
    expect(delta).toBe(-10)
    const after = startTimes.map((t) => t + delta)
    expect(after).toEqual([0, 10, 20])
  })

  test('cross-pair group shift: delta is in seconds, not pixels', () => {
    // Pair 1 has kfs at 5 & 15, pair 2 has kfs at 25. User selects all
    // three and drags by +3 sec. All three should shift by +3.
    const allTimes = [5, 15, 25]
    const delta = clampMultiDragDelta(allTimes, 3, 100)
    expect(delta).toBe(3)
    expect(allTimes.map((t) => t + delta)).toEqual([8, 18, 28])
  })
})
