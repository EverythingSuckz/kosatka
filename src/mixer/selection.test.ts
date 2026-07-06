import { describe, expect, test } from 'bun:test'

import {
  SELECTION_NONE,
  isKeyframeSelected,
  isPairSelected,
  rangeBetween,
  selectedIndicesForPair,
  selectionReducer,
  singleSelectedKeyframe,
} from './selection'
import type { Selection } from './selection'

describe('selection state machine', () => {
  test('default selection is none', () => {
    expect(SELECTION_NONE).toEqual({ kind: 'none' })
  })

  test('select-pair from none', () => {
    const next = selectionReducer(SELECTION_NONE, {
      type: 'select-pair',
      pairIndex: 3,
    })
    expect(next).toEqual({ kind: 'pair', pairIndex: 3 })
  })

  test('select-keyframe wraps to single-element keyframes', () => {
    const a = selectionReducer(SELECTION_NONE, {
      type: 'select-pair',
      pairIndex: 2,
    })
    const b = selectionReducer(a, {
      type: 'select-keyframe',
      pairIndex: 2,
      keyframeIndex: 1,
    })
    expect(b.kind).toBe('keyframes')
    if (b.kind === 'keyframes') {
      expect(b.items).toEqual([{ pairIndex: 2, keyframeIndex: 1 }])
    }
  })

  test('clear returns to none', () => {
    const a = selectionReducer(SELECTION_NONE, {
      type: 'select-keyframe',
      pairIndex: 5,
      keyframeIndex: 0,
    })
    const b = selectionReducer(a, { type: 'clear' })
    expect(b).toEqual({ kind: 'none' })
  })

  test('pair-removed clears matching pair selection', () => {
    const a = selectionReducer(SELECTION_NONE, {
      type: 'select-pair',
      pairIndex: 3,
    })
    const b = selectionReducer(a, { type: 'pair-removed', pairIndex: 3 })
    expect(b).toEqual({ kind: 'none' })
  })

  test('pair-removed also drops keyframes of that pair from selection', () => {
    const a = selectionReducer(SELECTION_NONE, {
      type: 'select-keyframe',
      pairIndex: 4,
      keyframeIndex: 2,
    })
    const b = selectionReducer(a, { type: 'pair-removed', pairIndex: 4 })
    expect(b).toEqual({ kind: 'none' })
  })

  test('pair-removed leaves unrelated selection intact', () => {
    const a = selectionReducer(SELECTION_NONE, {
      type: 'select-pair',
      pairIndex: 1,
    })
    const b = selectionReducer(a, { type: 'pair-removed', pairIndex: 5 })
    expect(b).toEqual({ kind: 'pair', pairIndex: 1 })
  })

  test('keyframe-removed of the only selected kf falls back to its pair', () => {
    const a = selectionReducer(SELECTION_NONE, {
      type: 'select-keyframe',
      pairIndex: 2,
      keyframeIndex: 1,
    })
    const b = selectionReducer(a, {
      type: 'keyframe-removed',
      pairIndex: 2,
      keyframeIndex: 1,
    })
    expect(b).toEqual({ kind: 'pair', pairIndex: 2 })
  })

  test('keyframe-removed of an earlier kf shifts the single index down', () => {
    const a = selectionReducer(SELECTION_NONE, {
      type: 'select-keyframe',
      pairIndex: 3,
      keyframeIndex: 2,
    })
    const b = selectionReducer(a, {
      type: 'keyframe-removed',
      pairIndex: 3,
      keyframeIndex: 0,
    })
    if (b.kind !== 'keyframes') throw new Error('expected keyframes')
    expect(b.items).toEqual([{ pairIndex: 3, keyframeIndex: 1 }])
  })

  test('keyframe-removed of a later kf leaves selection intact', () => {
    const a = selectionReducer(SELECTION_NONE, {
      type: 'select-keyframe',
      pairIndex: 3,
      keyframeIndex: 0,
    })
    const b = selectionReducer(a, {
      type: 'keyframe-removed',
      pairIndex: 3,
      keyframeIndex: 2,
    })
    if (b.kind !== 'keyframes') throw new Error('expected keyframes')
    expect(b.items).toEqual([{ pairIndex: 3, keyframeIndex: 0 }])
  })

  test('keyframe-removed in a different pair is a no-op', () => {
    const a = selectionReducer(SELECTION_NONE, {
      type: 'select-keyframe',
      pairIndex: 3,
      keyframeIndex: 1,
    })
    const b = selectionReducer(a, {
      type: 'keyframe-removed',
      pairIndex: 5,
      keyframeIndex: 0,
    })
    if (b.kind !== 'keyframes') throw new Error('expected keyframes')
    expect(b.items).toEqual([{ pairIndex: 3, keyframeIndex: 1 }])
  })
})

describe('selection predicates', () => {
  test('isPairSelected on none / pair / keyframes', () => {
    expect(isPairSelected(SELECTION_NONE, 1)).toBe(false)
    expect(isPairSelected({ kind: 'pair', pairIndex: 2 }, 2)).toBe(true)
    expect(isPairSelected({ kind: 'pair', pairIndex: 2 }, 1)).toBe(false)
    const sel: Selection = {
      kind: 'keyframes',
      items: [{ pairIndex: 4, keyframeIndex: 0 }],
    }
    expect(isPairSelected(sel, 4)).toBe(true)
    expect(isPairSelected(sel, 5)).toBe(false)
  })

  test('isKeyframeSelected requires both indices to match', () => {
    const sel: Selection = {
      kind: 'keyframes',
      items: [{ pairIndex: 2, keyframeIndex: 1 }],
    }
    expect(isKeyframeSelected(sel, 2, 1)).toBe(true)
    expect(isKeyframeSelected(sel, 2, 0)).toBe(false)
    expect(isKeyframeSelected(sel, 1, 1)).toBe(false)
    expect(isKeyframeSelected(SELECTION_NONE, 0, 0)).toBe(false)
    expect(isKeyframeSelected({ kind: 'pair', pairIndex: 2 }, 2, 0)).toBe(false)
  })

  test('isKeyframeSelected works on a multi-selection', () => {
    const sel: Selection = {
      kind: 'keyframes',
      items: [
        { pairIndex: 2, keyframeIndex: 1 },
        { pairIndex: 2, keyframeIndex: 3 },
        { pairIndex: 5, keyframeIndex: 0 },
      ],
    }
    expect(isKeyframeSelected(sel, 2, 1)).toBe(true)
    expect(isKeyframeSelected(sel, 2, 3)).toBe(true)
    expect(isKeyframeSelected(sel, 5, 0)).toBe(true)
    expect(isKeyframeSelected(sel, 2, 2)).toBe(false)
  })

  test('singleSelectedKeyframe returns the lone keyframe or null', () => {
    expect(singleSelectedKeyframe(SELECTION_NONE)).toBeNull()
    expect(singleSelectedKeyframe({ kind: 'pair', pairIndex: 1 })).toBeNull()
    expect(
      singleSelectedKeyframe({
        kind: 'keyframes',
        items: [{ pairIndex: 2, keyframeIndex: 1 }],
      }),
    ).toEqual({ pairIndex: 2, keyframeIndex: 1 })
    expect(
      singleSelectedKeyframe({
        kind: 'keyframes',
        items: [
          { pairIndex: 2, keyframeIndex: 1 },
          { pairIndex: 2, keyframeIndex: 2 },
        ],
      }),
    ).toBeNull()
  })

  test('selectedIndicesForPair returns all selected indices for one pair', () => {
    const sel: Selection = {
      kind: 'keyframes',
      items: [
        { pairIndex: 2, keyframeIndex: 1 },
        { pairIndex: 2, keyframeIndex: 4 },
        { pairIndex: 5, keyframeIndex: 0 },
      ],
    }
    expect(selectedIndicesForPair(sel, 2).sort()).toEqual([1, 4])
    expect(selectedIndicesForPair(sel, 5)).toEqual([0])
    expect(selectedIndicesForPair(sel, 9)).toEqual([])
  })
})

describe('multi-keyframe selection (ctrl-click toggle)', () => {
  test('toggle-keyframe from none adds it', () => {
    const next = selectionReducer(SELECTION_NONE, {
      type: 'toggle-keyframe',
      pairIndex: 2,
      keyframeIndex: 1,
    })
    if (next.kind !== 'keyframes') throw new Error('expected keyframes')
    expect(next.items).toEqual([{ pairIndex: 2, keyframeIndex: 1 }])
  })

  test('toggle-keyframe re-toggles an existing one to remove', () => {
    const a = selectionReducer(SELECTION_NONE, {
      type: 'toggle-keyframe',
      pairIndex: 2,
      keyframeIndex: 1,
    })
    const b = selectionReducer(a, {
      type: 'toggle-keyframe',
      pairIndex: 2,
      keyframeIndex: 1,
    })
    expect(b).toEqual({ kind: 'none' })
  })

  test('toggle-keyframe adds a second keyframe to selection', () => {
    const a = selectionReducer(SELECTION_NONE, {
      type: 'toggle-keyframe',
      pairIndex: 2,
      keyframeIndex: 1,
    })
    const b = selectionReducer(a, {
      type: 'toggle-keyframe',
      pairIndex: 2,
      keyframeIndex: 3,
    })
    if (b.kind !== 'keyframes') throw new Error('expected keyframes')
    expect(b.items.length).toBe(2)
  })

  test('toggle-keyframe from pair selection creates a fresh keyframe set', () => {
    const a: Selection = { kind: 'pair', pairIndex: 3 }
    const b = selectionReducer(a, {
      type: 'toggle-keyframe',
      pairIndex: 3,
      keyframeIndex: 0,
    })
    if (b.kind !== 'keyframes') throw new Error('expected keyframes')
    expect(b.items).toEqual([{ pairIndex: 3, keyframeIndex: 0 }])
  })
})

describe('select-keyframes (shift-click range)', () => {
  test('replaces current selection', () => {
    const a = selectionReducer(SELECTION_NONE, {
      type: 'select-keyframes',
      items: [
        { pairIndex: 2, keyframeIndex: 1 },
        { pairIndex: 2, keyframeIndex: 2 },
        { pairIndex: 2, keyframeIndex: 3 },
      ],
    })
    if (a.kind !== 'keyframes') throw new Error('expected keyframes')
    expect(a.items.length).toBe(3)
  })

  test('empty list lands on none', () => {
    const a = selectionReducer(SELECTION_NONE, {
      type: 'select-keyframes',
      items: [],
    })
    expect(a).toEqual({ kind: 'none' })
  })
})

describe('rangeBetween', () => {
  test('builds an inclusive range within a pair', () => {
    const r = rangeBetween(
      { pairIndex: 3, keyframeIndex: 1 },
      { pairIndex: 3, keyframeIndex: 4 },
    )
    expect(r).toEqual([
      { pairIndex: 3, keyframeIndex: 1 },
      { pairIndex: 3, keyframeIndex: 2 },
      { pairIndex: 3, keyframeIndex: 3 },
      { pairIndex: 3, keyframeIndex: 4 },
    ])
  })

  test('handles reverse ordering', () => {
    const r = rangeBetween(
      { pairIndex: 3, keyframeIndex: 4 },
      { pairIndex: 3, keyframeIndex: 1 },
    )
    expect(r).toEqual([
      { pairIndex: 3, keyframeIndex: 1 },
      { pairIndex: 3, keyframeIndex: 2 },
      { pairIndex: 3, keyframeIndex: 3 },
      { pairIndex: 3, keyframeIndex: 4 },
    ])
  })

  test('cross-pair returns just the target', () => {
    const r = rangeBetween(
      { pairIndex: 1, keyframeIndex: 0 },
      { pairIndex: 2, keyframeIndex: 0 },
    )
    expect(r).toEqual([{ pairIndex: 2, keyframeIndex: 0 }])
  })

  test('same index returns just that one', () => {
    const r = rangeBetween(
      { pairIndex: 4, keyframeIndex: 2 },
      { pairIndex: 4, keyframeIndex: 2 },
    )
    expect(r).toEqual([{ pairIndex: 4, keyframeIndex: 2 }])
  })
})

describe('multi-keyframe drag selection invariants', () => {
  // These tests document the round-5 multi-drag contract at the selection
  // level. The actual DOM-driven drag logic lives in `timeline.tsx`, here
  // we lock in the rules the route depends on.

  test('dragging a non-selected diamond replaces selection with that one kf', () => {
    // Setup: kfs (pair 2, idx 1) and (pair 2, idx 3) are selected. User
    // mousedowns on a diamond NOT in the set (idx 0). The KeyframesLayer
    // treats that as "not multi-drag" → on pointerup with no movement the
    // route fires `select-keyframe`, which replaces selection with just
    // that one kf, the existing multi-select breaks. This guarantees the
    // user can always escape a sticky selection by clicking outside it.
    const before: Selection = {
      kind: 'keyframes',
      items: [
        { pairIndex: 2, keyframeIndex: 1 },
        { pairIndex: 2, keyframeIndex: 3 },
      ],
    }
    const after = selectionReducer(before, {
      type: 'select-keyframe',
      pairIndex: 2,
      keyframeIndex: 0,
    })
    if (after.kind !== 'keyframes') throw new Error('expected keyframes')
    expect(after.items).toEqual([{ pairIndex: 2, keyframeIndex: 0 }])
  })

  test('shifting all selected kfs by the same delta preserves the set', () => {
    // Conceptual test: the route's `moveKeyframesMany` shifts every kf by
    // the same `deltaSeconds`. After the shift, the selection should still
    // reference the SAME kfs (by identity), even if their indices changed
    // because the engine resorted by time. We model that here by asserting
    // that `select-keyframes` with the new index set replaces cleanly.
    const items = [
      { pairIndex: 1, keyframeIndex: 0 },
      { pairIndex: 1, keyframeIndex: 1 },
      { pairIndex: 2, keyframeIndex: 0 },
    ]
    const initial: Selection = { kind: 'keyframes', items }
    // Imagine times shifted by +5s, engine re-sorts, no index changes for
    // a uniform delta, selection ends up identical.
    const after = selectionReducer(initial, {
      type: 'select-keyframes',
      items,
    })
    if (after.kind !== 'keyframes') throw new Error('expected keyframes')
    expect(after.items.length).toBe(3)
  })

  test('cross-pair multi-select survives select-keyframes replace', () => {
    const items = [
      { pairIndex: 1, keyframeIndex: 0 },
      { pairIndex: 3, keyframeIndex: 2 },
    ]
    const after = selectionReducer(SELECTION_NONE, {
      type: 'select-keyframes',
      items,
    })
    if (after.kind !== 'keyframes') throw new Error('expected keyframes')
    const pairs = new Set(after.items.map((r) => r.pairIndex))
    expect(pairs.size).toBe(2)
  })
})

describe('multi-keyframe keyframe-removed handling', () => {
  test('removes the targeted kf from a multi-selection', () => {
    const a: Selection = {
      kind: 'keyframes',
      items: [
        { pairIndex: 2, keyframeIndex: 1 },
        { pairIndex: 2, keyframeIndex: 3 },
      ],
    }
    const b = selectionReducer(a, {
      type: 'keyframe-removed',
      pairIndex: 2,
      keyframeIndex: 1,
    })
    if (b.kind !== 'keyframes') throw new Error('expected keyframes')
    // After removal of index 1, the later index 3 shifts down to 2.
    expect(b.items).toEqual([{ pairIndex: 2, keyframeIndex: 2 }])
  })

  test('emptying via keyframe-removed lands on none', () => {
    const a: Selection = {
      kind: 'keyframes',
      items: [
        { pairIndex: 2, keyframeIndex: 1 },
        { pairIndex: 2, keyframeIndex: 3 },
      ],
    }
    const b = selectionReducer(a, {
      type: 'keyframe-removed',
      pairIndex: 2,
      keyframeIndex: 1,
    })
    const c = selectionReducer(b, {
      type: 'keyframe-removed',
      pairIndex: 2,
      keyframeIndex: 2,
    })
    // Item left was {pair:2, kf:2}, removing it falls back to pair view.
    expect(c).toEqual({ kind: 'pair', pairIndex: 2 })
  })
})
