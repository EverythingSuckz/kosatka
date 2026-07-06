/**
 * `useMixer` perf-isolation tests.
 *
 * The bug we are guarding against: bundling the playhead position into the
 * snapshot handle re-renders every `useMixer()` consumer on every RAF
 * tick. With 8+ pair rows × per-row waveforms + keyframe layers, the
 * timeline went laggy at zoom + many keyframes + playback.
 *
 * The fix: `useMixer` returns only the snapshot fields, per-frame position
 * is exposed via a separate `usePlayheadPosition` hook so only leaf
 * components that actually paint the position re-render per tick.
 *
 * The fake engine here implements just enough of the `MixerEngine` API
 * surface that the hooks consume, we don't need Web Audio for this.
 */

// jsdom-setup is a side-effect import that installs DOM globals BEFORE
// any React code below evaluates. ESM evaluates imports top-down, so this
// being first guarantees `window` / `document` exist by the time
// @testing-library/react initializes.
import './jsdom-setup'

import { describe, expect, test } from 'bun:test'
import { act, renderHook } from '@testing-library/react'

import { useMixer, usePlayheadPosition } from './hook'
import type { MixerEngine } from './engine'
import type { MixerSnapshot } from './types'

function emptySnapshot(): MixerSnapshot {
  return {
    isPlaying: false,
    masterGain: 1,
    durationSeconds: 0,
    tracks: [],
    wasGlobalMuted: false,
    loopRegion: null,
    automation: {},
    previewPair: null,
  }
}

interface FakeEngine extends Pick<
  MixerEngine,
  'subscribe' | 'subscribeFrame' | 'snapshot' | 'positionSeconds'
> {
  emitFrame: (positionSeconds: number) => void
  emitSnapshot: (next?: Partial<MixerSnapshot>) => void
}

function makeFakeEngine(): FakeEngine {
  let snap: MixerSnapshot = emptySnapshot()
  let position = 0
  const snapListeners = new Set<() => void>()
  const frameListeners = new Set<(ts: number) => void>()
  return {
    snapshot: () => snap,
    positionSeconds: () => position,
    subscribe: (fn) => {
      snapListeners.add(fn)
      return () => {
        snapListeners.delete(fn)
      }
    },
    subscribeFrame: (fn) => {
      frameListeners.add(fn)
      return () => {
        frameListeners.delete(fn)
      }
    },
    emitFrame: (positionSeconds: number) => {
      position = positionSeconds
      for (const fn of frameListeners) fn(performance.now())
    },
    emitSnapshot: (next?: Partial<MixerSnapshot>) => {
      if (next) snap = { ...snap, ...next }
      for (const fn of snapListeners) fn()
    },
  }
}

describe('useMixer renders only on snapshot changes', () => {
  test('100 RAF ticks while playing do not re-render useMixer consumers', () => {
    const engine = makeFakeEngine()
    let renderCount = 0
    const { result } = renderHook(() => {
      renderCount += 1
      return useMixer(engine as unknown as MixerEngine)
    })
    // Initial mount.
    expect(renderCount).toBe(1)
    expect(result.current.isPlaying).toBe(false)
    // Drive 100 frames worth of position updates. None should re-render us
    // because the snapshot did not change.
    act(() => {
      for (let i = 0; i < 100; i++) {
        engine.emitFrame(i * 0.016)
      }
    })
    expect(renderCount).toBe(1)
  })

  test('snapshot change re-renders exactly once', () => {
    const engine = makeFakeEngine()
    let renderCount = 0
    renderHook(() => {
      renderCount += 1
      return useMixer(engine as unknown as MixerEngine)
    })
    expect(renderCount).toBe(1)
    act(() => {
      engine.emitSnapshot({ isPlaying: true })
    })
    expect(renderCount).toBe(2)
  })
})

describe('usePlayheadPosition isolates per-frame updates', () => {
  test('RAF ticks update the leaf hook', () => {
    const engine = makeFakeEngine()
    let renderCount = 0
    let last = -1
    const { result } = renderHook(() => {
      renderCount += 1
      const p = usePlayheadPosition(engine as unknown as MixerEngine)
      last = p
      return p
    })
    expect(renderCount).toBe(1)
    expect(result.current).toBe(0)
    act(() => {
      engine.emitFrame(1.5)
    })
    expect(last).toBeCloseTo(1.5, 5)
    // Mount + 1 tick = 2 renders. (initial position read + tick.)
    expect(renderCount).toBeGreaterThanOrEqual(2)
  })

  test('sub-half-frame ticks are coalesced (<= 8 ms)', () => {
    const engine = makeFakeEngine()
    let renderCount = 0
    renderHook(() => {
      renderCount += 1
      return usePlayheadPosition(engine as unknown as MixerEngine)
    })
    // Burn one full-step frame to set the coalescing baseline at 1.0.
    act(() => {
      engine.emitFrame(1.0)
    })
    const startRenders = renderCount
    // Emit 10 sub-half-frame ticks (< 8 ms apart from the baseline). Each
    // is below the 0.008 s gate so the hook should NOT setState, the
    // outer render counter stays at 'startRenders' (no extra commits).
    act(() => {
      for (let i = 0; i < 10; i++) {
        engine.emitFrame(1.0 + 0.0005 * i)
      }
    })
    // Allow one trailing render in case act batches a stale commit. What
    // we care about is that 10 sub-half-frame ticks do NOT translate to 10
    // re-renders.
    expect(renderCount - startRenders).toBeLessThanOrEqual(1)
  })

  test('seek while paused (snapshot-only) updates position', () => {
    const engine = makeFakeEngine()
    let last = -1
    renderHook(() => {
      last = usePlayheadPosition(engine as unknown as MixerEngine)
    })
    expect(last).toBe(0)
    act(() => {
      engine.emitFrame(5.0)
      engine.emitSnapshot({ isPlaying: false })
    })
    expect(last).toBeCloseTo(5.0, 5)
  })
})
