/**
 * Keyframe context menu. Opened on right-click of a keyframe diamond and
 * positioned at the click coordinates. Closes on outside click, Escape,
 * or after any of its actions runs.
 *
 * Built inline (no portal libraries). The menu is absolute-positioned in
 * the document, and the route renders one instance at a time.
 */

import { useEffect, useRef } from 'react'

export interface ContextMenuItem {
  label: string
  /** Optional kbd hint shown right-aligned, e.g. "Del". */
  kbd?: string
  /** Optional "danger" styling: red text / red hover. */
  danger?: boolean
  /** If true, render as a divider. `label` ignored. */
  divider?: boolean
  disabled?: boolean
  onSelect?: () => void
}

interface ContextMenuProps {
  /** Window-relative position (clientX/clientY). */
  x: number
  y: number
  items: ReadonlyArray<ContextMenuItem>
  onClose: () => void
}

export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: ContextMenuProps): React.ReactNode {
  const ref = useRef<HTMLDivElement>(null)

  // Close on outside click / Esc / window blur.
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (!ref.current) return
      if (e.target instanceof Node && ref.current.contains(e.target)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    const onScroll = (): void => onClose()
    // Use mousedown rather than click so we close before the next click lands.
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('wheel', onScroll, true)
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('wheel', onScroll, true)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])

  // Nudge the menu back into the viewport if it would overflow.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    let nx = x
    let ny = y
    if (rect.right > vw) nx = Math.max(0, vw - rect.width - 4)
    if (rect.bottom > vh) ny = Math.max(0, vh - rect.height - 4)
    el.style.left = `${nx}px`
    el.style.top = `${ny}px`
  }, [x, y])

  return (
    <div
      ref={ref}
      role="menu"
      aria-label="keyframe actions"
      onContextMenu={(e) => e.preventDefault()}
      className="fixed z-50 min-w-[12rem] border border-[var(--color-line-strong)] bg-[var(--color-bg-1)] py-1 shadow-lg"
      style={{ left: `${x}px`, top: `${y}px` }}
    >
      {items.map((item, i) => {
        if (item.divider) {
          return (
            <div
              key={`d-${i}`}
              className="my-1 border-t border-[var(--color-line)]"
              aria-hidden
            />
          )
        }
        const baseColor = item.danger
          ? 'text-[var(--color-danger)] hover:bg-[var(--color-danger)] hover:text-[var(--color-bg)]'
          : 'text-[var(--color-fg)] hover:bg-[var(--color-bg-2)]'
        const dim = item.disabled ? 'opacity-40 pointer-events-none' : ''
        return (
          <button
            key={`i-${i}`}
            type="button"
            role="menuitem"
            onClick={() => {
              if (item.disabled) return
              item.onSelect?.()
              onClose()
            }}
            disabled={item.disabled}
            className={`!border-0 !bg-transparent !rounded-none !px-2.5 !py-1 w-full text-left flex items-center justify-between gap-3 text-[11px] uppercase tracking-[0.10em] transition-colors ${baseColor} ${dim}`}
          >
            <span>{item.label}</span>
            {item.kbd && (
              <kbd className="!border-0 !bg-transparent !p-0 text-[9px] uppercase tracking-[0.06em] text-[var(--color-fg-mute)]">
                {item.kbd}
              </kbd>
            )}
          </button>
        )
      })}
    </div>
  )
}
