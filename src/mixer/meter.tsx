/**
 * Per-pair volume meter. Subscribes to the engine's shared RAF loop, not its
 * own per-component RAF, because per-component RAF made the timeline lag on
 * 16-channel files (8 meters at 60 fps of React state churn). All paint goes
 * through direct DOM mutation on ref'd divs, so React sees zero re-renders
 * during playback.
 *
 * Visual:
 *   [══════════════════·          ]   peak hold (1 px line)
 *    └─ live bar (green/yellow/red)
 *
 * Width spans 0..1.2 amplitude mapped to 0..100% so signal above 0 dBFS
 * still shows movement. Peak hold tracks the loudest sample in a 1 s window
 * then decays linearly.
 *
 * The component only re-renders when track ids or `active` flips, not per
 * frame.
 *
 * Also exports `PairListMeter`, a tiny inline meter used by the pair-list
 * column rows. Same shared-RAF plus direct-DOM-mutation strategy. Width
 * ~32 px, height 4 px, peak-hold pin for 500 ms.
 */

import { useEffect, useRef } from 'react'

import type { MixerEngine } from './engine'

interface PairMeterProps {
  engine: MixerEngine
  leftId: string | null
  rightId: string | null
  /** True while transport is playing. Meter only animates when true. */
  active: boolean
}

interface MasterMeterProps {
  engine: MixerEngine
  /** All audible track ids. The meter sums their analyser peaks. */
  trackIds: ReadonlyArray<string>
  /** True while transport is playing. Meter only animates when true. */
  active: boolean
}

/** How long peak hold stays at max before decaying (seconds). */
const PEAK_HOLD_SECONDS = 1.0
/** Decay rate after hold expires (amplitude units per second). */
const PEAK_DECAY_PER_SEC = 0.6

export function PairMeter({
  engine,
  leftId,
  rightId,
  active,
}: PairMeterProps): React.ReactNode {
  const barRef = useRef<HTMLDivElement>(null)
  const peakLineRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const bar = barRef.current
    const peakLine = peakLineRef.current
    if (!bar || !peakLine) return
    if (!active) {
      // Reset to flat when paused. looks more deliberate than freezing at
      // whatever the last frame was.
      bar.style.transform = 'scaleX(0)'
      bar.style.background = 'var(--color-line-strong)'
      peakLine.style.opacity = '0'
      return
    }
    let lastTs = -1
    let peakHold = 0
    let peakHoldExpiresAt = 0
    const unsubscribe = engine.subscribeFrame((ts) => {
      // ts is the rAF timestamp in ms.
      const now = ts / 1000
      if (lastTs < 0) lastTs = now
      const dt = now - lastTs
      lastTs = now

      const l = leftId ? engine.readMeter(leftId) : null
      const r = rightId ? engine.readMeter(rightId) : null
      const peak = Math.max(l?.peak ?? 0, r?.peak ?? 0)

      // Peak hold logic: if new peak ≥ current hold, replace and arm hold.
      // Otherwise decay after the hold window expires.
      if (peak >= peakHold) {
        peakHold = peak
        peakHoldExpiresAt = now + PEAK_HOLD_SECONDS
      } else if (now > peakHoldExpiresAt) {
        peakHold = Math.max(peak, peakHold - PEAK_DECAY_PER_SEC * dt)
      }

      // Map 0..1.2 → 0..1 for the bar, clamp to 100%.
      const barFrac = Math.min(1, peak / 1.2)
      // scaleX is cheaper than width for the GPU compositor.
      bar.style.transform = `scaleX(${barFrac.toFixed(4)})`
      let color = 'var(--color-active)'
      if (peak >= 0.95) color = 'var(--color-danger)'
      else if (peak >= 0.75) color = 'var(--color-solo)'
      bar.style.background = color

      const peakFrac = Math.min(1, peakHold / 1.2)
      // Position the peak-hold line at left%. (Width is 0, just translate.)
      peakLine.style.transform = `translateX(${(peakFrac * 100).toFixed(2)}%)`
      peakLine.style.opacity = peakHold > 0.02 ? '1' : '0'
    })
    return () => {
      unsubscribe()
      // Flush to flat so a paused meter doesn't show a stale frame.
      bar.style.transform = 'scaleX(0)'
      bar.style.background = 'var(--color-line-strong)'
      peakLine.style.opacity = '0'
    }
  }, [engine, leftId, rightId, active])

  return (
    <div
      className="relative h-1.5 w-full overflow-hidden border border-[var(--color-line)] bg-[var(--color-bg-2)]"
      aria-hidden
    >
      <div
        ref={barRef}
        className="absolute inset-0 origin-left"
        style={{
          transform: 'scaleX(0)',
          background: 'var(--color-line-strong)',
          willChange: 'transform',
        }}
      />
      <div
        ref={peakLineRef}
        className="pointer-events-none absolute inset-y-0 left-0 w-px bg-[var(--color-fg)] opacity-0"
        style={{ willChange: 'transform, opacity' }}
      />
    </div>
  )
}

/**
 * Master output meter. Sums the peak across every track that's currently
 * un-muted. Uses the same shared RAF loop and direct-DOM-mutation strategy as
 * PairMeter so 16 stems still animate at 60 fps. Two side-by-side bars (L/R
 * approximated by even-index vs odd-index tracks, matching the auto-pan
 * convention in the mixer route).
 */
export function MasterMeter({
  engine,
  trackIds,
  active,
}: MasterMeterProps): React.ReactNode {
  const lBarRef = useRef<HTMLDivElement>(null)
  const rBarRef = useRef<HTMLDivElement>(null)
  const lPeakRef = useRef<HTMLDivElement>(null)
  const rPeakRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const lBar = lBarRef.current
    const rBar = rBarRef.current
    const lPeak = lPeakRef.current
    const rPeak = rPeakRef.current
    if (!lBar || !rBar || !lPeak || !rPeak) return
    const reset = (): void => {
      lBar.style.transform = 'scaleX(0)'
      rBar.style.transform = 'scaleX(0)'
      lBar.style.background = 'var(--color-line-strong)'
      rBar.style.background = 'var(--color-line-strong)'
      lPeak.style.opacity = '0'
      rPeak.style.opacity = '0'
    }
    if (!active) {
      reset()
      return
    }
    let lastTs = -1
    let lHold = 0
    let rHold = 0
    let lHoldExp = 0
    let rHoldExp = 0
    const unsubscribe = engine.subscribeFrame((ts) => {
      const now = ts / 1000
      if (lastTs < 0) lastTs = now
      const dt = now - lastTs
      lastTs = now
      let lPk = 0
      let rPk = 0
      for (let i = 0; i < trackIds.length; i++) {
        const id = trackIds[i]!
        const m = engine.readMeter(id)
        if (!m) continue
        // Convention: even idx = L channel, odd = R channel. We rely on
        // trackIds being in the same channel order the engine loaded.
        if (i % 2 === 0) {
          if (m.peak > lPk) lPk = m.peak
        } else {
          if (m.peak > rPk) rPk = m.peak
        }
      }
      if (lPk >= lHold) {
        lHold = lPk
        lHoldExp = now + PEAK_HOLD_SECONDS
      } else if (now > lHoldExp) {
        lHold = Math.max(lPk, lHold - PEAK_DECAY_PER_SEC * dt)
      }
      if (rPk >= rHold) {
        rHold = rPk
        rHoldExp = now + PEAK_HOLD_SECONDS
      } else if (now > rHoldExp) {
        rHold = Math.max(rPk, rHold - PEAK_DECAY_PER_SEC * dt)
      }
      const lFrac = Math.min(1, lPk / 1.2)
      const rFrac = Math.min(1, rPk / 1.2)
      lBar.style.transform = `scaleX(${lFrac.toFixed(4)})`
      rBar.style.transform = `scaleX(${rFrac.toFixed(4)})`
      const colorFor = (p: number): string =>
        p >= 0.95
          ? 'var(--color-danger)'
          : p >= 0.75
            ? 'var(--color-solo)'
            : 'var(--color-active)'
      lBar.style.background = colorFor(lPk)
      rBar.style.background = colorFor(rPk)
      lPeak.style.transform = `translateX(${(Math.min(1, lHold / 1.2) * 100).toFixed(2)}%)`
      rPeak.style.transform = `translateX(${(Math.min(1, rHold / 1.2) * 100).toFixed(2)}%)`
      lPeak.style.opacity = lHold > 0.02 ? '1' : '0'
      rPeak.style.opacity = rHold > 0.02 ? '1' : '0'
    })
    return () => {
      unsubscribe()
      reset()
    }
  }, [engine, trackIds, active])

  return (
    <div
      className="flex flex-col gap-0.5 w-full"
      aria-label="master level meter"
    >
      {(['L', 'R'] as const).map((side) => {
        const barRef = side === 'L' ? lBarRef : rBarRef
        const peakRef = side === 'L' ? lPeakRef : rPeakRef
        return (
          <div key={side} className="flex items-center gap-2">
            <span
              aria-hidden
              className="text-[9px] uppercase tracking-[0.08em] text-[var(--color-fg-dim)] w-2"
            >
              {side}
            </span>
            <div
              className="relative h-2 flex-1 overflow-hidden border border-[var(--color-line)] bg-[var(--color-bg-2)]"
              aria-hidden
            >
              <div
                ref={barRef}
                className="absolute inset-0 origin-left"
                style={{
                  transform: 'scaleX(0)',
                  background: 'var(--color-line-strong)',
                  willChange: 'transform',
                }}
              />
              <div
                ref={peakRef}
                className="pointer-events-none absolute inset-y-0 left-0 w-px bg-[var(--color-fg)] opacity-0"
                style={{ willChange: 'transform, opacity' }}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}

/**
 * Tiny pair-list meter. One per row in the pair list column, ~4 px tall,
 * ~32 px wide. Direct DOM mutation through the engine's shared RAF, no React
 * state. Peak-hold line pins for 500 ms.
 *
 * When `active` is false or the pair has no audible tracks (locked / muted),
 * the bar resets to flat and stops subscribing, so it costs zero RAF.
 */
export function PairListMeter({
  engine,
  leftId,
  rightId,
  active,
}: {
  engine: MixerEngine
  leftId: string | null
  rightId: string | null
  active: boolean
}): React.ReactNode {
  const barRef = useRef<HTMLDivElement>(null)
  const peakRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const bar = barRef.current
    const peak = peakRef.current
    if (!bar || !peak) return
    const reset = (): void => {
      bar.style.transform = 'scaleX(0)'
      bar.style.background = 'var(--color-line-strong)'
      peak.style.opacity = '0'
    }
    if (!active || (!leftId && !rightId)) {
      reset()
      return
    }
    let lastTs = -1
    let hold = 0
    let holdExp = 0
    const unsubscribe = engine.subscribeFrame((ts) => {
      const now = ts / 1000
      if (lastTs < 0) lastTs = now
      const dt = now - lastTs
      lastTs = now
      const l = leftId ? engine.readMeter(leftId) : null
      const r = rightId ? engine.readMeter(rightId) : null
      const pk = Math.max(l?.peak ?? 0, r?.peak ?? 0)
      if (pk >= hold) {
        hold = pk
        holdExp = now + 0.5
      } else if (now > holdExp) {
        hold = Math.max(pk, hold - PEAK_DECAY_PER_SEC * dt)
      }
      const frac = Math.min(1, pk / 1.2)
      bar.style.transform = `scaleX(${frac.toFixed(4)})`
      bar.style.background =
        pk >= 0.95 ? 'var(--color-mute)' : 'var(--color-active)'
      const peakFrac = Math.min(1, hold / 1.2)
      peak.style.transform = `translateX(${(peakFrac * 100).toFixed(2)}%)`
      peak.style.opacity = hold > 0.02 ? '1' : '0'
    })
    return () => {
      unsubscribe()
      reset()
    }
  }, [engine, leftId, rightId, active])

  return (
    <span
      className="block h-1 flex-1 min-w-0 max-w-[60px] border border-[var(--color-line)] overflow-hidden relative"
      aria-hidden
    >
      <span
        ref={barRef}
        className="absolute inset-0 origin-left"
        style={{
          transform: 'scaleX(0)',
          background: 'var(--color-line-strong)',
          willChange: 'transform',
        }}
      />
      <span
        ref={peakRef}
        className="pointer-events-none absolute inset-y-0 left-0 w-px bg-[var(--color-fg)] opacity-0"
        style={{ willChange: 'transform, opacity' }}
      />
    </span>
  )
}
