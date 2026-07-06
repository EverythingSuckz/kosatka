/**
 * /rpf/$rpfId: the RPF explorer as a real navigation destination.
 *
 * The explorer used to be a transient stage inside the drop-zone box. the
 * moment you picked an entry and navigated to the mixer, the open archive
 * died with the drop screen's component state. Auditioning the next track
 * meant re-dropping and re-opening the whole archive. As a route, the
 * archive lives in the module-level registry (`src/rpf-session.ts`) and the
 * history stack becomes `/ → /rpf/x → /mix/y`. browser-back from the mixer
 * lands HERE, instantly, and the pick → listen → back → pick-next loop is
 * one key each way.
 *
 * Page refresh loses the registry by design (archives can be multi-GB, we
 * don't copy them into IDB, see rpf-session.ts). This route degrades to a
 * "re-drop to reopen" prompt that keeps the same id/URL via
 * `replaceRpfSession`, so a refresh costs one drag, not your place.
 *
 * The entry-pick pipeline (read → parse → key check → extract → session →
 * navigate) is the one that used to live in `index.tsx`'s `loadRpfEntry`.
 * failures stay inside this route so the user can try a different entry
 * without re-opening the archive.
 */

import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useCallback, useState } from 'react'
import { ArrowLineDown } from '@phosphor-icons/react'

import { useAliveRef } from '../../lib/use-alive-ref'

import { NeedsKeyPromptBody } from '../../components/NeedsKeyPrompt'
import { ProgressLine } from '../../components/ProgressLine'
import { RpfExplorer } from '../../components/RpfExplorer'
import { CopyButton } from '../../components/CopyButton'
import { KeyActionButton } from '../../components/KeyCap'
import { extractAllStreamsWithBlocks } from '../../awc/extract'
import { parseAwc } from '../../awc/parser'
import { getAwcKey, getDerivedKeys } from '../../keys'
import { openRpf } from '../../rpf'
import {
  createRpfSession,
  getRpfSession,
  getRpfSessionName,
  replaceRpfSession,
} from '../../rpf-session'
import { attachParsed, createSession } from '../../session'
import { NAVIGATE_HOLD_MS, classifyFile } from '../-dropStage'
import type { RpfSession } from '../../rpf-session'
import type { RpfEntry } from '../../rpf'
import type { SortMode } from '../../components/RpfExplorer'

const SORT_RE = /^(name|path|size)-(asc|desc)$/

export const Route = createFileRoute('/rpf/$rpfId')({
  component: RpfPage,
  // Persist the explorer sort in the URL so returning from the mixer restores
  // it. Invalid/absent values just fall through to the explorer's default.
  validateSearch: (search: Record<string, unknown>): { sort?: SortMode } => {
    const sort = search.sort
    return typeof sort === 'string' && SORT_RE.test(sort)
      ? { sort: sort as SortMode }
      : {}
  },
})

function RpfPage() {
  const { rpfId } = Route.useParams()
  // The registry is a plain module Map (not reactive). `version` exists only
  // to force a re-read after a re-drop swaps the archive in place.
  const [version, setVersion] = useState(0)
  void version
  const session = getRpfSession(rpfId)

  if (!session) {
    return (
      <ReopenPrompt rpfId={rpfId} onReopened={() => setVersion((v) => v + 1)} />
    )
  }
  // Keyed by session id: navigating from one archive to another (dropping a
  // second .rpf while browsing) remounts the explorer with fresh stage state.
  return <ExplorerView key={session.id} session={session} />
}

// ─── Explorer (registry hit) ───────────────────────────────────────────────

type ExplorerStage =
  | { kind: 'browsing' }
  | { kind: 'loading-entry'; entry: RpfEntry }
  | { kind: 'entry-error'; entry: RpfEntry; message: string }
  | { kind: 'drop-error'; message: string }
  | { kind: 'navigating'; displayName: string }

function ExplorerView({ session }: { session: RpfSession }) {
  const navigate = useNavigate()
  const { sort } = Route.useSearch()
  const [stage, setStage] = useState<ExplorerStage>({ kind: 'browsing' })
  // Liveness flag: the entry pipeline spans multi-second awaits (read +
  // decrypt + inflate) and the user can browser-back out mid-load. navigate()
  // is router-bound and fires fine after unmount. an unguarded call would
  // yank the user out of wherever they went AND truncate the forward
  // history entry this route lives on.
  // The `alive()` accessor also breaks ESLint's control-flow narrowing (same
  // class of false positive as the AbortController `aborted()` pattern in
  // CLAUDE.md, don't "simplify" the call away).
  const alive = useAliveRef()

  /**
   * Shared tail of both load paths (picked entry or dropped .awc). Throws a
   * human-readable message on failure. callers own their error stage.
   */
  const openAwcBuffer = useCallback(
    async (buffer: ArrayBuffer, displayName: string): Promise<void> => {
      // The AWC inside an RPF is the same shape as one dropped on disk. the
      // encryption-needs-AWC-key check applies the same way.
      const awc = parseAwc(buffer)
      const needsKey = awc.streams.some((s) =>
        s.layout.kind === 'mc-channel'
          ? s.layout.source.encrypted
          : s.layout.encrypted,
      )
      const awcKey = needsKey ? await getAwcKey() : null
      if (needsKey && !awcKey) {
        // This would be a derived-keys-missing race. opening the archive
        // required the derived bundle, so getAwcKey should also succeed.
        throw new Error(
          'awc key not available. re-derive it by dropping a .rpf from the index page',
        )
      }
      const streamBytes = extractAllStreamsWithBlocks(awc, buffer, {
        key: awcKey,
      })
      // Liveness check BEFORE committing side effects: an abandoned load
      // (user backed out mid-read) must not persist a phantom session to
      // IDB or pin the parsed payload in the module-level cache.
      if (!alive()) return
      // Synthesise a File so the persistence + mix-route loader sees the
      // same surface as if the user had dropped the AWC directly.
      const synth = new File([buffer], displayName, {
        type: 'application/octet-stream',
      })
      const id = createSession(synth)
      attachParsed(id, { awc, buffer, streamBytes })
      // Same fade-to-navigate beat as the drop-zone pipeline.
      setStage({ kind: 'navigating', displayName })
      await new Promise((r) => setTimeout(r, NAVIGATE_HOLD_MS))
      if (!alive()) return
      void navigate({ to: '/mix/$sessionId', params: { sessionId: id } })
    },
    [navigate],
  )

  /**
   * Load a single entry out of the open archive and hand off to the mixer.
   * Failures stay inside this route so the user can try a different entry
   * without re-opening the (large) RPF.
   */
  const loadEntry = useCallback(
    async (entry: RpfEntry): Promise<void> => {
      setStage({ kind: 'loading-entry', entry })
      try {
        const bytes = await entry.read()
        // Slice into a fresh ArrayBuffer so downstream code that does
        // `buffer.slice` / `new DataView(buffer)` sees offset 0.
        const buffer = bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer
        await openAwcBuffer(buffer, entry.name)
      } catch (e) {
        if (!alive()) return
        setStage({
          kind: 'entry-error',
          entry,
          message: e instanceof Error ? e.message : String(e),
        })
      }
    },
    [openAwcBuffer],
  )

  /**
   * The old drop-screen explorer let you drop another archive (or a bare
   * .awc) while browsing. without handlers here the browser default would
   * navigate the tab away, wiping every in-memory registry. A dropped .rpf
   * opens as a NEW rpf session, a dropped .awc goes straight to the mixer.
   */
  const onArchiveDrop = useCallback(
    async (file: File): Promise<void> => {
      const kind = classifyFile(file.name)
      if (kind === 'awc') {
        try {
          const buffer = await file.arrayBuffer()
          await openAwcBuffer(buffer, file.name)
        } catch (e) {
          if (!alive()) return
          setStage({
            kind: 'drop-error',
            message: e instanceof Error ? e.message : String(e),
          })
        }
        return
      }
      if (kind === 'rpf') {
        const derived = await getDerivedKeys()
        if (!derived) {
          setStage({
            kind: 'drop-error',
            message:
              'rpf decryption keys unavailable. open the archive from the drop zone instead',
          })
          return
        }
        try {
          const archive = await openRpf(file, derived, { name: file.name })
          if (!alive()) return
          const newId = createRpfSession(file, archive)
          void navigate({ to: '/rpf/$rpfId', params: { rpfId: newId } })
        } catch (e) {
          if (!alive()) return
          setStage({
            kind: 'drop-error',
            message: e instanceof Error ? e.message : String(e),
          })
        }
        return
      }
      setStage({
        kind: 'drop-error',
        message: `expected .awc or .rpf, got ${file.name}`,
      })
    },
    [openAwcBuffer, navigate],
  )

  const onPickEntry = useCallback(
    (entry: RpfEntry) => {
      if (stage.kind === 'loading-entry' || stage.kind === 'navigating') return
      void loadEntry(entry)
    },
    [stage.kind, loadEntry],
  )

  const backToBrowsing = useCallback(() => {
    setStage({ kind: 'browsing' })
  }, [])

  const onClose = useCallback(() => {
    void navigate({ to: '/' })
  }, [navigate])

  return (
    <main className="mx-auto w-full max-w-[1280px] px-4 py-12">
      <div className="mb-8">
        <h1 className="truncate text-2xl font-normal uppercase tracking-[0.12em] text-[var(--color-fg)]">
          {session.name}
        </h1>
        <p className="mt-2 text-[var(--color-fg-dim)]">
          pick an .awc to open in the mixer. back from the mixer returns here.
        </p>
      </div>

      <div
        onDragEnter={(e) => e.preventDefault()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          // Always swallow the browser default (navigating the tab to the
          // file would wipe every in-memory registry). Only start a new
          // pipeline from a settled state.
          e.preventDefault()
          if (
            stage.kind !== 'browsing' &&
            stage.kind !== 'entry-error' &&
            stage.kind !== 'drop-error'
          ) {
            return
          }
          const file = e.dataTransfer.files[0]
          if (file) void onArchiveDrop(file)
        }}
        className={`flex min-h-[440px] flex-col items-stretch justify-center border border-[var(--color-line-strong)] bg-[var(--color-bg)] px-6 py-12 transition-[opacity] duration-150 ${
          stage.kind === 'navigating' ? 'opacity-60' : 'opacity-100'
        }`}
      >
        {stage.kind === 'browsing' && (
          <RpfExplorer
            archive={session.archive}
            onPickEntry={onPickEntry}
            onReset={onClose}
            initialSort={sort}
            onSortChange={(next) =>
              void navigate({
                to: '/rpf/$rpfId',
                params: { rpfId: session.id },
                search: { sort: next },
                replace: true,
              })
            }
          />
        )}

        {(stage.kind === 'loading-entry' || stage.kind === 'navigating') && (
          <ProgressLine
            label={
              stage.kind === 'loading-entry'
                ? 'loading entry…'
                : 'ready, opening mixer…'
            }
            readout={
              stage.kind === 'loading-entry'
                ? stage.entry.name
                : stage.displayName
            }
            indeterminate={stage.kind === 'loading-entry'}
            pct={100}
          />
        )}

        {stage.kind === 'entry-error' && (
          <ExplorerError
            title="entry load failed"
            subtitle={stage.entry.path}
            message={stage.message}
            onBack={backToBrowsing}
          />
        )}

        {stage.kind === 'drop-error' && (
          <ExplorerError
            title="drop failed"
            message={stage.message}
            onBack={backToBrowsing}
          />
        )}
      </div>
    </main>
  )
}

/** Themed error for the explorer with a copy button and an esc-to-dismiss. */
function ExplorerError({
  title,
  subtitle,
  message,
  onBack,
}: {
  title: string
  subtitle?: string
  message: string
  onBack: () => void
}): React.ReactNode {
  return (
    <div className="mx-auto w-full max-w-[560px]">
      <div className="border-2 border-[var(--color-danger)]">
        <div className="flex items-center justify-between border-b border-[var(--color-danger)]/40 px-3 py-1.5">
          <span className="text-[10px] uppercase tracking-[0.14em] text-[var(--color-danger)]">
            {title}
          </span>
          <CopyButton
            text={message}
            className="!px-1.5 !py-0.5 inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.1em] text-[var(--color-danger)] hover:opacity-80"
          />
        </div>
        {subtitle && (
          <p className="border-b border-[var(--color-danger)]/40 px-3 py-1.5 text-[10px] text-[var(--color-fg-dim)]">
            {subtitle}
          </p>
        )}
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap px-3 py-2 text-[11px] text-[var(--color-danger)]">
          {message}
        </pre>
      </div>
      <div className="mt-3 flex justify-center">
        <KeyActionButton keyName="Escape" keyLabel="esc" onAction={onBack}>
          back to explorer
        </KeyActionButton>
      </div>
    </div>
  )
}

// ─── Re-drop prompt (registry miss, e.g. after a page refresh) ────────────

type ReopenStage =
  | { kind: 'prompt' }
  | { kind: 'needs-key'; file: File }
  | { kind: 'opening'; file: File }
  | { kind: 'error'; message: string }

function ReopenPrompt({
  rpfId,
  onReopened,
}: {
  rpfId: string
  onReopened: () => void
}) {
  const navigate = useNavigate()
  const [stage, setStage] = useState<ReopenStage>({ kind: 'prompt' })
  const [dragOver, setDragOver] = useState(false)
  // Name breadcrumb survives refresh via sessionStorage (see rpf-session.ts)
  // so the prompt can say WHICH archive to re-drop.
  const rpfName = getRpfSessionName(rpfId)

  const reopen = useCallback(
    async (file: File): Promise<void> => {
      if (classifyFile(file.name) !== 'rpf') {
        setStage({
          kind: 'error',
          message: `expected an .rpf archive, got ${file.name}`,
        })
        return
      }
      const derived = await getDerivedKeys()
      if (!derived) {
        setStage({ kind: 'needs-key', file })
        return
      }
      setStage({ kind: 'opening', file })
      try {
        const archive = await openRpf(file, derived, { name: file.name })
        // Swap in place: same id, same URL, so the user's place is restored.
        replaceRpfSession(rpfId, file, archive)
        onReopened()
      } catch (e) {
        setStage({
          kind: 'error',
          message: e instanceof Error ? e.message : String(e),
        })
      }
    },
    [rpfId, onReopened],
  )

  const onKeyReady = useCallback(() => {
    if (stage.kind === 'needs-key') void reopen(stage.file)
  }, [stage, reopen])

  const openPicker = useCallback(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.rpf'
    input.onchange = (): void => {
      const f = input.files?.[0]
      if (f) void reopen(f)
    }
    input.click()
  }, [reopen])

  return (
    <main className="mx-auto w-full max-w-[1280px] px-4 py-12">
      <div className="mb-8">
        <h1 className="text-2xl font-normal uppercase tracking-[0.12em] text-[var(--color-fg)]">
          archive not in memory
        </h1>
        <p className="mt-2 text-[var(--color-fg-dim)]">
          rpf archives are opened in memory only (they can be huge), so a page
          reload drops them. re-drop{' '}
          {rpfName ? <code>{rpfName}</code> : 'the rpf archive'} to reopen it
          right here, or{' '}
          <button
            type="button"
            className="!border-0 !bg-transparent !p-0 !normal-case !tracking-normal align-baseline underline underline-offset-2 hover:text-[var(--color-accent)]"
            onClick={() => void navigate({ to: '/' })}
          >
            go back to the drop zone
          </button>
          .
        </p>
      </div>

      <div
        onDragEnter={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={(e) => {
          e.preventDefault()
          setDragOver(false)
        }}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          // Only accept drops from settled states (mirrors the onClick
          // gate). Crucially this blocks 'needs-key': NeedsKeyPromptBody's
          // own drop handler doesn't stopPropagation, so the exe drop
          // bubbles here. without this gate it would flip the stage to
          // error mid-derivation and destroy the key prompt.
          if (stage.kind !== 'prompt' && stage.kind !== 'error') return
          const file = e.dataTransfer.files[0]
          if (file) void reopen(file)
        }}
        onClick={() => {
          if (stage.kind === 'prompt' || stage.kind === 'error') openPicker()
        }}
        className={`flex min-h-[440px] flex-col items-center justify-center border px-6 py-12 transition-[background-color,border-color] duration-150 ${
          stage.kind === 'error'
            ? 'border-[var(--color-danger)] bg-[var(--color-bg)]'
            : dragOver
              ? 'border-[var(--color-accent)] bg-[var(--color-bg-1)]'
              : 'border-[var(--color-line-strong)] bg-[var(--color-bg)]'
        } ${stage.kind === 'prompt' || stage.kind === 'error' ? 'cursor-pointer' : ''}`}
      >
        {stage.kind === 'prompt' && (
          <div className="flex flex-col items-center gap-2 text-center">
            <ArrowLineDown
              aria-hidden
              size={24}
              className="text-[var(--color-accent)]"
            />
            <span className="uppercase tracking-[0.16em] text-[var(--color-fg)]">
              {dragOver
                ? 'release to reopen'
                : `drop ${rpfName ?? 'the rpf'} here`}
            </span>
            <span className="mt-1 text-xs uppercase tracking-[0.16em] text-[var(--color-fg-mute)]">
              or click to browse
            </span>
          </div>
        )}

        {stage.kind === 'needs-key' && (
          <div className="w-full" onClick={(e) => e.stopPropagation()}>
            <NeedsKeyPromptBody onReady={onKeyReady} />
          </div>
        )}

        {stage.kind === 'opening' && (
          <ProgressLine
            label="opening rpf…"
            readout={stage.file.name}
            indeterminate
          />
        )}

        {stage.kind === 'error' && (
          <div className="flex flex-col items-stretch gap-3 text-center">
            <p className="uppercase tracking-[0.16em] text-[var(--color-danger)]">
              reopen failed
            </p>
            <pre
              role="alert"
              className="mx-auto max-w-2xl whitespace-pre-wrap border border-[var(--color-danger)] px-3 py-2 text-left text-xs text-[var(--color-danger)]"
            >
              {stage.message}
            </pre>
            <p className="text-xs uppercase tracking-[0.16em] text-[var(--color-fg-mute)]">
              drop again or click to browse
            </p>
          </div>
        )}
      </div>
    </main>
  )
}
