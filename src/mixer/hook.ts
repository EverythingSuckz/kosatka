/**
 * `useMixer`. React hook around MixerEngine.
 *
 * Snapshot state (mute, solo, gain, transport) flows via useSyncExternalStore.
 * The engine is the single source of truth, and we re-render on its `notify`.
 *
 * The playhead position is INTENTIONALLY excluded from this handle: it
 * changes 60× per second during playback, and bundling it with the snapshot
 * would force every consumer (the whole `MixerView`, with its 8+ pair rows
 * and per-row waveforms) to reconcile every frame. That was the root cause
 * of the timeline lag at zoom + many keyframes + playback.
 *
 * Components that genuinely need to update per frame (the playhead overlay,
 * the time readout) should use `usePlayheadPosition` directly, typically
 * inside a small leaf component whose only job is to mutate a ref on each
 * tick.
 *
 * Automation gating is scheduled on the audio thread via AudioParam events
 * (`gain.setValueAtTime` / `linearRampToValueAtTime`), no per-frame toggling.
 * The shared RAF only drives the position readout and the loop region
 * bookkeeping.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'

import type { MixerEngine } from './engine'
import type { MixerSnapshot } from './types'

const EMPTY_SNAPSHOT: MixerSnapshot = {
  isPlaying: false,
  masterGain: 1,
  durationSeconds: 0,
  tracks: [],
  wasGlobalMuted: false,
  loopRegion: null,
  automation: {},
  previewPair: null,
}

interface MixerHandle extends MixerSnapshot {
  /** True iff `engine` is non-null. Useful for "first user gesture" gating. */
  ready: boolean
}

export function useMixer(engine: MixerEngine | null): MixerHandle {
  const subscribe = (cb: () => void): (() => void) => {
    if (!engine) return () => {}
    return engine.subscribe(cb)
  }
  const getSnapshot = (): MixerSnapshot => engine?.snapshot() ?? EMPTY_SNAPSHOT
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  return {
    ...snapshot,
    ready: engine !== null,
  }
}

/**
 * Subscribe to the engine's playhead position with React state.
 *
 * Use this ONLY in leaf components whose entire job is to render the
 * position (the playhead overlay, the time readout). Avoid in branches that
 * also render expensive subtrees, those re-render every frame.
 *
 * The hook returns 0 when no engine is connected and never returns stale
 * values: it updates once at mount, on every snapshot change (so paused
 * seeks land), and on every RAF tick while playing.
 */
export function usePlayheadPosition(engine: MixerEngine | null): number {
  const [position, setPosition] = useState(() => engine?.positionSeconds() ?? 0)

  useEffect(() => {
    if (!engine) {
      setPosition(0)
      return undefined
    }
    // Always re-read on snapshot changes. seek while paused / play start
    // both fire `notify` and we want the readout to land at the new offset.
    const unsubSnap = engine.subscribe(() => {
      setPosition(engine.positionSeconds())
    })
    // While playing, RAF drives the readout. Skip sub-half-frame deltas to
    // keep the React commit pressure down on idle desktops where the
    // AudioContext clock has < 1 ms jitter between consecutive frames.
    let lastTick = -1
    const unsubFrame = engine.subscribeFrame(() => {
      const p = engine.positionSeconds()
      if (Math.abs(p - lastTick) < 0.008) return
      lastTick = p
      setPosition(p)
    })
    return () => {
      unsubSnap()
      unsubFrame()
    }
  }, [engine])

  return position
}

/**
 * Subscribe to the playhead position via a ref, zero React renders.
 *
 * Pass a callback that writes the new position to the DOM (e.g. via
 * `el.style.transform = …`). The callback fires on every snapshot change
 * (seek, stop, play) and on every RAF tick while playing.
 *
 * Use this when you can mutate the DOM directly. Prefer it over
 * `usePlayheadPosition` for any component that would otherwise render a
 * non-trivial subtree on every tick.
 */
export function usePlayheadPositionEffect(
  engine: MixerEngine | null,
  onPosition: (positionSeconds: number) => void,
): void {
  const cbRef = useRef(onPosition)
  cbRef.current = onPosition
  useEffect(() => {
    if (!engine) return undefined
    // Emit once immediately so the consumer can paint the initial position.
    cbRef.current(engine.positionSeconds())
    const unsubSnap = engine.subscribe(() => {
      cbRef.current(engine.positionSeconds())
    })
    const unsubFrame = engine.subscribeFrame(() => {
      cbRef.current(engine.positionSeconds())
    })
    return () => {
      unsubSnap()
      unsubFrame()
    }
  }, [engine])
}
