/**
 * Figma-style scrub input: a numeric field that doubles as a horizontal-drag
 * scrubber. Click+drag to change value. click without drag to focus for
 * keyboard edit (Enter commits, Esc reverts).
 *
 * Sensitivity: `sensitivity` is "units per pixel" (default 0.01). Shift × 10
 * (coarse), Alt × 0.1 (fine). Cursor on idle is `ew-resize` and switches to a
 * text caret when focused for typing. Pointer-lock during drag (when
 * available) lets the user pull past screen edges without clipping. if
 * denied, we just track plain pointermove deltas.
 *
 * The math is delegated to ./scrub-math (pure helpers, unit-tested).
 *
 * The component is uncontrolled-while-editing (a local string `draft` mirror
 * of the input so typing partial text like "-" or "1." doesn't snap-back),
 * and controlled otherwise (display re-syncs from `value` on every prop
 * change). `onChange` fires on every drag delta (live update) and on commit
 * (Enter / blur). Drag start does NOT fire onChange. an unmoved click is
 * treated as a focus, not a no-op edit.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import {
  clampValue,
  dragDeltaToValue,
  formatValue,
  parseDraft,
} from './scrub-math'

export interface ScrubInputProps {
  value: number
  onChange: (v: number) => void
  /** Pixels per unit. Default: 0.01 unit per pixel (1 px = 0.01 step). */
  sensitivity?: number
  /** Min/max bounds (clamped). */
  min?: number
  max?: number
  /** Decimal places to display (default 2). */
  precision?: number
  /** Suffix label (e.g. "s", "db"). */
  suffix?: string
  /** ARIA / accessibility label. */
  label?: string
  disabled?: boolean
  className?: string
}

const DRAG_THRESHOLD_PX = 3

export function ScrubInput({
  value,
  onChange,
  sensitivity = 0.01,
  min,
  max,
  precision = 2,
  suffix,
  label,
  disabled = false,
  className,
}: ScrubInputProps): React.ReactNode {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const dragRef = useRef<{
    startX: number
    startValue: number
    accumX: number
    movedPx: number
    pointerId: number
    pointerLock: boolean
  } | null>(null)

  const commitDraft = useCallback((): void => {
    const parsed = parseDraft(draft)
    if (parsed !== null) {
      onChange(clampValue(parsed, min, max))
    }
    setEditing(false)
  }, [draft, onChange, min, max])

  const cancelDraft = useCallback((): void => {
    setEditing(false)
  }, [])

  // Drag handling via window-level listeners. Attached only while mounted.
  // the dragRef gate keeps them cheap when not dragging.
  useEffect(() => {
    const onMove = (e: PointerEvent): void => {
      const drag = dragRef.current
      if (!drag) return
      // movementX is consistent under pointer lock, clientX delta otherwise.
      const dx = drag.pointerLock
        ? e.movementX
        : e.clientX - drag.startX - drag.accumX
      drag.accumX += dx
      drag.movedPx = Math.max(drag.movedPx, Math.abs(drag.accumX))
      const next = dragDeltaToValue(
        drag.startValue,
        drag.accumX,
        sensitivity,
        { shift: e.shiftKey, alt: e.altKey },
        min,
        max,
      )
      onChange(next)
    }
    const onUp = (): void => {
      const drag = dragRef.current
      if (!drag) return
      dragRef.current = null
      if (drag.pointerLock && document.pointerLockElement) {
        document.exitPointerLock()
      }
      // If the drag didn't actually move, treat it as a click → enter edit.
      if (drag.movedPx < DRAG_THRESHOLD_PX) {
        setDraft(formatValue(value, precision))
        setEditing(true)
        // Defer focus & select to next tick so the input is rendered.
        requestAnimationFrame(() => {
          inputRef.current?.focus()
          inputRef.current?.select()
        })
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [min, max, onChange, sensitivity, value, precision])

  const startDrag = useCallback(
    (e: React.PointerEvent<HTMLDivElement>): void => {
      if (disabled) return
      if (editing) return
      if (e.button !== 0) return
      e.preventDefault()
      const el = e.currentTarget
      let usingLock = false
      // Try pointer lock so the user can drag past screen edges. Some
      // browsers throw / reject, so we fall back to plain pointermove deltas.
      const lockReq = el.requestPointerLock as
        | ((this: HTMLDivElement) => void)
        | undefined
      if (typeof lockReq === 'function') {
        try {
          lockReq.call(el)
          usingLock = true
        } catch {
          usingLock = false
        }
      }
      dragRef.current = {
        startX: e.clientX,
        startValue: value,
        accumX: 0,
        movedPx: 0,
        pointerId: e.pointerId,
        pointerLock: usingLock,
      }
    },
    [disabled, editing, value],
  )

  const displayValue = editing ? draft : formatValue(value, precision)

  return (
    <div
      onPointerDown={startDrag}
      className={`inline-flex items-baseline gap-1 select-none ${
        disabled ? 'opacity-40 cursor-not-allowed' : ''
      } ${className ?? ''}`}
      style={{
        cursor: disabled ? 'not-allowed' : editing ? 'text' : 'ew-resize',
      }}
      aria-label={label}
      role="spinbutton"
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-disabled={disabled}
    >
      <input
        ref={inputRef}
        type="text"
        inputMode="decimal"
        value={displayValue}
        readOnly={!editing}
        disabled={disabled}
        onPointerDown={(e) => {
          // Don't focus on pointerdown. let the parent decide drag vs focus.
          if (!editing) e.preventDefault()
        }}
        onChange={(e) => {
          if (!editing) return
          setDraft(e.target.value)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commitDraft()
            inputRef.current?.blur()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            cancelDraft()
            inputRef.current?.blur()
          }
        }}
        onBlur={() => {
          if (editing) commitDraft()
        }}
        aria-label={label}
        className="w-16 text-[10px] !py-0 !px-1 tabular-nums bg-transparent border border-[var(--color-line-strong)] focus:border-[var(--color-fg)] focus:outline-none"
        style={{
          cursor: 'inherit',
        }}
      />
      {suffix && (
        <span className="text-[9px] uppercase text-[var(--color-fg-mute)]">
          {suffix}
        </span>
      )}
    </div>
  )
}
