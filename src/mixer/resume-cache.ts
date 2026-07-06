/**
 * Resume cache. Module-level, capacity-1 stash of a mix session's expensive
 * state so browser-back out of the mixer is instantly reversible.
 *
 * Why module-level: the SPA router unmounts the mix route on back-navigation,
 * destroying all component state. Everything we want to survive the round
 * trip, decoded AudioBuffers (seconds of re-decode for 16 stems), the
 * undo/redo stack, playhead, and selection, has to live outside React. A
 * plain module variable does that, lifetime = page, matching the session
 * registry.
 *
 * Why capacity 1: caching every visited session would pin all their decoded
 * buffers (tens of MB each) in memory indefinitely. Holding only the most
 * recent session keeps peak memory ≈ one open mixer, same as today, while
 * still covering the real UX loop (back → pick next → back). `evictOthers`
 * exists so a DIFFERENT session's mount can release the old buffers to GC
 * BEFORE it starts decoding, avoiding transient double residency.
 *
 * Why peek, not take: React StrictMode double-mounts effects in dev. A
 * consuming read would hand the entry to the throwaway first mount and leave
 * the real second mount with a cache miss (full re-decode). Non-consuming
 * reads are idempotent across both mounts, the entry is simply overwritten by
 * `stashResume` on the next unmount.
 *
 * Why data, not the live engine: the AudioContext and its audio-graph nodes
 * are tied to a lifecycle the route owns (created per mount, closed on
 * unmount). Caching them would resurrect nodes bound to a closed context.
 * AudioBuffers are context-independent data, so we cache those plus plain
 * state and let each mount rebuild its own engine.
 */

import type { HashMixState } from './hash-state'
import type { MixHistory } from './history'
import type { Selection } from './selection'
import type { TrackSpec } from './types'

/**
 * One failed stem decode. Mirrors the mix route's `Map<number, string>`
 * (stream index → error message) flattened to entries, so the cache stays a
 * plain-data snapshot the route can rebuild its Map from.
 */
export interface DecodeFailure {
  /** Index into the AWC's stream order (the route's Map key). */
  streamIndex: number
  /** Human-readable decode error message (the route's Map value). */
  message: string
}

export interface ResumeEntry {
  sessionId: string
  displayName: string
  /** Decoded AudioBuffers ride along here, the expensive part. */
  specs: Array<TrackSpec>
  /** Live instance, reused across mounts so undo survives back-navigation. */
  history: MixHistory
  playheadSec: number
  selection: Selection
  decodeFailures: Array<DecodeFailure>
  /**
   * Snapshot of the mix parameters (mutes/gains/pans/master/automation) at
   * stash time, in the URL-hash wire shape. The URL hash is still the
   * primary source of truth, but it rides on HISTORY ENTRIES, so a fresh
   * navigation to /mix/<id> (e.g. clicking a recent-session card) arrives
   * hash-less. This snapshot is the fallback for exactly that path, without
   * it "instant resume" would restore the audio but reset the mix to
   * all-muted defaults.
   */
  hashState: HashMixState | null
  /** When this entry was stashed (ms since epoch). */
  savedAt: number
}

let cached: ResumeEntry | null = null

/** Stash a session's resume state. Capacity 1: replaces whatever is stored. */
export function stashResume(entry: ResumeEntry): void {
  cached = entry
}

/**
 * Non-consuming read (StrictMode-safe). Returns null when the cache is empty
 * or holds a different session.
 */
export function peekResume(sessionId: string): ResumeEntry | null {
  if (cached === null || cached.sessionId !== sessionId) return null
  return cached
}

/** Whether an instant resume is available for this session. */
export function hasResume(sessionId: string): boolean {
  return cached !== null && cached.sessionId === sessionId
}

/**
 * Clear the cache iff it holds a DIFFERENT session. Called on mix-route mount
 * so the previous session's buffers can GC before the new one decodes.
 */
export function evictOthers(sessionId: string): void {
  if (cached !== null && cached.sessionId !== sessionId) {
    cached = null
  }
}

/** For tests. */
export function clearResumeCache(): void {
  cached = null
}
