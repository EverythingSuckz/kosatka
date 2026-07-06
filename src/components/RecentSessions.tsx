/**
 * Recent-session cards shown under the drop zone (idle state only).
 *
 * Sessions persist to IndexedDB on every drop (see persistence/sessions.ts,
 * pruned to the newest few), so "come back later" was already possible, but
 * only by re-dropping the same file. These cards surface what's already
 * stored: one click re-opens the mix. The most recent session usually also
 * has its decoded buffers alive in the resume cache (mixer/resume-cache.ts),
 * in which case the card is badged "instant". opening it skips the decode
 * entirely.
 */

import { useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useState } from 'react'
import { Waveform, X } from '@phosphor-icons/react'

import { hasResume } from '../mixer/resume-cache'
import { deleteSession, listSessions } from '../persistence/sessions'
import type { SessionSummary } from '../persistence/sessions'

export function RecentSessions() {
  const navigate = useNavigate()
  const [sessions, setSessions] = useState<Array<SessionSummary> | null>(null)

  useEffect(() => {
    let cancelled = false
    void listSessions()
      .then((list) => {
        if (!cancelled) setSessions(list)
      })
      .catch(() => {
        // IDB unavailable (private browsing etc.). just show nothing.
        if (!cancelled) setSessions([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  const onDelete = useCallback(async (id: string) => {
    try {
      await deleteSession(id)
    } catch {
      // Best-effort. worst case the card reappears next visit.
    }
    setSessions((prev) => (prev ? prev.filter((s) => s.id !== id) : prev))
  }, [])

  if (!sessions || sessions.length === 0) return null

  return (
    <section className="mt-8">
      <h2 className="text-xs uppercase tracking-[0.16em] text-[var(--color-fg-dim)]">
        recent
      </h2>
      <ul className="mt-2 flex flex-col gap-2">
        {sessions.map((s) => (
          <li
            key={s.id}
            className="flex items-center gap-3 border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2"
          >
            <button
              type="button"
              onClick={() =>
                void navigate({
                  to: '/mix/$sessionId',
                  params: { sessionId: s.id },
                })
              }
              className="flex min-w-0 flex-1 items-center gap-3 text-left"
            >
              <Waveform
                aria-hidden
                size={14}
                className="shrink-0 text-[var(--color-fg-mute)]"
              />
              <span className="truncate uppercase tracking-[0.12em] text-[var(--color-fg)]">
                {s.name}
              </span>
              <span className="shrink-0 text-xs tabular-nums text-[var(--color-fg-mute)]">
                {(s.size / 1024 / 1024).toFixed(1)} mib
              </span>
              <span className="shrink-0 text-xs text-[var(--color-fg-mute)]">
                {fmtAge(Date.now() - s.createdAt)}
              </span>
              {hasResume(s.id) && (
                <span className="shrink-0 border border-[var(--color-active)] px-1.5 py-0.5 text-[10px] uppercase tracking-[0.12em] text-[var(--color-active)]">
                  instant
                </span>
              )}
            </button>
            <button
              type="button"
              aria-label={`delete ${s.name}`}
              onClick={() => void onDelete(s.id)}
              className="shrink-0 !border-0 !bg-transparent !p-1 text-[var(--color-fg-mute)] hover:text-[var(--color-danger)]"
            >
              <X size={13} />
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** Coarse relative age. cards are a memory aid, not a log. */
function fmtAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'just now'
  const min = Math.floor(ms / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}
