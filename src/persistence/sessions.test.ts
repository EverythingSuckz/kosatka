/**
 * Tests for the pure session-store helpers. bun has no IndexedDB shim, so
 * the IDB glue (persist/load/delete/list) stays untested here, the same
 * trade-off src/keys makes. The decisions that matter (summary ordering,
 * prune selection) are pure functions and locked in below.
 */

import { describe, expect, test } from 'bun:test'

import { MAX_PERSISTED_SESSIONS, selectPruneIds, toSummaries } from './sessions'

function rec(id: string, createdAt: number, name = `${id}.awc`, content = 'x') {
  return { id, file: new File([content], name), createdAt }
}

describe('toSummaries', () => {
  test('orders newest first', () => {
    const out = toSummaries([rec('old', 100), rec('new', 300), rec('mid', 200)])
    expect(out.map((s) => s.id)).toEqual(['new', 'mid', 'old'])
  })

  test('maps file name and size into the summary', () => {
    const out = toSummaries([rec('a', 1, 'track.awc', 'abcde')])
    expect(out).toEqual([{ id: 'a', name: 'track.awc', size: 5, createdAt: 1 }])
  })

  test('ties on createdAt keep input order (stable)', () => {
    const out = toSummaries([
      rec('first', 100),
      rec('second', 100),
      rec('third', 100),
    ])
    expect(out.map((s) => s.id)).toEqual(['first', 'second', 'third'])
  })

  test('empty input gives empty output', () => {
    expect(toSummaries([])).toEqual([])
  })

  test('does not mutate the input array', () => {
    const input = [rec('a', 1), rec('b', 2)]
    toSummaries(input)
    expect(input.map((r) => r.id)).toEqual(['a', 'b'])
  })
})

describe('selectPruneIds', () => {
  test('returns empty when record count is below max', () => {
    expect(selectPruneIds([{ id: 'a', createdAt: 1 }], 5)).toEqual([])
  })

  test('returns empty at exactly max', () => {
    const records = [
      { id: 'a', createdAt: 1 },
      { id: 'b', createdAt: 2 },
    ]
    expect(selectPruneIds(records, 2)).toEqual([])
  })

  test('drops the oldest records beyond max', () => {
    const records = [
      { id: 'mid', createdAt: 200 },
      { id: 'newest', createdAt: 400 },
      { id: 'oldest', createdAt: 100 },
      { id: 'newer', createdAt: 300 },
    ]
    expect(selectPruneIds(records, 2)).toEqual(['mid', 'oldest'])
  })

  test('max of zero deletes everything', () => {
    const records = [
      { id: 'a', createdAt: 1 },
      { id: 'b', createdAt: 2 },
    ]
    expect(selectPruneIds(records, 0)).toEqual(['b', 'a'])
  })

  test('ties on createdAt prune later-input records first (stable)', () => {
    const records = [
      { id: 'first', createdAt: 100 },
      { id: 'second', createdAt: 100 },
      { id: 'third', createdAt: 100 },
    ]
    expect(selectPruneIds(records, 2)).toEqual(['third'])
  })

  test('empty input gives empty output', () => {
    expect(selectPruneIds([], 5)).toEqual([])
  })
})

describe('MAX_PERSISTED_SESSIONS', () => {
  test('caps the store at five records', () => {
    expect(MAX_PERSISTED_SESSIONS).toBe(5)
  })
})
