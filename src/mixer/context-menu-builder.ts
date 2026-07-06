/**
 * Pure builder that constructs the keyframe context-menu item array.
 *
 * The action handlers passed in let the route's keyframe-mutation layer
 * (delete / duplicate / set-easing / add-fade-in / add-fade-out) wire into
 * the menu without polluting the menu component with route state.
 *
 * Pulled out as its own module so it's unit-testable without React.
 */

import { isLinearEasingDisabled } from './inspector'
import type { ContextMenuItem } from './context-menu'
import type { Keyframe } from './types'

export interface KeyframeMenuInputs {
  keyframe: Keyframe
  keyframeIndex: number
  pairKeyframes: ReadonlyArray<Keyframe>
  durationSeconds: number
  playheadSeconds: number
}

export interface KeyframeMenuActions {
  onDelete?: () => void
  onDuplicate?: () => void
  onAddFadeIn?: () => void
  onAddFadeOut?: () => void
  onSetLinear?: () => void
  onSetHold?: () => void
}

/**
 * Build the context-menu item array for a given keyframe.
 *
 * NOTE: the structural shape of the items (labels, disabled flags, danger
 * flag, dividers) is the unit-test surface. actions can be omitted at
 * build time and wired by the caller.
 */
export function buildKeyframeContextMenu(
  inputs: KeyframeMenuInputs,
  actions: KeyframeMenuActions = {},
): ReadonlyArray<ContextMenuItem> {
  const linearDisabled = isLinearEasingDisabled(inputs.keyframeIndex)
  // "Properties" was previously the last item. it's redundant now because
  // a plain left-click already selects the keyframe and shows it in the
  // inspector. Right-click also selects-then-opens-the-menu, so a separate
  // "properties" entry duplicates that behaviour for no benefit.
  return [
    {
      label: 'delete',
      kbd: 'del',
      danger: true,
      onSelect: actions.onDelete,
    },
    {
      label: 'duplicate',
      onSelect: actions.onDuplicate,
    },
    {
      label: 'add fade in',
      onSelect: actions.onAddFadeIn,
    },
    {
      label: 'add fade out',
      onSelect: actions.onAddFadeOut,
    },
    { divider: true, label: '' },
    {
      label: 'set linear easing',
      disabled: linearDisabled,
      onSelect: actions.onSetLinear,
    },
    {
      label: 'set hold easing',
      onSelect: actions.onSetHold,
    },
  ]
}

/**
 * Compute the time for a "duplicated" keyframe: 1 second after the source,
 * or the playhead time if the playhead is past the source, clamped to the
 * song duration.
 */
export function duplicateTimeFor(
  source: Keyframe,
  playheadSeconds: number,
  durationSeconds: number,
): number {
  let candidate = source.time + 1
  if (playheadSeconds > source.time + 1e-6) {
    candidate = playheadSeconds
  }
  return Math.min(Math.max(0, candidate), Math.max(0, durationSeconds))
}

/**
 * Compute the keyframe(s) needed for "add fade in" at the given source.
 * Returns up to two operations the route applies:
 *   - update an existing kf at time 0 to envelope 0 (if present), OR add one
 *   - ensure the source itself is gain 1 (already is by definition)
 *
 * The route applies these as engine.setKeyframe / addKeyframe calls.
 */
export interface FadeInOps {
  /** True if a kf already exists at time 0 that we should update. */
  hasZeroKf: boolean
  /** Index of the existing-at-zero kf, or -1. */
  zeroKfIndex: number
}

export function planFadeIn(pairKeyframes: ReadonlyArray<Keyframe>): FadeInOps {
  for (let i = 0; i < pairKeyframes.length; i++) {
    const k = pairKeyframes[i]!
    if (k.time < 0.001) return { hasZeroKf: true, zeroKfIndex: i }
  }
  return { hasZeroKf: false, zeroKfIndex: -1 }
}

/** Time of the fade-OUT keyframe to add. */
export function fadeOutTime(source: Keyframe, durationSeconds: number): number {
  return Math.min(source.time + 2, Math.max(source.time, durationSeconds))
}
