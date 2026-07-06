/**
 * `.mix` preset file, the shareable artifact for a mix.
 *
 * URL-hash state is great for personal bookmarks and A/B comparison but loses
 * its payload the moment you close the tab or share via a channel that mangles
 * `#fragment`. The `.mix` file is the durable counterpart. Hand a friend the
 * original `.awc` and a `.mix` file and they see your exact mix.
 *
 * The on-disk shape is JSON so it's human-inspectable. The `state` block is
 * the same shape used by the URL hash (`HashMixState` in `./hash-state.ts`)
 * so there is exactly one canonical payload format across the app. Versioned
 * so we can evolve later. The `awc` block is a sanity hint the loader uses to
 * detect "loaded the wrong file" situations and warn before applying.
 *
 * All parsing here is pure (no DOM side effects). The download helper is
 * separate so tests can serialize without touching `document`.
 */

import { downloadBlob } from './export'
import { normalizeKeyframes } from './types'
import type { HashMixState } from './hash-state'
import type { MixerEngine } from './engine'
import type { Keyframe, KeyframeEasing } from './types'

/** App version baked into saved `.mix` files. Bump when the format changes. */
export const MIX_FILE_APP_VERSION = '0.1.0'

/** Magic value identifying our format. Files missing this are rejected. */
export const MIX_FILE_FORMAT = 'awc-mix' as const

/**
 * Highest version we know how to read.
 *
 * Version history:
 *   v1: initial format. keyframe `g` values were envelope MULTIPLIERS
 *       (nodeGain = pairSlider × envelope).
 *   v2: keyframe `g` values are ABSOLUTE gain (nodeGain = envelope, pair
 *       slider ignored on automated pairs). the on-disk shape is unchanged
 *       from v1, only the meaning of automation values flipped.
 *
 * ALL v1 files are REJECTED on load with a clear error pointing at the
 * semantic change, even keyframe-free ones. The `.mix` file is the durable
 * shareable artifact, so we refuse to silently reinterpret a saved mix under
 * new automation semantics rather than guess. (The URL-hash layer in
 * `./hash-state.ts` is deliberately more lenient, accepting a v1 hash and
 * only warning, because hash links are ephemeral personal bookmarks where an
 * unchanged envelope-multiplier is usually 100% anyway.) Manual conversion is
 * documented but intentionally not auto-applied.
 */
export const MIX_FILE_VERSION = 2 as const

export interface MixFileAwcMeta {
  /** Original AWC filename at save time (e.g. `hei4_fin_track_a03.awc`). */
  name: string
  /** Original AWC byte size at save time. */
  size: number
  /** Number of audio streams the AWC had. */
  streamCount: number
  /** Sample rate (Hz) of the source AWC. */
  sampleRate: number
}

export interface MixFile {
  format: typeof MIX_FILE_FORMAT
  version: typeof MIX_FILE_VERSION
  awc: MixFileAwcMeta
  state: HashMixState
  /** ISO-8601 timestamp set at save time. */
  savedAt: string
  /** App version baked at save time, diagnostic only. */
  appVersion: string
}

export interface BuildMixFileOpts {
  awcName: string
  awcSize: number
  streamCount: number
  sampleRate: number
  state: HashMixState
}

export function buildMixFile(opts: BuildMixFileOpts): MixFile {
  return {
    format: MIX_FILE_FORMAT,
    version: MIX_FILE_VERSION,
    awc: {
      name: opts.awcName,
      size: opts.awcSize,
      streamCount: opts.streamCount,
      sampleRate: opts.sampleRate,
    },
    state: opts.state,
    savedAt: new Date().toISOString(),
    appVersion: MIX_FILE_APP_VERSION,
  }
}

export function downloadMixFile(file: MixFile, baseName: string): void {
  const json = JSON.stringify(file, null, 2)
  const blob = new Blob([json], { type: 'application/json' })
  const safeBase = baseName.replace(/\.mix$/i, '') || 'mix'
  downloadBlob(blob, `${safeBase}.mix`)
}

export type ParseMixFileResult =
  | { ok: true; mix: MixFile; legacyAutomationDropped?: boolean }
  | { ok: false; error: string }

export function parseMixFile(text: string): ParseMixFileResult {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    return {
      ok: false,
      error: `not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'expected a JSON object at the root' }
  }
  const obj = raw as Record<string, unknown>
  if (obj.format !== MIX_FILE_FORMAT) {
    return {
      ok: false,
      error: `unrecognized format "${String(obj.format)}" (expected "${MIX_FILE_FORMAT}")`,
    }
  }
  if (obj.version !== MIX_FILE_VERSION) {
    // v1 files used envelope-multiplier semantics for keyframe gain, v2 is
    // absolute. Calling out the change explicitly so users understand why a
    // once-loadable file no longer loads.
    if (obj.version === 1) {
      return {
        ok: false,
        error:
          'version 1 .mix files use older keyframe semantics (envelope multiplier) and are not loadable in this build (which uses absolute keyframe gain, version 2). Re-export the mix from a v1 build, or recreate the automation here.',
      }
    }
    return {
      ok: false,
      error: `unsupported version ${String(obj.version)} (this build understands version ${MIX_FILE_VERSION})`,
    }
  }
  const awcMeta = parseAwcMeta(obj.awc)
  if (!awcMeta) {
    return { ok: false, error: 'missing or malformed `awc` metadata block' }
  }
  const parsedState = parseHashState(obj.state)
  if (!parsedState) {
    return { ok: false, error: 'missing or malformed `state` block' }
  }
  const savedAt = typeof obj.savedAt === 'string' ? obj.savedAt : ''
  const appVersion =
    typeof obj.appVersion === 'string' ? obj.appVersion : 'unknown'
  return {
    ok: true,
    mix: {
      format: MIX_FILE_FORMAT,
      version: MIX_FILE_VERSION,
      awc: awcMeta,
      state: parsedState.state,
      savedAt,
      appVersion,
    },
    legacyAutomationDropped: parsedState.legacyAutomationDropped || undefined,
  }
}

function parseAwcMeta(raw: unknown): MixFileAwcMeta | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const name = typeof obj.name === 'string' ? obj.name : ''
  const size = typeof obj.size === 'number' ? obj.size : 0
  const streamCount = typeof obj.streamCount === 'number' ? obj.streamCount : 0
  const sampleRate = typeof obj.sampleRate === 'number' ? obj.sampleRate : 48000
  if (
    name === '' &&
    size === 0 &&
    streamCount === 0 &&
    sampleRate === 48000 &&
    !('name' in obj) &&
    !('size' in obj) &&
    !('streamCount' in obj) &&
    !('sampleRate' in obj)
  ) {
    return null
  }
  return { name, size, streamCount, sampleRate }
}

function parseHashState(raw: unknown): {
  state: HashMixState
  legacyAutomationDropped: boolean
} | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  if (
    !Array.isArray(obj.m) ||
    !Array.isArray(obj.g) ||
    !Array.isArray(obj.p) ||
    typeof obj.M !== 'number'
  ) {
    return null
  }
  const out: HashMixState = {
    m: (obj.m as Array<unknown>).map((v) => (v ? 1 : 0)),
    g: (obj.g as Array<unknown>).map((v) => (typeof v === 'number' ? v : 100)),
    p: (obj.p as Array<unknown>).map((v) => (typeof v === 'number' ? v : 0)),
    M: obj.M,
  }
  const { list: a, droppedLegacy } = parseAutomation(obj.a)
  if (a) out.a = a
  return { state: out, legacyAutomationDropped: droppedLegacy }
}

/**
 * Decode the `a` field. Modern form: each pair is `[t×100, g×100, eFlag, ...]`
 * triples or `0`/`null` for empty. Legacy segment forms (length not divisible
 * by 3, or `-1` sentinel) are silently dropped and the dropped flag is set.
 */
function parseAutomation(raw: unknown): {
  list: Array<ReadonlyArray<Keyframe> | null> | undefined
  droppedLegacy: boolean
} {
  if (!Array.isArray(raw)) return { list: undefined, droppedLegacy: false }
  const out: Array<ReadonlyArray<Keyframe> | null> = []
  let droppedLegacy = false
  for (const entry of raw) {
    if (entry === 0 || entry === null) {
      out.push(null)
      continue
    }
    if (!Array.isArray(entry) || entry.length === 0) {
      out.push(null)
      continue
    }
    const first = entry[0]
    if (first === -1) {
      droppedLegacy = true
      out.push(null)
      continue
    }
    if (typeof first !== 'number' || entry.length % 3 !== 0) {
      droppedLegacy = true
      out.push(null)
      continue
    }
    const kfs: Array<Keyframe> = []
    for (let i = 0; i + 2 < entry.length; i += 3) {
      const t = entry[i]
      const g = entry[i + 1]
      const ef = entry[i + 2]
      if (typeof t !== 'number' || typeof g !== 'number') continue
      if (!Number.isFinite(t) || !Number.isFinite(g)) continue
      const easing: KeyframeEasing = ef === 1 ? 'hold' : 'linear'
      kfs.push({ time: t / 100, gain: g / 100, easing })
    }
    const norm = normalizeKeyframes(kfs)
    out.push(norm.length > 0 ? norm : null)
  }
  return { list: out, droppedLegacy }
}

export interface ApplyMixFileOpts {
  /** Number of pairs currently visible in the mix view (= ceil(streamCount/2)). */
  pairCount: number
  /**
   * Resolver: given a pair index (1-based) returns its L/R track IDs as
   * `{ left, right }` (either may be null if that side failed to decode).
   */
  trackIdsForPair: (pairIndex: number) => {
    left: string | null
    right: string | null
  }
}

export interface ApplyMixFileResult {
  applied: boolean
  warnings: Array<string>
}

export function applyMixFile(
  mix: MixFile,
  engine: MixerEngine,
  opts: ApplyMixFileOpts,
): ApplyMixFileResult {
  const warnings: Array<string> = []
  const state = mix.state
  const expectedPairCount = Math.ceil(mix.awc.streamCount / 2)
  if (state.m.length !== opts.pairCount) {
    warnings.push(
      `mix saved for ${state.m.length} pairs, this AWC has ${opts.pairCount}, applying overlap only`,
    )
  } else if (expectedPairCount !== opts.pairCount) {
    warnings.push(
      `awc.streamCount (${mix.awc.streamCount}) implies ${expectedPairCount} pairs but state has ${state.m.length}`,
    )
  }
  const limit = Math.min(state.m.length, opts.pairCount)
  for (let n = 0; n < limit; n++) {
    const { left, right } = opts.trackIdsForPair(n + 1)
    const enabled = (state.m[n] ?? 0) === 1
    const gain = (state.g[n] ?? 100) / 100
    const spread = Math.abs((state.p[n] ?? 100) / 100)
    if (left) {
      engine.setMuted(left, !enabled)
      engine.setGain(left, gain)
      engine.setPan(left, -spread)
    }
    if (right) {
      engine.setMuted(right, !enabled)
      engine.setGain(right, gain)
      engine.setPan(right, +spread)
    }
  }
  engine.setMasterGain(state.M / 100)
  // Apply automation per-pair. Always call clearKeyframes() first so loading
  // a mix gives a deterministic result regardless of prior in-memory state.
  engine.clearKeyframes()
  if (state.a) {
    const autoLimit = Math.min(state.a.length, opts.pairCount)
    for (let n = 0; n < autoLimit; n++) {
      const list = state.a[n]
      if (!list || list.length === 0) continue
      engine.setKeyframes(
        `pair-${n + 1}`,
        list.map((k) => ({ ...k })),
      )
    }
  }
  return { applied: true, warnings }
}
