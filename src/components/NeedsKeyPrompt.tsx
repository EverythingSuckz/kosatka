/**
 * Production key-derivation prompt. Shown when an encrypted AWC is dropped
 * but no AWC key is available locally. Asks the user to drop their
 * `gta5_enhanced.exe` once. we hash-search the AES key, decrypt + inflate
 * our shipped `magic.dat`, slice off the AWC key, and persist to IndexedDB.
 * After this completes the key is cached for every future session.
 *
 * Two surfaces:
 *   - {@link NeedsKeyPrompt}: full-page variant with a top-level heading and
 *     `<main>` wrapper. Used by the mix route's fallback (IDB-reload path).
 *   - {@link NeedsKeyPromptBody}: wrapper-less variant intended to be
 *     embedded inside another container (e.g. the drop zone box on the
 *     index route). No heading, no `<main>`. the parent decides framing.
 */

import { useCallback, useState } from 'react'
import { Fingerprint } from '@phosphor-icons/react'

import { deriveKeys } from '../keys/derive'
import { setDerivedKeys } from '../keys'
import { CopyButton } from './CopyButton'
import type { DeriveStage } from '../keys/derive'

interface Props {
  onReady: () => void
}

/** Full-page key prompt used by the mix route's IDB-reload fallback. */
export function NeedsKeyPrompt({ onReady }: Props): React.ReactNode {
  return (
    <main className="mx-auto flex min-h-[calc(100vh-2.5rem)] w-full max-w-[720px] flex-col justify-center px-4 py-10">
      <NeedsKeyPromptBody onReady={onReady} />
    </main>
  )
}

/**
 * Wrapper-less key prompt. Renders just the drop zone + progress / error
 * surfaces, with no outer `<main>` or heading. The caller is expected to
 * provide its own framing (the index route puts this inside its bordered
 * drop-zone box).
 */
export function NeedsKeyPromptBody({ onReady }: Props): React.ReactNode {
  const [dragOver, setDragOver] = useState(false)
  const [stage, setStage] = useState<DeriveStage | 'idle' | 'storing'>('idle')
  const [progress, setProgress] = useState(0)
  const [sampleHex, setSampleHex] = useState('')
  const [error, setError] = useState<string | null>(null)

  const handleFile = useCallback(
    async (file: File) => {
      setError(null)
      try {
        const exeBytes = new Uint8Array(await file.arrayBuffer())
        const keys = await deriveKeys(exeBytes, {
          onProgress: (s, p, hex) => {
            setStage(s)
            setProgress(p)
            if (hex !== undefined) setSampleHex(hex)
          },
        })
        setStage('storing')
        await setDerivedKeys(keys)
        onReady()
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        setStage('idle')
      }
    },
    [onReady],
  )

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>): void => {
      e.preventDefault()
      setDragOver(false)
      const file = e.dataTransfer.files[0]
      if (file) void handleFile(file)
    },
    [handleFile],
  )

  const stageLabel = (): string => {
    switch (stage) {
      case 'aes-search':
        return 'searching exe for AES key'
      case 'decrypt':
        return 'decrypting magic blob'
      case 'inflate':
        return 'inflating'
      case 'storing':
        return 'persisting to indexeddb'
      default:
        return 'idle'
    }
  }

  const busy = stage !== 'idle'
  const pct = Math.round(progress * 100)

  return (
    <div className="w-full">
      <div className="mb-4">
        <h2 className="flex items-center gap-2 text-sm uppercase tracking-[0.16em] text-[var(--color-fg)]">
          <Fingerprint
            size={18}
            weight="fill"
            className="text-[var(--color-accent)]"
          />
          decryption key required
        </h2>
        <p className="mt-2 max-w-xl text-xs leading-relaxed text-[var(--color-fg-dim)]">
          This content is encrypted. Provide your <code>gta5_enhanced.exe</code>{' '}
          (or <code>gta5.exe</code> for legacy editions) to confirm you own the
          game. The decryption key is derived from it locally and never leaves
          your device. You only do this once.
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
        onDrop={onDrop}
        className={`flex min-h-[160px] flex-col items-center justify-center gap-2 border-2 ${
          dragOver
            ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/5'
            : 'border-[var(--color-line-strong)] bg-[var(--color-bg)]'
        } px-6 py-8 transition-colors ${busy ? 'pointer-events-none opacity-60' : 'cursor-pointer'}`}
        onClick={() => {
          if (busy) return
          const input = document.createElement('input')
          input.type = 'file'
          input.accept = '.exe'
          input.onchange = (): void => {
            const f = input.files?.[0]
            if (f) void handleFile(f)
          }
          input.click()
        }}
      >
        <span className="uppercase tracking-[0.16em] text-[var(--color-accent)]">
          {dragOver ? 'release to load' : 'drop gta5_enhanced.exe'}
        </span>
        <span className="text-[var(--color-fg-mute)] text-xs uppercase tracking-[0.16em]">
          or click to browse
        </span>
      </div>

      {busy && (
        <div className="mt-4 flex flex-col items-stretch gap-2">
          <div className="flex items-baseline justify-between text-[10px] uppercase tracking-[0.16em]">
            <span className="text-[var(--color-fg-dim)]">{stageLabel()}</span>
            <span className="tabular-nums text-[var(--color-fg-mute)]">
              {stage === 'aes-search' ? `${pct}%` : ''}
            </span>
          </div>
          {/* Live scan: the current 12-byte candidate window being hashed and
              compared. These are real bytes at the current file offset. */}
          {stage === 'aes-search' && (
            <div className="border-2 border-[var(--color-line-strong)] bg-[var(--color-bg)] px-3 py-2">
              <div className="text-[9px] uppercase tracking-[0.16em] text-[var(--color-fg-mute)]">
                testing candidate window
              </div>
              <div className="mt-1 font-mono text-[12px] tracking-[0.12em] text-[var(--color-accent)]">
                {sampleHex || '…'}
              </div>
            </div>
          )}
          <div className="h-0.5 w-full overflow-hidden bg-[var(--color-bg-2)]">
            <div
              className={`h-full bg-[var(--color-accent)] transition-[width] duration-200 ${
                stage === 'aes-search' ? '' : 'loading-indeterminate w-1/3'
              }`}
              style={stage === 'aes-search' ? { width: `${pct}%` } : undefined}
            />
          </div>
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="mt-4 border-2 border-[var(--color-danger)]"
        >
          <div className="flex items-center justify-between border-b border-[var(--color-danger)]/40 px-3 py-1.5">
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
  )
}
