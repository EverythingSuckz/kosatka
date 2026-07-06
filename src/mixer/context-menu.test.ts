/**
 * Tests for the keyframe context-menu item BUILDER. The presentation
 * component is exercised by the JSDOM hook tests. here we cover the
 * "what items should appear for a given keyframe + state" logic that the
 * route uses to populate the menu.
 *
 * The builder is exported alongside the route's keyframe action layer so it
 * can be unit-tested in isolation.
 */

import { describe, expect, test } from 'bun:test'

import {
  buildKeyframeContextMenu,
  duplicateTimeFor,
  fadeOutTime,
  planFadeIn,
} from './context-menu-builder'
import type { Keyframe } from './types'

function kf(
  time: number,
  gain = 1,
  easing: Keyframe['easing'] = 'linear',
): Keyframe {
  return { time, gain, easing }
}

describe('buildKeyframeContextMenu', () => {
  test('always includes Delete and Duplicate', () => {
    const items = buildKeyframeContextMenu({
      keyframe: kf(2, 1, 'linear'),
      keyframeIndex: 1,
      pairKeyframes: [kf(0), kf(2)],
      durationSeconds: 60,
      playheadSeconds: 0,
    })
    const labels = items.filter((i) => !i.divider).map((i) => i.label)
    expect(labels).toContain('delete')
    expect(labels).toContain('duplicate')
  })

  test('does NOT include the redundant Properties item', () => {
    // Plain left-click already selects the keyframe and shows it in the
    // inspector. right-click selects + opens the menu. A separate
    // "properties" entry duplicates the same effect.
    const items = buildKeyframeContextMenu({
      keyframe: kf(2, 1, 'linear'),
      keyframeIndex: 1,
      pairKeyframes: [kf(0), kf(2)],
      durationSeconds: 60,
      playheadSeconds: 0,
    })
    const labels = items.filter((i) => !i.divider).map((i) => i.label)
    expect(labels).not.toContain('properties')
  })

  test('Delete is danger-styled and has Del kbd', () => {
    const items = buildKeyframeContextMenu({
      keyframe: kf(2),
      keyframeIndex: 0,
      pairKeyframes: [kf(2)],
      durationSeconds: 10,
      playheadSeconds: 0,
    })
    const del = items.find((i) => i.label === 'delete')
    expect(del?.danger).toBe(true)
    expect(del?.kbd).toBe('del')
  })

  test('Add fade in always available', () => {
    const items = buildKeyframeContextMenu({
      keyframe: kf(2, 1, 'linear'),
      keyframeIndex: 0,
      pairKeyframes: [kf(2)],
      durationSeconds: 10,
      playheadSeconds: 0,
    })
    const fadeIn = items.find((i) => i.label === 'add fade in')
    expect(fadeIn).toBeDefined()
    expect(fadeIn?.disabled).toBeFalsy()
  })

  test('Add fade out always available', () => {
    const items = buildKeyframeContextMenu({
      keyframe: kf(2, 1, 'linear'),
      keyframeIndex: 0,
      pairKeyframes: [kf(2)],
      durationSeconds: 10,
      playheadSeconds: 0,
    })
    const fadeOut = items.find((i) => i.label === 'add fade out')
    expect(fadeOut).toBeDefined()
    expect(fadeOut?.disabled).toBeFalsy()
  })

  test('Linear easing option is DISABLED on the first keyframe', () => {
    const items = buildKeyframeContextMenu({
      keyframe: kf(0, 1, 'linear'),
      keyframeIndex: 0,
      pairKeyframes: [kf(0), kf(2)],
      durationSeconds: 10,
      playheadSeconds: 0,
    })
    const linear = items.find((i) => i.label === 'set linear easing')
    expect(linear?.disabled).toBe(true)
  })

  test('Linear easing option is ENABLED on later keyframes', () => {
    const items = buildKeyframeContextMenu({
      keyframe: kf(2, 1, 'hold'),
      keyframeIndex: 1,
      pairKeyframes: [kf(0), kf(2)],
      durationSeconds: 10,
      playheadSeconds: 0,
    })
    const linear = items.find((i) => i.label === 'set linear easing')
    expect(linear?.disabled).toBeFalsy()
  })

  test('Hold easing option is always present', () => {
    const items = buildKeyframeContextMenu({
      keyframe: kf(0, 1, 'linear'),
      keyframeIndex: 0,
      pairKeyframes: [kf(0)],
      durationSeconds: 10,
      playheadSeconds: 0,
    })
    const hold = items.find((i) => i.label === 'set hold easing')
    expect(hold).toBeDefined()
  })

  test('includes at least one divider', () => {
    const items = buildKeyframeContextMenu({
      keyframe: kf(0, 1, 'linear'),
      keyframeIndex: 0,
      pairKeyframes: [kf(0)],
      durationSeconds: 10,
      playheadSeconds: 0,
    })
    expect(items.some((i) => i.divider === true)).toBe(true)
  })

  test('planFadeIn finds existing kf at time 0', () => {
    const plan = planFadeIn([kf(0), kf(2)])
    expect(plan.hasZeroKf).toBe(true)
    expect(plan.zeroKfIndex).toBe(0)
  })

  test('planFadeIn reports no existing kf at time 0', () => {
    const plan = planFadeIn([kf(2), kf(4)])
    expect(plan.hasZeroKf).toBe(false)
    expect(plan.zeroKfIndex).toBe(-1)
  })

  test('duplicateTimeFor returns source+1 by default', () => {
    expect(duplicateTimeFor(kf(3), 0, 60)).toBe(4)
  })

  test('duplicateTimeFor returns playhead when playhead is past source', () => {
    expect(duplicateTimeFor(kf(3), 7, 60)).toBe(7)
  })

  test('duplicateTimeFor clamps to song duration', () => {
    expect(duplicateTimeFor(kf(58), 0, 60)).toBe(59)
    expect(duplicateTimeFor(kf(99), 0, 60)).toBe(60)
  })

  test('fadeOutTime returns source+2 by default', () => {
    expect(fadeOutTime(kf(3), 60)).toBe(5)
  })

  test('fadeOutTime clamps at song end', () => {
    expect(fadeOutTime(kf(58), 59)).toBe(59)
  })

  test('actions wire through to onSelect handlers when provided', () => {
    let fadeInRan = 0
    const items = buildKeyframeContextMenu(
      {
        keyframe: kf(2, 1, 'linear'),
        keyframeIndex: 0,
        pairKeyframes: [kf(2)],
        durationSeconds: 10,
        playheadSeconds: 0,
      },
      { onAddFadeIn: () => fadeInRan++ },
    )
    const fadeIn = items.find((i) => i.label === 'add fade in')
    expect(fadeIn?.onSelect).toBeInstanceOf(Function)
    fadeIn?.onSelect?.()
    expect(fadeInRan).toBe(1)
  })
})
