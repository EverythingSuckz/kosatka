/**
 * App settings, a tiny persisted preferences store. Framework-agnostic via
 * useSyncExternalStore, persisted to localStorage under one key. Presentation
 * settings (accent, reduced motion) apply to the document root on module load
 * and on every change, so every screen reflects them without prop-drilling.
 */

const STORAGE_KEY = 'awc-mixer-settings'

export interface AccentPreset {
  key: string
  label: string
  /** Drives both --color-accent and --color-active. */
  color: string
}

/** Danger/mute reds are intentionally NOT offered. They stay semantic. */
export const ACCENT_PRESETS: ReadonlyArray<AccentPreset> = [
  { key: 'tangerine', label: 'tangerine', color: '#ff9500' },
  { key: 'amber', label: 'amber', color: '#ffb000' },
  { key: 'lime', label: 'lime', color: '#a3e635' },
  { key: 'cyan', label: 'cyan', color: '#22d3ee' },
  { key: 'violet', label: 'violet', color: '#a78bfa' },
  { key: 'pink', label: 'pink', color: '#f472b6' },
]

export interface Settings {
  /** Accent preset key (see ACCENT_PRESETS). */
  accent: string
  /** Force-disable animations/transitions app-wide. */
  reduceMotion: boolean
  /** Start playback automatically once a mix finishes decoding. */
  autoplayOnLoad: boolean
  /** Master gain a freshly-loaded mix starts at, as a percentage (0..150). */
  defaultMasterPct: number
}

const DEFAULTS: Settings = {
  accent: 'tangerine',
  reduceMotion: false,
  autoplayOnLoad: false,
  defaultMasterPct: 100,
}

function load(): Settings {
  if (typeof localStorage === 'undefined') return { ...DEFAULTS }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULTS }
    const parsed = JSON.parse(raw) as Partial<Settings>
    return {
      accent:
        typeof parsed.accent === 'string' &&
        ACCENT_PRESETS.some((p) => p.key === parsed.accent)
          ? parsed.accent
          : DEFAULTS.accent,
      reduceMotion:
        typeof parsed.reduceMotion === 'boolean'
          ? parsed.reduceMotion
          : DEFAULTS.reduceMotion,
      autoplayOnLoad:
        typeof parsed.autoplayOnLoad === 'boolean'
          ? parsed.autoplayOnLoad
          : DEFAULTS.autoplayOnLoad,
      defaultMasterPct:
        typeof parsed.defaultMasterPct === 'number' &&
        parsed.defaultMasterPct >= 0 &&
        parsed.defaultMasterPct <= 150
          ? parsed.defaultMasterPct
          : DEFAULTS.defaultMasterPct,
    }
  } catch {
    return { ...DEFAULTS }
  }
}

let current: Settings = load()
const listeners = new Set<() => void>()

/** Apply presentation settings to the document root. No-op without a DOM. */
function applyToDom(s: Settings): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  const preset =
    ACCENT_PRESETS.find((p) => p.key === s.accent) ?? ACCENT_PRESETS[0]!
  root.style.setProperty('--color-accent', preset.color)
  root.style.setProperty('--color-active', preset.color)
  if (s.reduceMotion) root.setAttribute('data-reduce-motion', 'on')
  else root.removeAttribute('data-reduce-motion')
}

// Apply persisted settings as early as the module is imported (before first
// paint on the client) so there's no accent flash.
applyToDom(current)

export function getSettings(): Settings {
  return current
}

export function setSettings(patch: Partial<Settings>): void {
  current = { ...current, ...patch }
  applyToDom(current)
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current))
  } catch {
    // Storage unavailable (private mode / quota). Settings stay in-memory
    // for the session, not worth failing over.
  }
  for (const fn of listeners) fn()
}

export function subscribeSettings(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}
