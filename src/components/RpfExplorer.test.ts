/**
 * Unit tests for the filter + sort pure-functions backing the RpfExplorer.
 * The lazy-peek + React behaviour is exercised manually in the browser. the
 * core list semantics are extracted into {@link filterAndSort} so we can
 * cover them here without a DOM.
 */

import { describe, expect, test } from 'bun:test'

import { filterAndSort } from './RpfExplorer'
import type { RpfEntry } from '../rpf'

function makeEntry(path: string, size: number, name?: string): RpfEntry {
  const finalName = name ?? path.slice(path.lastIndexOf('/') + 1)
  return {
    path,
    name: finalName,
    size,
    isDirectory: false,
    isResource: false,
    isEncrypted: false,
    isCompressed: false,
    read: () => Promise.resolve(new Uint8Array(0)),
  }
}

describe('filterAndSort', () => {
  const entries: Array<RpfEntry> = [
    makeEntry(
      'x64/audio/sfx/dlc_hei4_music/hei4_prep_track_a02.awc',
      4_000_000,
    ),
    makeEntry(
      'x64/audio/sfx/dlc_hei4_music/hei4_prep_track_a04.awc',
      3_000_000,
    ),
    makeEntry('x64/audio/sfx/resident/intro.awc', 8_000_000),
    makeEntry('x64/audio/sfx/resident/bingo.awc', 1_000_000),
  ]

  test('name-asc sorts by basename ascending', () => {
    const got = filterAndSort(entries, '', 'name-asc').map((e) => e.name)
    expect(got).toEqual([
      'bingo.awc',
      'hei4_prep_track_a02.awc',
      'hei4_prep_track_a04.awc',
      'intro.awc',
    ])
  })

  test('path-asc sorts by full path ascending', () => {
    const got = filterAndSort(entries, '', 'path-asc').map((e) => e.path)
    // dlc_hei4_music < resident lexically, within each alphabetic.
    expect(got[0]).toContain('hei4_prep_track_a02')
    expect(got[3]).toContain('resident/intro')
  })

  test('size-desc sorts by size descending', () => {
    const got = filterAndSort(entries, '', 'size-desc').map((e) => e.size)
    expect(got).toEqual([8_000_000, 4_000_000, 3_000_000, 1_000_000])
  })

  test('size-asc reverses the size order (direction toggle)', () => {
    const got = filterAndSort(entries, '', 'size-asc').map((e) => e.size)
    expect(got).toEqual([1_000_000, 3_000_000, 4_000_000, 8_000_000])
  })

  test('name-desc reverses the name order (direction toggle)', () => {
    const asc = filterAndSort(entries, '', 'name-asc').map((e) => e.name)
    const desc = filterAndSort(entries, '', 'name-desc').map((e) => e.name)
    expect(desc).toEqual([...asc].reverse())
  })

  test('search matches name (case-insensitive)', () => {
    const got = filterAndSort(entries, 'BINGO', 'name-asc').map((e) => e.name)
    expect(got).toEqual(['bingo.awc'])
  })

  test('search matches path', () => {
    const got = filterAndSort(entries, 'hei4_music', 'name-asc').map(
      (e) => e.name,
    )
    expect(got.length).toBe(2)
    expect(got).toContain('hei4_prep_track_a02.awc')
    expect(got).toContain('hei4_prep_track_a04.awc')
  })

  test('whitespace-only search returns everything', () => {
    const got = filterAndSort(entries, '   ', 'name-asc')
    expect(got.length).toBe(entries.length)
  })

  test('no matches returns empty array', () => {
    const got = filterAndSort(entries, 'no-such-thing-zzz', 'name-asc')
    expect(got).toEqual([])
  })

  test('does not mutate input array', () => {
    const original = [...entries]
    filterAndSort(entries, '', 'name-asc')
    expect(entries).toEqual(original)
  })
})
