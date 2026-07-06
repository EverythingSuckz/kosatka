/**
 * Self-consistency tests for the NG cipher. We don't have an independent
 * test vector for Rockstar's specific Feistel parameters, so we test the
 * invariants that the cipher's structure guarantees:
 *
 *   - Tail bytes < 16 pass through unmodified.
 *   - All-zero block decryption produces deterministic output (sanity).
 *   - Building NgContext from raw byte slices doesn't lose information
 *     (re-extracting the u32 view round-trips).
 *
 * The end-to-end "decrypts a real NG-encrypted RPF" check lives in the
 * gated parser.test.ts.
 */

import { describe, expect, test } from 'bun:test'

import {
  NG_COLS,
  NG_ENTRIES,
  NG_ROUNDS,
  buildNgContext,
  buildNgSubKeys,
  buildNgTables,
  decryptNg,
} from './feistel'

function makeFakeKeys(): Uint8Array {
  // 101 sub-keys × 272 bytes = 27472 bytes. Fill with a deterministic
  // pattern so we can verify u32 reconstruction.
  const u = new Uint8Array(101 * 272)
  for (let i = 0; i < u.length; i++) u[i] = i & 0xff
  return u
}

function makeFakeTables(): Uint8Array {
  // 17 × 16 × 256 × 4 = 278528 bytes.
  const u = new Uint8Array(NG_ROUNDS * NG_COLS * NG_ENTRIES * 4)
  for (let i = 0; i < u.length; i++) u[i] = (i * 17) & 0xff
  return u
}

function makeFakeLut(): Uint8Array {
  const u = new Uint8Array(256)
  for (let i = 0; i < 256; i++) u[i] = (i * 31 + 7) & 0xff
  return u
}

describe('NG cipher: structural invariants', () => {
  test('buildNgTables / buildNgSubKeys reject wrong-sized inputs', () => {
    expect(() => buildNgTables(new Uint8Array(10))).toThrow(/278528/)
    expect(() => buildNgSubKeys(new Uint8Array(10))).toThrow(/27472/)
  })

  test('buildNgContext round-trips', () => {
    const ctx = buildNgContext(makeFakeKeys(), makeFakeTables(), makeFakeLut())
    expect(ctx.subKeys.length).toBe(101 * 17 * 4)
    expect(ctx.tables.data.length).toBe(NG_ROUNDS * NG_COLS * NG_ENTRIES)
    expect(ctx.lut.length).toBe(256)
    // Spot-check a u32 is the correct LE composition of 4 bytes.
    // sub-key 0, round 0, u32 0 = bytes [0,1,2,3] = 0x03020100.
    expect(ctx.subKeys[0]).toBe(0x03020100)
  })

  test('tail bytes (< 16) pass through unchanged', () => {
    const ctx = buildNgContext(makeFakeKeys(), makeFakeTables(), makeFakeLut())
    // 23 bytes = 1 block (16) + 7 tail bytes.
    const data = new Uint8Array(23)
    for (let i = 0; i < 23; i++) data[i] = 0xaa
    const expectedTail = data.subarray(16).slice() // copy
    decryptNg(data, 'test.rpf', 1024, ctx)
    expect(data.subarray(16)).toEqual(expectedTail)
  })

  test('empty input is a no-op', () => {
    const ctx = buildNgContext(makeFakeKeys(), makeFakeTables(), makeFakeLut())
    const data = new Uint8Array(0)
    expect(() => decryptNg(data, 'foo.rpf', 0, ctx)).not.toThrow()
    expect(data.length).toBe(0)
  })

  test('all-zero block decryption is deterministic across calls', () => {
    const ctx = buildNgContext(makeFakeKeys(), makeFakeTables(), makeFakeLut())
    const a = new Uint8Array(16)
    const b = new Uint8Array(16)
    decryptNg(a, 'same.rpf', 4096, ctx)
    decryptNg(b, 'same.rpf', 4096, ctx)
    expect(a).toEqual(b)
  })

  test('different archive names produce different outputs', () => {
    const ctx = buildNgContext(makeFakeKeys(), makeFakeTables(), makeFakeLut())
    const a = new Uint8Array(16)
    const b = new Uint8Array(16)
    decryptNg(a, 'arch_one.rpf', 4096, ctx)
    decryptNg(b, 'arch_two.rpf', 4096, ctx)
    // Overwhelmingly likely to differ. If they don't, our sub-key indexing
    // (or the cipher) is broken.
    expect(a).not.toEqual(b)
  })
})
