/**
 * F6. Encode/decode the user's mix state to a compact base64-JSON string
 * stored in the URL hash. Format is intentionally tiny and stable so links
 * remain readable when pasted in chat:
 *
 *   #s=<base64(JSON({ v, m, g, p, M, a? }))>
 *
 * Where:
 *   v: number    format version (currently 2). Omitted in v1 hashes.
 *   m: number[]  per-pair ON bits (1 = audible, 0 = muted)
 *   g: number[]  per-pair gain × 100, integer 0..150
 *   p: number[]  per-pair pan (or spread) × 100, integer -100..+100
 *   M: number    master gain × 100, integer 0..150
 *   a: optional automation per pair as flat int arrays of keyframes:
 *        per pair: [t×100, g×100, eFlag, t×100, g×100, eFlag, ...]
 *        eFlag: 0 = linear easing, 1 = hold
 *      Or `0` (or null) when that pair has no keyframes.
 *      The whole field is omitted if no pair has any keyframes.
 *
 * Version history:
 *   v1: keyframe `g` was an envelope MULTIPLIER on top of the pair slider
 *       (nodeGain = pairSlider × envelope).
 *   v2: keyframe `g` is the ABSOLUTE gain written into the param
 *       (nodeGain = envelope, pair slider ignored on automated pairs).
 *   The on-disk wire shape is byte-identical between v1 and v2, only the
 *   semantics changed. On decoding a v1 hash that carries keyframes we flag
 *   `legacyV1Automation` so the route can warn the user.
 *
 * Backward compatibility: an older `a` field encoded SEGMENTS, a different
 * shape entirely (pairs of `[s×100, e×100]` ints or a `-1`-tagged form with
 * fades). On decode we recognize segment-shaped entries (pair count isn't
 * divisible by 3 OR the leading `-1` sentinel), drop them silently, and
 * continue. The route surfaces a one-line warning about lost automation on a
 * successful load.
 *
 * Decoding silently ignores malformed hashes, invalid input never throws.
 */

import { normalizeKeyframes } from './types'
import type { Keyframe, KeyframeEasing } from './types'

/**
 * Current wire-format version. Bumped to 2 with the keyframe-semantics flip
 * (envelope-multiplier → absolute-gain). See module docstring.
 */
export const HASH_STATE_VERSION = 2 as const

export interface HashMixState {
  /** Per-pair ON/OFF (0/1). Length = pair count. */
  m: Array<number>
  /** Per-pair gain × 100, integer 0..150. */
  g: Array<number>
  /** Per-pair pan/spread × 100, integer -100..+100. */
  p: Array<number>
  /** Master gain × 100, integer 0..150. */
  M: number
  /**
   * Optional per-pair keyframe arrays. `a[i]` is the keyframe list for pair
   * i. undefined / null / empty means "no automation for this pair". Omit
   * the whole field if no pair has any keyframes.
   */
  a?: ReadonlyArray<ReadonlyArray<Keyframe> | null>
}

/**
 * Result of decoding a hash. The `legacyAutomationDropped` flag is set when
 * the decoder detected an old segment-shaped `a` field and silently dropped
 * it, and the route surfaces a one-line warning to the user.
 *
 * `legacyV1Automation` is set when a v1 hash with keyframes was decoded.
 * keyframe values are kept as-is but their meaning changed (was envelope
 * multiplier, now absolute gain). The route warns the user.
 */
export interface DecodedHashState extends HashMixState {
  legacyAutomationDropped?: boolean
  legacyV1Automation?: boolean
}

const EASING_LINEAR_FLAG = 0
const EASING_HOLD_FLAG = 1

function easingToFlag(e: KeyframeEasing): number {
  return e === 'hold' ? EASING_HOLD_FLAG : EASING_LINEAR_FLAG
}

function flagToEasing(n: unknown): KeyframeEasing {
  return n === EASING_HOLD_FLAG ? 'hold' : 'linear'
}

function encodeKeyframeList(list: ReadonlyArray<Keyframe>): Array<number> {
  const out: Array<number> = []
  for (const k of list) {
    out.push(
      Math.round(k.time * 100),
      Math.round(k.gain * 100),
      easingToFlag(k.easing),
    )
  }
  return out
}

function encodeAutomation(
  list: ReadonlyArray<ReadonlyArray<Keyframe> | null> | undefined,
): Array<Array<number> | 0> | undefined {
  if (!list || list.length === 0) return undefined
  let any = false
  const out: Array<Array<number> | 0> = []
  for (const pair of list) {
    if (!pair || pair.length === 0) {
      out.push(0)
    } else {
      any = true
      out.push(encodeKeyframeList(pair))
    }
  }
  return any ? out : undefined
}

/**
 * Decode the `a` field. Modern form: each pair is either `0` (no keyframes)
 * or `number[]` with length divisible by 3, i.e. flat
 * `[t×100, g×100, eFlag, ...]` triples.
 *
 * Anything that doesn't fit that shape is treated as "legacy" and silently
 * dropped. The function returns null for that pair AND a top-level "dropped"
 * flag that the caller can use to warn the user.
 */
function decodeAutomation(raw: unknown): {
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
    // Legacy segment detection:
    //  - leading -1 sentinel was the old "tagged with fades" form
    //  - bare 2-int-per-segment legacy form has length divisible by 2 but
    //    not divisible by 3 (most common case). If it happens to be both
    //    divisible by 2 and 3 (i.e. length 6, 12, …), we'd misread it as
    //    keyframes, that's the documented data-loss edge of the migration.
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
    // Looks like keyframes. Decode triples.
    const kfs: Array<Keyframe> = []
    for (let i = 0; i + 2 < entry.length; i += 3) {
      const t = entry[i]
      const g = entry[i + 1]
      const ef = entry[i + 2]
      if (typeof t !== 'number' || typeof g !== 'number') continue
      if (!Number.isFinite(t) || !Number.isFinite(g)) continue
      kfs.push({
        time: t / 100,
        gain: g / 100,
        easing: flagToEasing(ef),
      })
    }
    const norm = normalizeKeyframes(kfs)
    out.push(norm.length > 0 ? norm : null)
  }
  return { list: out, droppedLegacy }
}

export function encodeHashState(state: HashMixState): string {
  const obj: Record<string, unknown> = {
    v: HASH_STATE_VERSION,
    m: state.m,
    g: state.g.map(Math.round),
    p: state.p.map(Math.round),
    M: Math.round(state.M),
  }
  const a = encodeAutomation(state.a)
  if (a !== undefined) obj.a = a
  const json = JSON.stringify(obj)
  return btoa(json).replace(/=+$/, '')
}

export function decodeHashState(hash: string): DecodedHashState | null {
  try {
    const m = /(?:^|[#&])s=([^&]+)/.exec(hash)
    const payload = m?.[1] ?? hash
    if (!payload) return null
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4)
    const json = atob(padded)
    const parsed = JSON.parse(json) as unknown
    if (!parsed || typeof parsed !== 'object') return null
    const obj = parsed as Record<string, unknown>
    if (
      !Array.isArray(obj.m) ||
      !Array.isArray(obj.g) ||
      !Array.isArray(obj.p) ||
      typeof obj.M !== 'number'
    ) {
      return null
    }
    const version = typeof obj.v === 'number' ? obj.v : 1
    const out: DecodedHashState = {
      m: obj.m.map((v) => (v ? 1 : 0)),
      g: obj.g.map((v) => (typeof v === 'number' ? v : 100)),
      p: obj.p.map((v) => (typeof v === 'number' ? v : 0)),
      M: obj.M,
    }
    const { list: a, droppedLegacy } = decodeAutomation(obj.a)
    if (a) out.a = a
    if (droppedLegacy) out.legacyAutomationDropped = true
    // v1 hashes carry envelope-multiplier semantics for keyframes, v2+ carry
    // absolute gain. The wire shape is identical, so we leave values as-is
    // and flag for the route to log a one-line warning.
    if (version < HASH_STATE_VERSION && a && a.some((p) => p && p.length > 0)) {
      out.legacyV1Automation = true
    }
    return out
  } catch {
    return null
  }
}

export function writeHashState(state: HashMixState): void {
  if (typeof window === 'undefined') return
  const encoded = encodeHashState(state)
  const url = new URL(window.location.href)
  url.hash = `s=${encoded}`
  // Preserve the existing history state object: TanStack Router keeps its
  // entry bookkeeping (__TSR_index / __TSR_key) there, and replacing it with
  // null breaks back/forward delta classification and entry-identity checks.
  window.history.replaceState(window.history.state, '', url.toString())
}

export function readHashState(): DecodedHashState | null {
  if (typeof window === 'undefined') return null
  const hash = window.location.hash.replace(/^#/, '')
  if (!hash) return null
  return decodeHashState(hash)
}
