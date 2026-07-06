/**
 * Audacity-style multi-track timeline view.
 *
 * Layout:
 *   ┌─ Ruler (time labels 0:00, 0:30, …) ────────────────────────┐
 *   ├─ Pair row 1: [controls col, sticky][waveform area, scroll] │
 *   ├─ Pair row 2: …                                             │
 *   │  …                                                         │
 *   └────────────────────────────────────────────────────────────┘
 *
 * Automation: per-pair keyframes drive a gain envelope.
 *  - Right-click on empty timeline space → drop a keyframe.
 *  - Click an existing keyframe → select it (route opens the inspector).
 *  - Drag a keyframe horizontally → change its time.
 *  - Right-click or Shift-click an existing keyframe → delete it.
 *
 * The timeline knows nothing about the engine. It raises callbacks for
 * seek / loop set / keyframe edits, and the route wires them.
 */

import { memo, useEffect, useMemo, useRef, useState } from 'react'

import { usePlayheadPositionEffect } from './hook'
import { GAIN_MAX } from './types'
import type { MixerEngine } from './engine'
import type { Keyframe, KeyframeEasing } from './types'

/**
 * Build the keyframe inserted when the user right-clicks an empty patch of
 * a timeline row. The gain is fixed at 1.0 (unity / full pass-through).
 * Keyframes carry ABSOLUTE gain (the pair slider is bypassed for automated
 * pairs), so 1.0 means "play at unity, regardless of the slider's current
 * value". Dropping a fresh keyframe should feel additive, not destructive.
 * Easing is `linear` by default. The inspector disables that choice for
 * the first keyframe of a pair (no prior point to interpolate from).
 *
 * Exported for unit testing. The actual right-click handler in
 * `KeyframesLayerImpl` calls this with the time it computed from the click x.
 */
export function defaultNewKeyframe(timeSec: number): Keyframe {
  return { time: timeSec, gain: 1, easing: 'linear' }
}

/**
 * Compute the SVG path-`d` string for the gain envelope of a single pair.
 * Pure: no DOM, no React. Used both by the React render (memoized) and by
 * the imperative multi-drag re-paint so the same projection is used for
 * both cases.
 *
 * Coordinates target a viewBox of `[0 0 100 100]` (we use
 * `preserveAspectRatio="none"` to stretch to the layer's actual size).
 *  - x is `(time / duration) * 100`
 *  - y is `100 - (gain / GAIN_MAX) * 100`, so peak gain sits at the top.
 *  - `hold` easing renders as a horizontal step into the next kf rather
 *    than a slope, matching the engine's `setValueAtTime` semantics.
 */
export function buildEnvelopePathD(
  keyframes: ReadonlyArray<Keyframe>,
  durationSeconds: number,
): { pathD: string; fillD: string } {
  if (keyframes.length === 0 || durationSeconds <= 0) {
    return { pathD: '', fillD: '' }
  }
  const xy = (k: Keyframe): [number, number] => [
    (k.time / durationSeconds) * 100,
    100 - Math.min(100, (k.gain / GAIN_MAX) * 100),
  ]
  let d = ''
  const [x0, y0] = xy(keyframes[0]!)
  d += `M${x0},${y0}`
  for (let i = 1; i < keyframes.length; i++) {
    const cur = keyframes[i]!
    const prev = keyframes[i - 1]!
    const [xc, yc] = xy(cur)
    const [, yp] = xy(prev)
    if (cur.easing === 'hold') {
      d += `L${xc},${yp}L${xc},${yc}`
    } else {
      d += `L${xc},${yc}`
    }
  }
  const last = keyframes[keyframes.length - 1]!
  const first = keyframes[0]!
  const fill = `${d} L${(last.time / durationSeconds) * 100},100 L${(first.time / durationSeconds) * 100},100 Z`
  return { pathD: d, fillD: fill }
}

/**
 * Clamp a multi-keyframe drag delta so every selected keyframe stays within
 * the song's bounds [0, durationSeconds]. The user's gesture sets `delta`
 * (seconds, signed), and we tighten it to the largest value that keeps all
 * selected keyframes on-screen.
 *
 * Pure: no DOM. Tested directly.
 */
export function clampMultiDragDelta(
  selectedKfTimes: ReadonlyArray<number>,
  delta: number,
  durationSeconds: number,
): number {
  if (selectedKfTimes.length === 0 || durationSeconds <= 0) return 0
  let mn = Infinity
  let mx = -Infinity
  for (const t of selectedKfTimes) {
    if (t < mn) mn = t
    if (t > mx) mx = t
  }
  const minDelta = -mn
  const maxDelta = durationSeconds - mx
  if (delta < minDelta) return minDelta
  if (delta > maxDelta) return maxDelta
  return delta
}

/**
 * Fingerprint a multi-keyframe selection (sorted (pair, idx) refs). This is
 * the coalesce key for the history. Same fingerprint within the coalesce
 * window means "same gesture", so a release-then-pick-up of the SAME
 * selection collapses into one history entry.
 */
export function multiDragFingerprint(
  items: ReadonlyArray<{ pairIndex: number; keyframeIndex: number }>,
): string {
  const pairs = items.map((r) => `${r.pairIndex}.${r.keyframeIndex}`).sort()
  return `kf-multi-drag-${pairs.join('|')}`
}

// Minimum width of the timeline content (CSS pixels) at zoom = 1.
const MIN_TIMELINE_PX = 720

export interface TimelineRulerProps {
  durationSeconds: number
  loopRegion: { start: number; end: number } | null
  loopEnabled: boolean
  contentWidthPx: number
  onSeek: (timeSeconds: number) => void
  onSetLoopBounds: (start: number, end: number) => void
}

function fmtTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0
  const min = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${min}:${String(sec).padStart(2, '0')}`
}

/** Choose a "nice" major tick interval (in seconds) for the ruler labels. */
function pickTickInterval(secondsPerPixel: number): number {
  const targetPx = 100
  const targetSec = secondsPerPixel * targetPx
  const candidates = [
    1, 2, 5, 10, 15, 20, 30, 60, 90, 120, 180, 300, 600, 900, 1200, 1800,
  ]
  for (const c of candidates) {
    if (c >= targetSec) return c
  }
  return candidates[candidates.length - 1]!
}

export function TimelineRuler({
  durationSeconds,
  loopRegion,
  loopEnabled,
  contentWidthPx,
  onSeek,
  onSetLoopBounds,
}: TimelineRulerProps): React.ReactNode {
  const rulerRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<'start' | 'end' | null>(null)
  const dragTimeRef = useRef<number>(0)
  const startHandleRef = useRef<HTMLDivElement>(null)
  const endHandleRef = useRef<HTMLDivElement>(null)
  const startOverlayRef = useRef<HTMLDivElement>(null)
  const [, force] = useState(0)

  const tickSec = pickTickInterval(
    contentWidthPx > 0 ? durationSeconds / contentWidthPx : 1,
  )
  const ticks: Array<number> = []
  if (durationSeconds > 0) {
    for (let t = 0; t <= durationSeconds + 0.001; t += tickSec) {
      ticks.push(t)
    }
  }

  useEffect(() => {
    if (!loopEnabled || !loopRegion) return
    const onMove = (e: MouseEvent): void => {
      const el = rulerRef.current
      if (!el || durationSeconds <= 0) return
      if (!dragRef.current) return
      const rect = el.getBoundingClientRect()
      const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
      const t = pct * durationSeconds
      dragTimeRef.current = t
      const startSec =
        dragRef.current === 'start'
          ? Math.min(t, loopRegion.end - 0.1)
          : loopRegion.start
      const endSec =
        dragRef.current === 'end'
          ? Math.max(t, loopRegion.start + 0.1)
          : loopRegion.end
      const sPct = (startSec / durationSeconds) * 100
      const ePct = (endSec / durationSeconds) * 100
      if (startHandleRef.current) startHandleRef.current.style.left = `${sPct}%`
      if (endHandleRef.current) endHandleRef.current.style.left = `${ePct}%`
      if (startOverlayRef.current) {
        startOverlayRef.current.style.left = `${sPct}%`
        startOverlayRef.current.style.width = `${Math.max(0, ePct - sPct)}%`
      }
    }
    const onUp = (): void => {
      if (!dragRef.current) return
      const t = dragTimeRef.current
      const which = dragRef.current
      dragRef.current = null
      if (which === 'start') {
        onSetLoopBounds(Math.min(t, loopRegion.end - 0.1), loopRegion.end)
      } else {
        onSetLoopBounds(loopRegion.start, Math.max(t, loopRegion.start + 0.1))
      }
      force((v) => v + 1)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [durationSeconds, loopRegion, loopEnabled, onSetLoopBounds])

  const onRulerMouseDown = (e: React.MouseEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    if (dragRef.current) return
    const el = rulerRef.current
    if (!el || durationSeconds <= 0) return
    const rect = el.getBoundingClientRect()
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    onSeek(pct * durationSeconds)
  }

  return (
    <div
      ref={rulerRef}
      onMouseDown={onRulerMouseDown}
      className="relative h-7 cursor-pointer select-none border-b border-[var(--color-line-strong)] bg-[var(--color-bg-1)]"
      style={{ width: `${contentWidthPx}px` }}
      role="slider"
      aria-label="timeline ruler (click to seek)"
      aria-valuemin={0}
      aria-valuemax={Math.round(durationSeconds)}
    >
      {ticks.map((t) => {
        const pct = durationSeconds > 0 ? t / durationSeconds : 0
        return (
          <div
            key={t}
            className="pointer-events-none absolute top-0 h-full flex items-center pl-1"
            style={{ left: `${pct * 100}%` }}
          >
            <span className="block h-2 w-px bg-[var(--color-line-strong)]" />
            <span className="ml-1 text-[10px] tabular-nums uppercase tracking-[0.08em] text-[var(--color-fg-dim)]">
              {fmtTime(t)}
            </span>
          </div>
        )
      })}
      {loopEnabled && loopRegion && durationSeconds > 0 && (
        <>
          <div
            ref={startOverlayRef}
            className="pointer-events-none absolute inset-y-0 bg-[var(--color-active)]/20 border-x border-[var(--color-active)]/70"
            style={{
              left: `${(loopRegion.start / durationSeconds) * 100}%`,
              width: `${((loopRegion.end - loopRegion.start) / durationSeconds) * 100}%`,
            }}
          />
          <LoopHandle
            handleRef={startHandleRef}
            position="start"
            pct={loopRegion.start / durationSeconds}
            onMouseDown={() => {
              dragRef.current = 'start'
              dragTimeRef.current = loopRegion.start
            }}
          />
          <LoopHandle
            handleRef={endHandleRef}
            position="end"
            pct={loopRegion.end / durationSeconds}
            onMouseDown={() => {
              dragRef.current = 'end'
              dragTimeRef.current = loopRegion.end
            }}
          />
        </>
      )}
    </div>
  )
}

function LoopHandle({
  handleRef,
  position,
  pct,
  onMouseDown,
}: {
  handleRef: React.RefObject<HTMLDivElement | null>
  position: 'start' | 'end'
  pct: number
  onMouseDown: () => void
}): React.ReactNode {
  return (
    <div
      ref={handleRef}
      onMouseDown={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onMouseDown()
      }}
      onClick={(e) => e.stopPropagation()}
      className="absolute top-0 z-10 h-full w-3 cursor-ew-resize"
      style={{
        left: `${pct * 100}%`,
        transform: position === 'start' ? 'translateX(-100%)' : 'translateX(0)',
      }}
      role="slider"
      aria-label={`loop ${position}`}
      aria-valuenow={Math.round(pct * 100)}
    >
      <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-0.5 bg-[var(--color-active)] shadow-[0_0_4px_rgba(74,222,128,0.7)]" />
      <div
        className="absolute top-0 left-1/2 -translate-x-1/2 h-2 w-2 bg-[var(--color-active)]"
        style={{ clipPath: 'polygon(0 0, 100% 0, 50% 100%)' }}
      />
      <div
        className="absolute bottom-0 left-1/2 -translate-x-1/2 h-2 w-2 bg-[var(--color-active)]"
        style={{ clipPath: 'polygon(0 100%, 100% 100%, 50% 0)' }}
      />
    </div>
  )
}

/**
 * Single overlay playhead. Self-subscribes to the engine's RAF so the
 * surrounding `MixerView` does NOT re-render per frame. Only this leaf
 * mutates a transform on its own DOM node. Triggers no React state churn.
 *
 * Width / duration / engine are stable props. Only the engine subscription
 * fires every tick, and the body of that callback is a single `style.transform =`.
 */
export function TimelinePlayhead({
  engine,
  durationSeconds,
  contentWidthPx,
}: {
  engine: MixerEngine | null
  durationSeconds: number
  contentWidthPx: number
}): React.ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  // Keep latest layout values in refs so the per-frame subscription closes
  // over the freshest geometry without re-subscribing on every render.
  const durRef = useRef(durationSeconds)
  durRef.current = durationSeconds
  const widthRef = useRef(contentWidthPx)
  widthRef.current = contentWidthPx
  usePlayheadPositionEffect(engine, (positionSeconds) => {
    const el = ref.current
    if (!el) return
    const dur = durRef.current
    const width = widthRef.current
    if (dur <= 0) {
      el.style.transform = 'translateX(0px)'
      return
    }
    const px = (positionSeconds / dur) * width
    el.style.transform = `translateX(${Math.max(0, Math.min(width, px)).toFixed(2)}px)`
  })
  // Geometry-only re-positioning: when zoom/duration changes the position
  // we last drew is stale even though the underlying position hasn't moved.
  // Re-emit on geometry change.
  useEffect(() => {
    const el = ref.current
    if (!el || !engine) return
    const dur = durationSeconds
    if (dur <= 0) {
      el.style.transform = 'translateX(0px)'
      return
    }
    const px = (engine.positionSeconds() / dur) * contentWidthPx
    el.style.transform = `translateX(${Math.max(0, Math.min(contentWidthPx, px)).toFixed(2)}px)`
  }, [engine, durationSeconds, contentWidthPx])
  return (
    <div
      ref={ref}
      className="pointer-events-none absolute top-0 left-0 z-20 h-full w-px bg-[var(--color-active)] shadow-[0_0_4px_rgba(74,222,128,0.7)]"
      style={{ willChange: 'transform' }}
      aria-hidden
    />
  )
}

export function TimelineLoopOverlay({
  loopRegion,
  durationSeconds,
  contentWidthPx,
  loopEnabled,
}: {
  loopRegion: { start: number; end: number } | null
  durationSeconds: number
  contentWidthPx: number
  loopEnabled: boolean
}): React.ReactNode {
  if (!loopEnabled || !loopRegion || durationSeconds <= 0) return null
  const startPx = (loopRegion.start / durationSeconds) * contentWidthPx
  const widthPx =
    ((loopRegion.end - loopRegion.start) / durationSeconds) * contentWidthPx
  return (
    <div
      className="pointer-events-none absolute inset-y-0 z-10 bg-[var(--color-active)]/10 border-x border-[var(--color-active)]/40"
      style={{ left: `${startPx}px`, width: `${widthPx}px` }}
      aria-hidden
    />
  )
}

/**
 * Per-pair keyframe layer. Renders a diamond for each keyframe and a polyline
 * between them visualizing the gain ramp. Gestures:
 *  - Right-click on empty space    → place a new keyframe at click time.
 *  - Left-click on a diamond       → select that keyframe (replace selection).
 *  - Ctrl/Cmd-click on a diamond   → toggle this kf in/out of the selection.
 *  - Shift-click on a diamond      → select range from last click to here.
 *  - Left-drag a diamond           → move it in time (commits on pointerup).
 *  - Right-click on a diamond      → open context menu.
 */
// Bumped from 10 → 12 so unselected diamonds are easier to grab on a busy
// timeline. The fills (see `easingClass`) carry most of the visibility win.
// The size bump just gives the hitbox a bit more room.
const KF_DIAMOND_PX = 12

/** Modifier flags forwarded from a kf click. The route decides what to do. */
export interface KeyframeClickModifiers {
  ctrl: boolean
  shift: boolean
}

/**
 * Selected keyframe ref used by the multi-drag coordinator. Mirrors the
 * `KeyframeRef` from `selection.ts` but kept independent here so the
 * timeline module doesn't depend on selection.
 */
export interface MultiDragKeyframeRef {
  pairIndex: number
  keyframeIndex: number
}

/**
 * Cross-pair registry so a drag started on one pair's diamond can imperatively
 * move diamonds + recompute paths on OTHER pairs during the drag. The route
 * builds one of these and passes it down to every `KeyframesLayer`, and each
 * pair's layer registers its DOM refs into it on mount / on change.
 *
 * The coordinator is intentionally a plain object (not a context). Drags
 * touch DOM 60×/s, and going through React state would defeat the
 * "don't re-render per frame" goal we have for the single-kf drag too.
 */
export interface MultiDragCoordinator {
  /** Look up the diamond DOM node for a given (pair, kf). Returns null if
   *  unregistered or recently unmounted. */
  getDiamond: (pairIndex: number, kfIndex: number) => HTMLDivElement | null
  /** Look up the path/fill DOM nodes for a given pair. */
  getPath: (pairIndex: number) => {
    path: SVGPathElement | null
    fill: SVGPathElement | null
  }
  /** Current keyframes for a pair, used to recompute path d-strings during
   *  drag without going through React. */
  getKeyframes: (pairIndex: number) => ReadonlyArray<Keyframe>
  /** A KeyframesLayer registers / unregisters as its diamonds and SVG paths
   *  mount / unmount. The route's coordinator owns the storage. */
  registerDiamond: (
    pairIndex: number,
    kfIndex: number,
    el: HTMLDivElement | null,
  ) => void
  registerPath: (
    pairIndex: number,
    el: { path: SVGPathElement | null; fill: SVGPathElement | null },
  ) => void
}

interface KeyframesLayerProps {
  /** Identifies which pair this layer represents. Used for multi-drag plumbing
   *  so the coordinator can route drag updates to other pairs' diamonds. */
  pairIndex: number
  keyframes: ReadonlyArray<Keyframe>
  durationSeconds: number
  /**
   * Indices of all selected keyframes in this pair (for highlighting).
   * Single-selection callers can pass `[idx]`, empty array means none.
   */
  selectedIndices: ReadonlyArray<number>
  /**
   * Full multi-selection (across all pairs). When the user starts a drag on a
   * diamond that IS in this set, we treat the drag as a GROUP move where the
   * coordinator updates diamonds and SVG paths on other pairs imperatively.
   * Passing `null` (or an empty array) disables multi-drag, useful for tests
   * and for layers that don't have a coordinator wired.
   */
  multiSelectedRefs: ReadonlyArray<MultiDragKeyframeRef> | null
  /** Multi-drag DOM coordinator (null for layers rendered without one). */
  coordinator: MultiDragCoordinator | null
  onKeyframeAdd: (kf: Keyframe) => void
  onKeyframeMove: (index: number, identity: Keyframe, newTime: number) => void
  /** Group-move commit: every selected kf shifts by `deltaSeconds`. */
  onKeyframesMoveMany: (
    refs: ReadonlyArray<MultiDragKeyframeRef>,
    deltaSeconds: number,
  ) => void
  /**
   * Plain click (no modifiers): caller replaces selection.
   * With modifiers: caller toggles or extends.
   */
  onKeyframeClick: (
    index: number,
    keyframe: Keyframe,
    mods: KeyframeClickModifiers,
  ) => void
  /** Right-click on a diamond: caller opens a context menu at (x, y). */
  onKeyframeContextMenu: (
    index: number,
    keyframe: Keyframe,
    clientX: number,
    clientY: number,
  ) => void
}

function KeyframesLayerImpl({
  pairIndex,
  keyframes,
  durationSeconds,
  selectedIndices,
  multiSelectedRefs,
  coordinator,
  onKeyframeAdd,
  onKeyframeMove,
  onKeyframesMoveMany,
  onKeyframeClick,
  onKeyframeContextMenu,
}: KeyframesLayerProps): React.ReactNode {
  const layerRef = useRef<HTMLDivElement>(null)
  const diamondRefs = useRef(new Map<number, HTMLDivElement>())
  const pathRef = useRef<SVGPathElement | null>(null)
  const fillRef = useRef<SVGPathElement | null>(null)
  // Drag-state ref shape:
  //  - `multi: null`            → single-kf drag (legacy path, by-time commit)
  //  - `multi: [...refs]`       → group drag (delta-time commit across refs)
  // `multi.refs` is captured at pointerdown so the user's selection edits
  // during the drag don't move the goalposts.
  const dragRef = useRef<{
    index: number
    identity: Keyframe
    startedAt: number
    moved: boolean
    mods: KeyframeClickModifiers
    /** Non-null iff the grabbed diamond is part of a 2+ multi-selection. */
    multi: {
      /** Snapshot of selected refs at pointerdown. Captures includes from
       *  other pairs as well as this one. */
      refs: ReadonlyArray<MultiDragKeyframeRef>
      /** Snapshot of kf TIMES (per ref, same order) at pointerdown. Used to
       *  compute live preview positions without re-querying state. */
      startTimes: ReadonlyArray<number>
    } | null
  } | null>(null)
  const dragCommitRef = useRef<{
    /** Single-kf path: the committed absolute time. */
    newTime?: number
    /** Multi-kf path: the committed delta in seconds. */
    deltaSeconds?: number
  } | null>(null)

  const selectedSet = useMemo(() => {
    const s = new Set<number>()
    for (const i of selectedIndices) s.add(i)
    return s
  }, [selectedIndices])

  // Look up THIS pair's index in the multi-selection. Used so the
  // pointerdown handler can decide whether to enter group-drag mode.
  const multiSelInThisPair = useMemo(() => {
    if (!multiSelectedRefs) return new Set<number>()
    const s = new Set<number>()
    for (const r of multiSelectedRefs) {
      if (r.pairIndex === pairIndex) s.add(r.keyframeIndex)
    }
    return s
  }, [multiSelectedRefs, pairIndex])

  const xToTime = (clientX: number): number => {
    const el = layerRef.current
    if (!el || durationSeconds <= 0) return 0
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0) return 0
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    // Snap to 0.01s (or finer with zoom, but the snap step is uniform here).
    const t = pct * durationSeconds
    return Math.round(t * 100) / 100
  }

  useEffect(() => {
    const onMove = (e: PointerEvent): void => {
      const drag = dragRef.current
      if (!drag) return
      const t = xToTime(e.clientX)
      if (Math.abs(t - drag.startedAt) > 0.001) drag.moved = true

      // Multi-drag path
      if (drag.multi) {
        // Compute the delta the user is requesting (from the grabbed kf's
        // original time). Then clamp so no selected kf escapes [0, dur].
        const rawDelta = t - drag.startedAt
        const clamped = clampMultiDragDelta(
          drag.multi.startTimes,
          rawDelta,
          durationSeconds,
        )
        dragCommitRef.current = { deltaSeconds: clamped }
        if (durationSeconds <= 0) return

        // Update every selected diamond AND its parent pair's envelope path.
        // We group refs by pair so we only do one path recompute per pair.
        const byPair = new Map<
          number,
          { refs: Array<MultiDragKeyframeRef>; startTimes: Array<number> }
        >()
        for (let i = 0; i < drag.multi.refs.length; i++) {
          const r = drag.multi.refs[i]!
          const startT = drag.multi.startTimes[i]!
          const slot = byPair.get(r.pairIndex)
          if (slot) {
            slot.refs.push(r)
            slot.startTimes.push(startT)
          } else {
            byPair.set(r.pairIndex, { refs: [r], startTimes: [startT] })
          }
        }
        for (const [pairIdx, group] of byPair) {
          // 1) move each diamond imperatively
          //    The grabbed pair's diamonds live in our local diamondRefs map,
          //    all other pairs' diamonds are reachable via the coordinator.
          for (let i = 0; i < group.refs.length; i++) {
            const r = group.refs[i]!
            const newT = group.startTimes[i]! + clamped
            const pct = (newT / durationSeconds) * 100
            const node =
              pairIdx === pairIndex
                ? (diamondRefs.current.get(r.keyframeIndex) ?? null)
                : (coordinator?.getDiamond(r.pairIndex, r.keyframeIndex) ??
                  null)
            if (node) node.style.left = `${pct}%`
          }
          // 2) recompute the envelope path for the pair (Option A polish).
          //    Build a preview keyframe list with the selected kfs shifted by
          //    `clamped`, sorted by time, and re-emit d-strings.
          let live: ReadonlyArray<Keyframe>
          if (pairIdx === pairIndex) {
            live = keyframes
          } else {
            live = coordinator?.getKeyframes(pairIdx) ?? []
          }
          const selSet = new Set<number>(group.refs.map((r) => r.keyframeIndex))
          const preview: Array<Keyframe> = []
          for (let i = 0; i < live.length; i++) {
            const k = live[i]!
            if (selSet.has(i)) {
              preview.push({
                time: k.time + clamped,
                gain: k.gain,
                easing: k.easing,
              })
            } else {
              preview.push(k)
            }
          }
          preview.sort((a, b) => a.time - b.time)
          const { pathD, fillD } = buildEnvelopePathD(preview, durationSeconds)
          let pathEl: SVGPathElement | null = null
          let fillEl: SVGPathElement | null = null
          if (pairIdx === pairIndex) {
            pathEl = pathRef.current
            fillEl = fillRef.current
          } else if (coordinator) {
            const got = coordinator.getPath(pairIdx)
            pathEl = got.path
            fillEl = got.fill
          }
          if (pathEl) pathEl.setAttribute('d', pathD)
          if (fillEl) fillEl.setAttribute('d', fillD)
        }
        return
      }

      // Single-kf path (legacy)
      dragCommitRef.current = { newTime: t }
      const node = diamondRefs.current.get(drag.index)
      if (node && durationSeconds > 0) {
        const pct = (t / durationSeconds) * 100
        node.style.left = `${pct}%`
      }
      // Also keep the envelope path in sync during a single-kf drag. The
      // memoized React render won't kick in until pointerup commits.
      if (pathRef.current || fillRef.current) {
        const preview = keyframes.map((k, i) =>
          i === drag.index ? { time: t, gain: k.gain, easing: k.easing } : k,
        )
        preview.sort((a, b) => a.time - b.time)
        const { pathD, fillD } = buildEnvelopePathD(preview, durationSeconds)
        if (pathRef.current) pathRef.current.setAttribute('d', pathD)
        if (fillRef.current) fillRef.current.setAttribute('d', fillD)
      }
    }
    const onUp = (_e: PointerEvent): void => {
      const drag = dragRef.current
      const commit = dragCommitRef.current
      dragRef.current = null
      dragCommitRef.current = null
      if (!drag) return
      if (drag.moved && commit) {
        if (drag.multi && commit.deltaSeconds !== undefined) {
          // Snap-to-grid the delta to 0.01s for consistency with single-kf.
          const dq = Math.round(commit.deltaSeconds * 100) / 100
          onKeyframesMoveMany(drag.multi.refs, dq)
        } else if (commit.newTime !== undefined) {
          onKeyframeMove(drag.index, drag.identity, commit.newTime)
        }
      } else {
        // Treat as a click → forward to the route with modifiers.
        onKeyframeClick(drag.index, drag.identity, drag.mods)
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [
    durationSeconds,
    onKeyframeMove,
    onKeyframesMoveMany,
    onKeyframeClick,
    coordinator,
    keyframes,
    pairIndex,
  ])

  // Right-click on the empty layer → add a keyframe at click time.
  // See `defaultNewKeyframe` for why gain is fixed at 1.0 rather than the
  // pair's current slider value.
  const onLayerContextMenu = (e: React.MouseEvent<HTMLDivElement>): void => {
    e.preventDefault()
    if (durationSeconds <= 0) return
    const t = xToTime(e.clientX)
    onKeyframeAdd(defaultNewKeyframe(t))
  }

  // Memoize the SVG path + fill-region path. With dozens of keyframes per
  // pair and re-renders happening any time the surrounding view reconciles,
  // re-stringifying the path every commit was a measurable cost, so this caches
  // it until the keyframe list or duration actually changes.
  //
  // We render at fixed 100% height and place keyframes vertically by
  // `1 - gain/GAIN_MAX` (so max gain sits at top, zero at bottom).
  // `hold` easing renders as a step instead of a slope.
  //
  // The path/fill DOM nodes are also captured into refs (and the coordinator)
  // so the multi-drag handler can imperatively repaint them during a gesture
  // without going through React.
  const { pathD, fillD } = useMemo(
    () => buildEnvelopePathD(keyframes, durationSeconds),
    [keyframes, durationSeconds],
  )

  // Position lookups for diamonds + droppers. Also memoized. The input is
  // the same data, the output is read twice per render (droppers + diamonds).
  const positions = useMemo(() => {
    if (durationSeconds <= 0) return []
    return keyframes.map((kf) => (kf.time / durationSeconds) * 100)
  }, [keyframes, durationSeconds])

  return (
    <div
      ref={layerRef}
      onContextMenu={onLayerContextMenu}
      className="absolute inset-0 z-[12]"
      aria-hidden
    >
      {/* SVG envelope visualization. Pointer events disabled so the diamonds
          and the underlying right-click handler still get hits. */}
      {pathD !== '' && (
        <svg
          className="pointer-events-none absolute inset-0 h-full w-full"
          preserveAspectRatio="none"
          viewBox="0 0 100 100"
          aria-hidden
        >
          {/* Fill region under the curve. */}
          <path
            ref={(el) => {
              fillRef.current = el
              coordinator?.registerPath(pairIndex, {
                path: pathRef.current,
                fill: el,
              })
            }}
            d={fillD}
            fill="var(--color-active)"
            fillOpacity={0.3}
          />
          {/* The line itself. */}
          <path
            ref={(el) => {
              pathRef.current = el
              coordinator?.registerPath(pairIndex, {
                path: el,
                fill: fillRef.current,
              })
            }}
            d={pathD}
            fill="none"
            stroke="var(--color-active)"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      )}
      {/* Tiny vertical droppers from each keyframe for placement readability. */}
      {keyframes.map((kf, i) => {
        const pct = positions[i]
        if (pct === undefined) return null
        return (
          <div
            key={`drop-${i}-${kf.time}`}
            className="pointer-events-none absolute top-0 bottom-0 w-px bg-[var(--color-active)]/40"
            style={{ left: `${pct}%` }}
            aria-hidden
          />
        )
      })}
      {keyframes.map((kf, i) => {
        const pct = positions[i]
        if (pct === undefined) return null
        const isSelected = selectedSet.has(i)
        return (
          <KeyframeDiamond
            key={`kf-${i}-${kf.time}`}
            keyframe={kf}
            leftPct={pct}
            selected={isSelected}
            setRef={(el) => {
              if (el) diamondRefs.current.set(i, el)
              else diamondRefs.current.delete(i)
              coordinator?.registerDiamond(pairIndex, i, el)
            }}
            onPointerDown={(e) => {
              if (e.button === 2) return // right-click handled in onContextMenu
              if (e.button !== 0) return
              e.preventDefault()
              e.stopPropagation()
              // Decide single-vs-multi drag based on whether THIS diamond is
              // in the current multi-selection AND there are 2+ selected
              // keyframes overall. Grabbing a non-selected diamond reverts
              // to the legacy single-kf drag. The route's `onKeyframeClick`
              // (fired only on a click without movement, see onUp) will swap
              // selection to this single kf.
              const inMulti = multiSelInThisPair.has(i)
              const totalSelected = multiSelectedRefs?.length ?? 0
              const useMulti = inMulti && totalSelected >= 2
              const refs = useMulti
                ? (multiSelectedRefs as ReadonlyArray<MultiDragKeyframeRef>)
                : null
              let startTimes: Array<number> | null = null
              if (refs) {
                startTimes = []
                for (const r of refs) {
                  // Resolve each ref's CURRENT time. For the grabbed pair we
                  // read from `keyframes` directly, for other pairs ask the
                  // coordinator. Missing refs (e.g. pair without coord) fall
                  // back to the grabbed kf's time to keep clamps sane.
                  if (r.pairIndex === pairIndex) {
                    const k = keyframes[r.keyframeIndex]
                    startTimes.push(k ? k.time : kf.time)
                  } else if (coordinator) {
                    const list = coordinator.getKeyframes(r.pairIndex)
                    const k = list[r.keyframeIndex]
                    startTimes.push(k ? k.time : kf.time)
                  } else {
                    startTimes.push(kf.time)
                  }
                }
              }
              dragRef.current = {
                index: i,
                identity: kf,
                startedAt: kf.time,
                moved: false,
                mods: {
                  ctrl: e.ctrlKey || e.metaKey,
                  shift: e.shiftKey,
                },
                multi: refs && startTimes ? { refs, startTimes } : null,
              }
              dragCommitRef.current = null
            }}
            onContextMenu={(e) => {
              e.preventDefault()
              e.stopPropagation()
              onKeyframeContextMenu(i, kf, e.clientX, e.clientY)
            }}
          />
        )
      })}
    </div>
  )
}

/**
 * `KeyframesLayer` is rendered once per pair, often 8+ times on a single
 * timeline. The parent (`PairTimelineRow`) reconciled on every playhead
 * tick before this perf pass, so wrapping in `memo` short-circuits the
 * reconcile when nothing about THIS pair has changed (no keyframe edit,
 * no zoom change, no selection change).
 */
export const KeyframesLayer = memo(KeyframesLayerImpl)

function easingClass(
  selected: boolean,
  easing: KeyframeEasing,
): {
  border: string
  fill: string
  borderWidthPx: number
} {
  if (selected) {
    // Solid active + matching border. Reads as "this is what the inspector
    // is showing right now."
    return {
      border: 'var(--color-active)',
      fill: 'var(--color-active)',
      borderWidthPx: 1,
    }
  }
  // Unselected: OUTLINE ONLY (transparent fill) with a thick 1.5 px border
  // so the diamond reads against the timeline track. Round-4 used filled
  // dim-grey, which the user reported as "not even visible." Hold uses the
  // active hue at 60 % opacity so hold vs linear is distinguishable at a
  // glance without needing a separate token.
  if (easing === 'hold') {
    return {
      border: 'color-mix(in srgb, var(--color-active) 60%, transparent)',
      fill: 'transparent',
      borderWidthPx: 1.5,
    }
  }
  return {
    border: 'var(--color-fg)',
    fill: 'transparent',
    borderWidthPx: 1.5,
  }
}

function KeyframeDiamond({
  keyframe,
  leftPct,
  selected,
  setRef,
  onPointerDown,
  onContextMenu,
}: {
  keyframe: Keyframe
  leftPct: number
  selected: boolean
  setRef: (el: HTMLDivElement | null) => void
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void
  onContextMenu: (e: React.MouseEvent<HTMLDivElement>) => void
}): React.ReactNode {
  const { border, fill, borderWidthPx } = easingClass(selected, keyframe.easing)
  return (
    <div
      ref={setRef}
      onPointerDown={onPointerDown}
      onContextMenu={onContextMenu}
      onClick={(e) => e.stopPropagation()}
      role="button"
      aria-label={`keyframe at ${keyframe.time.toFixed(2)}s, gain ${keyframe.gain.toFixed(2)}`}
      title={`time ${keyframe.time.toFixed(2)}s, gain ${keyframe.gain.toFixed(2)}, ${keyframe.easing}, drag to move, right-click to delete`}
      className="absolute top-1/2 z-[14] cursor-grab select-none"
      style={{
        left: `${leftPct}%`,
        width: `${KF_DIAMOND_PX}px`,
        height: `${KF_DIAMOND_PX}px`,
        marginLeft: `-${KF_DIAMOND_PX / 2}px`,
        marginTop: `-${KF_DIAMOND_PX / 2}px`,
        background: fill,
        border: `${borderWidthPx}px solid ${border}`,
        transform: 'rotate(45deg)',
      }}
    />
  )
}

export function computeContentWidth(
  containerWidthPx: number,
  zoom: number,
): number {
  const base = Math.max(MIN_TIMELINE_PX, containerWidthPx)
  return Math.round(base * zoom)
}

/**
 * Factory for the multi-drag DOM coordinator (see `MultiDragCoordinator`).
 * The route owns one instance and passes it to every `KeyframesLayer`. The
 * coordinator holds raw DOM refs, no React state, so drag handlers can
 * mutate transforms at 60 Hz without triggering reconciles.
 *
 * `getKeyframes` is supplied by the caller (the route) and reads from the
 * latest snapshot. The coordinator can't store keyframes itself because
 * the engine's snapshot changes on every edit and we want fresh data.
 */
export function createMultiDragCoordinator(
  getKeyframes: (pairIndex: number) => ReadonlyArray<Keyframe>,
): MultiDragCoordinator {
  const diamonds = new Map<string, HTMLDivElement>()
  const paths = new Map<
    number,
    { path: SVGPathElement | null; fill: SVGPathElement | null }
  >()
  const k = (pi: number, kf: number): string => `${pi}.${kf}`
  return {
    getDiamond: (pi, kf) => diamonds.get(k(pi, kf)) ?? null,
    getPath: (pi) => paths.get(pi) ?? { path: null, fill: null },
    getKeyframes,
    registerDiamond: (pi, kf, el) => {
      const key = k(pi, kf)
      if (el) diamonds.set(key, el)
      else diamonds.delete(key)
    },
    registerPath: (pi, refs) => {
      paths.set(pi, refs)
    },
  }
}
