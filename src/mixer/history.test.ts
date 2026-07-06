import { describe, expect, test } from 'bun:test'

import { createHistory } from './history'
import type { MixHistoryState } from './history'

function emptyState(masterGain = 1): MixHistoryState {
  return { tracks: [], masterGain, automation: {} }
}

describe('createHistory', () => {
  test('starts empty', () => {
    const h = createHistory()
    expect(h.canUndo()).toBe(false)
    expect(h.canRedo()).toBe(false)
    expect(h.sizes()).toEqual({ past: 0, future: 0 })
  })

  test('push appends to past and clears future', () => {
    const h = createHistory()
    h.push({ state: emptyState(0.5), label: 'a' })
    h.push({ state: emptyState(0.6), label: 'b' })
    expect(h.canUndo()).toBe(true)
    expect(h.canRedo()).toBe(false)
    expect(h.sizes().past).toBe(2)
  })

  test('undo pops past and pushes current state to future', () => {
    const h = createHistory()
    h.push({ state: emptyState(0.5), label: 'pre-A' })
    h.push({ state: emptyState(0.6), label: 'pre-B' })
    // Current state when undoing is 0.7 (after B mutation).
    const entry = h.undo(emptyState(0.7))
    expect(entry).not.toBeNull()
    expect(entry!.state.masterGain).toBe(0.6)
    expect(entry!.label).toBe('pre-B')
    expect(h.sizes()).toEqual({ past: 1, future: 1 })
    expect(h.canRedo()).toBe(true)
  })

  test('redo pops future and pushes current state back onto past', () => {
    const h = createHistory()
    h.push({ state: emptyState(0.5), label: 'pre-A' })
    h.push({ state: emptyState(0.6), label: 'pre-B' })
    h.undo(emptyState(0.7))
    const entry = h.redo(emptyState(0.6))
    expect(entry).not.toBeNull()
    expect(entry!.state.masterGain).toBe(0.7)
    expect(h.sizes()).toEqual({ past: 2, future: 0 })
  })

  test('undo returns null when empty', () => {
    const h = createHistory()
    expect(h.undo(emptyState())).toBeNull()
  })

  test('redo returns null when empty', () => {
    const h = createHistory()
    h.push({ state: emptyState(0.5), label: 'a' })
    expect(h.redo(emptyState())).toBeNull()
  })

  test('new push after undo clears the future stack', () => {
    const h = createHistory()
    h.push({ state: emptyState(0.5), label: 'a' })
    h.push({ state: emptyState(0.6), label: 'b' })
    h.undo(emptyState(0.7))
    expect(h.canRedo()).toBe(true)
    h.push({ state: emptyState(0.8), label: 'c' })
    expect(h.canRedo()).toBe(false)
  })

  test('clear empties both stacks', () => {
    const h = createHistory()
    h.push({ state: emptyState(0.5), label: 'a' })
    h.push({ state: emptyState(0.6), label: 'b' })
    h.undo(emptyState(0.7))
    h.clear()
    expect(h.canUndo()).toBe(false)
    expect(h.canRedo()).toBe(false)
  })

  test('coalesce replaces previous entry when key matches within window', () => {
    let t = 1000
    const h = createHistory(() => t)
    h.push(
      { state: emptyState(0.5), label: 'drag start' },
      { coalesceKey: 'drag-k' },
    )
    t = 1100
    h.push(
      { state: emptyState(0.6), label: 'drag mid' },
      { coalesceKey: 'drag-k' },
    )
    t = 1200
    h.push(
      { state: emptyState(0.7), label: 'drag end' },
      { coalesceKey: 'drag-k' },
    )
    expect(h.sizes().past).toBe(1)
    // The state captured is the FIRST push's state, that's the pre-drag snapshot.
    const entry = h.undo(emptyState(0.99))
    expect(entry!.state.masterGain).toBe(0.5)
  })

  test('coalesce does NOT replace when key differs', () => {
    let t = 1000
    const h = createHistory(() => t)
    h.push({ state: emptyState(0.5), label: 'a' }, { coalesceKey: 'a-key' })
    t = 1100
    h.push({ state: emptyState(0.6), label: 'b' }, { coalesceKey: 'b-key' })
    expect(h.sizes().past).toBe(2)
  })

  test('coalesce does NOT replace beyond the window', () => {
    let t = 1000
    const h = createHistory(() => t)
    h.push(
      { state: emptyState(0.5), label: 'a' },
      { coalesceKey: 'drag', coalesceMs: 500 },
    )
    t = 2000 // 1000 ms later, way past the 500 ms window
    h.push(
      { state: emptyState(0.6), label: 'b' },
      { coalesceKey: 'drag', coalesceMs: 500 },
    )
    expect(h.sizes().past).toBe(2)
  })

  test('coalesce on first push appends (no previous to replace)', () => {
    const h = createHistory()
    h.push({ state: emptyState(0.5), label: 'a' }, { coalesceKey: 'drag' })
    expect(h.sizes().past).toBe(1)
  })

  test('cap drops oldest at 100 entries', () => {
    const h = createHistory()
    for (let i = 0; i < 105; i++) {
      h.push({ state: emptyState(i / 100), label: `m${i}` })
    }
    expect(h.sizes().past).toBe(100)
    // The earliest entry should now be index 5 (since 0..4 were dropped).
    // Undo five entries, they should be the most recent ones.
    let current = emptyState(2)
    for (let i = 0; i < 5; i++) {
      const e = h.undo(current)
      expect(e).not.toBeNull()
      current = e!.state
    }
    // The next undo's state.masterGain should be 99/100 from m99? No, undo
    // pops from the END (most recent push). After 5 undos: 104,103,102,101,100.
    // We started with 105 pushes (0..104), capped to last 100 (5..104). After
    // popping 5: state = m100/100 = 1.0
    expect(current.masterGain).toBeCloseTo(1.0, 5)
  })

  test('pushed entry mutates the timestamp field consistently', () => {
    let t = 50
    const h = createHistory(() => t)
    h.push({ state: emptyState(), label: 'a' })
    t = 75
    h.push({ state: emptyState(), label: 'b' })
    // No coalesce key, both should be in the past stack.
    expect(h.sizes().past).toBe(2)
  })
})
