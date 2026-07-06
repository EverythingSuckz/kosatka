/**
 * Nav guard. The dirty-gate predicate for leaving the mix route.
 *
 * Spec: docs/superpowers/specs/2026-07-03-back-navigation-ux-design.md (§3).
 *
 * Why a whole module for one boolean OR: the definition of "dirty" is a
 * product decision, not an implementation detail. Back-navigation is cheap
 * because of the resume cache (src/mixer/resume-cache.ts). Decoded buffers,
 * history, playhead, and selection all survive a back-press, so the leave
 * dialog must fire ONLY when something genuinely un-recoverable or invested
 * exists:
 *
 *   - `canUndo`: undo history is in-memory only, it dies on tab close, and
 *     its presence means the user has actually edited the mix.
 *   - `hasAutomation`: drawn keyframes represent deliberate authoring work.
 *   - `isPlaying`: active playback means the user is mid-audition, killing
 *     the transport without asking is hostile.
 *
 * Fresh-loaded, untouched tracks exit silently, the rpf audition loop
 * (back → pick next → back) must stay dialog-free. Naming and testing this
 * predicate here keeps the gate a single documented decision instead of an
 * inline expression scattered through the route (which would drift as the
 * route grows more `useBlocker` / `beforeunload` wiring).
 */

/** Inputs the mix route snapshots when deciding whether to block a leave. */
export interface MixDirtyArgs {
  /** Undo stack is non-empty, the user has made at least one edit. */
  canUndo: boolean
  /** Any automation keyframes exist on any track pair. */
  hasAutomation: boolean
  /** The transport is currently playing. */
  isPlaying: boolean
}

/**
 * True when leaving the mixer should prompt for confirmation.
 * Dirty = any of: undo history, drawn automation, active playback.
 */
export function isMixDirty(args: MixDirtyArgs): boolean {
  return args.canUndo || args.hasAutomation || args.isPlaying
}
