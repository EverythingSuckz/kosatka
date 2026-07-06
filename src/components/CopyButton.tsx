/**
 * Copy-to-clipboard button with a brief "copied" confirmation. Used on error
 * surfaces so a user can grab the full message / traceback to report it.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Copy } from '@phosphor-icons/react'

export function CopyButton({
  text,
  label = 'copy',
  className,
}: {
  text: string
  label?: string
  className?: string
}): React.ReactNode {
  const [copied, setCopied] = useState(false)
  // Bumped on each successful copy. Used as a `key` on the button contents so
  // the pop animation remounts and replays even on a rapid second copy (when
  // `copied` is already true and wouldn't otherwise re-trigger the keyframe).
  const [pop, setPop] = useState(0)
  const timer = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
    },
    [],
  )

  const onCopy = useCallback(() => {
    // `navigator.clipboard` is typed as always-present but is undefined in
    // insecure contexts, widen so the guard is honest.
    const clip = (navigator as unknown as { clipboard?: Clipboard }).clipboard
    if (!clip) return
    void clip
      .writeText(text)
      .then(() => {
        setCopied(true)
        setPop((n) => n + 1)
        if (timer.current !== null) window.clearTimeout(timer.current)
        timer.current = window.setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => {
        /* clipboard blocked, no-op */
      })
  }, [text])

  return (
    <button
      type="button"
      onClick={onCopy}
      aria-label={copied ? 'copied' : label}
      className={
        className ??
        '!px-2 !py-1 inline-flex items-center gap-1.5 text-[10px] uppercase tracking-[0.1em] text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]'
      }
    >
      <span
        key={pop}
        className={`inline-flex items-center gap-1.5 px-1 -mx-1 ${copied ? 'copy-flash' : ''}`}
      >
        {copied ? (
          <>
            <Check size={12} weight="bold" /> copied
          </>
        ) : (
          <>
            <Copy size={12} /> {label}
          </>
        )}
      </span>
    </button>
  )
}
