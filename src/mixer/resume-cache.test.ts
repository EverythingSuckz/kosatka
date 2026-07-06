import { beforeEach, describe, expect, test } from 'bun:test'

import { createHistory } from './history'
import {
  clearResumeCache,
  evictOthers,
  hasResume,
  peekResume,
  stashResume,
} from './resume-cache'
import { SELECTION_NONE } from './selection'
import type { ResumeEntry } from './resume-cache'
import type { TrackSpec } from './types'

// AudioBuffer does not exist under bun, a tiny shape cast stands in. The
// cache never touches the buffer, so nothing more is needed.
const fakeBuffer = { duration: 1.5 } as unknown as AudioBuffer

function makeSpec(id: string): TrackSpec {
  return { id, name: id, buffer: fakeBuffer }
}

function makeEntry(overrides: Partial<ResumeEntry> = {}): ResumeEntry {
  return {
    sessionId: 'session-a',
    displayName: 'song.awc',
    specs: [makeSpec('0-abc'), makeSpec('1-def')],
    history: createHistory(),
    playheadSec: 12.5,
    selection: SELECTION_NONE,
    decodeFailures: [{ streamIndex: 3, message: 'bad frame header' }],
    hashState: { m: [1], g: [100], p: [100], M: 100 },
    savedAt: 1000,
    ...overrides,
  }
}

describe('resume-cache', () => {
  beforeEach(() => {
    clearResumeCache()
  })

  test('stash then peek returns the same entry by identity', () => {
    const entry = makeEntry()
    stashResume(entry)
    const got = peekResume('session-a')
    expect(got).toBe(entry)
    // The live history instance rides along untouched.
    expect(got?.history).toBe(entry.history)
    expect(got?.specs).toBe(entry.specs)
    expect(got?.decodeFailures).toEqual([
      { streamIndex: 3, message: 'bad frame header' },
    ])
  })

  test('peek is non-consuming: repeated peeks keep returning the entry', () => {
    const entry = makeEntry()
    stashResume(entry)
    expect(peekResume('session-a')).toBe(entry)
    expect(peekResume('session-a')).toBe(entry)
    expect(hasResume('session-a')).toBe(true)
  })

  test('peek with a different session id returns null', () => {
    stashResume(makeEntry())
    expect(peekResume('session-b')).toBeNull()
  })

  test('peek on an empty cache returns null', () => {
    expect(peekResume('session-a')).toBeNull()
  })

  test('capacity 1: stashing a second session evicts the first', () => {
    stashResume(makeEntry({ sessionId: 'session-a' }))
    const b = makeEntry({ sessionId: 'session-b' })
    stashResume(b)
    expect(peekResume('session-a')).toBeNull()
    expect(hasResume('session-a')).toBe(false)
    expect(peekResume('session-b')).toBe(b)
  })

  test('evictOthers with the cached id is a no-op', () => {
    const entry = makeEntry({ sessionId: 'session-a' })
    stashResume(entry)
    evictOthers('session-a')
    expect(peekResume('session-a')).toBe(entry)
  })

  test('evictOthers with a different id clears the cache', () => {
    stashResume(makeEntry({ sessionId: 'session-a' }))
    evictOthers('session-b')
    expect(peekResume('session-a')).toBeNull()
    expect(hasResume('session-a')).toBe(false)
    // The evicting session gains nothing, the cache is simply empty.
    expect(peekResume('session-b')).toBeNull()
  })

  test('evictOthers on an empty cache is a no-op', () => {
    evictOthers('session-a')
    expect(hasResume('session-a')).toBe(false)
  })

  test('hasResume reflects the cached session id', () => {
    expect(hasResume('session-a')).toBe(false)
    stashResume(makeEntry({ sessionId: 'session-a' }))
    expect(hasResume('session-a')).toBe(true)
    expect(hasResume('session-b')).toBe(false)
  })

  test('re-stashing the same session overwrites savedAt and playhead', () => {
    stashResume(makeEntry({ savedAt: 1000, playheadSec: 12.5 }))
    stashResume(makeEntry({ savedAt: 2000, playheadSec: 30 }))
    const got = peekResume('session-a')
    expect(got?.savedAt).toBe(2000)
    expect(got?.playheadSec).toBe(30)
  })

  test('clearResumeCache empties the cache', () => {
    stashResume(makeEntry())
    clearResumeCache()
    expect(peekResume('session-a')).toBeNull()
    expect(hasResume('session-a')).toBe(false)
  })
})
