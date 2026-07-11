/**
 * Drop-zone landing page. Owns the entire pre-decode pipeline so the user
 * never sees a context-switch to a loading screen before navigation. Handles
 * two input formats:
 *
 *   .awc → idle → parsing → (needs-key →) extracting → navigating → /mix/:id
 *                                                                ↘ error
 *   .rpf → idle → (needs-key →) rpf-opening → navigate to /rpf/:id
 *                                                          ↘ error
 *
 * The RPF explorer itself is a ROUTE (`./rpf/$rpfId.tsx`), not a drop-zone
 * stage. That's what makes browser-back from the mixer land back in the
 * explorer with the archive still open. The drop zone only opens the
 * archive and hands off.
 *
 * The `navigating` stage pins the progress bar at 100% with a brief fade
 * so the user gets a "loading complete" cue before the route swap to the
 * mix page.
 *
 * The bordered drop-zone box hosts every state so the user's eyes never have
 * to jump.
 */

import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useCallback, useState } from 'react'
import { ArrowLineDown, LockKey } from '@phosphor-icons/react'

import { APP_NAME } from '../app-meta'
import { NeedsKeyPromptBody } from '../components/NeedsKeyPrompt'
import { ProgressLine } from '../components/ProgressLine'
import { RecentSessions } from '../components/RecentSessions'
import { useAliveRef } from '../lib/use-alive-ref'
import { extractAllStreamsWithBlocks } from '../awc/extract'
import { parseAwc } from '../awc/parser'
import { getAwcKey, getDerivedKeys } from '../keys'
import { openRpf } from '../rpf'
import { createRpfSession } from '../rpf-session'
import { attachParsed, createSession } from '../session'
import { NAVIGATE_HOLD_MS, classifyFile } from './-dropStage'
import type { LoadStage } from './-dropStage'

export const Route = createFileRoute('/')({ component: DropPage })

function DropPage() {
  const navigate = useNavigate()
  const [dragOver, setDragOver] = useState(false)
  const [stage, setStage] = useState<LoadStage>({ kind: 'idle' })
  // Liveness flag: both pipelines await multi-second work (openRpf, parse +
  // extract) and then navigate. If the user navigates away mid-pipeline
  // (recent-session card, browser back/forward), an unguarded navigate()
  // would yank them out of wherever they went once the work resolves. The
  // `alive()` accessor also breaks ESLint's control-flow narrowing (same
  // class of false positive as the AbortController `aborted()` pattern in
  // CLAUDE.md, don't "simplify" the call away).
  const alive = useAliveRef()

  const runAwcPipeline = useCallback(
    async (file: File): Promise<void> => {
      setStage({ kind: 'parsing', file })
      let buffer: ArrayBuffer
      let awc: ReturnType<typeof parseAwc>
      try {
        buffer = await file.arrayBuffer()
        awc = parseAwc(buffer)
      } catch (e) {
        setStage({
          kind: 'error',
          file,
          message: e instanceof Error ? e.message : String(e),
        })
        return
      }

      const needsKey = awc.streams.some((s) =>
        s.layout.kind === 'mc-channel'
          ? s.layout.source.encrypted
          : s.layout.encrypted,
      )
      const key = needsKey ? await getAwcKey() : null
      if (needsKey && !key) {
        setStage({ kind: 'needs-key', file, intent: 'awc' })
        return
      }

      setStage({ kind: 'extracting', file })
      let streamBytes: ReturnType<typeof extractAllStreamsWithBlocks>
      try {
        // Wrapping in a microtask lets the "extracting…" paint before work.
        await Promise.resolve()
        streamBytes = extractAllStreamsWithBlocks(awc, buffer, { key })
      } catch (e) {
        setStage({
          kind: 'error',
          file,
          message: e instanceof Error ? e.message : String(e),
        })
        return
      }

      // Liveness check BEFORE committing side effects: navigating away
      // mid-pipeline must not persist a phantom session or pin the parsed
      // payload in the module-level cache.
      if (!alive()) return
      const id = createSession(file)
      attachParsed(id, { awc, buffer, streamBytes })
      // Hold a "loading complete" beat with the progress bar pinned at 100%
      // so the user sees a visual completion cue before the mix route mounts.
      // The mix route's `consumeParsed` cache means it will go straight to
      // 'ready' without re-rendering its own 'parsing…' fallback.
      setStage({ kind: 'navigating', file, displayName: file.name })
      await new Promise((r) => setTimeout(r, NAVIGATE_HOLD_MS))
      if (!alive()) return
      void navigate({ to: '/mix/$sessionId', params: { sessionId: id } })
    },
    [navigate],
  )

  /**
   * RPF pipeline: requires the full DerivedKeys bundle (NG tables + lut),
   * so even un-encrypted RPFs go through the same getDerivedKeys gate to
   * keep the UX consistent. Inner OPEN-mode RPFs would technically work
   * without NG keys, but the typical user is dropping a stock NG-encrypted
   * archive. defaulting to require-keys keeps the failure mode obvious.
   *
   * On success the archive is registered in the rpf-session registry and we
   * NAVIGATE to /rpf/:id. the explorer is a route, so back from the mixer
   * returns to it with the archive still open.
   */
  const runRpfPipeline = useCallback(
    async (file: File): Promise<void> => {
      setStage({ kind: 'rpf-opening', file })
      const derived = await getDerivedKeys()
      if (!derived) {
        setStage({ kind: 'needs-key', file, intent: 'rpf' })
        return
      }
      try {
        const archive = await openRpf(file, derived, { name: file.name })
        if (!alive()) return
        const rpfId = createRpfSession(file, archive)
        void navigate({ to: '/rpf/$rpfId', params: { rpfId } })
      } catch (e) {
        setStage({
          kind: 'error',
          file,
          message: e instanceof Error ? e.message : String(e),
        })
      }
    },
    [navigate],
  )

  const runPipeline = useCallback(
    async (file: File): Promise<void> => {
      const kind = classifyFile(file.name)
      if (kind === 'awc') {
        await runAwcPipeline(file)
      } else if (kind === 'rpf') {
        await runRpfPipeline(file)
      } else {
        setStage({
          kind: 'error',
          file,
          message: `expected .awc or .rpf, got ${file.name}`,
        })
      }
    },
    [runAwcPipeline, runRpfPipeline],
  )

  const handleFile = useCallback(
    (file: File) => {
      void runPipeline(file)
    },
    [runPipeline],
  )

  // Re-runs the pipeline after the key prompt succeeds. The user's original
  // file is still bound to the current stage, so we resume from parsing.
  const onKeyReady = useCallback(() => {
    if (stage.kind === 'needs-key') void runPipeline(stage.file)
  }, [stage, runPipeline])

  const reset = useCallback(() => {
    setStage({ kind: 'idle' })
  }, [])

  const openPicker = useCallback(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.awc,.rpf'
    input.onchange = (): void => {
      const f = input.files?.[0]
      if (f) handleFile(f)
    }
    input.click()
  }, [handleFile])

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault()
      setDragOver(false)
      // Ignore drops a sub-flow owns: the mid-pipeline stages, and the
      // needs-key prompt, which has its own exe drop target. Its onDrop does
      // not stopPropagation, so without gating needs-key the dropped exe would
      // bubble here and get classified as a bad file (expected .awc or .rpf).
      if (
        stage.kind === 'parsing' ||
        stage.kind === 'extracting' ||
        stage.kind === 'rpf-opening' ||
        stage.kind === 'navigating' ||
        stage.kind === 'needs-key'
      ) {
        return
      }
      const file = e.dataTransfer.files[0]
      if (file) handleFile(file)
    },
    [handleFile, stage.kind],
  )

  // Only the idle state makes the WHOLE box clickable. In every other state
  // (parsing, extracting, needs-key, rpf-opening, navigating, error) the user
  // is mid-flow and the inner controls own click semantics: the error state
  // has explicit clear/choose-another buttons, the key prompt has its own
  // picker.
  const boxIsPicker = stage.kind === 'idle'

  return (
    <div className="flex min-h-[calc(100vh-2.5rem)] flex-col">
      <main className="mx-auto flex w-full max-w-[760px] flex-1 flex-col px-4">
        <div className="flex flex-1 flex-col items-stretch justify-center gap-4 py-10">
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
            onDrop={onDrop}
            className={`flex min-h-[280px] flex-col items-stretch justify-center border px-6 py-12 transition-[background-color,border-color,opacity] duration-150 ${
              stage.kind === 'error'
                ? 'border-[var(--color-danger)] bg-[var(--color-bg)]'
                : dragOver
                  ? 'border-[var(--color-accent)] bg-[var(--color-bg-1)]'
                  : 'border-[var(--color-line-strong)] bg-[var(--color-bg)]'
            } ${stage.kind === 'navigating' ? 'opacity-60' : 'opacity-100'} ${
              boxIsPicker ? 'cursor-pointer' : ''
            }`}
            onClick={() => {
              // Only the idle state opens the picker globally. Clicks on text,
              // padding, and empty area all bubble up here. Child controls in
              // other stages (explorer, error buttons, key prompt) are reached
              // via the `boxIsPicker === false` gate, so we don't intercept them.
              if (!boxIsPicker) return
              openPicker()
            }}
          >
            <DropZoneContents
              stage={stage}
              dragOver={dragOver}
              onKeyReady={onKeyReady}
              onReset={reset}
              onBrowse={openPicker}
            />
          </div>

          {stage.kind === 'idle' && (
            <>
              <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-1 text-[10px] uppercase tracking-[0.14em] text-[var(--color-fg-mute)]">
                <span>
                  <span className="text-[var(--color-fg-dim)]">.awc</span> audio
                </span>
                <span>
                  <span className="text-[var(--color-fg-dim)]">.rpf</span>{' '}
                  archives
                </span>
              </div>
              <RecentSessions />
            </>
          )}
        </div>
      </main>

      {stage.kind === 'idle' && (
        <footer className="w-full border-t border-[var(--color-line)]">
          <div className="mx-auto flex max-w-[760px] flex-wrap items-center justify-center gap-x-4 gap-y-1 px-4 py-4 text-center">
            <span className="inline-flex items-center gap-1.5 text-[11px] tracking-[0.02em] text-[var(--color-fg-dim)]">
              <LockKey
                size={13}
                weight="fill"
                className="text-[var(--color-ok)]"
                aria-hidden
              />
              Everything is processed locally. No files leave this device.
            </span>
            <span className="text-[10px] uppercase tracking-[0.14em] text-[var(--color-fg-mute)]">
              © 2026 {APP_NAME}
            </span>
          </div>
        </footer>
      )}
    </div>
  )
}

interface DropZoneContentsProps {
  stage: LoadStage
  dragOver: boolean
  onKeyReady: () => void
  onReset: () => void
  onBrowse: () => void
}

function DropZoneContents({
  stage,
  dragOver,
  onKeyReady,
  onReset,
  onBrowse,
}: DropZoneContentsProps): React.ReactNode {
  if (stage.kind === 'idle') {
    return (
      <div className="flex flex-col items-center justify-center gap-2 text-center">
        <ArrowLineDown
          aria-hidden
          size={24}
          className="text-[var(--color-accent)]"
        />
        <span className="text-[var(--color-fg)] uppercase tracking-[0.16em]">
          {dragOver ? 'release to load' : 'drop an .awc or .rpf'}
        </span>
        <span className="mt-1 text-[var(--color-fg-mute)] text-xs uppercase tracking-[0.16em]">
          or click to browse
        </span>
      </div>
    )
  }

  if (
    stage.kind === 'parsing' ||
    stage.kind === 'extracting' ||
    stage.kind === 'rpf-opening' ||
    stage.kind === 'navigating'
  ) {
    const label =
      stage.kind === 'parsing'
        ? 'parsing…'
        : stage.kind === 'extracting'
          ? 'extracting streams…'
          : stage.kind === 'rpf-opening'
            ? 'opening rpf…'
            : 'ready, opening mixer…'
    // Rough progress hint per stage. The actual work has no fine-grained
    // progress events, so this is just a visual cue. The 'navigating' stage
    // pins the bar at 100% as a "loading complete" beat before route swap.
    const pct =
      stage.kind === 'parsing'
        ? 35
        : stage.kind === 'rpf-opening'
          ? 50
          : stage.kind === 'extracting'
            ? 80
            : 100
    const displayName =
      stage.kind === 'navigating' ? stage.displayName : stage.file.name
    return <ProgressLine label={label} readout={displayName} pct={pct} />
  }

  if (stage.kind === 'needs-key') {
    return <NeedsKeyPromptBody onReady={onKeyReady} />
  }

  // error
  return (
    <div className="flex flex-col items-stretch gap-3 text-center">
      <p className="uppercase tracking-[0.16em] text-[var(--color-danger)]">
        load failed
      </p>
      <pre
        role="alert"
        className="mx-auto max-w-2xl whitespace-pre-wrap border border-[var(--color-danger)] px-3 py-2 text-left text-xs text-[var(--color-danger)]"
      >
        {stage.message}
      </pre>
      <div className="mt-2 flex items-center justify-center gap-2">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onReset()
          }}
        >
          clear
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onBrowse()
          }}
        >
          choose another
        </button>
      </div>
    </div>
  )
}
