/**
 * MixerEngine pure-helper tests. The engine itself wires Web Audio nodes and
 * needs a browser to exercise, so we cover the framework-agnostic logic
 * (effective-gain math, clamp ranges, keyframe normalization, envelope
 * evaluation) here.
 */

import { describe, expect, test } from 'bun:test'

import { evaluateKeyframesAt, normalizeKeyframes } from './engine'
import {
  GAIN_MAX,
  GAIN_MIN,
  PAN_MAX,
  PAN_MIN,
  clamp,
  computeNodeGainAt,
  effectiveTrackGain,
} from './types'
import type { Keyframe } from './types'

describe('clamp', () => {
  test('clamps below the floor', () => {
    expect(clamp(-1, 0, 1)).toBe(0)
  })
  test('clamps above the ceiling', () => {
    expect(clamp(2, 0, 1)).toBe(1)
  })
  test('passes through when in range', () => {
    expect(clamp(0.5, 0, 1)).toBe(0.5)
  })
})

describe('effectiveTrackGain', () => {
  test('no mute, no solo, no any-solo: passes track gain', () => {
    expect(effectiveTrackGain(0.7, false, false, false)).toBe(0.7)
  })
  test('muted, no any-solo: silent', () => {
    expect(effectiveTrackGain(0.7, true, false, false)).toBe(0)
  })
  test('not muted, but another track is soloed: silent', () => {
    expect(effectiveTrackGain(0.7, false, false, true)).toBe(0)
  })
  test('soloed track: audible regardless of muted', () => {
    expect(effectiveTrackGain(0.7, true, true, true)).toBe(0.7)
  })
  test('soloed track with no any-solo flag: audible (mute does NOT apply)', () => {
    expect(effectiveTrackGain(0.7, false, true, false)).toBe(0.7)
  })
})

describe('range constants are sensible', () => {
  test('gain spans [0, 1.5]', () => {
    expect(GAIN_MIN).toBe(0)
    expect(GAIN_MAX).toBe(1.5)
  })
  test('pan spans [-1, 1]', () => {
    expect(PAN_MIN).toBe(-1)
    expect(PAN_MAX).toBe(1)
  })
})

describe('keyframe normalization', () => {
  test('sorts by time and clamps negative times to zero', () => {
    const out = normalizeKeyframes([
      { time: 30, gain: 1, easing: 'linear' },
      { time: -5, gain: 0.5, easing: 'linear' },
      { time: 10, gain: 0.8, easing: 'hold' },
    ])
    expect(out.map((k) => k.time)).toEqual([0, 10, 30])
    expect(out.map((k) => k.gain)).toEqual([0.5, 0.8, 1])
  })

  test('clamps gain to [0, 1.5]', () => {
    const out = normalizeKeyframes([
      { time: 0, gain: -1, easing: 'linear' },
      { time: 1, gain: 3, easing: 'linear' },
    ])
    expect(out[0]?.gain).toBe(0)
    expect(out[1]?.gain).toBe(1.5)
  })

  test('coerces unknown easing to linear', () => {
    const out = normalizeKeyframes([
      // @ts-expect-error intentionally bad easing
      { time: 0, gain: 1, easing: 'cubic' },
    ])
    expect(out[0]?.easing).toBe('linear')
  })

  test('drops NaN / inf values', () => {
    const out = normalizeKeyframes([
      { time: NaN, gain: 1, easing: 'linear' },
      { time: 1, gain: Infinity, easing: 'linear' },
      { time: 2, gain: 0.5, easing: 'linear' },
    ])
    expect(out.length).toBe(1)
    expect(out[0]?.time).toBe(2)
  })

  test('deduplicates same-time keyframes (last wins)', () => {
    const out = normalizeKeyframes([
      { time: 5, gain: 0.5, easing: 'linear' },
      { time: 5, gain: 0.9, easing: 'hold' },
    ])
    expect(out.length).toBe(1)
    expect(out[0]?.gain).toBe(0.9)
    expect(out[0]?.easing).toBe('hold')
  })

  test('empty input returns empty array', () => {
    expect(normalizeKeyframes([])).toEqual([])
  })
})

describe('evaluateKeyframesAt', () => {
  const kfs: Array<Keyframe> = [
    { time: 0, gain: 1, easing: 'linear' },
    { time: 10, gain: 0.5, easing: 'linear' },
    { time: 20, gain: 0.8, easing: 'hold' },
    { time: 30, gain: 0.2, easing: 'linear' },
  ]

  test('returns null for empty list', () => {
    expect(evaluateKeyframesAt([], 5)).toBe(null)
  })

  test('before first keyframe returns first gain', () => {
    expect(evaluateKeyframesAt(kfs, -5)).toBe(1)
  })

  test('at a keyframe time returns that keyframe gain', () => {
    expect(evaluateKeyframesAt(kfs, 0)).toBe(1)
    expect(evaluateKeyframesAt(kfs, 10)).toBe(0.5)
    expect(evaluateKeyframesAt(kfs, 30)).toBe(0.2)
  })

  test('linear interpolates between keyframes', () => {
    // halfway between t=0 (gain 1) and t=10 (gain 0.5) → 0.75
    expect(evaluateKeyframesAt(kfs, 5)).toBeCloseTo(0.75, 6)
  })

  test('hold easing keeps prev value until kf.time', () => {
    // between t=10 (gain 0.5) and t=20 (gain 0.8, hold easing) → 0.5
    expect(evaluateKeyframesAt(kfs, 15)).toBe(0.5)
    expect(evaluateKeyframesAt(kfs, 19.999)).toBe(0.5)
    // AT 20s, kf value applies.
    expect(evaluateKeyframesAt(kfs, 20)).toBe(0.8)
  })

  test('after last keyframe returns last gain', () => {
    expect(evaluateKeyframesAt(kfs, 999)).toBe(0.2)
  })

  test('single keyframe is constant everywhere', () => {
    const one: Array<Keyframe> = [{ time: 5, gain: 0.7, easing: 'linear' }]
    expect(evaluateKeyframesAt(one, 0)).toBe(0.7)
    expect(evaluateKeyframesAt(one, 5)).toBe(0.7)
    expect(evaluateKeyframesAt(one, 100)).toBe(0.7)
  })
})

/**
 * The piecewise-gain semantics adjustment (round 5) makes keyframes own
 * the gain only INSIDE their [firstKf.time, lastKf.time] range. OUTSIDE
 * the range the pair slider wins. These tests pin down the three regions:
 *
 *   - t < firstKf.time              → slider × gate
 *   - t ∈ [firstKf.time, lastKf.time] → envelope × gate (slider ignored)
 *   - t > lastKf.time               → slider × gate
 *
 * Where `gate` = 0 if (muted-and-no-solo) or (any-solo-and-not-this-solo),
 * else 1. The previous round-4 semantics was "any keyframes → envelope
 * everywhere", so these tests would have failed against that implementation.
 */
describe('computeNodeGainAt: piecewise keyframe semantics', () => {
  // Two-keyframe envelope so the "inside the range" region has a definable
  // shape. firstKf @ t=5, lastKf @ t=10.
  const kfsRange: Array<Keyframe> = [
    { time: 5, gain: 0.8, easing: 'linear' },
    { time: 10, gain: 0.4, easing: 'linear' },
  ]

  test('t < firstKf.time → returns slider × gate (envelope ignored)', () => {
    const base = {
      keyframes: kfsRange,
      muted: false,
      solo: false,
      anyTrackSoloed: false,
      timeSeconds: 2, // before firstKf @ 5
    }
    expect(computeNodeGainAt({ ...base, trackSlider: 0.5 })).toBe(0.5)
    expect(computeNodeGainAt({ ...base, trackSlider: 1.0 })).toBe(1.0)
    expect(computeNodeGainAt({ ...base, trackSlider: 1.5 })).toBe(1.5)
  })

  test('firstKf.time ≤ t ≤ lastKf.time → returns envelope × gate (slider ignored)', () => {
    const base = {
      keyframes: kfsRange,
      muted: false,
      solo: false,
      anyTrackSoloed: false,
      timeSeconds: 7.5, // halfway between firstKf (5) and lastKf (10)
    }
    const a = computeNodeGainAt({ ...base, trackSlider: 0.5 })
    const b = computeNodeGainAt({ ...base, trackSlider: 1.0 })
    const c = computeNodeGainAt({ ...base, trackSlider: 1.5 })
    expect(a).toBe(b)
    expect(b).toBe(c)
    // Halfway between 0.8 and 0.4 = 0.6
    expect(a).toBeCloseTo(0.6, 6)
    // At the exact boundaries.
    expect(
      computeNodeGainAt({ ...base, trackSlider: 0.1, timeSeconds: 5 }),
    ).toBe(0.8)
    expect(
      computeNodeGainAt({ ...base, trackSlider: 0.1, timeSeconds: 10 }),
    ).toBe(0.4)
  })

  test('t > lastKf.time → returns slider × gate (envelope ignored)', () => {
    const base = {
      keyframes: kfsRange,
      muted: false,
      solo: false,
      anyTrackSoloed: false,
      timeSeconds: 20, // after lastKf @ 10
    }
    expect(computeNodeGainAt({ ...base, trackSlider: 0.3 })).toBe(0.3)
    expect(computeNodeGainAt({ ...base, trackSlider: 1.2 })).toBe(1.2)
  })

  test('pair WITHOUT keyframes uses the slider directly', () => {
    expect(
      computeNodeGainAt({
        keyframes: [],
        trackSlider: 0.3,
        muted: false,
        solo: false,
        anyTrackSoloed: false,
        timeSeconds: 999,
      }),
    ).toBe(0.3)
    expect(
      computeNodeGainAt({
        keyframes: [],
        trackSlider: 1.2,
        muted: false,
        solo: false,
        anyTrackSoloed: false,
        timeSeconds: 0,
      }),
    ).toBe(1.2)
  })

  test('mute gates to zero in ALL three regions (before / inside / after)', () => {
    const base = {
      keyframes: kfsRange,
      trackSlider: 1.0,
      muted: true,
      solo: false,
      anyTrackSoloed: false,
    }
    // Before the range, slider would have been audible, gate forces 0.
    expect(computeNodeGainAt({ ...base, timeSeconds: 2 })).toBe(0)
    // Inside the range, envelope would be 0.6, gate forces 0.
    expect(computeNodeGainAt({ ...base, timeSeconds: 7.5 })).toBe(0)
    // After the range, slider would have been audible, gate forces 0.
    expect(computeNodeGainAt({ ...base, timeSeconds: 20 })).toBe(0)
  })

  test('solo elsewhere gates to zero in ALL three regions', () => {
    const base = {
      keyframes: kfsRange,
      trackSlider: 1.0,
      muted: false,
      solo: false,
      anyTrackSoloed: true,
    }
    expect(computeNodeGainAt({ ...base, timeSeconds: 2 })).toBe(0)
    expect(computeNodeGainAt({ ...base, timeSeconds: 7.5 })).toBe(0)
    expect(computeNodeGainAt({ ...base, timeSeconds: 20 })).toBe(0)
  })

  test('clearing keyframes hands control back to the slider (round trip)', () => {
    // Step 1: pair has keyframes around t=1, output is envelope value.
    const kfs: Array<Keyframe> = [
      { time: 0, gain: 1, easing: 'linear' },
      { time: 2, gain: 1, easing: 'linear' },
    ]
    const automated = computeNodeGainAt({
      keyframes: kfs,
      trackSlider: 0.5,
      muted: false,
      solo: false,
      anyTrackSoloed: false,
      timeSeconds: 1, // inside the [0, 2] range
    })
    expect(automated).toBe(1)
    // Step 2: keyframes cleared → slider re-engages, output is 0.5.
    const constant = computeNodeGainAt({
      keyframes: [],
      trackSlider: 0.5,
      muted: false,
      solo: false,
      anyTrackSoloed: false,
      timeSeconds: 1,
    })
    expect(constant).toBe(0.5)
  })

  test('soloed automated track is audible inside the range at envelope value', () => {
    const kfs: Array<Keyframe> = [
      { time: 0, gain: 0.9, easing: 'linear' },
      { time: 5, gain: 0.9, easing: 'linear' },
    ]
    expect(
      computeNodeGainAt({
        keyframes: kfs,
        trackSlider: 0.1,
        muted: true, // mute is overridden by solo
        solo: true,
        anyTrackSoloed: true,
        timeSeconds: 0,
      }),
    ).toBe(0.9)
  })
})
