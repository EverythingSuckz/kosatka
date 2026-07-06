/**
 * StemWaveform paints a peak-amplitude waveform of an AudioBuffer onto a
 * canvas, with a CSS-driven playhead cursor on top. Peaks are computed once
 * and only the cursor moves while playing.
 *
 * Click anywhere on the surface to seek there (callback-driven).
 *
 * F12: hover anywhere on the surface and a thin vertical guide + timestamp
 * tooltip follow the pointer. State is mutated directly on a ref'd element so
 * we don't trigger a React re-render per pixel of mouse movement.
 *
 * Usage:
 *   <StemWaveform
 *     buffer={audioBuffer}
 *     positionSeconds={mixer.positionSeconds}
 *     muted={track.muted}
 *     onSeek={(t) => engine.seek(t)}
 *   />
 */

import { memo, useEffect, useRef, useState } from 'react'

interface StemWaveformProps {
  buffer: AudioBuffer
  /**
   * Position of the local cursor (seconds). Omit when the cursor is hidden
   * (`hideCursor`). in the timeline view the shared `TimelinePlayhead`
   * handles position, and threading position into every waveform would
   * force per-frame reconciliation of every row.
   */
  positionSeconds?: number
  /** When true, render dimmed (e.g. for muted or non-soloed tracks). */
  muted?: boolean
  /** When true, accent the foreground colour (e.g. soloed). */
  accent?: boolean
  /** Click-to-seek callback. Receives the time in seconds at the click point. */
  onSeek?: (timeSeconds: number) => void
  /**
   * Total duration of the timeline this waveform is rendered against. When
   * provided, the waveform is laid out spanning [0, totalDuration] so it
   * stays time-aligned with other stems of different lengths. Defaults to
   * the buffer's own duration (legacy single-stem rendering).
   */
  totalDuration?: number
  /**
   * Hide the playhead cursor. The timeline view draws a single shared
   * playhead across all rows so per-row cursors are redundant.
   */
  hideCursor?: boolean
  /**
   * Hide the F12 hover tooltip. the timeline ruler provides one shared
   * tooltip across all rows.
   */
  hideHoverTooltip?: boolean
  /**
   * Right-click (or shift-click) on the waveform to place an automation
   * marker at the indicated time. Receives time in seconds.
   */
  onMarkAt?: (timeSeconds: number) => void
}

function fmtTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0
  const min = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${min}:${String(sec).padStart(2, '0')}`
}

function StemWaveformImpl({
  buffer,
  positionSeconds,
  muted = false,
  accent = false,
  onSeek,
  totalDuration,
  hideCursor = false,
  hideHoverTooltip = false,
  onMarkAt,
}: StemWaveformProps): React.ReactNode {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const cursorRef = useRef<HTMLDivElement>(null)
  const hoverGuideRef = useRef<HTMLDivElement>(null)
  const hoverTooltipRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  // Tracks the canvas container's measured width. Used as a dep on the
  // paint effect so we re-draw when the layout settles (the timeline area
  // measures its width via ResizeObserver, so the first mount can see a
  // 0-px wide canvas, paint nothing, and never re-fire, leaving rows
  // visibly blank until something else nudges the deps). See bug log.
  const [canvasWidth, setCanvasWidth] = useState(0)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = Math.round(entry.contentRect.width)
        if (w > 0) setCanvasWidth(w)
      }
    })
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    const cssWidth = canvas.clientWidth
    const cssHeight = canvas.clientHeight
    // Skip paint when the canvas has no measured width yet. the ResizeObserver
    // effect above will fire once layout settles and re-trigger this paint.
    // Drawing into a 0/1-px canvas wastes work and produces a blank result
    // that the user sees until the next dep change.
    if (cssWidth <= 0 || cssHeight <= 0) return
    canvas.width = Math.max(1, Math.floor(cssWidth * dpr))
    canvas.height = Math.max(1, Math.floor(cssHeight * dpr))
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.scale(dpr, dpr)

    const colour = muted
      ? 'rgba(245,245,245,0.18)'
      : accent
        ? 'rgba(251,191,36,0.78)'
        : 'rgba(245,245,245,0.55)'

    ctx.clearRect(0, 0, cssWidth, cssHeight)
    ctx.fillStyle = colour

    const channel = buffer.getChannelData(0)
    const halfH = cssHeight / 2
    // If totalDuration is provided and longer than the buffer, scale the
    // waveform's pixel span so it sits at [0, buffer.duration / totalDuration]
    // of the canvas. This keeps multi-length stems time-aligned on a shared
    // timeline.
    const bufDur = buffer.duration
    const total = totalDuration && totalDuration > 0 ? totalDuration : bufDur
    const waveformPixels =
      total > 0
        ? Math.max(1, Math.floor((bufDur / total) * cssWidth))
        : cssWidth
    const targetBins = Math.max(1, waveformPixels)
    const samplesPerBin = Math.max(1, Math.floor(channel.length / targetBins))

    for (let bin = 0; bin < targetBins; bin++) {
      let peak = 0
      const start = bin * samplesPerBin
      const end = Math.min(start + samplesPerBin, channel.length)
      for (let j = start; j < end; j++) {
        const v = Math.abs(channel[j]!)
        if (v > peak) peak = v
      }
      const h = Math.max(1, peak * cssHeight)
      ctx.fillRect(bin, halfH - h / 2, 1, h)
    }
  }, [buffer, muted, accent, totalDuration, canvasWidth])

  // Cursor position. We set `left` as a percentage of the parent (not a
  // transform on the element itself) because `translateX(20%)` on a
  // 2-px-wide cursor would move it by 0.4 px, not 20 % of the container.
  //
  // Skip entirely when the cursor is hidden. the timeline view stacks a
  // shared `TimelinePlayhead` over all rows, so running this effect per
  // pair × per frame is dead work.
  useEffect(() => {
    if (hideCursor) return
    const cursor = cursorRef.current
    if (!cursor) return
    const dur =
      totalDuration && totalDuration > 0 ? totalDuration : buffer.duration
    if (dur <= 0) {
      cursor.style.left = '0%'
      return
    }
    const pos = positionSeconds ?? 0
    const pct = Math.max(0, Math.min(1, pos / dur))
    cursor.style.left = `${pct * 100}%`
  }, [buffer.duration, positionSeconds, totalDuration, hideCursor])

  // Effective horizontal time scale: totalDuration if provided, else the
  // buffer's own duration (legacy single-stem behaviour).
  const scaleDur =
    totalDuration && totalDuration > 0 ? totalDuration : buffer.duration

  // F12 hover handlers. direct DOM mutation, no React state.
  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>): void => {
    const el = containerRef.current
    const guide = hoverGuideRef.current
    const tip = hoverTooltipRef.current
    if (!el || !guide) return
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0) return
    const x = e.clientX - rect.left
    const pct = Math.max(0, Math.min(1, x / rect.width))
    guide.style.left = `${pct * 100}%`
    guide.style.opacity = '1'
    if (tip && !hideHoverTooltip) {
      const t = pct * scaleDur
      tip.textContent = fmtTime(t)
      tip.style.left = `${pct * 100}%`
      tip.style.opacity = '1'
    }
  }

  const handleMouseLeave = (): void => {
    const guide = hoverGuideRef.current
    const tip = hoverTooltipRef.current
    if (guide) guide.style.opacity = '0'
    if (tip) tip.style.opacity = '0'
  }

  const timeAtEvent = (e: React.MouseEvent<HTMLDivElement>): number | null => {
    const el = containerRef.current
    if (!el) return null
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0) return null
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    return pct * scaleDur
  }

  const handleClick = (e: React.MouseEvent<HTMLDivElement>): void => {
    // Shift-click places an automation marker (if onMarkAt is wired). The
    // right-click handler covers the other discoverability path.
    if (e.shiftKey && onMarkAt) {
      e.preventDefault()
      const t = timeAtEvent(e)
      if (t !== null) onMarkAt(t)
      return
    }
    if (onSeek) {
      const t = timeAtEvent(e)
      if (t !== null) onSeek(t)
    }
  }

  const handleContextMenu = onMarkAt
    ? (e: React.MouseEvent<HTMLDivElement>): void => {
        e.preventDefault()
        const t = timeAtEvent(e)
        if (t !== null) onMarkAt(t)
      }
    : undefined

  return (
    <div
      ref={containerRef}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      className={`relative h-full w-full overflow-hidden ${onSeek ? 'cursor-pointer' : ''}`}
    >
      <canvas ref={canvasRef} className="h-full w-full block" />
      {!hideCursor && (
        <div
          ref={cursorRef}
          className="pointer-events-none absolute left-0 top-0 h-full w-0.5 bg-[var(--color-active,#fbbf24)] shadow-[0_0_4px_rgba(251,191,36,0.7)]"
          style={{ willChange: 'transform' }}
          aria-hidden
        />
      )}
      <div
        ref={hoverGuideRef}
        className="pointer-events-none absolute left-0 top-0 h-full w-px bg-[var(--color-fg-dim)] opacity-0 transition-opacity duration-75"
        aria-hidden
      />
      {!hideHoverTooltip && (
        <div
          ref={hoverTooltipRef}
          className="pointer-events-none absolute -top-4 left-0 -translate-x-1/2 whitespace-nowrap rounded-sm bg-[var(--color-bg-2)] px-1 text-[9px] tabular-nums uppercase tracking-[0.08em] text-[var(--color-fg-dim)] opacity-0 transition-opacity duration-75"
          aria-hidden
        />
      )}
    </div>
  )
}

/**
 * `StemWaveform` is rendered up to 16× in the timeline. Memoization is
 * load-bearing: without it, every snapshot tick from the parent would
 * reconcile each waveform even though the canvas only paints on buffer /
 * size changes. With the route's stable `onSeek` ref, the memo wrapper
 * short-circuits all idle frames.
 */
export const StemWaveform = memo(StemWaveformImpl)
