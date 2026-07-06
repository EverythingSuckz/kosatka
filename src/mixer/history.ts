/**
 * Mix history. Snapshot-based undo / redo.
 *
 * Why snapshots, not a command pattern: the engine is small, mutations are
 * coarse-grained (mute, gain, pan, master, automation), and the snapshot
 * captures exactly the user-visible state we care about. We trade a few
 * bytes per entry for code that doesn't have to model inverse-mutations
 * across mute/gain/pan/keyframe interactions.
 *
 * Cap: 100 entries. Drop oldest on overflow.
 *
 * Coalescing: drag operations (keyframe move, slider scrub) push many tiny
 * deltas in quick succession. The user expects ONE undo to revert the whole
 * gesture. `push(entry, { coalesceKey })` will REPLACE the previous entry
 * if it has the same coalesce key AND was pushed within `coalesceMs` ago
 * (default 500 ms). Use coalesce keys like:
 *   - `kf-drag-${pairIndex}-${kfIndex}`
 *   - `slider-gain-${pairIndex}`
 *   - `slider-master`
 *
 * Entries record FULL snapshots (the state the engine SHOULD be returned to
 * when this entry is restored). The route is responsible for pushing the
 * PRE-mutation state, so `undo` lands on the state BEFORE the mutation.
 *
 * Structural sharing: `Keyframe[]` arrays inside the `automation` map are
 * cheap to clone shallow (the route passes them by reference, the history
 * keeps them frozen).
 */

import type { Keyframe } from './types'

/** Per-track piece of state captured in a history entry. */
export interface HistoryTrackState {
  id: string
  muted: boolean
  gain: number
  pan: number
  solo: boolean
}

/** The full snapshot the history stores. */
export interface MixHistoryState {
  tracks: ReadonlyArray<HistoryTrackState>
  masterGain: number
  /** Pair-key → keyframe list. Shallow-shared copies are fine. */
  automation: Record<string, ReadonlyArray<Keyframe>>
}

export interface MixHistoryEntry {
  state: MixHistoryState
  /** Human-readable label (used by future "undo: X" UI). */
  label: string
  /**
   * The coalesce key this entry was pushed with, if any. Used by the next
   * `push` call to decide whether to REPLACE this entry rather than append.
   */
  coalesceKey?: string
  /** When this entry was pushed (ms since epoch). */
  pushedAt: number
}

export interface PushOptions {
  /**
   * If set, and the previous entry was pushed with the same key within
   * `coalesceMs`, this push REPLACES the previous entry instead of appending.
   * Used for drags / scrubs where many small pushes should fold into one
   * logical undo step.
   */
  coalesceKey?: string
  /** Defaults to 500 ms. */
  coalesceMs?: number
}

const DEFAULT_COALESCE_MS = 500
const MAX_ENTRIES = 100

export interface MixHistory {
  push: (
    entry: Omit<MixHistoryEntry, 'pushedAt'>,
    options?: PushOptions,
  ) => void
  /** Returns the state to restore (or null if empty). Caller passes CURRENT
   *  state so we can push it onto the future stack for redo. */
  undo: (currentState: MixHistoryState) => MixHistoryEntry | null
  redo: (currentState: MixHistoryState) => MixHistoryEntry | null
  clear: () => void
  canUndo: () => boolean
  canRedo: () => boolean
  /** For tests. Current sizes. */
  sizes: () => { past: number; future: number }
}

/**
 * Create a new history instance. The `now` parameter is overridable for
 * deterministic tests.
 */
export function createHistory(now: () => number = Date.now): MixHistory {
  const past: Array<MixHistoryEntry> = []
  const future: Array<MixHistoryEntry> = []

  function push(
    entry: Omit<MixHistoryEntry, 'pushedAt'>,
    options: PushOptions = {},
  ): void {
    const pushedAt = now()
    const coalesceKey = options.coalesceKey
    const coalesceMs = options.coalesceMs ?? DEFAULT_COALESCE_MS
    const tail = past[past.length - 1]
    if (
      tail &&
      coalesceKey !== undefined &&
      tail.coalesceKey === coalesceKey &&
      pushedAt - tail.pushedAt <= coalesceMs
    ) {
      // Replace the previous entry. Its `state` already captures the
      // pre-gesture snapshot, which is what undo should restore.
      tail.label = entry.label
      tail.pushedAt = pushedAt
      // Any new push invalidates the redo stack.
      future.length = 0
      return
    }
    const full: MixHistoryEntry = {
      state: entry.state,
      label: entry.label,
      coalesceKey,
      pushedAt,
    }
    past.push(full)
    if (past.length > MAX_ENTRIES) {
      past.splice(0, past.length - MAX_ENTRIES)
    }
    future.length = 0
  }

  function undo(currentState: MixHistoryState): MixHistoryEntry | null {
    const entry = past.pop()
    if (!entry) return null
    future.push({
      state: currentState,
      label: entry.label,
      coalesceKey: entry.coalesceKey,
      pushedAt: now(),
    })
    return entry
  }

  function redo(currentState: MixHistoryState): MixHistoryEntry | null {
    const entry = future.pop()
    if (!entry) return null
    past.push({
      state: currentState,
      label: entry.label,
      coalesceKey: entry.coalesceKey,
      pushedAt: now(),
    })
    return entry
  }

  function clear(): void {
    past.length = 0
    future.length = 0
  }

  function canUndo(): boolean {
    return past.length > 0
  }

  function canRedo(): boolean {
    return future.length > 0
  }

  function sizes(): { past: number; future: number } {
    return { past: past.length, future: future.length }
  }

  return { push, undo, redo, clear, canUndo, canRedo, sizes }
}
