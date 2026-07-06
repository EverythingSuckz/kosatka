import { Link, createFileRoute, useBlocker } from '@tanstack/react-router'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  CaretDown,
  CaretRight,
  DownloadSimple,
  Eraser,
  FilePlus,
  FloppyDisk,
  FolderOpen,
  GearSix,
  Info,
  MagnifyingGlassMinus,
  MagnifyingGlassPlus,
  Pause,
  Play,
  Power,
  Repeat,
  SpeakerHigh,
  SpeakerSlash,
  Square,
} from '@phosphor-icons/react'

import { ContextMenu } from '../../mixer/context-menu'
import {
  buildKeyframeContextMenu,
  duplicateTimeFor,
  fadeOutTime,
  planFadeIn,
} from '../../mixer/context-menu-builder'
import { createHistory } from '../../mixer/history'
import { MixerErrorBoundary } from '../../components/MixerErrorBoundary'
import { NeedsKeyPrompt } from '../../components/NeedsKeyPrompt'
import { extractAllStreamsWithBlocks } from '../../awc/extract'
import { parseAwc } from '../../awc/parser'
import { resolveStreamLabels } from '../../awc/stream-names'
import { decodeStream } from '../../codecs'
import { getAwcKey } from '../../keys'
import { MixerEngine } from '../../mixer/engine'
import { audioBufferToWavBlob, downloadBlob } from '../../mixer/export'
import { exportStemsAsZip } from '../../mixer/stems-export'
import { readHashState, writeHashState } from '../../mixer/hash-state'
import {
  applyMixFile,
  buildMixFile,
  downloadMixFile,
  parseMixFile,
} from '../../mixer/mix-file'
import { useMixer, usePlayheadPosition } from '../../mixer/hook'
import { MasterMeter, PairListMeter } from '../../mixer/meter'
import { ScrubInput } from '../../mixer/scrub-input'
import { getSettings } from '../../settings/store'
import { openSettings } from '../../settings/ui'
import { APP_NAME } from '../../app-meta'
import { AwcInfoModal } from '../../components/AwcInfoModal'
import { CopyButton } from '../../components/CopyButton'
import { ProgressLine } from '../../components/ProgressLine'
import { KeyCap } from '../../components/KeyCap'
import {
  KeyframesLayer,
  TimelineLoopOverlay,
  TimelinePlayhead,
  TimelineRuler,
  computeContentWidth,
  createMultiDragCoordinator,
  multiDragFingerprint,
} from '../../mixer/timeline'
import { Inspector, buildInspectorVM } from '../../mixer/inspector'
import {
  SELECTION_NONE,
  isPairSelected,
  rangeBetween,
  selectionReducer,
} from '../../mixer/selection'
import { GAIN_MAX } from '../../mixer/types'
import { isMixDirty } from '../../mixer/nav-guard'
import { evictOthers, peekResume, stashResume } from '../../mixer/resume-cache'
import { StemWaveform } from '../../mixer/waveform'
import { consumeParsed, loadSession } from '../../session'
import type { ResumeEntry } from '../../mixer/resume-cache'
import type { Keyframe, MixerSnapshot, TrackSpec } from '../../mixer/types'
import type { KeyframeRef, Selection } from '../../mixer/selection'
import type { InspectorPairInfo } from '../../mixer/inspector'
import type {
  KeyframeClickModifiers,
  MultiDragCoordinator,
  MultiDragKeyframeRef,
} from '../../mixer/timeline'
import type { DecodedHashState, HashMixState } from '../../mixer/hash-state'
import type { ExtractedStream } from '../../codecs'
import type { AwcFile } from '../../awc/types'
import type { StemLabel } from '../../awc/stream-names'
import type { MixHistory, MixHistoryState } from '../../mixer/history'
import type { ContextMenuItem } from '../../mixer/context-menu'

export const Route = createFileRoute('/mix/$sessionId')({ component: MixPage })

interface ParsedAwc {
  file: File
  buffer: ArrayBuffer
  awc: AwcFile
  streamBytes: Array<ExtractedStream>
  /**
   * Present when this mount is an instant resume from the module-level
   * cache (mixer/resume-cache.ts): decoded buffers, undo history, playhead
   * and selection all survive a back-navigation round trip. `streamBytes`
   * is empty on this path. the decode stage is skipped entirely.
   */
  resume: ResumeEntry | null
}

function MixPage() {
  const { sessionId } = Route.useParams()
  const [state, setState] = useState<
    'loading' | 'ready' | 'needs-key' | 'error' | 'no-session'
  >('loading')
  const [parsed, setParsed] = useState<ParsedAwc | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [keyVersion, setKeyVersion] = useState(0)

  useEffect(() => {
    const ac = new AbortController()
    const aborted = (): boolean => ac.signal.aborted
    setState('loading')
    void (async () => {
      let file: File | null
      try {
        file = await loadSession(sessionId)
      } catch (e) {
        // IDB read failure (corrupted store, database deleted mid-session,
        // quota/IO error). without this catch the route would hang on the
        // loading screen forever.
        if (!aborted()) {
          setError(e instanceof Error ? e.message : String(e))
          setState('error')
        }
        return
      }
      if (aborted()) return
      if (!file) {
        setState('no-session')
        return
      }
      // Instant resume: a previous mount of THIS session stashed its decoded
      // buffers + editor state in the module cache (back-navigation round
      // trip). We still re-parse the AWC (it's fast and the UI needs the
      // stream metadata) but skip key-check/extract/decode entirely.
      const resume = peekResume(sessionId)
      if (resume) {
        try {
          const buffer = await file.arrayBuffer()
          const awc = parseAwc(buffer)
          if (!aborted()) {
            setParsed({ file, buffer, awc, streamBytes: [], resume })
            setState('ready')
          }
          return
        } catch {
          // Resume is best-effort. fall through to the normal pipeline.
        }
      }
      // A different session is loading: release the old session's cached
      // buffers to GC before we decode a new set (capacity-1 cache, avoids
      // transient double residency of two full stem sets).
      evictOthers(sessionId)
      const prep = consumeParsed(sessionId)
      if (prep) {
        if (!aborted()) {
          setParsed({
            file,
            buffer: prep.buffer,
            awc: prep.awc,
            streamBytes: prep.streamBytes,
            resume: null,
          })
          setState('ready')
        }
        return
      }
      try {
        const buffer = await file.arrayBuffer()
        const awc = parseAwc(buffer)
        const needsKey = awc.streams.some((s) =>
          s.layout.kind === 'mc-channel'
            ? s.layout.source.encrypted
            : s.layout.encrypted,
        )
        const key = needsKey ? await getAwcKey() : null
        if (needsKey && !key) {
          if (!aborted()) setState('needs-key')
          return
        }
        const streamBytes = extractAllStreamsWithBlocks(awc, buffer, { key })
        if (!aborted()) {
          setParsed({ file, buffer, awc, streamBytes, resume: null })
          setState('ready')
        }
      } catch (e) {
        if (!aborted()) {
          setError(e instanceof Error ? e.message : String(e))
          setState('error')
        }
      }
    })()
    return () => ac.abort()
  }, [sessionId, keyVersion])

  if (state === 'no-session') {
    return (
      <LoadingShell
        name={null}
        label="session not found"
        pct={0}
        terminal
        note="this session isn't in memory anymore. click AWC to go back and drop your file again."
      />
    )
  }
  if (state === 'loading') {
    // Hard-reload fallback: the drop-zone normally hands us a parsed
    // payload via `consumeParsed`, but on a direct visit to /mix/<id>
    // (or a refresh that didn't preserve the in-memory cache) we re-run
    // parse+extract here. Parse+extract is synchronous with no fine-grained
    // progress, so the bar is indeterminate (was a fake, frozen 35%).
    return (
      <LoadingShell
        name={null}
        label="loading session…"
        pct={0}
        indeterminate
      />
    )
  }
  if (state === 'needs-key') {
    return <NeedsKeyPrompt onReady={() => setKeyVersion((v) => v + 1)} />
  }
  if (state === 'error' || !parsed) {
    return (
      <LoadingShell
        name={null}
        label="parse failed"
        pct={0}
        terminal
        error={error}
      />
    )
  }
  return (
    <MixerErrorBoundary>
      <Mixer parsed={parsed} sessionId={sessionId} />
    </MixerErrorBoundary>
  )
}

interface DecodeStatus {
  total: number
  done: number
  failed: number
  /**
   * Block-granular progress. Whole-stem counts are useless as a progress
   * signal here: all 16 stems decode in PARALLEL workers, so stem
   * completions cluster at the end (the bar sat at 0/16 for most of the
   * decode). Workers stream per-block ticks (~80/stem) instead.
   */
  blocksDone: number
  blocksTotal: number
}

function Mixer({
  parsed,
  sessionId,
}: {
  parsed: ParsedAwc
  sessionId: string
}) {
  const { file, awc, streamBytes } = parsed
  const [engine, setEngine] = useState<MixerEngine | null>(null)
  const [buffers, setBuffers] = useState<Array<AudioBuffer | null>>([])
  const [decoding, setDecoding] = useState<DecodeStatus | null>({
    total: awc.streams.length,
    done: 0,
    failed: 0,
    blocksDone: 0,
    blocksTotal: 0,
  })
  const [decodeError, setDecodeError] = useState<string | null>(null)
  const [decodeFailures, setDecodeFailures] = useState<Map<number, string>>(
    new Map(),
  )

  useEffect(() => {
    const ac = new AbortController()
    const aborted = (): boolean => ac.signal.aborted

    // Instant resume: buffers were decoded by a previous mount and stashed
    // in the resume cache. rebuild route state from the entry synchronously
    // and skip the decode stage entirely. The hash-restore effect in
    // MixerView then applies the user's real mutes/gains/keyframes exactly
    // as on a cold mount. only the playhead comes from the entry (it isn't
    // part of the URL hash).
    const resume = parsed.resume
    if (resume) {
      const ctx = new AudioContext({ sampleRate: 48000 })
      const byIdx: Array<AudioBuffer | null> = new Array<AudioBuffer | null>(
        awc.streams.length,
      ).fill(null)
      for (const spec of resume.specs) {
        const idxStr = spec.id.split('-')[0]
        const idx = idxStr ? parseInt(idxStr, 10) : NaN
        if (Number.isFinite(idx) && idx >= 0 && idx < byIdx.length) {
          byIdx[idx] = spec.buffer
        }
      }
      const failures = new Map<number, string>()
      for (const f of resume.decodeFailures) {
        failures.set(f.streamIndex, f.message)
      }
      setBuffers(byIdx)
      setDecodeFailures(failures)
      const eng = new MixerEngine(ctx)
      eng.loadTracks(resume.specs)
      // Same startup defaults as the cold path below. the hash-restore
      // effect overrides them with the user's saved state right after.
      for (const spec of resume.specs) {
        const idxStr = spec.id.split('-')[0]
        const idx = idxStr ? parseInt(idxStr, 10) : NaN
        if (Number.isFinite(idx)) {
          eng.setPan(spec.id, idx % 2 === 0 ? -1 : 1)
        }
        eng.setMuted(spec.id, true)
      }
      eng.seek(resume.playheadSec)
      setEngine(eng)
      setDecoding(null)
      return () => ac.abort()
    }

    void (async () => {
      try {
        const ctx = new AudioContext({ sampleRate: 48000 })
        const failures = new Map<number, string>()

        // Block-granular progress across ALL parallel stem decodes. Each
        // worker streams per-block ticks. we sum them and push to state at
        // most every ~80 ms so 16 workers × ~80 blocks don't stampede React.
        const blocksPer = awc.streams.map((_, i) =>
          Math.max(streamBytes[i]?.blocks.length ?? 0, 1),
        )
        const blocksTotal = blocksPer.reduce((a, b) => a + b, 0)
        const blockDone: Array<number> = new Array<number>(
          awc.streams.length,
        ).fill(0)
        let lastPush = 0
        const pushBlocks = (force = false): void => {
          const now = performance.now()
          if (!force && now - lastPush < 80) return
          lastPush = now
          const sum = blockDone.reduce((a, b) => a + b, 0)
          if (!aborted()) {
            setDecoding((s) => (s ? { ...s, blocksDone: sum, blocksTotal } : s))
          }
        }
        pushBlocks(true)

        const decoded = await Promise.all(
          awc.streams.map(async (stream, i) => {
            try {
              const buf = await decodeStream(
                stream,
                streamBytes[i]!,
                ctx,
                awc.header.endianness,
                (blocksDone) => {
                  blockDone[i] = blocksDone
                  pushBlocks()
                },
              )
              blockDone[i] = blocksPer[i]!
              if (!aborted()) {
                setDecoding((s) => (s ? { ...s, done: s.done + 1 } : s))
                pushBlocks(true)
              }
              return buf
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e)
              failures.set(i, msg)
              blockDone[i] = blocksPer[i]!
              if (!aborted()) {
                setDecoding((s) =>
                  s ? { ...s, failed: s.failed + 1, done: s.done + 1 } : s,
                )
                pushBlocks(true)
              }
              return null
            }
          }),
        )
        if (aborted()) {
          void ctx.close()
          return
        }
        setBuffers(decoded)
        setDecodeFailures(failures)

        const specs: Array<TrackSpec> = []
        for (let i = 0; i < decoded.length; i++) {
          const b = decoded[i]
          if (!b) continue
          const stream = awc.streams[i]!
          specs.push({
            id: `${i}-${stream.hashHex}`,
            name: stream.hashHex,
            buffer: b,
          })
        }
        if (specs.length === 0) {
          setDecodeError(buildDecodeErrorReport(file, awc, failures))
          setDecoding(null)
          void ctx.close()
          return
        }

        const eng = new MixerEngine(ctx)
        eng.loadTracks(specs)
        for (const spec of specs) {
          const idxStr = spec.id.split('-')[0]
          const idx = idxStr ? parseInt(idxStr, 10) : NaN
          if (Number.isFinite(idx)) {
            eng.setPan(spec.id, idx % 2 === 0 ? -1 : 1)
          }
          eng.setMuted(spec.id, true)
        }
        // Default master level (settings) for a fresh mix. A saved mix in
        // the URL hash overrides this in MixerView's restore effect.
        eng.setMasterGain(getSettings().defaultMasterPct / 100)
        if (aborted()) {
          eng.dispose()
          void ctx.close()
          return
        }
        setEngine(eng)
        setDecoding(null)
      } catch (e) {
        if (!aborted()) {
          setDecodeError(e instanceof Error ? e.message : String(e))
          setDecoding(null)
        }
      }
    })()
    return () => ac.abort()
  }, [awc, file, streamBytes, parsed.resume])

  useEffect(() => {
    return () => {
      if (!engine) return
      const ctx = engine.context()
      engine.dispose()
      // Close the AudioContext explicitly: dispose() only tears down the
      // node graph. With instant resume making route remounts routine, a
      // leaked running context per visit would accumulate against the
      // browser's per-tab AudioContext limit.
      void ctx.close().catch(() => {
        // Already closed (or closing), nothing to do.
      })
    }
  }, [engine])

  const isEncrypted =
    awc.header.flagBits.multiChannelEncrypt ||
    awc.header.flagBits.singleChannelEncrypt

  if (!engine) {
    const total = decoding?.total ?? awc.streams.length
    const done = decoding?.done ?? 0
    const failed = decoding?.failed ?? 0
    // Block-granular percentage, moves within ~100ms of decode kickoff
    // (whole-stem counts cluster at the end, see DecodeStatus).
    const pct =
      decoding && decoding.blocksTotal > 0
        ? Math.round((decoding.blocksDone / decoding.blocksTotal) * 100)
        : total > 0
          ? Math.round((done / total) * 100)
          : 0
    const indeterminate =
      !!decoding && decoding.blocksDone === 0 && !decodeError
    // On a hard decode failure the readout stops reporting a live count (a
    // frozen "0%, 0/16" reads like it's still working). it flips to a red
    // "err -/N stems" and ProgressLine paints the bar danger-red.
    const readout = decodeError ? (
      <span className="text-[var(--color-danger)]">
        err&nbsp;&nbsp;-/{total} stems
      </span>
    ) : indeterminate ? undefined : (
      <>
        <span>{pct}%</span>{' '}
        <span className="text-[var(--color-fg-mute)]">
          {done}/{total} stems{failed > 0 ? ` (${failed} failed)` : ''}
        </span>
      </>
    )
    return (
      <LoadingShell
        name={file.name}
        label={indeterminate ? 'starting decoder…' : 'decoding stems…'}
        pct={decodeError ? 0 : pct}
        indeterminate={indeterminate}
        detail={readout}
        error={decodeError}
      />
    )
  }

  return (
    <MixerView
      file={file}
      awc={awc}
      engine={engine}
      buffers={buffers}
      isEncrypted={isEncrypted}
      decodeFailures={decodeFailures}
      sessionId={sessionId}
      resume={parsed.resume}
    />
  )
}

/**
 * Loading frame for the mix route's pre-editor states (parsing, decoding).
 * Renders the SAME chrome the editor will have (top bar with the orange
 * mark + filename slot, bottom transport strip disabled) so loading
 * reads as the editor filling in, not as a separate page. The progress
 * module sits exactly where the first pair row will appear.
 */
function LoadingShell({
  name,
  label,
  pct,
  detail,
  error,
  note,
  indeterminate,
  terminal,
}: {
  name: string | null
  label: string
  pct: number
  detail?: React.ReactNode
  error?: string | null
  /** Neutral explanatory line (e.g. "session not found"). */
  note?: string
  /**
   * True before the first unit of measurable work lands (worker spin-up +
   * first-block decode is ~0.7-1s). A static 0% bar reads as frozen, so we
   * show a moving indeterminate bar until real progress starts.
   */
  indeterminate?: boolean
  /** Terminal state (error / dead end). hides the progress bar entirely. */
  terminal?: boolean
}): React.ReactNode {
  return (
    <main className="flex h-screen w-full flex-col bg-[var(--color-bg)] text-[var(--color-fg)]">
      <header
        className="flex items-center gap-3 border-b border-[var(--color-line)] bg-[var(--color-bg)] px-3"
        style={{ height: `${TOP_BAR_PX}px` }}
      >
        <Link
          to="/"
          className="no-underline shrink-0"
          title="Back to drop zone"
        >
          <span className="font-bold uppercase tracking-[0.14em] text-[11px] text-[var(--color-accent)]">
            {APP_NAME}
          </span>
        </Link>
        <h1 className="truncate text-[13px] font-normal uppercase tracking-[0.14em]">
          {name ?? (
            <span className="text-[var(--color-fg-mute)]">
              loading session…
            </span>
          )}
        </h1>
        <button
          type="button"
          onClick={() => openSettings()}
          aria-label="settings"
          title="Settings"
          className="ml-auto !border-0 !bg-transparent !p-1 text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]"
        >
          <GearSix size={13} />
        </button>
      </header>
      <div className="grid min-h-0 flex-1 place-items-center px-6">
        <div className="w-full max-w-[560px]">
          {terminal ? (
            <p className="text-[11px] uppercase tracking-[0.16em] text-[var(--color-danger)]">
              {label}
            </p>
          ) : (
            <ProgressLine
              label={label}
              readout={indeterminate ? undefined : (detail ?? `${pct}%`)}
              pct={pct}
              indeterminate={indeterminate}
              error={!!error}
            />
          )}
          {note && (
            <p className="mt-3 text-[11px] leading-relaxed text-[var(--color-fg-dim)]">
              {note}
            </p>
          )}
          {error && (
            <div
              role="alert"
              className="mt-3 border-2 border-[var(--color-danger)]"
            >
              <div className="flex items-center justify-between gap-2 border-b border-[var(--color-danger)]/40 px-3 py-1.5">
                <span className="text-[10px] uppercase tracking-[0.14em] text-[var(--color-danger)]">
                  error
                </span>
                <CopyButton
                  text={error}
                  className="!px-1.5 !py-0.5 inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.1em] text-[var(--color-danger)] hover:opacity-80"
                />
              </div>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap px-3 py-2 text-[11px] text-[var(--color-danger)]">
                {error}
              </pre>
            </div>
          )}
        </div>
      </div>
      <div
        className="flex items-center gap-2 border-t-2 border-[var(--color-line-strong)] bg-[var(--color-bg-1)] px-3"
        style={{ height: `${MONITOR_PX}px` }}
      >
        <button disabled className="!px-2.5 !py-1 inline-flex items-center">
          <Play size={13} />
        </button>
        <button disabled className="!px-2 !py-1 inline-flex items-center">
          <Square size={13} />
        </button>
        <span className="ml-2 tabular-nums text-[12px] uppercase tracking-[0.10em] text-[var(--color-fg-mute)]">
          0:00 <span className="mx-1">/</span> –:––
        </span>
      </div>
    </main>
  )
}

function buildFileFields(
  file: File,
  awc: AwcFile,
  encrypted: boolean,
): Array<string> {
  const counts = new Map<string, number>()
  for (const s of awc.streams) {
    const k = s.codec.toUpperCase()
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  const codecParts: Array<string> = []
  for (const [k, v] of counts) codecParts.push(`${v} × ${k}`)
  const sampleRate = awc.streams[0]?.sampleRate ?? null
  const dur = awc.streams.reduce((m, s) => Math.max(m, s.durationSeconds), 0)
  return [
    `${(file.size / 1024 / 1024).toFixed(2)} mib`,
    `${awc.streams.length} stems`,
    encrypted ? 'encrypted' : 'unencrypted',
    codecParts.join(' + '),
    sampleRate ? `${(sampleRate / 1000).toFixed(1)} khz` : null,
    `${fmtTimeShort(dur)}`,
    `${awc.header.endianness.toLowerCase()}`,
  ].filter((x): x is string => Boolean(x))
}

/**
 * Build a copy-pasteable diagnostic when EVERY stem fails to decode. The old
 * message ("no stems decoded successfully") told the user nothing actionable.
 * this captures the file shape and the per-stem decoder errors so a bug report
 * is self-contained. Failures are grouped by message (16 identical "unsupported
 * codec" lines collapse to one) with the stream indices that hit each.
 */
function buildDecodeErrorReport(
  file: File,
  awc: AwcFile,
  failures: Map<number, string>,
): string {
  const encrypted =
    awc.header.flagBits.multiChannelEncrypt ||
    awc.header.flagBits.singleChannelEncrypt
  const counts = new Map<string, number>()
  for (const s of awc.streams) {
    const k = s.codec.toUpperCase()
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  const codec = [...counts].map(([k, v]) => `${v} × ${k}`).join(' + ')
  const sampleRate = awc.streams[0]?.sampleRate ?? null

  const lines = [
    'no stems decoded successfully',
    '',
    `file: ${file.name}`,
    `size: ${(file.size / 1024 / 1024).toFixed(2)} mib`,
    `stems: 0/${awc.streams.length} decoded (${failures.size} failed)`,
    `codec: ${codec || 'unknown'}`,
  ]
  if (sampleRate)
    lines.push(`sample rate: ${(sampleRate / 1000).toFixed(1)} khz`)
  lines.push(`encrypted: ${encrypted ? 'yes' : 'no'}`)
  lines.push(`endianness: ${awc.header.endianness.toLowerCase()}`)

  // Group identical failure messages so a wall of duplicates collapses.
  const byMsg = new Map<string, Array<number>>()
  for (const [idx, msg] of failures) {
    const arr = byMsg.get(msg)
    if (arr) arr.push(idx)
    else byMsg.set(msg, [idx])
  }
  if (byMsg.size > 0) {
    lines.push('', 'failures:')
    for (const [msg, idxs] of byMsg) {
      lines.push(`  stems ${idxs.join(', ')}: ${msg}`)
    }
  }
  return lines.join('\n')
}

/**
 * Channel marker (L / R) over an expanded pair's waveform lane so the two
 * stereo halves are identifiable at a glance. `pointer-events-none` lets
 * click-to-seek pass straight through to the canvas underneath.
 */
function ChannelTag({ children }: { children: string }): React.ReactNode {
  return (
    <span className="pointer-events-none absolute left-1 top-1 z-10 rounded-sm bg-[var(--color-bg)]/70 px-1 text-[9px] font-bold uppercase leading-[1.4] tracking-[0.12em] text-[var(--color-fg-dim)]">
      {children}
    </span>
  )
}

/**
 * Build the URL-hash wire shape from an engine snapshot. Shared by the
 * debounced hash writer (F6) and the resume-cache stash, one builder so the
 * two can't drift. Pure. pair count comes from the AWC stream count.
 */
function buildHashStateFromSnapshot(
  snap: Pick<MixerSnapshot, 'tracks' | 'masterGain' | 'automation'>,
  streamCount: number,
): HashMixState {
  const pairCount = Math.ceil(streamCount / 2)
  const mArr: Array<number> = []
  const gArr: Array<number> = []
  const pArr: Array<number> = []
  for (let n = 0; n < pairCount; n++) {
    const li = n * 2
    const leftTrack = snap.tracks.find((t) => t.id.startsWith(`${li}-`))
    const enabled = leftTrack ? !leftTrack.muted : true
    const gain = leftTrack?.gain ?? 1
    const spread = leftTrack ? Math.abs(leftTrack.pan) : 1
    mArr.push(enabled ? 1 : 0)
    gArr.push(Math.round(gain * 100))
    pArr.push(Math.round(spread * 100))
  }
  let aArr: Array<ReadonlyArray<Keyframe> | null> | undefined
  let anyKf = false
  const pa: Array<ReadonlyArray<Keyframe> | null> = []
  for (let n = 0; n < pairCount; n++) {
    const list = snap.automation[`pair-${n + 1}`]
    if (!list || list.length === 0) {
      pa.push(null)
    } else {
      anyKf = true
      pa.push(list.map((k) => ({ ...k })))
    }
  }
  if (anyKf) aArr = pa
  return {
    m: mArr,
    g: gArr,
    p: pArr,
    M: Math.round(snap.masterGain * 100),
    a: aArr,
  }
}

function fmtTimeShort(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '-'
  const min = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${min}:${String(sec).padStart(2, '0')}`
}

function fmtTimeReadout(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0
  const min = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${min}:${String(sec).padStart(2, '0')}`
}

function gainToDb(g: number): string {
  if (g <= 0.0001) return '-∞'
  const db = 20 * Math.log10(g)
  if (db >= 0) return `+${db.toFixed(1)}`
  return db.toFixed(1)
}

interface PairVM {
  pairIndex: number
  leftIdx: number
  rightIdx: number
  leftBuffer: AudioBuffer | null
  rightBuffer: AudioBuffer | null
  leftTrackId: string | null
  rightTrackId: string | null
  leftLabel: StemLabel | undefined
  rightLabel: StemLabel | undefined
  leftHashHex: string | null
  rightHashHex: string | null
}

// editor layout dimensions
const TOP_BAR_PX = 40
/** Bottom transport bar height. */
const MONITOR_PX = 44
const RULER_PX = 24
const PAIR_ROW_PX = 40
const PAIR_COL_PX = 232

const MIN_ZOOM = 1
const MAX_ZOOM = 20

function MixerView({
  file,
  awc,
  engine,
  buffers,
  isEncrypted,
  decodeFailures,
  sessionId,
  resume,
}: {
  file: File
  awc: AwcFile
  engine: MixerEngine
  buffers: Array<AudioBuffer | null>
  isEncrypted: boolean
  decodeFailures: Map<number, string>
  sessionId: string
  resume: ResumeEntry | null
}) {
  const m = useMixer(engine)

  const [selection, setSelection] = useState<Selection>(
    resume ? resume.selection : SELECTION_NONE,
  )
  const selectionRef = useRef<Selection>(selection)
  selectionRef.current = selection

  // Leave-prompt state, declared early because the debounced hash writer
  // below depends on it (re-arm after the dialog closes). The blocker that
  // drives it lives further down with the rest of the leave-guard logic.
  const leaveResolverRef = useRef<((leave: boolean) => void) | null>(null)
  const [leavePromptOpen, setLeavePromptOpen] = useState(false)
  const dispatchSel = useCallback(
    (action: Parameters<typeof selectionReducer>[1]) => {
      setSelection((prev) => selectionReducer(prev, action))
    },
    [],
  )

  const pairRefs = useRef(new Map<number, HTMLDivElement | null>())

  const [expandedPairs, setExpandedPairs] = useState<Set<number>>(new Set())
  const toggleExpanded = useCallback((pi: number) => {
    setExpandedPairs((prev) => {
      const next = new Set(prev)
      if (next.has(pi)) next.delete(pi)
      else next.add(pi)
      return next
    })
  }, [])

  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  const [exportingStems, setExportingStems] = useState(false)
  const [mixBanner, setMixBanner] = useState<{
    tone: 'ok' | 'warn' | 'error'
    message: string
  } | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [zoom, setZoom] = useState(1)
  const [timelineAreaWidth, setTimelineAreaWidth] = useState(720)
  const timelineAreaRef = useRef<HTMLDivElement>(null)
  const timelineScrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = timelineAreaRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = entry.contentRect.width
        if (w > 0) setTimelineAreaWidth(Math.round(w))
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const contentWidthPx = computeContentWidth(timelineAreaWidth, zoom)

  // Ctrl+wheel zoom toward cursor.
  useEffect(() => {
    const el = timelineScrollRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const cursorX = e.clientX - rect.left + el.scrollLeft
      const ratio = cursorX / Math.max(1, contentWidthPx)
      const step = e.deltaY > 0 ? 1 / 1.1 : 1.1
      setZoom((prev) => {
        const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, prev * step))
        // Keep the time under the cursor stable: new cursorX = ratio × newWidth.
        const newWidth = Math.round(Math.max(720, timelineAreaWidth) * next)
        const newCursorX = ratio * newWidth
        // Update scrollLeft so the same time stays at the same viewport offset.
        const viewportX = cursorX - el.scrollLeft
        requestAnimationFrame(() => {
          el.scrollLeft = newCursorX - viewportX
        })
        return next
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [contentWidthPx, timelineAreaWidth])

  // Auto-scroll the timeline to follow the playhead during playback. When the
  // playhead crosses 75% of the visible viewport, we snap-scroll so it lands
  // back at 25%. The "auto-follow" flag is cleared when the user manually
  // scrolls (wheel / scrollbar drag) and re-armed on stop / seek / play.
  // We do NOT auto-scroll while paused or stopped.
  const autoFollowRef = useRef(true)
  // Suppress one scroll event triggered by our own scrollLeft mutation so we
  // don't immediately disable auto-follow after auto-scrolling.
  const suppressNextScrollRef = useRef(0)
  useEffect(() => {
    const el = timelineScrollRef.current
    if (!el) return
    const onUserScroll = (): void => {
      if (suppressNextScrollRef.current > 0) {
        suppressNextScrollRef.current -= 1
        return
      }
      autoFollowRef.current = false
    }
    el.addEventListener('scroll', onUserScroll, { passive: true })
    return () => el.removeEventListener('scroll', onUserScroll)
  }, [])
  // Subscribe to the engine's shared RAF for auto-scroll. Reads scroll state
  // imperatively (no React state, would re-render every frame at 60Hz).
  useEffect(() => {
    if (!m.isPlaying) return
    // Re-arm follow on each play/seek transition. (The hook re-creates this
    // effect when isPlaying flips. seeking while playing also triggers a
    // play() with a new offset, which keeps `isPlaying` true, but the user
    // intent is clearly "show me where I jumped to", so we re-arm here too.)
    autoFollowRef.current = true
    const unsub = engine.subscribeFrame(() => {
      if (!autoFollowRef.current) return
      const el = timelineScrollRef.current
      if (!el) return
      const dur = engine.durationSeconds()
      if (dur <= 0) return
      const playheadPx = (engine.positionSeconds() / dur) * contentWidthPx
      const scrollLeft = el.scrollLeft
      const clientWidth = el.clientWidth
      if (clientWidth <= 0) return
      const cushion = clientWidth * 0.75
      const inViewportX = playheadPx - scrollLeft
      if (inViewportX > cushion) {
        // Snap-scroll so the playhead lands at 25% of the viewport.
        const target = Math.max(0, playheadPx - clientWidth * 0.25)
        suppressNextScrollRef.current += 1
        el.scrollLeft = target
      } else if (inViewportX < 0) {
        // Playhead is BEFORE the visible window (user scrolled past it).
        // Snap back if auto-follow is still armed.
        const target = Math.max(0, playheadPx - clientWidth * 0.25)
        suppressNextScrollRef.current += 1
        el.scrollLeft = target
      }
    })
    return unsub
  }, [engine, m.isPlaying, contentWidthPx])

  // Convenience wrapper: explicit user seek (ruler / waveform click / etc.)
  // re-arms auto-follow so the next frame snap-scrolls back if needed.
  const onSeekWithFollow = useCallback(
    (t: number): void => {
      autoFollowRef.current = true
      engine.seek(t)
    },
    [engine],
  )

  const [lastLoopRegion, setLastLoopRegion] = useState<{
    start: number
    end: number
  } | null>(null)
  useEffect(() => {
    if (m.loopRegion) setLastLoopRegion(m.loopRegion)
  }, [m.loopRegion])
  const loopEnabled = m.loopRegion !== null

  const keyframesByPair = useMemo<
    Record<number, ReadonlyArray<Keyframe>>
  >(() => {
    const out: Record<number, ReadonlyArray<Keyframe>> = {}
    for (const [key, list] of Object.entries(m.automation)) {
      const match = /^pair-(\d+)$/.exec(key)
      if (!match) continue
      const idx = parseInt(match[1]!, 10)
      if (Number.isFinite(idx)) out[idx] = list
    }
    return out
  }, [m.automation])

  // Latest-keyframes ref + multi-drag coordinator. The coordinator captures
  // the ref so its `getKeyframes(pi)` always reads the current value without
  // having to be re-instantiated on every snapshot tick (which would also
  // re-register every diamond, destroying the perf win). The keyframesRef
  // is updated synchronously each render so drag handlers see fresh data.
  const keyframesByPairRef = useRef(keyframesByPair)
  keyframesByPairRef.current = keyframesByPair
  const dragCoordinatorRef = useRef<MultiDragCoordinator | null>(null)
  if (dragCoordinatorRef.current === null) {
    dragCoordinatorRef.current = createMultiDragCoordinator((pi) => {
      return keyframesByPairRef.current[pi] ?? []
    })
  }
  const dragCoordinator = dragCoordinatorRef.current

  const streamLabels = useMemo(
    () => resolveStreamLabels(awc, file.name),
    [awc, file.name],
  )

  const pairs = useMemo(() => {
    const out: Array<PairVM> = []
    const trackIdByStreamIdx = new Map<number, string>()
    for (const t of m.tracks) {
      const idxStr = t.id.split('-')[0]
      const idx = idxStr ? parseInt(idxStr, 10) : NaN
      if (Number.isFinite(idx)) trackIdByStreamIdx.set(idx, t.id)
    }
    const pairCount = Math.ceil(awc.streams.length / 2)
    for (let n = 0; n < pairCount; n++) {
      const li = n * 2
      const ri = li + 1
      const lStream = awc.streams[li]
      const rStream = ri < awc.streams.length ? awc.streams[ri] : undefined
      out.push({
        pairIndex: n + 1,
        leftIdx: li,
        rightIdx: ri,
        leftBuffer: buffers[li] ?? null,
        rightBuffer: ri < buffers.length ? (buffers[ri] ?? null) : null,
        leftTrackId: trackIdByStreamIdx.get(li) ?? null,
        rightTrackId:
          ri < awc.streams.length ? (trackIdByStreamIdx.get(ri) ?? null) : null,
        leftLabel: streamLabels.get(lStream?.hash ?? -1),
        rightLabel: rStream ? streamLabels.get(rStream.hash) : undefined,
        leftHashHex: lStream?.hashHex ?? null,
        rightHashHex: rStream?.hashHex ?? null,
      })
    }
    return out
  }, [awc.streams, buffers, m.tracks, streamLabels])

  const trackById = useMemo(() => {
    const map = new Map<string, (typeof m.tracks)[number]>()
    for (const t of m.tracks) map.set(t.id, t)
    return map
  }, [m.tracks])

  // Autoplay-on-load (settings), best-effort: fired once state is restored,
  // for a fresh (non-resume) mount. Browser autoplay policy may keep the
  // AudioContext suspended if the drop gesture has expired. that's benign
  // (the mix is simply ready and paused). Not applied on resume, the user
  // was mid-session and shouldn't be surprised by playback starting.
  const autoplayedRef = useRef(false)
  const maybeAutoplay = useCallback((): void => {
    if (autoplayedRef.current || resume) return
    autoplayedRef.current = true
    if (getSettings().autoplayOnLoad) engine.play()
  }, [engine, resume])

  // F6: restore from URL hash on first mount once the engine is ready.
  const hasRestoredRef = useRef(false)
  useEffect(() => {
    if (hasRestoredRef.current) return
    if (m.tracks.length === 0) return
    // On a RESUME mount the stashed mix state wins over the URL hash: the
    // stash reads the live engine at unmount, while the URL lags behind by
    // the writer's debounce (and recent-card navigations arrive with no hash
    // at all, it rides on history entries, not fresh links). The URL stays
    // the authority for cold mounts. The debounced writer below re-writes
    // the hash as soon as the restore mutations land, so the URL heals.
    const hashState: DecodedHashState | null =
      resume?.hashState ?? readHashState() ?? null
    if (!hashState) {
      hasRestoredRef.current = true
      maybeAutoplay()
      return
    }
    const pairCount = Math.ceil(awc.streams.length / 2)
    for (let n = 0; n < pairCount; n++) {
      const li = n * 2
      const ri = li + 1
      const leftTrackId =
        m.tracks.find((t) => t.id.startsWith(`${li}-`))?.id ?? null
      const rightTrackId =
        m.tracks.find((t) => t.id.startsWith(`${ri}-`))?.id ?? null
      const enabled = (hashState.m[n] ?? 0) === 1
      const gain = (hashState.g[n] ?? 100) / 100
      const spread = Math.abs((hashState.p[n] ?? 100) / 100)
      if (leftTrackId) {
        engine.setMuted(leftTrackId, !enabled)
        engine.setGain(leftTrackId, gain)
        engine.setPan(leftTrackId, -spread)
      }
      if (rightTrackId) {
        engine.setMuted(rightTrackId, !enabled)
        engine.setGain(rightTrackId, gain)
        engine.setPan(rightTrackId, +spread)
      }
    }
    engine.setMasterGain(hashState.M / 100)
    engine.clearKeyframes()
    if (hashState.a) {
      for (let n = 0; n < hashState.a.length; n++) {
        const list = hashState.a[n]
        if (!list || list.length === 0) continue
        engine.setKeyframes(
          `pair-${n + 1}`,
          list.map((k) => ({ ...k })),
        )
      }
    }
    if (hashState.legacyAutomationDropped) {
      setMixBanner({
        tone: 'warn',
        message:
          'old segment automation in the URL was dropped; the keyframe system replaces it',
      })
    } else if (hashState.legacyV1Automation) {
      // v1 keyframe gains meant "envelope multiplier", v2 means "absolute
      // gain". The wire bytes are identical, so we kept the values, but in
      // most cases v1 envelope = 100% (no change), which IS the same as
      // absolute = full slider value, so the audible impact is minimal.
      console.warn(
        '[hash-state] v1 keyframe semantics detected, keyframe gain now means absolute gain, not envelope multiplier. Values were preserved as-is.',
      )
      setMixBanner({
        tone: 'warn',
        message:
          'keyframe semantics changed: gain is now absolute (it was a multiplier on the pair slider). review your envelopes',
      })
    }
    hasRestoredRef.current = true
    maybeAutoplay()
  }, [m.tracks, awc.streams.length, engine, resume, maybeAutoplay])

  // F6: debounced hash writer.
  useEffect(() => {
    if (!hasRestoredRef.current) return
    if (m.tracks.length === 0) return
    const next = buildHashStateFromSnapshot(
      { tracks: m.tracks, masterGain: m.masterGain, automation: m.automation },
      awc.streams.length,
    )
    // Entry identity at arm time: TanStack stamps each history entry with a
    // unique __TSR_key. Comparing it at fire time catches same-path foreign
    // entries (e.g. an adjacent /mix/<id> entry created by a manual hash
    // edit) that a pathname check alone would let through.
    const armedKey = (window.history.state as { __TSR_key?: string } | null)
      ?.__TSR_key
    const handle = setTimeout(() => {
      // TanStack blocks POP navigations RETROACTIVELY: while the leave
      // dialog is up, window.location is already the PREVIOUS history entry,
      // and the router's patched replaceState would treat a write as a
      // navigation (force-unmounting the mixer under the dialog). Never
      // write unless we're still on this mix route AND the same entry.
      if (!window.location.pathname.endsWith(`/mix/${sessionId}`)) return
      const nowKey = (window.history.state as { __TSR_key?: string } | null)
        ?.__TSR_key
      if (nowKey !== armedKey) return
      writeHashState(next)
    }, 200)
    return () => clearTimeout(handle)
    // leavePromptOpen re-arms the writer after the dialog closes: a write
    // skipped by the guards above (fired while blocked) would otherwise
    // never retry, leaving the URL missing the last pre-dialog edit.
  }, [
    m.tracks,
    m.masterGain,
    m.automation,
    awc.streams.length,
    sessionId,
    leavePromptOpen,
  ])

  const onExport = useCallback(async () => {
    setExportError(null)
    setExporting(true)
    try {
      const buffersById = new Map<string, AudioBuffer>()
      for (let i = 0; i < buffers.length; i++) {
        const buf = buffers[i]
        if (!buf) continue
        const stream = awc.streams[i]!
        buffersById.set(`${i}-${stream.hashHex}`, buf)
      }
      if (buffersById.size === 0)
        throw new Error('no decoded buffers to render')
      const rendered = await engine.renderCurrentState(buffersById)
      const blob = audioBufferToWavBlob(rendered)
      const baseName = file.name.replace(/\.awc$/i, '') || 'mix'
      downloadBlob(blob, `${baseName}.mix.wav`)
    } catch (e) {
      setExportError(e instanceof Error ? e.message : String(e))
    } finally {
      setExporting(false)
    }
  }, [awc.streams, buffers, engine, file.name])

  const onExportStems = useCallback(async () => {
    setExportError(null)
    setExportingStems(true)
    try {
      const pairInputs = pairs.map((p) => {
        const labelL = p.leftLabel?.short ?? `pair_${p.pairIndex}`
        const labelR = p.rightLabel?.short ?? `pair_${p.pairIndex}`
        return {
          pairIndex: p.pairIndex,
          label: `${labelL}+${labelR}`.toLowerCase().replace(/\s+/g, '_'),
          leftBuffer: p.leftBuffer,
          rightBuffer: p.rightBuffer,
        }
      })
      const baseName = file.name.replace(/\.awc$/i, '') || 'stems'
      const zipBlob = await exportStemsAsZip(
        engine.context(),
        baseName,
        pairInputs,
      )
      downloadBlob(zipBlob, `${baseName}.stems.zip`)
    } catch (e) {
      setExportError(e instanceof Error ? e.message : String(e))
    } finally {
      setExportingStems(false)
    }
  }, [engine, file.name, pairs])

  const captureHashState = useCallback((): HashMixState => {
    const pairCount = Math.ceil(awc.streams.length / 2)
    const mArr: Array<number> = []
    const gArr: Array<number> = []
    const pArr: Array<number> = []
    for (let n = 0; n < pairCount; n++) {
      const li = n * 2
      const leftTrack = m.tracks.find((t) => t.id.startsWith(`${li}-`))
      const enabled = leftTrack ? !leftTrack.muted : true
      const gain = leftTrack?.gain ?? 1
      const spread = leftTrack ? Math.abs(leftTrack.pan) : 1
      mArr.push(enabled ? 1 : 0)
      gArr.push(Math.round(gain * 100))
      pArr.push(Math.round(spread * 100))
    }
    let aArr: Array<ReadonlyArray<Keyframe> | null> | undefined
    let anyKf = false
    const pa: Array<ReadonlyArray<Keyframe> | null> = []
    for (let n = 0; n < pairCount; n++) {
      const list = m.automation[`pair-${n + 1}`]
      if (!list || list.length === 0) {
        pa.push(null)
      } else {
        anyKf = true
        pa.push(list.map((k) => ({ ...k })))
      }
    }
    if (anyKf) aArr = pa
    return {
      m: mArr,
      g: gArr,
      p: pArr,
      M: Math.round(m.masterGain * 100),
      a: aArr,
    }
  }, [awc.streams.length, m.tracks, m.masterGain, m.automation])

  const trackIdsForPair = useCallback(
    (pairIndex: number): { left: string | null; right: string | null } => {
      const p = pairs[pairIndex - 1]
      if (!p) return { left: null, right: null }
      return { left: p.leftTrackId, right: p.rightTrackId }
    },
    [pairs],
  )

  const onSaveMix = useCallback(() => {
    try {
      const state = captureHashState()
      const sampleRate = awc.streams[0]?.sampleRate ?? 48000
      const mixFile = buildMixFile({
        awcName: file.name,
        awcSize: file.size,
        streamCount: awc.streams.length,
        sampleRate,
        state,
      })
      const baseName = file.name.replace(/\.awc$/i, '') || 'mix'
      downloadMixFile(mixFile, baseName)
    } catch (e) {
      setMixBanner({
        tone: 'error',
        message: `failed to save mix: ${e instanceof Error ? e.message : String(e)}`,
      })
    }
  }, [awc.streams, captureHashState, file.name, file.size])

  const onLoadMixFile = useCallback(
    async (input: File): Promise<void> => {
      const lower = input.name.toLowerCase()
      const looksLikeMix =
        lower.endsWith('.mix') ||
        input.type === 'application/json' ||
        input.type === 'text/json'
      if (!looksLikeMix) {
        setMixBanner({
          tone: 'error',
          message: `wrong file type. drop a .mix file (got "${input.name}")`,
        })
        return
      }
      try {
        const text = await input.text()
        const result = parseMixFile(text)
        if (!result.ok) {
          setMixBanner({
            tone: 'error',
            message: `failed to load mix: ${result.error}`,
          })
          return
        }
        const pairCount = Math.ceil(awc.streams.length / 2)
        const warnings: Array<string> = []
        if (result.mix.awc.name && result.mix.awc.name !== file.name) {
          warnings.push(
            `this mix was saved for "${result.mix.awc.name}", but you have "${file.name}" loaded. applying it anyway`,
          )
        }
        if (result.legacyAutomationDropped) {
          warnings.push(
            'segment automation was dropped (replaced by keyframes)',
          )
        }
        const apply = applyMixFile(result.mix, engine, {
          pairCount,
          trackIdsForPair,
        })
        warnings.push(...apply.warnings)
        // Same route guard as the debounced writer: a blocked popstate can
        // park window.location on a foreign entry, and writing there would
        // both pollute that entry and force a router transition. The engine
        // state IS applied either way. the debounced writer re-syncs the
        // URL on the next snapshot change.
        if (window.location.pathname.endsWith(`/mix/${sessionId}`)) {
          writeHashState(result.mix.state)
        }
        if (warnings.length > 0) {
          setMixBanner({
            tone: 'warn',
            message: `loaded mix: ${input.name}. ${warnings.join('; ')}`,
          })
        } else {
          setMixBanner({
            tone: 'ok',
            message: `loaded mix: ${input.name}`,
          })
        }
      } catch (e) {
        setMixBanner({
          tone: 'error',
          message: `failed to load mix: ${e instanceof Error ? e.message : String(e)}`,
        })
      }
    },
    [awc.streams.length, engine, file.name, trackIdsForPair, sessionId],
  )

  const onLoadMixClick = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  useEffect(() => {
    if (!mixBanner) return
    const handle = setTimeout(() => setMixBanner(null), 5000)
    return () => clearTimeout(handle)
  }, [mixBanner])

  const pairTrackIds = useCallback(
    (pairIndex: number): Array<string> => {
      const p = pairs[pairIndex - 1]
      if (!p) return []
      const ids: Array<string> = []
      if (p.leftTrackId) ids.push(p.leftTrackId)
      if (p.rightTrackId) ids.push(p.rightTrackId)
      return ids
    },
    [pairs],
  )

  // captureMixStateRef + pushHistoryRef wrap the latest closures so mutations
  // defined earlier in the component can call them via stable refs. Defined
  // here to avoid a forward-reference dance between callbacks.
  // (They're populated below where captureMixState / pushHistory are defined.)
  const captureMixStateRef = useRef<() => MixHistoryState>(() => ({
    tracks: [],
    masterGain: 1,
    automation: {},
  }))

  const pushHistoryRef = useRef<(label: string, coalesceKey?: string) => void>(
    () => {},
  )

  const togglePairEnabled = useCallback(
    (pairIndex: number): void => {
      const ids = pairTrackIds(pairIndex)
      if (ids.length === 0) return
      const first = trackById.get(ids[0]!)
      const currentlyEnabled = !(first?.muted ?? false)
      pushHistoryRef.current('toggle pair')
      for (const id of ids) engine.setMuted(id, currentlyEnabled)
    },
    [engine, pairTrackIds, trackById],
  )

  /** Bulk-set every pair's enabled state, one history entry. */
  const setAllPairsEnabled = useCallback(
    (enabled: boolean): void => {
      pushHistoryRef.current(enabled ? 'enable all pairs' : 'disable all pairs')
      for (const p of pairs) {
        for (const id of pairTrackIds(p.pairIndex)) {
          engine.setMuted(id, !enabled)
        }
      }
    },
    [engine, pairs, pairTrackIds],
  )

  const setPairGain = useCallback(
    (pairIndex: number, gain: number): void => {
      pushHistoryRef.current('pair gain', `slider-gain-${pairIndex}`)
      for (const id of pairTrackIds(pairIndex)) engine.setGain(id, gain)
    },
    [engine, pairTrackIds],
  )

  const setPairSpread = useCallback(
    (pairIndex: number, spread01: number): void => {
      pushHistoryRef.current('pair spread', `slider-spread-${pairIndex}`)
      const p = pairs[pairIndex - 1]
      if (!p) return
      const s = Math.max(0, Math.min(1, spread01))
      if (p.leftTrackId) engine.setPan(p.leftTrackId, -s)
      if (p.rightTrackId) engine.setPan(p.rightTrackId, +s)
    },
    [engine, pairs],
  )

  useEffect(() => {
    for (const p of pairs) {
      const ids: Array<string> = []
      if (p.leftTrackId) ids.push(p.leftTrackId)
      if (p.rightTrackId) ids.push(p.rightTrackId)
      engine.setAutomationTargets(`pair-${p.pairIndex}`, ids)
    }
  }, [engine, pairs])

  // history (undo / redo)
  // One instance per Mixer mount, except on instant resume, where the
  // previous mount's instance is reused so the undo stack survives the
  // back-navigation round trip. Snapshots are pushed BEFORE the mutation
  // they should undo. Replays from undo / redo set `replayingRef` to suppress
  // the next snapshot push (we don't want undo itself to leave a redo trail).
  const historyRef = useRef<MixHistory>(
    resume ? resume.history : createHistory(),
  )
  const replayingRef = useRef(false)

  // leave guard + resume stash
  // Dirty-gate (mixer/nav-guard.ts): the dialog only fires when something
  // genuinely invested exists: in-memory undo history, drawn automation, or
  // active playback. A fresh-loaded track backs out silently, keeping the
  // rpf audition loop (back → pick next → back) dialog-free. The same gate
  // drives the native beforeunload prompt: tab close/refresh kills the
  // in-memory resume cache, so that's where undo history genuinely dies.
  // Reads live engine/history state at decision time, no stale closures.
  const computeDirty = useCallback((): boolean => {
    const snap = engine.snapshot()
    // The engine never flips `playing` at natural end-of-buffer (sources
    // have no onended handler), so isPlaying() alone would trip the dialog
    // on a track auditioned to its end. Past-the-end counts as not playing,
    // UNLESS something loops: a looping source keeps making sound while the
    // transport clock counts past the buffer duration.
    const anyLoop = snap.loopRegion !== null || snap.tracks.some((t) => t.loop)
    const playing =
      engine.isPlaying() &&
      (anyLoop || engine.positionSeconds() < engine.durationSeconds())
    return isMixDirty({
      canUndo: historyRef.current.canUndo(),
      hasAutomation: Object.keys(snap.automation).length > 0,
      isPlaying: playing,
    })
  }, [engine])

  // The blocker manages its OWN dialog promise instead of withResolver.
  // Reason: @tanstack/history's popstate handler has no re-entrancy guard.
  // a second back-press while the dialog is open runs a second blockerFn,
  // and withResolver's setResolver would overwrite (orphan) the first
  // blocked promise, leaving browser history off by one. Here the second
  // call sees the pending resolver and blocks IMMEDIATELY (returns true),
  // so the history layer reverts that pop with its own go(1) while the one
  // open dialog keeps governing the first. (leaveResolverRef /
  // leavePromptOpen are declared near the top of the component. the hash
  // writer needs them.)
  useBlocker({
    shouldBlockFn: async (args) => {
      // An open dialog governs EVERY navigation attempt, even if dirtiness
      // has since decayed (e.g. playback ended). Checking this before
      // computeDirty prevents a second back-press from proceeding underneath
      // the dialog and orphaning its promise.
      if (leaveResolverRef.current) return true
      if (!computeDirty()) return false
      // @tanstack/history reverts a blocked pop with a hardcoded go(1),
      // which is only correct for a single-step BACK. Blocking a FORWARD or
      // GO pop would desync browser history (no-op at top-of-stack / wrong
      // direction) and, worse, strand the URL on a foreign entry, muting
      // the hash writer's route guard for the rest of the session. Let those
      // pops through: leaving is cheap, the resume cache restores everything.
      // (Known library limitation: a FORWARD pressed while the dialog is
      // already open is caught by the resolver check above and reverted with
      // the same go(1), which can swallow one subsequent back-press before
      // self-recovering.)
      if (args.action === 'FORWARD' || args.action === 'GO') return false
      const leave = await new Promise<boolean>((resolve) => {
        leaveResolverRef.current = resolve
        setLeavePromptOpen(true)
      })
      leaveResolverRef.current = null
      setLeavePromptOpen(false)
      return !leave
    },
    enableBeforeUnload: computeDirty,
  })
  const resolveLeavePrompt = useCallback((leave: boolean) => {
    leaveResolverRef.current?.(leave)
  }, [])

  // React 19 runs the PARENT's effect cleanup before the child's on unmount,
  // so by the time the stash below runs, Mixer has already disposed the
  // engine, engine.snapshot() would return empty tracks. Capture the last
  // committed snapshot during render and stash from that instead.
  // (positionSeconds() stays valid through dispose() because dispose leaves
  // playing/startedAt/offsetAtStart untouched, noted in its docstring.)
  const lastSnapshotRef = useRef(m)
  lastSnapshotRef.current = m

  // Stash everything expensive on unmount so browser-back is instantly
  // reversible (mixer/resume-cache.ts). Specs are rebuilt exactly the way
  // the decode path builds them (id = `${streamIndex}-${hashHex}`).
  useEffect(() => {
    return () => {
      const specs: Array<TrackSpec> = []
      for (let i = 0; i < buffers.length; i++) {
        const b = buffers[i]
        if (!b) continue
        const stream = awc.streams[i]
        if (!stream) continue
        specs.push({
          id: `${i}-${stream.hashHex}`,
          name: stream.hashHex,
          buffer: b,
        })
      }
      if (specs.length === 0) return
      stashResume({
        sessionId,
        displayName: file.name,
        specs,
        history: historyRef.current,
        playheadSec: engine.positionSeconds(),
        selection: selectionRef.current,
        decodeFailures: [...decodeFailures].map(([streamIndex, message]) => ({
          streamIndex,
          message,
        })),
        // From the render-captured snapshot, the engine is already
        // disposed by the parent's cleanup at this point (see above).
        // Fallback mix state for hash-less navigations (recent card).
        hashState: buildHashStateFromSnapshot(
          lastSnapshotRef.current,
          awc.streams.length,
        ),
        savedAt: Date.now(),
      })
    }
  }, [engine, buffers, decodeFailures, awc.streams, sessionId, file.name])

  const captureMixState = useCallback((): MixHistoryState => {
    const tracks = m.tracks.map((t) => ({
      id: t.id,
      muted: t.muted,
      gain: t.gain,
      pan: t.pan,
      solo: t.solo,
    }))
    const automation: Record<string, ReadonlyArray<Keyframe>> = {}
    for (const [k, list] of Object.entries(m.automation)) {
      automation[k] = list.map((kf) => ({ ...kf }))
    }
    return { tracks, masterGain: m.masterGain, automation }
  }, [m.tracks, m.masterGain, m.automation])

  /** Push current state onto history. Coalesce key folds multiple rapid
   *  pushes (e.g. slider scrub) into one entry. */
  const pushHistory = useCallback(
    (label: string, coalesceKey?: string): void => {
      if (replayingRef.current) return
      historyRef.current.push(
        { state: captureMixState(), label },
        { coalesceKey },
      )
    },
    [captureMixState],
  )

  // Mirror to refs so earlier-declared callbacks can call them.
  captureMixStateRef.current = captureMixState
  pushHistoryRef.current = pushHistory

  /** Replay a history state onto the engine. No history pushes happen
   *  during the replay (guarded by replayingRef). */
  const replayState = useCallback(
    (state: MixHistoryState): void => {
      replayingRef.current = true
      try {
        for (const t of state.tracks) {
          engine.setMuted(t.id, t.muted)
          engine.setGain(t.id, t.gain)
          engine.setPan(t.id, t.pan)
          engine.setSolo(t.id, t.solo)
        }
        engine.setMasterGain(state.masterGain)
        // Replace automation wholesale. clearKeyframes() is cheap, then we
        // setKeyframes per key with the snapshot's lists. Empty snapshot key
        // → clearKeyframes for that key (handled by setKeyframes(empty)).
        const keysSeen = new Set<string>()
        for (const [k, list] of Object.entries(state.automation)) {
          keysSeen.add(k)
          engine.setKeyframes(k, list.slice())
        }
        // Any pair-key in the current engine state that's NOT in the
        // snapshot must be cleared.
        for (const k of Object.keys(m.automation)) {
          if (!keysSeen.has(k)) engine.clearKeyframes(k)
        }
      } finally {
        replayingRef.current = false
      }
    },
    [engine, m.automation],
  )

  const doUndo = useCallback((): void => {
    const entry = historyRef.current.undo(captureMixState())
    if (!entry) return
    replayState(entry.state)
  }, [captureMixState, replayState])

  const doRedo = useCallback((): void => {
    const entry = historyRef.current.redo(captureMixState())
    if (!entry) return
    replayState(entry.state)
  }, [captureMixState, replayState])

  const addKeyframe = useCallback(
    (pairIndex: number, kf: Keyframe): void => {
      pushHistory('add keyframe')
      const key = `pair-${pairIndex}`
      const insertedIndex = engine.addKeyframe(key, kf)
      // Auto-select the newly inserted keyframe so the inspector flips to
      // the keyframe view with it active. -1 means the engine rejected the
      // kf (invalid time/gain), leave selection alone in that case.
      if (insertedIndex >= 0) {
        setSelection({
          kind: 'keyframes',
          items: [{ pairIndex, keyframeIndex: insertedIndex }],
        })
      }
    },
    [engine, pushHistory],
  )

  /**
   * Multi-keyframe group move: shift every selected kf by `deltaSeconds`. Used
   * by the timeline when the user drags any diamond that is part of a 2+
   * multi-selection. We commit each per-pair group in one engine call, and
   * push a SINGLE coalesced history entry for the whole gesture (the
   * `multiDragFingerprint` ensures release-then-pick-up-with-same-selection
   * lands in the same undo step within the 500 ms window).
   *
   * Selection is updated post-commit to re-resolve each ref by identity
   * (gain + easing + shifted time). the engine may reorder the list when
   * crossing neighbouring keyframes by time.
   */
  const moveKeyframesMany = useCallback(
    (refs: ReadonlyArray<MultiDragKeyframeRef>, deltaSeconds: number): void => {
      if (refs.length === 0 || deltaSeconds === 0) return
      pushHistory('move keyframes', multiDragFingerprint(refs))
      // Group refs by pair so we issue a single `setKeyframes` per pair.
      const byPair = new Map<number, Array<number>>()
      for (const r of refs) {
        const list = byPair.get(r.pairIndex)
        if (list) list.push(r.keyframeIndex)
        else byPair.set(r.pairIndex, [r.keyframeIndex])
      }
      // For new-selection tracking after the move: collect (pair, gain,
      // easing, shifted-time) tuples and re-resolve indices post-commit.
      const identities: Array<{
        pairIndex: number
        gain: number
        easing: Keyframe['easing']
        newTime: number
      }> = []
      for (const [pairIndex, indices] of byPair) {
        const key = `pair-${pairIndex}`
        const current = engine.getKeyframes(key)
        const selSet = new Set(indices)
        const next: Array<Keyframe> = current.map((k, i) => {
          if (selSet.has(i)) {
            const nt = Math.max(0, k.time + deltaSeconds)
            identities.push({
              pairIndex,
              gain: k.gain,
              easing: k.easing,
              newTime: nt,
            })
            return { time: nt, gain: k.gain, easing: k.easing }
          }
          return k
        })
        engine.setKeyframes(key, next)
      }
      // Re-resolve selection to track the moved keyframes by identity.
      const newItems: Array<KeyframeRef> = []
      for (const id of identities) {
        const after = engine.getKeyframes(`pair-${id.pairIndex}`)
        for (let i = 0; i < after.length; i++) {
          const k = after[i]!
          if (
            Math.abs(k.time - id.newTime) < 1e-6 &&
            k.gain === id.gain &&
            k.easing === id.easing
          ) {
            newItems.push({ pairIndex: id.pairIndex, keyframeIndex: i })
            break
          }
        }
      }
      if (newItems.length > 0) {
        setSelection({ kind: 'keyframes', items: newItems })
      }
    },
    [engine, pushHistory],
  )

  const moveKeyframe = useCallback(
    (pairIndex: number, idx: number, identity: Keyframe, newTime: number) => {
      // Coalesce per-pair-per-kf so a drag is one undo step.
      pushHistory('move keyframe', `kf-drag-${pairIndex}-${idx}`)
      const key = `pair-${pairIndex}`
      // Look up current keyframes to find this kf by identity (its time may
      // have moved since the drag started if other edits happened).
      const list = engine.getKeyframes(key)
      // Locate by best match against the identity object's time+gain+easing.
      let curIdx = idx
      for (let i = 0; i < list.length; i++) {
        const k = list[i]!
        if (
          k.time === identity.time &&
          k.gain === identity.gain &&
          k.easing === identity.easing
        ) {
          curIdx = i
          break
        }
      }
      engine.setKeyframe(key, curIdx, { time: newTime })
      // After move, the kf may have a new index in the sorted list. Update
      // selection to track it by identity (time = newTime, gain/easing same).
      const after = engine.getKeyframes(key)
      for (let i = 0; i < after.length; i++) {
        const k = after[i]!
        if (
          Math.abs(k.time - newTime) < 1e-6 &&
          k.gain === identity.gain &&
          k.easing === identity.easing
        ) {
          setSelection({
            kind: 'keyframes',
            items: [{ pairIndex, keyframeIndex: i }],
          })
          break
        }
      }
    },
    [engine, pushHistory],
  )

  const editKeyframe = useCallback(
    (pairIndex: number, idx: number, partial: Partial<Keyframe>) => {
      // Editing time/gain via scrub-input fires rapidly, coalesce.
      pushHistory('edit keyframe', `kf-edit-${pairIndex}-${idx}`)
      engine.setKeyframe(`pair-${pairIndex}`, idx, partial)
    },
    [engine, pushHistory],
  )

  const deleteKeyframe = useCallback(
    (pairIndex: number, idx: number) => {
      pushHistory('delete keyframe')
      engine.deleteKeyframe(`pair-${pairIndex}`, idx)
      dispatchSel({
        type: 'keyframe-removed',
        pairIndex,
        keyframeIndex: idx,
      })
    },
    [engine, dispatchSel, pushHistory],
  )

  const clearPairAutomation = useCallback(
    (pairIndex: number) => {
      pushHistory('clear pair keyframes')
      engine.clearKeyframes(`pair-${pairIndex}`)
      const sel = selectionRef.current
      if (sel.kind === 'keyframes') {
        const items = sel.items.filter((it) => it.pairIndex !== pairIndex)
        if (items.length === 0) {
          setSelection({ kind: 'pair', pairIndex })
        } else {
          setSelection({ kind: 'keyframes', items })
        }
      }
    },
    [engine, pushHistory],
  )

  // Tracks the keyframe most recently clicked WITHOUT modifiers. shift+click
  // ranges anchor from this reference. Updated by `onKeyframeClick`.
  const lastClickedKfRef = useRef<KeyframeRef | null>(null)

  // Click handler that interprets ctrl/shift modifiers per file-explorer
  // semantics. Plain click → replace selection, ctrl → toggle, shift → range.
  const onKeyframeClick = useCallback(
    (
      pairIndex: number,
      keyframeIndex: number,
      mods: KeyframeClickModifiers,
    ): void => {
      const ref: KeyframeRef = { pairIndex, keyframeIndex }
      if (mods.shift) {
        const anchor = lastClickedKfRef.current ?? ref
        const range = rangeBetween(anchor, ref)
        // Filter to indices that actually exist in the pair's keyframe list,
        // in case the anchor pointed past current bounds.
        const list = keyframesByPair[pairIndex] ?? []
        const items: Array<KeyframeRef> = []
        for (const r of range) {
          if (r.pairIndex === pairIndex && r.keyframeIndex < list.length) {
            items.push(r)
          } else {
            items.push(r)
          }
        }
        setSelection({ kind: 'keyframes', items })
        return
      }
      if (mods.ctrl) {
        dispatchSel({
          type: 'toggle-keyframe',
          pairIndex,
          keyframeIndex,
        })
        lastClickedKfRef.current = ref
        return
      }
      // Plain click, replace selection and anchor.
      setSelection({ kind: 'keyframes', items: [ref] })
      lastClickedKfRef.current = ref
    },
    [dispatchSel, keyframesByPair],
  )

  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    items: ReadonlyArray<ContextMenuItem>
  } | null>(null)

  const onKeyframeContextMenu = useCallback(
    (
      pairIndex: number,
      keyframeIndex: number,
      kf: Keyframe,
      clientX: number,
      clientY: number,
    ): void => {
      // Select this keyframe first so the inspector flips to it.
      setSelection({
        kind: 'keyframes',
        items: [{ pairIndex, keyframeIndex }],
      })
      const list = keyframesByPair[pairIndex] ?? []
      const playhead = engine.positionSeconds()
      const dur = m.durationSeconds
      const items = buildKeyframeContextMenu(
        {
          keyframe: kf,
          keyframeIndex,
          pairKeyframes: list,
          durationSeconds: dur,
          playheadSeconds: playhead,
        },
        {
          onDelete: () => deleteKeyframe(pairIndex, keyframeIndex),
          onDuplicate: () => {
            const t = duplicateTimeFor(kf, playhead, dur)
            addKeyframe(pairIndex, {
              time: t,
              gain: kf.gain,
              easing: kf.easing,
            })
          },
          onAddFadeIn: () => {
            pushHistory('add fade in')
            const plan = planFadeIn(list)
            // The destination keyframe (the right-clicked one) becomes the
            // "end of fade-in" at envelope 1.0.
            engine.setKeyframe(`pair-${pairIndex}`, keyframeIndex, {
              gain: 1.0,
            })
            if (plan.hasZeroKf) {
              engine.setKeyframe(`pair-${pairIndex}`, plan.zeroKfIndex, {
                gain: 0,
                easing: 'linear',
              })
            } else {
              engine.addKeyframe(`pair-${pairIndex}`, {
                time: 0,
                gain: 0,
                easing: 'linear',
              })
            }
          },
          onAddFadeOut: () => {
            pushHistory('add fade out')
            const t = fadeOutTime(kf, dur)
            engine.addKeyframe(`pair-${pairIndex}`, {
              time: t,
              gain: 0,
              easing: 'linear',
            })
          },
          onSetLinear: () =>
            editKeyframe(pairIndex, keyframeIndex, { easing: 'linear' }),
          onSetHold: () =>
            editKeyframe(pairIndex, keyframeIndex, { easing: 'hold' }),
        },
      )
      setContextMenu({ x: clientX, y: clientY, items })
    },
    [
      engine,
      m.durationSeconds,
      keyframesByPair,
      addKeyframe,
      deleteKeyframe,
      editKeyframe,
      pushHistory,
    ],
  )

  const toggleLoopEnabled = useCallback(() => {
    if (m.loopRegion) {
      engine.clearLoopRegion()
      return
    }
    const dur = m.durationSeconds
    if (dur <= 0) return
    const region =
      lastLoopRegion && lastLoopRegion.end - lastLoopRegion.start >= 0.05
        ? lastLoopRegion
        : { start: dur * 0.25, end: dur * 0.75 }
    engine.setLoopRegion(region.start, region.end)
  }, [engine, lastLoopRegion, m.durationSeconds, m.loopRegion])

  const selectPair = useCallback((pairIndex: number): void => {
    setSelection({ kind: 'pair', pairIndex })
    requestAnimationFrame(() => {
      pairRefs.current.get(pairIndex)?.focus()
    })
  }, [])

  const enterPreview = useCallback(
    (pairIndex: number) => {
      engine.enterPreview(`pair-${pairIndex}`)
    },
    [engine],
  )
  const exitPreview = useCallback(() => {
    engine.exitPreview()
  }, [engine])

  // Bulk delete every currently-selected keyframe. ONE history entry covers
  // the whole batch so the user gets a single undo.
  const deleteSelectedKeyframes = useCallback((): void => {
    const sel = selectionRef.current
    if (sel.kind !== 'keyframes' || sel.items.length === 0) return
    pushHistory(`delete ${sel.items.length} keyframes`)
    // Group items by pair and sort descending so deleting an earlier index
    // doesn't shift indices of later (still-undeleted) ones in the same pair.
    const byPair = new Map<number, Array<number>>()
    for (const it of sel.items) {
      const arr = byPair.get(it.pairIndex) ?? []
      arr.push(it.keyframeIndex)
      byPair.set(it.pairIndex, arr)
    }
    for (const [pi, idxs] of byPair) {
      idxs.sort((a, b) => b - a)
      for (const i of idxs) {
        engine.deleteKeyframe(`pair-${pi}`, i)
      }
    }
    setSelection(SELECTION_NONE)
  }, [engine, pushHistory])

  // Helper: produce the "focused" pair index for a selection (for shortcut
  // navigation). For keyframes-selection, returns the first item's pair.
  const focusedPair = useCallback((sel: Selection): number | null => {
    if (sel.kind === 'none') return null
    if (sel.kind === 'pair') return sel.pairIndex
    if (sel.items.length > 0) return sel.items[0]!.pairIndex
    return null
  }, [])

  // Cycle the selection between adjacent keyframes within the focused pair.
  // Direction: +1 (next, "]") or -1 (prev, "["). Silently no-ops when the
  // pair has no keyframes.
  const navigateKeyframe = useCallback(
    (direction: 1 | -1): void => {
      const sel = selectionRef.current
      const pi = focusedPair(sel)
      if (pi == null) return
      const list = keyframesByPair[pi] ?? []
      if (list.length === 0) return
      let nextIdx: number
      if (sel.kind === 'keyframes' && sel.items.length === 1) {
        const cur = sel.items[0]!.keyframeIndex
        nextIdx = Math.max(0, Math.min(list.length - 1, cur + direction))
      } else {
        nextIdx = direction > 0 ? 0 : list.length - 1
      }
      setSelection({
        kind: 'keyframes',
        items: [{ pairIndex: pi, keyframeIndex: nextIdx }],
      })
    },
    [focusedPair, keyframesByPair],
  )

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const tag = (e.target as HTMLElement | null)?.tagName.toLowerCase()
      const isInput = tag === 'input' || tag === 'textarea' || tag === 'select'

      // Ctrl/Cmd + Z / Shift+Z is undo / redo. Allow even within inputs? No,
      // inputs have their own undo, keep ours to the route shell.
      const ctrl = e.ctrlKey || e.metaKey
      if (ctrl && (e.key === 'z' || e.key === 'Z') && !isInput) {
        e.preventDefault()
        if (e.shiftKey) doRedo()
        else doUndo()
        return
      }
      if (ctrl && (e.key === 'y' || e.key === 'Y') && !isInput) {
        // Win-style redo.
        e.preventDefault()
        doRedo()
        return
      }

      if (e.key === '?' && !isInput) {
        e.preventDefault()
        openSettings('shortcuts')
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        // Esc cascade: preview → selection → loop → stop
        if (engine.isPreview() !== null) {
          engine.exitPreview()
          return
        }
        if (selectionRef.current.kind !== 'none') {
          setSelection(SELECTION_NONE)
          return
        }
        if (m.loopRegion) {
          engine.clearLoopRegion()
          return
        }
        engine.stop()
        return
      }
      if (e.code === 'Space' && !isInput) {
        e.preventDefault()
        if (engine.isPlaying()) engine.pause()
        else engine.play()
        return
      }
      if (isInput) return

      if (e.key === 'Delete' || e.key === 'Backspace') {
        const sel = selectionRef.current
        if (sel.kind === 'keyframes' && sel.items.length > 0) {
          e.preventDefault()
          deleteSelectedKeyframes()
          return
        }
      }

      if (e.key === '[' || e.key === ']') {
        e.preventDefault()
        navigateKeyframe(e.key === ']' ? 1 : -1)
        return
      }

      if (e.key === 'g' || e.key === 'G') {
        e.preventDefault()
        pushHistory('toggle global mute')
        engine.toggleMuteAll()
        return
      }

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const delta = e.key === 'ArrowDown' ? 1 : -1
        const sel = selectionRef.current
        const currentPair = focusedPair(sel)
        const startFrom = currentPair ?? (delta > 0 ? 0 : pairs.length + 1)
        const next = Math.min(Math.max(startFrom + delta, 1), pairs.length)
        if (currentPair === null || next !== currentPair) {
          selectPair(next)
        }
        return
      }
      const sel = selectionRef.current
      const pi = focusedPair(sel)
      if (pi == null) return
      if (e.key === 'm' || e.key === 'M' || e.key === 'x' || e.key === 'X') {
        e.preventDefault()
        togglePairEnabled(pi)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    engine,
    selectPair,
    m.loopRegion,
    pairs.length,
    togglePairEnabled,
    doUndo,
    doRedo,
    deleteSelectedKeyframes,
    navigateKeyframe,
    focusedPair,
    pushHistory,
  ])

  const totalDuration = m.durationSeconds

  // Per-pair selected keyframe indices, memoized so each `PairTimelineRow`
  // sees a stable array reference unless the selection set for that pair
  // actually changes. Prevents the `memo`-wrapped rows from reconciling on
  // every snapshot tick (preserves the last-round perf win).
  const selectedIdxByPair = useMemo(() => {
    const map = new Map<number, ReadonlyArray<number>>()
    if (selection.kind !== 'keyframes') return map
    const grouped = new Map<number, Array<number>>()
    for (const it of selection.items) {
      const arr = grouped.get(it.pairIndex) ?? []
      arr.push(it.keyframeIndex)
      grouped.set(it.pairIndex, arr)
    }
    for (const [k, v] of grouped) {
      v.sort((a, b) => a - b)
      map.set(k, v)
    }
    return map
  }, [selection])

  const EMPTY_SELECTED_INDICES: ReadonlyArray<number> = useMemo(() => [], [])

  // Flat list of currently selected keyframe refs, shared with every
  // KeyframesLayer for multi-drag. Stable when the selection size is < 2
  // (returns null) so the timeline can cheaply skip the multi-drag path.
  const multiSelectedRefs =
    useMemo<ReadonlyArray<MultiDragKeyframeRef> | null>(() => {
      if (selection.kind !== 'keyframes') return null
      if (selection.items.length < 2) return null
      return selection.items.map((it) => ({
        pairIndex: it.pairIndex,
        keyframeIndex: it.keyframeIndex,
      }))
    }, [selection])

  const pairsByIndex = useMemo(() => {
    const map = new Map<number, PairVM>()
    for (const p of pairs) map.set(p.pairIndex, p)
    return map
  }, [pairs])

  const inspectorVM = useMemo(() => {
    return buildInspectorVM(selection, (pairIndex) => {
      const p = pairsByIndex.get(pairIndex)
      if (!p) return null
      const lTrack = p.leftTrackId ? trackById.get(p.leftTrackId) : undefined
      const rTrack = p.rightTrackId ? trackById.get(p.rightTrackId) : undefined
      const ref = lTrack ?? rTrack
      const info: InspectorPairInfo = {
        pairIndex: p.pairIndex,
        gain: ref?.gain ?? 1,
        spread: lTrack ? Math.abs(lTrack.pan) : 1,
        enabled: !(ref?.muted ?? false),
        unavailable: !lTrack && !rTrack,
        leftHashHex: p.leftHashHex,
        rightHashHex: p.rightHashHex,
        leftTrackId: p.leftTrackId,
        rightTrackId: p.rightTrackId,
        leftLabel: p.leftLabel?.short ?? null,
        rightLabel: p.rightLabel?.short ?? null,
        keyframes: keyframesByPair[p.pairIndex] ?? [],
        durationSeconds: totalDuration,
      }
      return info
    })
  }, [selection, pairsByIndex, trackById, keyframesByPair, totalDuration])

  const fileFields = useMemo(
    () => buildFileFields(file, awc, isEncrypted),
    [file, awc, isEncrypted],
  )

  const orderedTrackIds = useMemo(() => {
    const ids: Array<string> = []
    for (let i = 0; i < awc.streams.length; i++) {
      const stream = awc.streams[i]!
      const id = `${i}-${stream.hashHex}`
      if (trackById.has(id)) ids.push(id)
    }
    return ids
  }, [awc.streams, trackById])

  const previewPairIndex = useMemo(() => {
    if (!m.previewPair) return null
    const match = /^pair-(\d+)$/.exec(m.previewPair)
    if (!match) return null
    const idx = parseInt(match[1]!, 10)
    return Number.isFinite(idx) ? idx : null
  }, [m.previewPair])

  // Global on/off summary for the pairs-header master toggle. A pair counts
  // as "on" when its reference track isn't muted. ignores unavailable pairs.
  const { anyPairOn, allPairsOn } = useMemo(() => {
    let any = false
    let all = true
    let counted = 0
    for (const p of pairs) {
      const ref = p.leftTrackId
        ? trackById.get(p.leftTrackId)
        : p.rightTrackId
          ? trackById.get(p.rightTrackId)
          : undefined
      if (!ref) continue
      counted++
      if (ref.muted) all = false
      else any = true
    }
    return { anyPairOn: any, allPairsOn: counted > 0 && all }
  }, [pairs, trackById])

  return (
    <main
      className="relative flex h-screen w-full flex-col bg-[var(--color-bg)] text-[var(--color-fg)]"
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        if (!dragOver) setDragOver(true)
      }}
      onDragLeave={(e) => {
        if (
          e.relatedTarget instanceof Node &&
          e.currentTarget.contains(e.relatedTarget)
        ) {
          return
        }
        setDragOver(false)
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        setDragOver(false)
        // The leave dialog's overlay doesn't intercept drag events, ignore
        // drops while it's up so a .mix load can't fire under the modal.
        if (leavePromptOpen) return
        const f = e.dataTransfer.files[0]
        if (!f) return
        void onLoadMixFile(f)
      }}
    >
      {dragOver && (
        <div
          className="pointer-events-none fixed inset-2 z-40 border-2 border-dashed border-[var(--color-active)] bg-[var(--color-active)]/5 flex items-center justify-center"
          aria-hidden
        >
          <span className="text-sm uppercase tracking-[0.16em] text-[var(--color-active)]">
            drop .mix to load
          </span>
        </div>
      )}

      <TopBar
        file={file}
        awc={awc}
        isEncrypted={isEncrypted}
        fields={fileFields}
        chips={[`${awc.streams.length} stems`, fmtTimeReadout(totalDuration)]}
        onOpenSettings={() => openSettings()}
        onLoadMix={onLoadMixClick}
        onSaveMix={onSaveMix}
        onExportWav={() => void onExport()}
        onExportStems={() => void onExportStems()}
        exporting={exporting}
        exportingStems={exportingStems}
        height={TOP_BAR_PX}
      />

      {mixBanner && (
        <div
          role={mixBanner.tone === 'error' ? 'alert' : 'status'}
          className={
            mixBanner.tone === 'error'
              ? 'flex items-center justify-between gap-3 border-b border-[var(--color-danger)] bg-[var(--color-bg-1)] px-4 py-1.5 text-[var(--color-danger)]'
              : mixBanner.tone === 'warn'
                ? 'flex items-center justify-between gap-3 border-b border-[var(--color-mute)] bg-[var(--color-bg-1)] px-4 py-1.5 text-[var(--color-mute)]'
                : 'flex items-center justify-between gap-3 border-b border-[var(--color-active)] bg-[var(--color-bg-1)] px-4 py-1.5 text-[var(--color-active)]'
          }
        >
          <span className="text-[11px] uppercase tracking-[0.12em]">
            {mixBanner.message}
          </span>
          <button
            onClick={() => setMixBanner(null)}
            className="!border-0 !bg-transparent !px-1 !py-0 text-current opacity-80 hover:opacity-100"
            aria-label="dismiss"
          >
            ×
          </button>
        </div>
      )}
      {exportError && (
        <p
          role="alert"
          className="border-b border-[var(--color-danger)] bg-[var(--color-bg-1)] px-4 py-1.5 text-[var(--color-danger)] text-[11px] uppercase tracking-[0.12em]"
        >
          {exportError}
        </p>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept=".mix,application/json"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) void onLoadMixFile(f)
          e.target.value = ''
        }}
      />

      <div className="flex flex-1 min-h-0">
        <section className="flex flex-1 min-w-0 flex-col" aria-label="timeline">
          <div className="flex flex-1 min-h-0 border-b border-[var(--color-line)]">
            <div
              className="shrink-0 flex flex-col border-r border-[var(--color-line)] bg-[var(--color-bg)]"
              style={{ width: `${PAIR_COL_PX}px` }}
            >
              <div
                className="flex items-center gap-2 px-3 text-[10px] uppercase tracking-[0.16em] text-[var(--color-fg-dim)] border-b border-[var(--color-line)]"
                style={{ height: `${RULER_PX}px` }}
              >
                <span className="flex-1">pairs {pairs.length}</span>
                {/* Global pairs on/off: turns every pair on, or all off.
                    (Panic "mute all" lives by the master fader now.) */}
                <button
                  type="button"
                  onClick={() => setAllPairsEnabled(!anyPairOn)}
                  disabled={m.wasGlobalMuted}
                  className={
                    allPairsOn
                      ? '!border-[var(--color-active)] !bg-[var(--color-active)] !text-[var(--color-bg)] !px-1.5 !py-0 inline-flex items-center gap-1 text-[10px]'
                      : '!px-1.5 !py-0 inline-flex items-center gap-1 text-[10px] text-[var(--color-fg-dim)]'
                  }
                  aria-pressed={allPairsOn}
                  title={anyPairOn ? 'Turn all pairs off' : 'Turn all pairs on'}
                  aria-label={
                    anyPairOn ? 'turn all pairs off' : 'turn all pairs on'
                  }
                >
                  <Power size={10} />
                  {anyPairOn ? 'all on' : 'all off'}
                </button>
              </div>
              <div className="flex-1 overflow-y-auto">
                {pairs.map((p) => {
                  const lTrack = p.leftTrackId
                    ? trackById.get(p.leftTrackId)
                    : undefined
                  const rTrack = p.rightTrackId
                    ? trackById.get(p.rightTrackId)
                    : undefined
                  const ref = lTrack ?? rTrack
                  const muted = ref?.muted ?? false
                  const enabled = !muted
                  const disabled = !lTrack && !rTrack
                  const selected = isPairSelected(selection, p.pairIndex)
                  const expanded = expandedPairs.has(p.pairIndex)
                  const isPreview = previewPairIndex === p.pairIndex
                  const dimmed = previewPairIndex !== null && !isPreview
                  const pairGain = ref?.gain ?? 1
                  const pairSpread = lTrack ? Math.abs(lTrack.pan) : 1
                  const kfCount = (keyframesByPair[p.pairIndex] ?? []).length
                  return (
                    <PairListRow
                      key={p.pairIndex}
                      pair={p}
                      enabled={enabled}
                      disabled={disabled}
                      locked={m.wasGlobalMuted}
                      selected={selected}
                      active={m.isPlaying && enabled}
                      expanded={expanded}
                      isPreview={isPreview}
                      dimmed={dimmed}
                      heightPx={expanded ? PAIR_ROW_PX * 2 : PAIR_ROW_PX}
                      engine={engine}
                      pairGain={pairGain}
                      pairSpread={pairSpread}
                      keyframeCount={kfCount}
                      setRef={(el) => pairRefs.current.set(p.pairIndex, el)}
                      onSelect={() => selectPair(p.pairIndex)}
                      onToggle={() => togglePairEnabled(p.pairIndex)}
                      onToggleExpand={() => toggleExpanded(p.pairIndex)}
                      onPreviewToggle={() => {
                        if (isPreview) exitPreview()
                        else enterPreview(p.pairIndex)
                      }}
                      onGain={(g) => setPairGain(p.pairIndex, g)}
                      onSpread={(s) => setPairSpread(p.pairIndex, s)}
                      onClearAutomation={() => clearPairAutomation(p.pairIndex)}
                    />
                  )
                })}
              </div>
            </div>

            {/* TIMELINE CONTENT (scrollable). Wrapped in a positioned shell
                so the top-right zoom widget can float over the ruler without
                scrolling with the content. */}
            <div className="relative flex-1 min-w-0">
              {/* Top-right zoom widget, anchored at the ruler row so it stays
                  visible regardless of horizontal scroll. */}
              <div
                className="absolute right-0 top-0 z-30 flex items-center gap-1 border-l border-b border-[var(--color-line-strong)] bg-[var(--color-bg-1)] px-1.5"
                style={{ height: `${RULER_PX}px` }}
                aria-label="zoom controls"
              >
                <button
                  type="button"
                  onClick={() => setZoom((z) => Math.max(MIN_ZOOM, z / 1.5))}
                  className="!px-1 !py-0 inline-flex items-center !border-0 !bg-transparent text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]"
                  aria-label="zoom out"
                  title="Zoom out (ctrl+wheel)"
                >
                  <MagnifyingGlassMinus size={11} />
                </button>
                <span className="text-[10px] tabular-nums text-[var(--color-fg-dim)] w-9 text-center select-none">
                  {zoom.toFixed(2)}×
                </span>
                <button
                  type="button"
                  onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z * 1.5))}
                  className="!px-1 !py-0 inline-flex items-center !border-0 !bg-transparent text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]"
                  aria-label="zoom in"
                  title="Zoom in (ctrl+wheel)"
                >
                  <MagnifyingGlassPlus size={11} />
                </button>
              </div>
              <div
                ref={(el) => {
                  timelineAreaRef.current = el
                  timelineScrollRef.current = el
                }}
                className="h-full overflow-x-auto overflow-y-hidden"
              >
                <div
                  className="relative flex flex-col"
                  style={{ width: `${contentWidthPx}px` }}
                >
                  <div style={{ height: `${RULER_PX}px` }}>
                    <TimelineRuler
                      durationSeconds={totalDuration}
                      loopRegion={m.loopRegion}
                      loopEnabled={loopEnabled}
                      contentWidthPx={contentWidthPx}
                      onSeek={onSeekWithFollow}
                      onSetLoopBounds={(s, e) => engine.setLoopRegion(s, e)}
                    />
                  </div>
                  <div className="flex flex-col flex-1">
                    {pairs.map((p) => {
                      const lTrack = p.leftTrackId
                        ? trackById.get(p.leftTrackId)
                        : undefined
                      const rTrack = p.rightTrackId
                        ? trackById.get(p.rightTrackId)
                        : undefined
                      const ref = lTrack ?? rTrack
                      const muted = ref?.muted ?? false
                      const enabled = !muted
                      const keyframes = keyframesByPair[p.pairIndex] ?? []
                      const selected = isPairSelected(selection, p.pairIndex)
                      const expanded = expandedPairs.has(p.pairIndex)
                      const isPreview = previewPairIndex === p.pairIndex
                      const dimmed = previewPairIndex !== null && !isPreview
                      const selectedKfIdxs =
                        selectedIdxByPair.get(p.pairIndex) ??
                        EMPTY_SELECTED_INDICES
                      return (
                        <PairTimelineRow
                          key={p.pairIndex}
                          pair={p}
                          enabled={enabled}
                          locked={m.wasGlobalMuted}
                          selected={selected}
                          expanded={expanded}
                          dimmed={dimmed}
                          heightPx={expanded ? PAIR_ROW_PX * 2 : PAIR_ROW_PX}
                          totalDuration={totalDuration}
                          keyframes={keyframes}
                          selectedKeyframeIndices={selectedKfIdxs}
                          multiSelectedRefs={multiSelectedRefs}
                          dragCoordinator={dragCoordinator}
                          onSeek={onSeekWithFollow}
                          onSelectPair={() => selectPair(p.pairIndex)}
                          onKeyframeAdd={(kf) => addKeyframe(p.pairIndex, kf)}
                          onKeyframeMove={(idx, identity, newTime) =>
                            moveKeyframe(p.pairIndex, idx, identity, newTime)
                          }
                          onKeyframesMoveMany={moveKeyframesMany}
                          onKeyframeClick={(idx, _kf, mods) =>
                            onKeyframeClick(p.pairIndex, idx, mods)
                          }
                          onKeyframeContextMenu={(idx, kf, x, y) =>
                            onKeyframeContextMenu(p.pairIndex, idx, kf, x, y)
                          }
                        />
                      )
                    })}
                  </div>
                  <TimelineLoopOverlay
                    loopRegion={m.loopRegion}
                    durationSeconds={totalDuration}
                    contentWidthPx={contentWidthPx}
                    loopEnabled={loopEnabled}
                  />
                  <TimelinePlayhead
                    engine={engine}
                    durationSeconds={totalDuration}
                    contentWidthPx={contentWidthPx}
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Only a real problem earns a strip here: decode failures. */}
          {decodeFailures.size > 0 && (
            <div className="flex items-center bg-[var(--color-bg-1)] px-3 py-1">
              <span className="text-[10px] uppercase tracking-[0.10em] text-[var(--color-mute)]">
                {decodeFailures.size} stem(s) failed to decode
              </span>
            </div>
          )}
        </section>

        <Inspector
          vm={inspectorVM}
          engine={engine}
          isPlaying={m.isPlaying}
          globallyMuted={m.wasGlobalMuted}
          onTogglePairEnabled={togglePairEnabled}
          onPairGain={setPairGain}
          onPairSpread={setPairSpread}
          onClearAutomation={clearPairAutomation}
          onKeyframeEdit={editKeyframe}
          onKeyframeDelete={deleteKeyframe}
          onSelectKeyframe={(pi, idx) =>
            setSelection({
              kind: 'keyframes',
              items: [{ pairIndex: pi, keyframeIndex: idx }],
            })
          }
          onBackToPair={(pi) => setSelection({ kind: 'pair', pairIndex: pi })}
          onDeleteSelectedKeyframes={deleteSelectedKeyframes}
        />
      </div>

      <MonitorSection
        engine={engine}
        isPlaying={m.isPlaying}
        durationSeconds={totalDuration}
        masterGain={m.masterGain}
        loopEnabled={loopEnabled}
        orderedTrackIds={orderedTrackIds}
        onPlay={() => engine.play()}
        onPause={() => engine.pause()}
        onStop={() => engine.stop()}
        onMasterGain={(g) => {
          pushHistory('master gain', 'slider-master')
          engine.setMasterGain(g)
        }}
        onToggleLoop={toggleLoopEnabled}
        globalMuted={m.wasGlobalMuted}
        onToggleMuteAll={() => {
          pushHistory('toggle mute all')
          engine.toggleMuteAll()
        }}
        height={MONITOR_PX}
      />

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenu.items}
          onClose={() => setContextMenu(null)}
        />
      )}

      {leavePromptOpen && (
        <LeaveMixerDialog
          onStay={() => resolveLeavePrompt(false)}
          onLeave={() => resolveLeavePrompt(true)}
        />
      )}
    </main>
  )
}

/**
 * "Leave the mixer?" confirmation, shown by the dirty-gated navigation
 * blocker. Leaving is SAFE (the resume cache keeps buffers + undo history
 * for an instant return), so the LEAVE button gets initial focus and Enter
 * activates it, Esc stays.
 *
 * Keyboard modality: a capture-phase window listener silences the mixer's
 * global shortcut listeners (space, F-keys, [ / ]) via
 * stopImmediatePropagation. Tab is trapped between the two buttons. any key
 * arriving while focus is OUTSIDE the dialog is defaulted-out and focus is
 * pulled back (stopImmediatePropagation alone doesn't stop default actions
 * like background button activation or slider stepping). The effect is
 * mount-only and reads handlers through refs. a dep on the (inline) onStay
 * prop would re-run it on every parent re-render and yank focus back to
 * LEAVE after the user Tabbed to STAY. Prior focus is restored on close.
 */
function LeaveMixerDialog({
  onStay,
  onLeave,
}: {
  onStay: () => void
  onLeave: () => void
}) {
  const stayRef = useRef<HTMLButtonElement | null>(null)
  const leaveRef = useRef<HTMLButtonElement | null>(null)
  // Which action is mid-blink. also gates re-entry so a key can't double-fire.
  const [pending, setPending] = useState<'stay' | 'leave' | null>(null)
  const pendingRef = useRef<'stay' | 'leave' | null>(null)
  pendingRef.current = pending
  const actionsRef = useRef({ onStay, onLeave })
  actionsRef.current = { onStay, onLeave }

  const commit = useCallback((which: 'stay' | 'leave') => {
    if (which === 'stay') actionsRef.current.onStay()
    else actionsRef.current.onLeave()
  }, [])

  // Keyboard path: blink the matching button for a beat so the key-press is
  // visible, then commit. (Clicks commit immediately, the cursor is already
  // feedback enough, and a blink would just feel laggy on a direct click.)
  const triggerFromKey = useCallback(
    (which: 'stay' | 'leave') => {
      if (pendingRef.current) return
      setPending(which)
      window.setTimeout(() => commit(which), 620)
    },
    [commit],
  )

  useEffect(() => {
    const prevFocus = document.activeElement
    leaveRef.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      e.stopImmediatePropagation()
      if (pendingRef.current) {
        e.preventDefault()
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        triggerFromKey('stay')
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        triggerFromKey('leave')
        return
      }
      if (e.key === 'Tab') {
        e.preventDefault()
        const next =
          document.activeElement === leaveRef.current
            ? stayRef.current
            : leaveRef.current
        next?.focus()
        return
      }
      const el = document.activeElement
      if (el !== stayRef.current && el !== leaveRef.current) {
        e.preventDefault()
        leaveRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => {
      window.removeEventListener('keydown', onKey, { capture: true })
      if (prevFocus instanceof HTMLElement) prevFocus.focus()
    }
  }, [triggerFromKey])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      role="presentation"
      onClick={() => commit('stay')}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="leave the mixer?"
        className="w-full max-w-md border-2 border-[var(--color-line-strong)] bg-[var(--color-bg)] p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="uppercase tracking-[0.16em] text-[var(--color-fg)]">
          leave the mixer?
        </p>
        <p className="mt-2 text-xs leading-relaxed text-[var(--color-fg-dim)]">
          your mix is saved in the url. this session resumes instantly from the
          home screen, undo history included, until you load a different file or
          close the tab.
        </p>
        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            ref={stayRef}
            type="button"
            onClick={() => commit('stay')}
            className={`inline-flex items-center gap-2 border-2 border-[var(--color-line-strong)] px-3 py-1.5 text-xs uppercase tracking-[0.12em] text-[var(--color-fg)] ${pending === 'stay' ? 'key-blink' : ''}`}
          >
            stay <KeyCap>esc</KeyCap>
          </button>
          <button
            ref={leaveRef}
            type="button"
            onClick={() => commit('leave')}
            className={`inline-flex items-center gap-2 border-2 border-[var(--color-active)] px-3 py-1.5 text-xs uppercase tracking-[0.12em] text-[var(--color-active)] hover:bg-[var(--color-active)] hover:text-[var(--color-bg)] ${pending === 'leave' ? 'key-blink' : ''}`}
          >
            leave <KeyCap>enter</KeyCap>
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * Top bar, single dense row (~40 px). The site-wide Header is suppressed on
 * /mix/* so we own the entire top strip here. App-mark on the left doubles
 * as the "back to start" affordance. Filename is the visual anchor. Three
 * actions on the right are icon-only with hover tooltips.
 */
function TopBar({
  file,
  awc,
  isEncrypted,
  fields,
  chips,
  onOpenSettings,
  onLoadMix,
  onSaveMix,
  onExportWav,
  onExportStems,
  exporting,
  exportingStems,
  height,
}: {
  file: File
  awc: AwcFile
  isEncrypted: boolean
  fields: ReadonlyArray<string>
  /** Compact always-visible facts (stems count, duration), details in (i). */
  chips: ReadonlyArray<string>
  onOpenSettings: () => void
  onLoadMix: () => void
  onSaveMix: () => void
  onExportWav: () => void
  onExportStems: () => void
  exporting: boolean
  exportingStems: boolean
  height: number
}): React.ReactNode {
  const [infoOpen, setInfoOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const exportPopRef = useRef<HTMLDivElement>(null)

  // Close export popover on outside click / Esc.
  useEffect(() => {
    if (!exportOpen) return
    const onDown = (e: MouseEvent): void => {
      if (!exportPopRef.current) return
      if (e.target instanceof Node && exportPopRef.current.contains(e.target)) {
        return
      }
      setExportOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setExportOpen(false)
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [exportOpen])
  return (
    <header
      className="relative flex items-center gap-3 border-b border-[var(--color-line)] bg-[var(--color-bg)] px-3"
      style={{ height: `${height}px` }}
    >
      <Link to="/" className="no-underline shrink-0" title="Back to drop zone">
        <span className="font-bold uppercase tracking-[0.14em] text-[11px] text-[var(--color-accent)]">
          {APP_NAME}
        </span>
      </Link>
      <h1 className="truncate text-[13px] font-normal uppercase tracking-[0.14em] text-[var(--color-fg)]">
        {file.name}
      </h1>
      {chips.map((c) => (
        <span
          key={c}
          className="shrink-0 bg-[var(--color-bg-2)] px-2 py-0.5 text-[10px] uppercase tracking-[0.10em] text-[var(--color-fg-dim)]"
        >
          {c}
        </span>
      ))}
      <button
        type="button"
        onClick={() => setInfoOpen(true)}
        aria-label="file info"
        title={`file info: ${fields.join(', ')}`}
        className="!px-1 !py-0.5 inline-flex items-center !border-0 !bg-transparent text-[var(--color-fg-dim)] hover:text-[var(--color-fg)] shrink-0"
      >
        <Info size={11} />
      </button>
      <AwcInfoModal
        open={infoOpen}
        onClose={() => setInfoOpen(false)}
        file={file}
        awc={awc}
        isEncrypted={isEncrypted}
      />
      <span className="ml-auto inline-flex items-center gap-0.5 shrink-0">
        <button
          type="button"
          onClick={onLoadMix}
          className="!px-1.5 !py-1 inline-flex items-center !border-0 !bg-transparent text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]"
          aria-label="load .mix preset"
          title="Load .mix preset"
        >
          <FolderOpen size={13} />
        </button>
        <button
          type="button"
          onClick={onSaveMix}
          className="!px-1.5 !py-1 inline-flex items-center !border-0 !bg-transparent text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]"
          aria-label="save .mix preset"
          title="FloppyDisk .mix preset"
        >
          <FloppyDisk size={13} />
        </button>
        <Link
          to="/"
          className="!px-1.5 !py-1 inline-flex items-center no-underline text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]"
          aria-label="open a different .awc"
          title="Open a different .awc"
        >
          <FilePlus size={13} />
        </Link>
        <div className="relative" ref={exportPopRef}>
          <button
            type="button"
            onClick={() => setExportOpen((v) => !v)}
            aria-expanded={exportOpen}
            aria-label="export"
            title="Export the current mix"
            className="!px-1.5 !py-1 inline-flex items-center !border-0 !bg-transparent text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]"
          >
            <DownloadSimple size={13} />
          </button>
          {exportOpen && (
            <div
              role="menu"
              className="absolute right-0 top-full z-40 mt-1 min-w-[13rem] border border-[var(--color-line-strong)] bg-[var(--color-bg-1)] py-1 shadow-lg"
            >
              <button
                type="button"
                role="menuitem"
                disabled={exporting}
                onClick={() => {
                  setExportOpen(false)
                  onExportWav()
                }}
                className="!border-0 !bg-transparent !rounded-none !px-2.5 !py-1 w-full text-left text-[11px] uppercase tracking-[0.10em] text-[var(--color-fg)] hover:bg-[var(--color-bg-2)]"
              >
                {exporting ? 'rendering…' : 'current mix as wav'}
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={exportingStems}
                onClick={() => {
                  setExportOpen(false)
                  onExportStems()
                }}
                className="!border-0 !bg-transparent !rounded-none !px-2.5 !py-1 w-full text-left text-[11px] uppercase tracking-[0.10em] text-[var(--color-fg)] hover:bg-[var(--color-bg-2)]"
              >
                {exportingStems ? 'zipping…' : 'all stems as zip'}
              </button>
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onOpenSettings}
          className="!px-1.5 !py-1 inline-flex items-center !border-0 !bg-transparent text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]"
          aria-label="settings"
          title="Settings"
        >
          <GearSix size={13} />
        </button>
      </span>
    </header>
  )
}

/**
 * Bottom transport bar, one dense strip pinned under the timeline, in the
 * order a mixer reads: transport → time → master level → output meter.
 * The AWC spec readout that used to sit in a second header strip lives in
 * the TopBar's (i) popover now. this bar is playback only.
 */
function MonitorSection({
  engine: _engine,
  isPlaying,
  durationSeconds,
  masterGain,
  loopEnabled,
  orderedTrackIds,
  onPlay,
  onPause,
  onStop,
  onMasterGain,
  onToggleLoop,
  globalMuted,
  onToggleMuteAll,
  height,
}: {
  engine: MixerEngine
  isPlaying: boolean
  durationSeconds: number
  masterGain: number
  loopEnabled: boolean
  orderedTrackIds: ReadonlyArray<string>
  onPlay: () => void
  onPause: () => void
  onStop: () => void
  onMasterGain: (g: number) => void
  onToggleLoop: () => void
  /** Panic-mute state (muteAll stashed the per-track mutes). */
  globalMuted: boolean
  onToggleMuteAll: () => void
  height: number
}): React.ReactNode {
  return (
    <section
      aria-label="transport"
      className="flex items-center gap-2 border-t-2 border-[var(--color-line-strong)] bg-[var(--color-bg-1)] px-3"
      style={{ height: `${height}px` }}
    >
      <button
        onClick={isPlaying ? onPause : onPlay}
        className="!border-[var(--color-active)] !bg-[var(--color-active)] !text-[var(--color-bg)] !px-2.5 !py-1 inline-flex items-center hover:opacity-90"
        aria-label={isPlaying ? 'pause' : 'play'}
        title="Play / pause (space)"
      >
        {isPlaying ? <Pause size={13} /> : <Play size={13} />}
      </button>
      <button
        onClick={onStop}
        className="!px-2 !py-1 inline-flex items-center"
        aria-label="stop"
        title="Stop (esc)"
      >
        <Square size={13} />
      </button>
      <button
        onClick={onToggleLoop}
        aria-pressed={loopEnabled}
        className={
          loopEnabled
            ? '!border-[var(--color-active)] !bg-[var(--color-active)] !text-[var(--color-bg)] !px-2 !py-1 inline-flex items-center hover:opacity-90'
            : '!px-2 !py-1 inline-flex items-center'
        }
        aria-label="toggle loop"
        title="Toggle loop region"
      >
        <Repeat size={13} />
      </button>
      <div className="ml-2 shrink-0 tabular-nums text-[12px] uppercase tracking-[0.10em] text-[var(--color-fg)]">
        <PlayheadReadout engine={_engine} />
        <span className="text-[var(--color-fg-mute)] mx-1">/</span>
        <span className="text-[var(--color-fg-dim)]">
          {fmtTimeReadout(durationSeconds)}
        </span>
      </div>

      <div className="ml-auto flex w-[340px] shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={onToggleMuteAll}
          aria-pressed={globalMuted}
          className={
            globalMuted
              ? '!border-[var(--color-mute)] !bg-[var(--color-mute)] !text-[var(--color-bg)] !px-2 !py-1 inline-flex items-center'
              : '!px-2 !py-1 inline-flex items-center text-[var(--color-fg-dim)]'
          }
          title={globalMuted ? 'Restore mute state (g)' : 'Mute all (g)'}
          aria-label={globalMuted ? 'restore mute state' : 'mute all'}
        >
          {globalMuted ? <SpeakerSlash size={13} /> : <SpeakerHigh size={13} />}
        </button>
        <span className="text-[10px] uppercase tracking-[0.14em] text-[var(--color-fg-mute)]">
          master
        </span>
        <input
          type="range"
          min={0}
          max={GAIN_MAX * 100}
          step={1}
          value={Math.round(masterGain * 100)}
          onChange={(e) => onMasterGain(parseFloat(e.target.value) / 100)}
          className="flex-1 min-w-0"
          aria-label="master gain"
        />
        <span className="w-14 text-right text-[10px] tabular-nums text-[var(--color-fg-dim)]">
          {gainToDb(masterGain)} db
        </span>
      </div>

      <div className="w-[220px] shrink-0">
        <MasterMeter
          engine={_engine}
          trackIds={orderedTrackIds}
          active={isPlaying}
        />
      </div>
    </section>
  )
}

/**
 * Self-subscribing playhead time readout. Subscribes directly to the
 * engine's RAF so the surrounding `MonitorSection` (transport buttons,
 * master meter, master gain slider) does NOT re-render every frame.
 *
 * Drops a re-render-per-tick cost from O(MonitorSection subtree) to
 * O(small text). The component re-renders ~60×/s while playing, but its
 * body is two tiny `<span>`s, fine.
 */
function PlayheadReadout({ engine }: { engine: MixerEngine }): React.ReactNode {
  const positionSeconds = usePlayheadPosition(engine)
  return (
    <span className="text-[var(--color-fg)]">
      {fmtTimeReadout(positionSeconds)}
    </span>
  )
}

/**
 * Pair list row with chevron for L/R expand and preview gesture. Double-click
 * toggles preview mode, click selects, the chevron toggles expand state.
 *
 * Collapsed layout: > | NN | [ON] | [meter, grows] | [level scrub, ~64 px].
 * Expanded layout adds a second strip with stereo-spread scrub and a keyframe
 * count + clear button.
 *
 * The level / spread scrubs read snapshot values and dispatch through engine
 * setters (which already coalesce history). Drag updates fire onChange each
 * pointermove tick. ScrubInput owns the pointer-lock smoothness so React
 * doesn't see per-tick state.
 */
function PairListRowImpl({
  pair,
  enabled,
  disabled,
  locked,
  selected,
  active,
  expanded,
  isPreview,
  dimmed,
  heightPx,
  engine,
  pairGain,
  pairSpread,
  keyframeCount,
  setRef,
  onSelect,
  onToggle,
  onToggleExpand,
  onPreviewToggle,
  onGain,
  onSpread,
  onClearAutomation,
}: {
  pair: PairVM
  enabled: boolean
  disabled: boolean
  /** True iff global mute is engaged. Locks ON/OFF + meter + interaction. */
  locked: boolean
  selected: boolean
  active: boolean
  expanded: boolean
  isPreview: boolean
  dimmed: boolean
  heightPx: number
  /** For the in-row live meter, direct DOM subscription via shared RAF. */
  engine: MixerEngine
  pairGain: number
  pairSpread: number
  keyframeCount: number
  setRef: (el: HTMLDivElement | null) => void
  onSelect: () => void
  onToggle: () => void
  onToggleExpand: () => void
  onPreviewToggle: () => void
  onGain: (g: number) => void
  onSpread: (s: number) => void
  onClearAutomation: () => void
}): React.ReactNode {
  // The level scrub is disabled when muted/off, matching the inspector's
  // intent: a muted pair has no audible level to control. The kf-range
  // piecewise model means a slider drag IS audible when the playhead is
  // outside the keyframe range, so we no longer disable the scrub when
  // keyframes exist.
  const scrubDisabled = disabled || locked || !enabled
  return (
    <div
      ref={setRef}
      tabIndex={locked ? -1 : 0}
      role="button"
      aria-pressed={selected}
      aria-disabled={locked}
      onFocus={locked ? undefined : onSelect}
      onClick={locked ? undefined : onSelect}
      onDoubleClick={(e) => {
        if (locked) return
        e.preventDefault()
        e.stopPropagation()
        onPreviewToggle()
      }}
      data-selected={selected}
      data-disabled={disabled}
      data-locked={locked}
      data-off={!enabled}
      data-dimmed={dimmed}
      data-preview={isPreview}
      style={{
        height: `${heightPx}px`,
        boxShadow: selected ? 'inset 4px 0 0 var(--color-active)' : undefined,
      }}
      className="relative flex flex-col outline-none border-b border-[var(--color-line)] cursor-pointer hover:bg-[var(--color-bg-1)]/60 data-[selected=true]:bg-[var(--color-bg-1)] data-[disabled=true]:opacity-40 data-[off=true]:opacity-70 data-[dimmed=true]:opacity-50 data-[locked=true]:opacity-40 data-[locked=true]:pointer-events-none data-[locked=true]:cursor-not-allowed"
    >
      <div
        className="flex items-center gap-1.5 px-2"
        style={{ height: `${PAIR_ROW_PX}px` }}
      >
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onToggleExpand()
          }}
          disabled={locked}
          className="!border-0 !bg-transparent !px-0.5 !py-0 inline-flex items-center text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]"
          aria-label={expanded ? 'collapse pair' : 'expand pair'}
          title={expanded ? 'collapse L/R' : 'expand L/R'}
        >
          {expanded ? <CaretDown size={11} /> : <CaretRight size={11} />}
        </button>
        <span className="w-5 text-[10px] tabular-nums uppercase tracking-[0.06em] text-[var(--color-fg-dim)] select-none">
          {String(pair.pairIndex).padStart(2, '0')}
        </span>
        {isPreview && (
          <span
            className="text-[9px] uppercase tracking-[0.12em] text-[var(--color-active)] border border-[var(--color-active)] !px-1 !py-0 select-none"
            title="Preview mode. double-click again or press Esc to exit"
          >
            ★
          </span>
        )}
        <button
          onClick={(e) => {
            e.stopPropagation()
            onToggle()
          }}
          disabled={disabled || locked}
          className={
            enabled
              ? '!border-[var(--color-active)] !bg-[var(--color-active)] !text-[var(--color-bg)] !px-1.5 !py-0 text-[10px] w-9 text-center'
              : 'border-[var(--color-line-strong)] text-[var(--color-fg-dim)] !px-1.5 !py-0 text-[10px] w-9 text-center'
          }
          aria-pressed={enabled}
          aria-label={`toggle pair ${pair.pairIndex}`}
          title={enabled ? 'mute this pair (m)' : 'unmute this pair (m)'}
        >
          {enabled ? 'on' : 'off'}
        </button>
        <PairListMeter
          engine={engine}
          leftId={enabled && !locked ? pair.leftTrackId : null}
          rightId={enabled && !locked ? pair.rightTrackId : null}
          active={active}
        />
        <div
          className="shrink-0"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          title={`pair level: ${gainToDb(pairGain)} dB, drag (shift = 10× or alt = 0.1×), click to type a linear gain (0–${GAIN_MAX})`}
        >
          <ScrubInput
            value={pairGain}
            onChange={onGain}
            min={0}
            max={GAIN_MAX}
            precision={2}
            sensitivity={0.005}
            label={`pair ${pair.pairIndex} level`}
            disabled={scrubDisabled}
          />
        </div>
      </div>
      {expanded && (
        // The strip lives in the fixed 232px pair column (PAIR_COL_PX), so
        // its content budget is tight: label(48) + %-readout(28) + optional
        // eraser(~30) + gaps/padding leaves the slider ≥ ~86px. The L/R hash
        // labels and a "no auto" placeholder used to live here too, ~280px
        // of fixed content that crushed the flex-1 slider to zero width
        // (a floating thumb with no track, and any click snapped spread to
        // 0). L/R identities live in the inspector for the selected pair,
        // clicking this row selects it. The slider keeps a REAL min-width as
        // insurance, never min-w-0 in this column.
        <div
          className="flex items-center gap-2 px-2 border-t border-[var(--color-line)]/60"
          style={{ height: `${PAIR_ROW_PX}px` }}
          onClick={(e) => e.stopPropagation()}
        >
          <span className="text-[9px] uppercase tracking-[0.12em] text-[var(--color-fg-mute)] select-none w-12 shrink-0">
            spread
          </span>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={Math.round(pairSpread * 100)}
            onChange={(e) => onSpread(parseFloat(e.target.value) / 100)}
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            disabled={scrubDisabled}
            className="flex-1 min-w-14"
            aria-label={`pair ${pair.pairIndex} stereo spread`}
            title="stereo spread (0 = mono center, 100 = hard L/R)"
          />
          <span className="w-7 text-right text-[9px] tabular-nums text-[var(--color-fg-dim)] shrink-0">
            {Math.round(pairSpread * 100)}%
          </span>
          {keyframeCount > 0 && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onClearAutomation()
              }}
              disabled={locked}
              className="!border-0 !bg-transparent !px-1 !py-0 inline-flex items-center gap-1 text-[9px] uppercase tracking-[0.06em] text-[var(--color-fg-mute)] hover:text-[var(--color-danger)] shrink-0"
              title={`clear ${keyframeCount} keyframe${keyframeCount === 1 ? '' : 's'}`}
              aria-label="clear all keyframes for this pair"
            >
              <Eraser size={10} />
              <span className="tabular-nums">{keyframeCount}</span>
            </button>
          )}
        </div>
      )}
    </div>
  )
}
/**
 * `MixerView` re-renders on every snapshot tick (mute toggle, gain change,
 * snapshot bookkeeping). Without `memo`, all 8+ list rows reconcile even
 * though none of their props changed, that compounded with the timeline
 * row reconciliation on the playhead path before this perf pass.
 */
const PairListRow = memo(PairListRowImpl)

/**
 * One row in the timeline body. When `expanded`, splits the waveform area
 * vertically into two stacked sub-rows for L and R channels. Keyframes
 * still draw on the parent row (not duplicated).
 */
function PairTimelineRowImpl({
  pair,
  enabled,
  locked,
  selected,
  expanded,
  dimmed,
  heightPx,
  totalDuration,
  keyframes,
  selectedKeyframeIndices,
  multiSelectedRefs,
  dragCoordinator,
  onSeek,
  onSelectPair,
  onKeyframeAdd,
  onKeyframeMove,
  onKeyframesMoveMany,
  onKeyframeClick,
  onKeyframeContextMenu,
}: {
  pair: PairVM
  enabled: boolean
  /** True iff global mute is engaged, row visually locked. */
  locked: boolean
  selected: boolean
  expanded: boolean
  dimmed: boolean
  heightPx: number
  totalDuration: number
  keyframes: ReadonlyArray<Keyframe>
  selectedKeyframeIndices: ReadonlyArray<number>
  /** Full multi-selection (across all pairs), forwarded to KeyframesLayer. */
  multiSelectedRefs: ReadonlyArray<MultiDragKeyframeRef> | null
  /** Multi-drag DOM coordinator shared across pairs. */
  dragCoordinator: MultiDragCoordinator | null
  onSeek: (t: number) => void
  onSelectPair: () => void
  onKeyframeAdd: (kf: Keyframe) => void
  onKeyframeMove: (idx: number, identity: Keyframe, newTime: number) => void
  /** Commit a group move, shift every ref by `deltaSeconds`. */
  onKeyframesMoveMany: (
    refs: ReadonlyArray<MultiDragKeyframeRef>,
    deltaSeconds: number,
  ) => void
  onKeyframeClick: (
    idx: number,
    kf: Keyframe,
    mods: KeyframeClickModifiers,
  ) => void
  onKeyframeContextMenu: (
    idx: number,
    kf: Keyframe,
    clientX: number,
    clientY: number,
  ) => void
}): React.ReactNode {
  const wfBuffer = pair.leftBuffer ?? pair.rightBuffer
  return (
    <div
      data-off={!enabled}
      data-selected={selected}
      data-dimmed={dimmed}
      data-locked={locked}
      onClick={locked ? undefined : onSelectPair}
      aria-disabled={locked}
      className="relative border-b border-[var(--color-line)] data-[off=true]:opacity-70 data-[selected=true]:bg-[var(--color-bg-1)]/40 data-[dimmed=true]:opacity-50 data-[locked=true]:opacity-40 data-[locked=true]:pointer-events-none"
      style={{ height: `${heightPx}px` }}
    >
      <div className="absolute inset-0 flex flex-col">
        {expanded ? (
          <>
            <div className="relative flex-1 min-h-0 border-b border-[var(--color-line)]/50">
              <ChannelTag>L</ChannelTag>
              {pair.leftBuffer ? (
                <StemWaveform
                  buffer={pair.leftBuffer}
                  muted={!enabled}
                  onSeek={onSeek}
                  totalDuration={totalDuration}
                  hideCursor
                  hideHoverTooltip
                />
              ) : (
                <span className="block py-1 pl-6 text-[10px] text-[var(--color-fg-mute)]">
                  failed
                </span>
              )}
            </div>
            <div className="relative flex-1 min-h-0">
              <ChannelTag>R</ChannelTag>
              {pair.rightBuffer ? (
                <StemWaveform
                  buffer={pair.rightBuffer}
                  muted={!enabled}
                  onSeek={onSeek}
                  totalDuration={totalDuration}
                  hideCursor
                  hideHoverTooltip
                />
              ) : (
                <span className="block py-1 pl-6 text-[10px] text-[var(--color-fg-mute)]">
                  failed
                </span>
              )}
            </div>
          </>
        ) : wfBuffer ? (
          <StemWaveform
            buffer={wfBuffer}
            muted={!enabled}
            onSeek={onSeek}
            totalDuration={totalDuration}
            hideCursor
            hideHoverTooltip
          />
        ) : (
          <span className="block py-1 px-2 text-[10px] text-[var(--color-fg-mute)]">
            failed
          </span>
        )}
      </div>
      <KeyframesLayer
        pairIndex={pair.pairIndex}
        keyframes={keyframes}
        durationSeconds={totalDuration}
        selectedIndices={selectedKeyframeIndices}
        multiSelectedRefs={multiSelectedRefs}
        coordinator={dragCoordinator}
        onKeyframeAdd={onKeyframeAdd}
        onKeyframeMove={onKeyframeMove}
        onKeyframesMoveMany={onKeyframesMoveMany}
        onKeyframeClick={onKeyframeClick}
        onKeyframeContextMenu={onKeyframeContextMenu}
      />
    </div>
  )
}

/**
 * Memoized so the timeline rows stop reconciling on every snapshot tick.
 * Combined with the `usePlayheadPositionEffect`-driven `TimelinePlayhead`
 * and the in-pair `KeyframesLayer.memo`, no per-pair reconciliation runs
 * during playback unless something specific to that pair actually changed
 * (keyframe edit, selection, gain).
 */
const PairTimelineRow = memo(PairTimelineRowImpl)
