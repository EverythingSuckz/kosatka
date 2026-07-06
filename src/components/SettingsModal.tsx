/**
 * Settings. a centered modal with a left tab rail and a right content pane
 * (the shape most desktop apps use). Mounted ONCE at the app root and driven
 * by the global settings-ui store, so it opens from any screen: the drop
 * page, the rpf explorer, and the editor all share it.
 *
 * Every control is wired to real behavior. presentation settings apply live
 * via the settings store, data actions hit IndexedDB directly. Closes on
 * backdrop click or Esc.
 */

import { useCallback, useEffect, useState } from 'react'
import {
  ArrowClockwise,
  Bug,
  Check,
  DeviceMobile,
  Faders,
  Gauge,
  GithubLogo,
  HardDrives,
  Info,
  Keyboard,
  Megaphone,
  Palette,
  SpeakerHigh,
  Trash,
  X,
} from '@phosphor-icons/react'

import {
  APP_AUTHOR,
  APP_NAME,
  APP_VERSION,
  ISSUES_URL,
  NEW_ISSUE_URL,
  REPO_URL,
} from '../app-meta'
import { clearPersistedAwcKey, clearPersistedDerivedKeys } from '../keys/store'
import { clearAllSessions } from '../persistence/sessions'
import { getStorageReport } from '../persistence/storage-report'
import { SHORTCUTS } from '../mixer/shortcuts'
import { ACCENT_PRESETS, setSettings } from '../settings/store'
import { useSettings } from '../settings/use-settings'
import { closeSettings, setSettingsTab, useSettingsUi } from '../settings/ui'
import type { StorageReport } from '../persistence/storage-report'
import type { SettingsTab } from '../settings/ui'

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

let deferredInstall: BeforeInstallPromptEvent | null = null
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault()
    deferredInstall = e as BeforeInstallPromptEvent
  })
}

const TABS: ReadonlyArray<{
  key: SettingsTab
  label: string
  icon: typeof Palette
}> = [
  { key: 'appearance', label: 'appearance', icon: Palette },
  { key: 'audio', label: 'audio', icon: SpeakerHigh },
  { key: 'data', label: 'data & keys', icon: HardDrives },
  { key: 'shortcuts', label: 'shortcuts', icon: Keyboard },
  { key: 'about', label: 'about', icon: Info },
]

export function SettingsModal(): React.ReactNode {
  const { open, tab } = useSettingsUi()

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        closeSettings()
      }
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [open])

  if (!open) return null
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
      role="presentation"
      onClick={closeSettings}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="settings"
        className="flex h-[560px] max-h-full w-full max-w-[760px] overflow-hidden border-2 border-[var(--color-line-strong)] bg-[var(--color-bg-1)]"
        onClick={(e) => e.stopPropagation()}
      >
        <nav
          aria-label="settings sections"
          className="flex w-[180px] shrink-0 flex-col border-r-2 border-[var(--color-line-strong)] bg-[var(--color-bg)] p-2"
        >
          <div className="px-2 py-2 text-[10px] uppercase tracking-[0.18em] text-[var(--color-fg-mute)]">
            settings
          </div>
          {TABS.map((t) => {
            const TabIcon = t.icon
            const active = tab === t.key
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => setSettingsTab(t.key)}
                aria-current={active}
                className={
                  active
                    ? '!border-0 !bg-[var(--color-bg-2)] !justify-start !px-2.5 !py-2 inline-flex items-center gap-2.5 text-[11px] text-[var(--color-fg)]'
                    : '!border-0 !bg-transparent !justify-start !px-2.5 !py-2 inline-flex items-center gap-2.5 text-[11px] text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]'
                }
              >
                <TabIcon
                  size={15}
                  weight={active ? 'fill' : 'regular'}
                  style={active ? { color: 'var(--color-accent)' } : undefined}
                />
                {t.label}
              </button>
            )
          })}
        </nav>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex shrink-0 items-center justify-between border-b border-[var(--color-line)] px-5 py-3">
            <h2 className="text-[12px] uppercase tracking-[0.16em] text-[var(--color-fg)]">
              {TABS.find((t) => t.key === tab)?.label}
            </h2>
            <button
              type="button"
              onClick={closeSettings}
              aria-label="close settings"
              className="!border-0 !bg-transparent !p-1 text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]"
            >
              <X size={16} />
            </button>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {tab === 'appearance' && <AppearanceTab />}
            {tab === 'audio' && <AudioTab />}
            {tab === 'data' && <DataTab />}
            {tab === 'shortcuts' && <ShortcutsTab />}
            {tab === 'about' && <AboutTab />}
          </div>
        </div>
      </div>
    </div>
  )
}

function Row({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}): React.ReactNode {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5">
      <div className="min-w-0">
        <div className="text-[12px] uppercase tracking-[0.08em] text-[var(--color-fg)]">
          {label}
        </div>
        {hint && (
          <div className="mt-0.5 text-[10px] leading-snug text-[var(--color-fg-mute)]">
            {hint}
          </div>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

function Toggle({
  on,
  onToggle,
  label,
}: {
  on: boolean
  onToggle: () => void
  label: string
}): React.ReactNode {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onToggle}
      className={
        on
          ? '!border-[var(--color-active)] !bg-[var(--color-active)] !text-[var(--color-bg)] !px-2.5 !py-1 text-[10px] w-14 text-center'
          : '!px-2.5 !py-1 text-[10px] w-14 text-center text-[var(--color-fg-dim)]'
      }
    >
      {on ? 'on' : 'off'}
    </button>
  )
}

function AppearanceTab(): React.ReactNode {
  const s = useSettings()
  return (
    <div className="flex flex-col gap-5">
      <div>
        <div className="mb-2 text-[12px] uppercase tracking-[0.08em] text-[var(--color-fg)]">
          accent
        </div>
        <div className="flex flex-wrap gap-2">
          {ACCENT_PRESETS.map((p) => (
            <button
              key={p.key}
              type="button"
              aria-label={p.label}
              aria-pressed={s.accent === p.key}
              title={p.label}
              onClick={() => setSettings({ accent: p.key })}
              className="relative h-8 w-8 !border-2 !p-0"
              style={{
                background: p.color,
                borderColor:
                  s.accent === p.key ? 'var(--color-fg)' : 'transparent',
              }}
            >
              {s.accent === p.key && (
                <Check
                  size={16}
                  weight="bold"
                  className="absolute inset-0 m-auto text-[var(--color-bg)]"
                />
              )}
            </button>
          ))}
        </div>
      </div>
      <Row label="reduce motion" hint="disable animations and transitions">
        <Toggle
          on={s.reduceMotion}
          onToggle={() => setSettings({ reduceMotion: !s.reduceMotion })}
          label="reduce motion"
        />
      </Row>
    </div>
  )
}

function AudioTab(): React.ReactNode {
  const s = useSettings()
  return (
    <div className="flex flex-col gap-2">
      <Row
        label="autoplay on load"
        hint="start playing once a mix finishes decoding. best-effort, since the browser may keep it paused until you interact with the page"
      >
        <Toggle
          on={s.autoplayOnLoad}
          onToggle={() => setSettings({ autoplayOnLoad: !s.autoplayOnLoad })}
          label="autoplay on load"
        />
      </Row>
      <Row label="default master" hint="master level a new mix opens at">
        <div className="flex items-center gap-2">
          <Gauge size={14} className="text-[var(--color-fg-mute)]" />
          <input
            type="range"
            min={0}
            max={150}
            step={1}
            value={s.defaultMasterPct}
            onChange={(e) =>
              setSettings({ defaultMasterPct: parseInt(e.target.value, 10) })
            }
            aria-label="default master level"
            className="w-32"
          />
          <span className="w-8 text-right text-[10px] tabular-nums text-[var(--color-fg-dim)]">
            {s.defaultMasterPct}%
          </span>
        </div>
      </Row>
    </div>
  )
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function DataTab(): React.ReactNode {
  const [report, setReport] = useState<StorageReport | null>(null)
  const [sessionsCleared, setSessionsCleared] = useState(false)
  const [keyCleared, setKeyCleared] = useState(false)

  const refresh = useCallback(async () => {
    setReport(await getStorageReport())
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const onClearSessions = useCallback(async () => {
    try {
      await clearAllSessions()
      setSessionsCleared(true)
    } catch {
      /* best-effort */
    }
    setTimeout(() => void refresh(), 300)
  }, [refresh])

  const onForgetKey = useCallback(async () => {
    try {
      await clearPersistedAwcKey()
      await clearPersistedDerivedKeys()
      setKeyCleared(true)
    } catch {
      /* best-effort */
    }
    setTimeout(() => void refresh(), 300)
  }, [refresh])

  const sessionLabel = report
    ? `${report.sessionCount} saved, ${mb(report.sessionBytes)}`
    : '…'
  const originLabel = report
    ? report.originBytes === null
      ? 'unavailable'
      : mb(report.originBytes)
    : '…'

  return (
    <div className="flex flex-col gap-2">
      <Row
        label="saved mixes"
        hint="dropped files kept for quick re-open (this is what clearing frees)"
      >
        <span className="text-[11px] tabular-nums text-[var(--color-fg-dim)]">
          {sessionLabel}
        </span>
      </Row>
      <Row
        label="browser total"
        hint="all storage the browser attributes to this origin, including its own module and http caches. clearing your mixes will not shrink this part."
      >
        <span className="text-[11px] tabular-nums text-[var(--color-fg-mute)]">
          {originLabel}
        </span>
      </Row>
      <Row label="clear saved mixes" hint="removes the recent-file list">
        <button
          type="button"
          onClick={() => void onClearSessions()}
          disabled={sessionsCleared}
          className="!px-2 !py-1 inline-flex items-center gap-1.5 text-[10px] text-[var(--color-fg-dim)]"
        >
          {sessionsCleared ? (
            <>
              <Check size={12} weight="bold" /> cleared
            </>
          ) : (
            <>
              <Trash size={12} /> clear
            </>
          )}
        </button>
      </Row>
      <Row
        label="decryption key"
        hint={
          report?.hasKeys
            ? 'stored. re-derive from your game exe on the next drop'
            : 'not stored yet'
        }
      >
        <button
          type="button"
          onClick={() => void onForgetKey()}
          disabled={keyCleared || !report?.hasKeys}
          className="!px-2 !py-1 inline-flex items-center gap-1.5 text-[10px] text-[var(--color-fg-dim)]"
        >
          {keyCleared ? (
            <>
              <Check size={12} weight="bold" /> forgotten
            </>
          ) : (
            <>
              <ArrowClockwise size={12} /> forget
            </>
          )}
        </button>
      </Row>
    </div>
  )
}

function ShortcutsTab(): React.ReactNode {
  return (
    <dl className="grid grid-cols-[minmax(0,auto)_1fr] gap-x-4 gap-y-2 text-[11px]">
      {SHORTCUTS.map((sc) => (
        <div key={sc.keys} className="contents">
          <dt className="whitespace-nowrap">
            <kbd className="border border-[var(--color-line-strong)] bg-[var(--color-bg-2)] px-1.5 py-0.5 text-[10px]">
              {sc.keys}
            </kbd>
          </dt>
          <dd className="self-center uppercase tracking-[0.06em] text-[var(--color-fg-dim)]">
            {sc.description}
          </dd>
        </div>
      ))}
    </dl>
  )
}

function AboutTab(): React.ReactNode {
  const [installable, setInstallable] = useState(deferredInstall !== null)
  const [installed, setInstalled] = useState(false)

  // The install prompt can arrive after this tab mounts, so poll briefly so
  // the button enables itself once the browser offers it.
  useEffect(() => {
    if (installable) return
    const id = window.setInterval(() => {
      if (deferredInstall !== null) {
        setInstallable(true)
        window.clearInterval(id)
      }
    }, 500)
    return () => window.clearInterval(id)
  }, [installable])

  const onInstall = useCallback(async () => {
    if (!deferredInstall) return
    await deferredInstall.prompt()
    const choice = await deferredInstall.userChoice
    if (choice.outcome === 'accepted') setInstalled(true)
    deferredInstall = null
    setInstallable(false)
  }, [])

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-4">
        <div
          aria-hidden
          className="grid h-14 w-14 shrink-0 place-items-center border-2 border-[var(--color-accent)] bg-[var(--color-bg)]"
        >
          <Faders
            size={26}
            weight="fill"
            className="text-[var(--color-accent)]"
          />
        </div>
        <div className="min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-[15px] uppercase tracking-[0.12em] text-[var(--color-fg)]">
              {APP_NAME}
            </span>
            <span className="shrink-0 text-[10px] tabular-nums text-[var(--color-fg-mute)]">
              v{APP_VERSION}
            </span>
          </div>
          <div className="mt-0.5 text-[11px] text-[var(--color-fg-dim)]">
            by {APP_AUTHOR}
          </div>
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer noopener"
            className="mt-2 inline-flex w-fit items-center gap-1.5 border-2 border-[var(--color-line-strong)] !px-2.5 !py-1 text-[10px] uppercase tracking-[0.1em] text-[var(--color-fg-dim)] no-underline hover:border-[var(--color-fg)] hover:text-[var(--color-fg)]"
          >
            <GithubLogo size={13} weight="fill" /> source
          </a>
        </div>
      </div>

      <Row label="offline" hint="works with no network once installed / cached">
        <span className="text-[11px] uppercase tracking-[0.1em] text-[var(--color-active)]">
          supported
        </span>
      </Row>

      <div className="flex flex-col gap-2">
        <button
          type="button"
          onClick={() => void onInstall()}
          disabled={!installable || installed}
          title={
            installable
              ? 'install as an app'
              : 'available in the deployed build (no service worker in dev)'
          }
          className="inline-flex items-center justify-center gap-2 !py-2 text-[11px] uppercase tracking-[0.1em]"
        >
          <DeviceMobile size={14} weight="regular" />
          {installed
            ? 'installed'
            : installable
              ? 'install app'
              : 'install unavailable here'}
        </button>
        <div className="flex gap-2">
          <a
            href={NEW_ISSUE_URL}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex flex-1 items-center justify-center gap-2 border-2 border-[var(--color-line-strong)] !py-2 text-[11px] uppercase tracking-[0.1em] text-[var(--color-fg-dim)] no-underline hover:border-[var(--color-fg)] hover:text-[var(--color-fg)]"
          >
            <Megaphone size={14} /> send feedback
          </a>
          <a
            href={ISSUES_URL}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex flex-1 items-center justify-center gap-2 border-2 border-[var(--color-line-strong)] !py-2 text-[11px] uppercase tracking-[0.1em] text-[var(--color-fg-dim)] no-underline hover:border-[var(--color-fg)] hover:text-[var(--color-fg)]"
          >
            <Bug size={14} /> report issue
          </a>
        </div>
      </div>

      <p className="text-[10px] leading-relaxed text-[var(--color-fg-mute)]">
        Everything is processed locally. Your audio and keys never leave this
        device.
      </p>
    </div>
  )
}
