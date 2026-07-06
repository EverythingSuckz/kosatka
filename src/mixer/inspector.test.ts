import { describe, expect, test } from 'bun:test'

import {
  buildInspectorVM,
  easingButtonStyle,
  gainToPercent,
  isLinearEasingDisabled,
} from './inspector'
import { SELECTION_NONE } from './selection'
import type { InspectorPairInfo } from './inspector'

function makePair(
  pairIndex: number,
  keyframes: InspectorPairInfo['keyframes'] = [],
): InspectorPairInfo {
  return {
    pairIndex,
    gain: 1,
    spread: 1,
    enabled: true,
    unavailable: false,
    leftHashHex: '0xdeadbeef',
    rightHashHex: '0xcafebabe',
    leftTrackId: 'L',
    rightTrackId: 'R',
    leftLabel: null,
    rightLabel: null,
    keyframes,
    durationSeconds: 60,
  }
}

describe('buildInspectorVM', () => {
  test('none selection → empty VM', () => {
    const vm = buildInspectorVM(SELECTION_NONE, () => null)
    expect(vm).toEqual({ kind: 'none' })
  })

  test('pair selection → pair VM', () => {
    const p = makePair(3)
    const vm = buildInspectorVM({ kind: 'pair', pairIndex: 3 }, (i) =>
      i === 3 ? p : null,
    )
    expect(vm.kind).toBe('pair')
    if (vm.kind === 'pair') expect(vm.pair.pairIndex).toBe(3)
  })

  test('pair selection that points at a missing pair → falls back to none', () => {
    const vm = buildInspectorVM({ kind: 'pair', pairIndex: 9 }, () => null)
    expect(vm).toEqual({ kind: 'none' })
  })

  test('single-keyframe selection → keyframe VM', () => {
    const p = makePair(2, [
      { time: 1, gain: 0, easing: 'linear' },
      { time: 3, gain: 1, easing: 'hold' },
    ])
    const vm = buildInspectorVM(
      { kind: 'keyframes', items: [{ pairIndex: 2, keyframeIndex: 1 }] },
      (i) => (i === 2 ? p : null),
    )
    expect(vm.kind).toBe('keyframe')
    if (vm.kind === 'keyframe') {
      expect(vm.keyframeIndex).toBe(1)
      expect(vm.keyframe.time).toBe(3)
      expect(vm.keyframe.easing).toBe('hold')
    }
  })

  test('keyframe selection beyond list falls back to pair VM', () => {
    const p = makePair(4, [{ time: 0, gain: 1, easing: 'linear' }])
    const vm = buildInspectorVM(
      { kind: 'keyframes', items: [{ pairIndex: 4, keyframeIndex: 5 }] },
      (i) => (i === 4 ? p : null),
    )
    expect(vm.kind).toBe('pair')
    if (vm.kind === 'pair') expect(vm.pair.pairIndex).toBe(4)
  })

  test('keyframe selection in missing pair → none', () => {
    const vm = buildInspectorVM(
      { kind: 'keyframes', items: [{ pairIndex: 9, keyframeIndex: 0 }] },
      () => null,
    )
    expect(vm).toEqual({ kind: 'none' })
  })

  test('inspector exposes durationSeconds on pair info', () => {
    const p = makePair(1, [{ time: 5, gain: 0.5, easing: 'linear' }])
    const vm = buildInspectorVM({ kind: 'pair', pairIndex: 1 }, (i) =>
      i === 1 ? p : null,
    )
    if (vm.kind === 'pair') {
      expect(vm.pair.durationSeconds).toBe(60)
    } else {
      throw new Error('expected pair VM')
    }
  })

  test('multi-keyframe selection → keyframes-multi VM with count', () => {
    const p = makePair(2, [
      { time: 1, gain: 0, easing: 'linear' },
      { time: 2, gain: 0.5, easing: 'linear' },
      { time: 3, gain: 1, easing: 'hold' },
    ])
    const vm = buildInspectorVM(
      {
        kind: 'keyframes',
        items: [
          { pairIndex: 2, keyframeIndex: 0 },
          { pairIndex: 2, keyframeIndex: 1 },
        ],
      },
      (i) => (i === 2 ? p : null),
    )
    expect(vm.kind).toBe('keyframes-multi')
    if (vm.kind === 'keyframes-multi') {
      expect(vm.count).toBe(2)
      expect(vm.pairIndices).toEqual([2])
    }
  })

  test('multi-keyframe selection across pairs lists both pairIndices', () => {
    const p2 = makePair(2, [{ time: 1, gain: 1, easing: 'linear' }])
    const p5 = makePair(5, [{ time: 1, gain: 1, easing: 'linear' }])
    const vm = buildInspectorVM(
      {
        kind: 'keyframes',
        items: [
          { pairIndex: 5, keyframeIndex: 0 },
          { pairIndex: 2, keyframeIndex: 0 },
        ],
      },
      (i) => (i === 2 ? p2 : i === 5 ? p5 : null),
    )
    if (vm.kind !== 'keyframes-multi') {
      throw new Error('expected keyframes-multi')
    }
    expect(vm.pairIndices).toEqual([2, 5])
  })
})

describe('isLinearEasingDisabled', () => {
  test('disabled for the first keyframe (index 0)', () => {
    expect(isLinearEasingDisabled(0)).toBe(true)
  })
  test('enabled for any keyframe after the first', () => {
    expect(isLinearEasingDisabled(1)).toBe(false)
    expect(isLinearEasingDisabled(5)).toBe(false)
  })
})

describe('gainToPercent', () => {
  test('formats 1.0 as 100%', () => {
    expect(gainToPercent(1)).toBe('100%')
  })
  test('formats 0 as 0%', () => {
    expect(gainToPercent(0)).toBe('0%')
  })
  test('formats 1.5 (engine max) as 150%', () => {
    expect(gainToPercent(1.5)).toBe('150%')
  })
  test('rounds half-percents', () => {
    expect(gainToPercent(0.503)).toBe('50%')
    expect(gainToPercent(0.499)).toBe('50%')
  })
})

describe('easingButtonStyle (selected-state contrast)', () => {
  // Round-5 bug: the "selected" easing radio button looked identical to the
  // unselected one in production because the global `button:disabled` rule
  // in styles.css was overriding Tailwind utility classes. We now emit inline
  // styles, which the cascade can't beat. These assertions lock in the
  // intended contrast (active = green bg + bg-colour fg, inactive = transparent).
  test('selected uses active bg + bg-coloured fg + active border', () => {
    const style = easingButtonStyle(true, false)
    expect(style.background).toBe('var(--color-active)')
    expect(style.color).toBe('var(--color-bg)')
    expect(style.borderColor).toBe('var(--color-active)')
    expect(style.opacity).toBe(1)
  })

  test('unselected uses transparent bg + dim fg + line border', () => {
    const style = easingButtonStyle(false, false)
    expect(style.background).toBe('transparent')
    expect(style.color).toBe('var(--color-fg-dim)')
    expect(style.borderColor).toBe('var(--color-line-strong)')
    expect(style.opacity).toBe(1)
  })

  test('disabled still keeps the selected colour scheme, just dimmer', () => {
    // First-kf-linear case: linear IS selected (it's the default easing on
    // a fresh kf) but ALSO unavailable. Must remain visibly green so the
    // user can tell what is set, but at reduced opacity to communicate
    // "not interactive."
    const style = easingButtonStyle(true, true)
    expect(style.background).toBe('var(--color-active)')
    expect(style.borderColor).toBe('var(--color-active)')
    expect(style.opacity).toBeLessThan(1)
    expect(style.cursor).toBe('not-allowed')
  })

  test('disabled unselected dims as well', () => {
    const style = easingButtonStyle(false, true)
    expect(style.opacity).toBeLessThan(1)
    expect(style.cursor).toBe('not-allowed')
  })
})
