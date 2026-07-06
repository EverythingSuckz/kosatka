/**
 * AWC info dump. a centered modal (same shell language as Settings) that
 * shows everything the parser knows about the loaded archive: the file/header
 * summary plus a per-stream table. The metadata can be downloaded as plain
 * text or JSON so it can be dropped straight into a bug report.
 *
 * Opened from the (i) button in the editor's top bar. Closes on backdrop click
 * or Esc.
 */

import { useCallback, useEffect, useMemo } from 'react'
import { DownloadSimple, X } from '@phosphor-icons/react'

import { downloadBlob } from '../mixer/export'
import type { AwcFile } from '../awc/types'

interface StreamMeta {
  index: number
  hashHex: string
  codec: string
  codecId: number
  sampleRate: number
  sampleCount: number
  durationSeconds: number
  layout: 'mono' | 'mc-channel'
  encrypted: boolean
  blocks: number | null
}

interface AwcMeta {
  file: { name: string; sizeBytes: number }
  format: {
    endianness: string
    version: number
    encrypted: boolean
    multiChannel: boolean
    streamCount: number
    sampleRate: number | null
    durationSeconds: number
    codecBreakdown: string
  }
  streams: Array<StreamMeta>
}

function buildAwcMeta(file: File, awc: AwcFile, encrypted: boolean): AwcMeta {
  const counts = new Map<string, number>()
  for (const s of awc.streams) {
    const k = s.codec.toUpperCase()
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  const dur = awc.streams.reduce((m, s) => Math.max(m, s.durationSeconds), 0)
  const streams: Array<StreamMeta> = awc.streams.map((s, i) => ({
    index: i,
    hashHex: s.hashHex,
    codec: s.codec,
    codecId: s.codecId,
    sampleRate: s.sampleRate,
    sampleCount: s.sampleCount,
    durationSeconds: s.durationSeconds,
    layout: s.layout.kind,
    encrypted:
      s.layout.kind === 'mc-channel'
        ? s.layout.source.encrypted
        : s.layout.encrypted,
    blocks: s.layout.kind === 'mc-channel' ? s.layout.source.blockCount : null,
  }))
  return {
    file: { name: file.name, sizeBytes: file.size },
    format: {
      endianness: awc.header.endianness,
      version: awc.header.version,
      encrypted,
      multiChannel: awc.header.flagBits.multiChannel,
      streamCount: awc.streams.length,
      sampleRate: awc.streams[0]?.sampleRate ?? null,
      durationSeconds: dur,
      codecBreakdown: [...counts].map(([k, v]) => `${v} × ${k}`).join(' + '),
    },
    streams,
  }
}

function fmtDur(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '-'
  const min = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${min}:${String(sec).padStart(2, '0')}`
}

function metaToText(m: AwcMeta): string {
  const lines: Array<string> = []
  lines.push(`file: ${m.file.name}`)
  lines.push(`size: ${(m.file.sizeBytes / 1024 / 1024).toFixed(2)} MiB`)
  lines.push(`endianness: ${m.format.endianness}`)
  lines.push(`version: ${m.format.version}`)
  lines.push(`encrypted: ${m.format.encrypted ? 'yes' : 'no'}`)
  lines.push(`multi-channel: ${m.format.multiChannel ? 'yes' : 'no'}`)
  lines.push(`stems: ${m.format.streamCount}`)
  if (m.format.sampleRate)
    lines.push(`sample rate: ${(m.format.sampleRate / 1000).toFixed(1)} kHz`)
  lines.push(`duration: ${fmtDur(m.format.durationSeconds)}`)
  lines.push(`codecs: ${m.format.codecBreakdown || 'unknown'}`)
  lines.push('')
  lines.push('streams:')
  lines.push('  #   hash      codec  rate    dur    layout      blocks  enc')
  for (const s of m.streams) {
    lines.push(
      [
        String(s.index).padStart(3),
        s.hashHex.padEnd(8),
        s.codec.padEnd(5),
        `${(s.sampleRate / 1000).toFixed(1)}k`.padEnd(6),
        fmtDur(s.durationSeconds).padEnd(5),
        s.layout.padEnd(10),
        (s.blocks !== null ? String(s.blocks) : '-').padEnd(6),
        s.encrypted ? 'yes' : 'no',
      ].join('  '),
    )
  }
  return lines.join('\n')
}

export function AwcInfoModal({
  open,
  onClose,
  file,
  awc,
  isEncrypted,
}: {
  open: boolean
  onClose: () => void
  file: File
  awc: AwcFile
  isEncrypted: boolean
}): React.ReactNode {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [open, onClose])

  const meta = useMemo(
    () => buildAwcMeta(file, awc, isEncrypted),
    [file, awc, isEncrypted],
  )
  const baseName = useMemo(
    () => file.name.replace(/\.awc$/i, '') || 'awc',
    [file.name],
  )

  const onDownloadText = useCallback(() => {
    const blob = new Blob([metaToText(meta)], {
      type: 'text/plain;charset=utf-8',
    })
    downloadBlob(blob, `${baseName}.info.txt`)
  }, [meta, baseName])

  const onDownloadJson = useCallback(() => {
    const blob = new Blob([JSON.stringify(meta, null, 2)], {
      type: 'application/json',
    })
    downloadBlob(blob, `${baseName}.info.json`)
  }, [meta, baseName])

  if (!open) return null

  const summary: Array<[string, string]> = [
    ['file', meta.file.name],
    ['size', `${(meta.file.sizeBytes / 1024 / 1024).toFixed(2)} MiB`],
    ['endianness', meta.format.endianness],
    ['version', String(meta.format.version)],
    ['encrypted', meta.format.encrypted ? 'yes' : 'no'],
    ['multi-channel', meta.format.multiChannel ? 'yes' : 'no'],
    ['stems', String(meta.format.streamCount)],
    [
      'sample rate',
      meta.format.sampleRate
        ? `${(meta.format.sampleRate / 1000).toFixed(1)} kHz`
        : '-',
    ],
    ['duration', fmtDur(meta.format.durationSeconds)],
    ['codecs', meta.format.codecBreakdown || 'unknown'],
  ]

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
      role="presentation"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="awc file info"
        className="flex max-h-[85vh] w-full max-w-[720px] flex-col overflow-hidden border-2 border-[var(--color-line-strong)] bg-[var(--color-bg-1)]"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex shrink-0 items-center justify-between border-b border-[var(--color-line)] px-5 py-3">
          <h2 className="truncate text-[12px] uppercase tracking-[0.16em] text-[var(--color-fg)]">
            file info
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="close file info"
            className="!border-0 !bg-transparent !p-1 text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]"
          >
            <X size={16} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <dl className="grid grid-cols-[minmax(0,120px)_1fr] gap-x-4 gap-y-1.5 text-[11px]">
            {summary.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="uppercase tracking-[0.1em] text-[var(--color-fg-mute)]">
                  {k}
                </dt>
                <dd className="break-all text-[var(--color-fg)]">{v}</dd>
              </div>
            ))}
          </dl>

          <div className="mt-5 mb-2 text-[10px] uppercase tracking-[0.16em] text-[var(--color-fg-mute)]">
            streams
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[10px] tabular-nums">
              <thead>
                <tr className="text-left uppercase tracking-[0.08em] text-[var(--color-fg-mute)]">
                  <th className="py-1 pr-3 font-normal">#</th>
                  <th className="py-1 pr-3 font-normal">hash</th>
                  <th className="py-1 pr-3 font-normal">codec</th>
                  <th className="py-1 pr-3 font-normal">rate</th>
                  <th className="py-1 pr-3 font-normal">dur</th>
                  <th className="py-1 pr-3 font-normal">layout</th>
                  <th className="py-1 pr-3 font-normal">blocks</th>
                  <th className="py-1 font-normal">enc</th>
                </tr>
              </thead>
              <tbody>
                {meta.streams.map((s) => (
                  <tr
                    key={s.index}
                    className="border-t border-[var(--color-line)] text-[var(--color-fg-dim)]"
                  >
                    <td className="py-1 pr-3 text-[var(--color-fg)]">
                      {s.index}
                    </td>
                    <td className="py-1 pr-3">{s.hashHex}</td>
                    <td className="py-1 pr-3 uppercase">{s.codec}</td>
                    <td className="py-1 pr-3">
                      {(s.sampleRate / 1000).toFixed(1)}k
                    </td>
                    <td className="py-1 pr-3">{fmtDur(s.durationSeconds)}</td>
                    <td className="py-1 pr-3">{s.layout}</td>
                    <td className="py-1 pr-3">
                      {s.blocks !== null ? s.blocks : '-'}
                    </td>
                    <td className="py-1">
                      {s.encrypted ? (
                        <span className="text-[var(--color-accent)]">yes</span>
                      ) : (
                        'no'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-[var(--color-line)] px-5 py-3">
          <button
            type="button"
            onClick={onDownloadText}
            className="!px-3 !py-1.5 inline-flex items-center gap-2 text-[11px] uppercase tracking-[0.1em] text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]"
          >
            <DownloadSimple size={13} /> .txt
          </button>
          <button
            type="button"
            onClick={onDownloadJson}
            className="!px-3 !py-1.5 inline-flex items-center gap-2 text-[11px] uppercase tracking-[0.1em] text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]"
          >
            <DownloadSimple size={13} /> .json
          </button>
        </footer>
      </div>
    </div>
  )
}
