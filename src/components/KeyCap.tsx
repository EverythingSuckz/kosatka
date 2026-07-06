import { useEffect, useRef, useState } from 'react'

/** A small keyboard-key chip (esc / enter) shown inside action buttons. */
export function KeyCap({
  children,
}: {
  children: React.ReactNode
}): React.ReactNode {
  return (
    <kbd className="rounded-[2px] border border-current/40 bg-current/10 px-1.5 py-0.5 text-[9px] font-normal not-italic leading-none tracking-[0.1em]">
      {children}
    </kbd>
  )
}

/**
 * A button bound to a keyboard key that BLINKS the accent for a beat before
 * running its action when triggered by the KEY (so the key-press is visible),
 * but runs immediately on a mouse click. Used for esc-to-dismiss style
 * buttons across the app.
 */
export function KeyActionButton({
  keyName,
  keyLabel,
  onAction,
  children,
  className,
}: {
  /** KeyboardEvent.key to bind (e.g. 'Escape'). */
  keyName: string
  /** Label shown in the KeyCap chip (e.g. 'esc'). */
  keyLabel: string
  onAction: () => void
  children: React.ReactNode
  className?: string
}): React.ReactNode {
  const [blink, setBlink] = useState(false)
  const actionRef = useRef(onAction)
  actionRef.current = onAction
  const pendingRef = useRef(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== keyName || pendingRef.current) return
      e.preventDefault()
      e.stopPropagation()
      pendingRef.current = true
      setBlink(true)
      window.setTimeout(() => actionRef.current(), 620)
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [keyName])

  return (
    <button
      type="button"
      onClick={() => actionRef.current()}
      className={`inline-flex items-center gap-2 border-2 border-[var(--color-line-strong)] px-3 py-1.5 text-xs uppercase tracking-[0.12em] text-[var(--color-fg)] ${blink ? 'key-blink' : ''} ${className ?? ''}`}
    >
      {children} <KeyCap>{keyLabel}</KeyCap>
    </button>
  )
}
