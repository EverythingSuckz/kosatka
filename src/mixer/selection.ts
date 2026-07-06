/**
 * Selection state machine for the mixer editor.
 *
 * Three kinds of selection:
 *   - `none`: nothing selected (inspector shows shortcuts reference)
 *   - `pair`: one pair selected (inspector shows gain / spread / kf list)
 *   - `keyframes`: one or more keyframes selected. single → standard kf
 *     editing view, multiple → bulk view (count + bulk delete only).
 *
 * The single-keyframe case is just `kind: 'keyframes'` with one item. The
 * inspector dispatches on `items.length`.
 *
 * This module is pure, no React, no DOM. The route owns the state via
 * useState and threads it through to PairListRow / KeyframesLayer / Inspector.
 */

export interface KeyframeRef {
  pairIndex: number
  keyframeIndex: number
}

export type Selection =
  | { kind: 'none' }
  | { kind: 'pair'; pairIndex: number }
  | { kind: 'keyframes'; items: ReadonlyArray<KeyframeRef> }

export const SELECTION_NONE: Selection = { kind: 'none' }

export type SelectionAction =
  | { type: 'clear' }
  | { type: 'select-pair'; pairIndex: number }
  /** Replace selection with a single keyframe. */
  | { type: 'select-keyframe'; pairIndex: number; keyframeIndex: number }
  /** Replace selection with this exact set. */
  | { type: 'select-keyframes'; items: ReadonlyArray<KeyframeRef> }
  /** Ctrl-click toggle: add if not present, remove if present. */
  | {
      type: 'toggle-keyframe'
      pairIndex: number
      keyframeIndex: number
    }
  /** A pair was removed (decode failed, etc.), clear if it was selected. */
  | { type: 'pair-removed'; pairIndex: number }
  /**
   * A keyframe was deleted. Drops it from any multi-selection. If it was the
   * single selected one we fall back to the parent pair view. If an earlier
   * keyframe in the same pair was deleted we shift indices down.
   */
  | {
      type: 'keyframe-removed'
      pairIndex: number
      keyframeIndex: number
    }

function sameRef(a: KeyframeRef, b: KeyframeRef): boolean {
  return a.pairIndex === b.pairIndex && a.keyframeIndex === b.keyframeIndex
}

function pruneAndShift(
  items: ReadonlyArray<KeyframeRef>,
  removedPair: number,
  removedKfIdx: number,
): Array<KeyframeRef> {
  const out: Array<KeyframeRef> = []
  for (const it of items) {
    if (it.pairIndex === removedPair && it.keyframeIndex === removedKfIdx) {
      continue
    }
    if (it.pairIndex === removedPair && it.keyframeIndex > removedKfIdx) {
      out.push({
        pairIndex: it.pairIndex,
        keyframeIndex: it.keyframeIndex - 1,
      })
    } else {
      out.push(it)
    }
  }
  return out
}

export function selectionReducer(
  state: Selection,
  action: SelectionAction,
): Selection {
  switch (action.type) {
    case 'clear':
      return SELECTION_NONE
    case 'select-pair':
      return { kind: 'pair', pairIndex: action.pairIndex }
    case 'select-keyframe':
      return {
        kind: 'keyframes',
        items: [
          {
            pairIndex: action.pairIndex,
            keyframeIndex: action.keyframeIndex,
          },
        ],
      }
    case 'select-keyframes': {
      if (action.items.length === 0) return SELECTION_NONE
      return { kind: 'keyframes', items: action.items.map((r) => ({ ...r })) }
    }
    case 'toggle-keyframe': {
      const ref: KeyframeRef = {
        pairIndex: action.pairIndex,
        keyframeIndex: action.keyframeIndex,
      }
      const current =
        state.kind === 'keyframes'
          ? state.items.slice()
          : ([] as Array<KeyframeRef>)
      const idx = current.findIndex((r) => sameRef(r, ref))
      if (idx >= 0) {
        current.splice(idx, 1)
        if (current.length === 0) return SELECTION_NONE
        return { kind: 'keyframes', items: current }
      }
      current.push(ref)
      return { kind: 'keyframes', items: current }
    }
    case 'pair-removed':
      if (state.kind === 'pair' && state.pairIndex === action.pairIndex) {
        return SELECTION_NONE
      }
      if (state.kind === 'keyframes') {
        const kept = state.items.filter(
          (it) => it.pairIndex !== action.pairIndex,
        )
        if (kept.length === 0) return SELECTION_NONE
        return { kind: 'keyframes', items: kept }
      }
      return state
    case 'keyframe-removed':
      if (state.kind !== 'keyframes') return state
      // If the removed kf is the ONLY selected one (and matches), fall back
      // to the parent pair view. preserves the legacy single-select UX.
      if (state.items.length === 1) {
        const only = state.items[0]!
        if (
          only.pairIndex === action.pairIndex &&
          only.keyframeIndex === action.keyframeIndex
        ) {
          return { kind: 'pair', pairIndex: action.pairIndex }
        }
        // Maybe shift the single item's index down.
        if (
          only.pairIndex === action.pairIndex &&
          only.keyframeIndex > action.keyframeIndex
        ) {
          return {
            kind: 'keyframes',
            items: [
              {
                pairIndex: only.pairIndex,
                keyframeIndex: only.keyframeIndex - 1,
              },
            ],
          }
        }
        return state
      }
      // Multi-select case: drop the removed one and shift later siblings.
      return removeFromMulti(
        state.items,
        action.pairIndex,
        action.keyframeIndex,
      )
  }
}

function removeFromMulti(
  items: ReadonlyArray<KeyframeRef>,
  pairIndex: number,
  keyframeIndex: number,
): Selection {
  const pruned = pruneAndShift(items, pairIndex, keyframeIndex)
  if (pruned.length === 0) return SELECTION_NONE
  return { kind: 'keyframes', items: pruned }
}

/** True iff the given pair row should highlight (focused / selected). */
export function isPairSelected(sel: Selection, pairIndex: number): boolean {
  if (sel.kind === 'pair') return sel.pairIndex === pairIndex
  if (sel.kind === 'keyframes') {
    for (const it of sel.items) {
      if (it.pairIndex === pairIndex) return true
    }
    return false
  }
  return false
}

/** True iff a particular keyframe diamond should be highlighted. */
export function isKeyframeSelected(
  sel: Selection,
  pairIndex: number,
  keyframeIndex: number,
): boolean {
  if (sel.kind !== 'keyframes') return false
  for (const it of sel.items) {
    if (it.pairIndex === pairIndex && it.keyframeIndex === keyframeIndex) {
      return true
    }
  }
  return false
}

/**
 * For UI that needs the "current single keyframe" (e.g. inspector single-edit
 * view), returns the single selected keyframe if exactly one is selected,
 * else null.
 */
export function singleSelectedKeyframe(sel: Selection): KeyframeRef | null {
  if (sel.kind !== 'keyframes') return null
  if (sel.items.length !== 1) return null
  return sel.items[0] ?? null
}

/**
 * Compute the keyframe indices currently selected within ONE pair. Used to
 * paint diamonds in that pair's row. Returns an empty array when no
 * keyframes of this pair are selected.
 */
export function selectedIndicesForPair(
  sel: Selection,
  pairIndex: number,
): Array<number> {
  if (sel.kind !== 'keyframes') return []
  const out: Array<number> = []
  for (const it of sel.items) {
    if (it.pairIndex === pairIndex) out.push(it.keyframeIndex)
  }
  return out
}

/**
 * Compute the range of keyframe indices BETWEEN two keyframes (inclusive)
 * within a single pair. Used by shift-click range selection. Order does not
 * matter, we sort. Cross-pair ranges aren't supported (returns just the
 * destination).
 */
export function rangeBetween(
  anchor: KeyframeRef,
  target: KeyframeRef,
): Array<KeyframeRef> {
  if (anchor.pairIndex !== target.pairIndex) {
    return [{ ...target }]
  }
  const lo = Math.min(anchor.keyframeIndex, target.keyframeIndex)
  const hi = Math.max(anchor.keyframeIndex, target.keyframeIndex)
  const out: Array<KeyframeRef> = []
  for (let i = lo; i <= hi; i++) {
    out.push({ pairIndex: target.pairIndex, keyframeIndex: i })
  }
  return out
}
