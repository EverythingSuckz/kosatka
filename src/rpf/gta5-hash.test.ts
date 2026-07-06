/**
 * Cross-check the JS GTA5Hash against a couple of hand-computed values from
 * CodeWalker's `GTA5Hash.CalculateHash`. Tests are synthetic. We use a
 * deterministic LUT (identity permutation) so we can hand-derive the
 * expected result for short strings.
 */

import { describe, expect, test } from 'bun:test'

import { gta5Hash, ngKeyIndex } from './gta5-hash'

/** Identity LUT: lut[i] = i. Used so hand-computed expectations are trivial. */
const IDENT_LUT = (() => {
  const u = new Uint8Array(256)
  for (let i = 0; i < 256; i++) u[i] = i
  return u
})()

/** Reference impl mirroring CodeWalker exactly. */
function refHash(name: string, lut: Uint8Array): number {
  let result = 0
  for (let i = 0; i < name.length; i++) {
    const cc = name.charCodeAt(i) & 0xff
    const temp = Math.imul(1025, (lut[cc]! + result) | 0) >>> 0
    result = ((temp >>> 6) ^ temp) >>> 0
  }
  const r9 = Math.imul(9, result) >>> 0
  return Math.imul(32769, ((r9 >>> 11) ^ r9) >>> 0) >>> 0
}

describe('gta5Hash', () => {
  test('empty string hashes to 0', () => {
    expect(gta5Hash('', IDENT_LUT)).toBe(0)
  })

  test('matches the reference impl for short ASCII names', () => {
    const cases = [
      'a',
      'dlc.rpf',
      'mpHeist4.rpf',
      'audio/sfx/dlc_hei4_music.rpf',
      'A',
    ]
    for (const c of cases) {
      expect(gta5Hash(c, IDENT_LUT)).toBe(refHash(c, IDENT_LUT))
    }
  })

  test('rejects LUTs of the wrong size', () => {
    expect(() => gta5Hash('foo', new Uint8Array(128))).toThrow()
    expect(() => gta5Hash('foo', new Uint8Array(257))).toThrow()
  })

  test('output is always within u32 range', () => {
    // Pick some inputs that should exercise the high bits.
    const names = [
      'x'.repeat(255),
      '\xff'.repeat(64),
      'AbCdEfGh' + 'z'.repeat(200),
    ]
    for (const n of names) {
      const h = gta5Hash(n, IDENT_LUT)
      expect(h).toBeGreaterThanOrEqual(0)
      expect(h).toBeLessThanOrEqual(0xffffffff)
      expect(Number.isInteger(h)).toBe(true)
    }
  })
})

describe('ngKeyIndex', () => {
  test('falls in [0, 100]', () => {
    // Exercise a few names with arbitrary lengths.
    const lengths = [0, 1, 1024, 0x80000000, 0xffffffff]
    const names = ['dlc.rpf', 'mpheist4/dlc.rpf', 'a.rpf', '']
    for (const name of names) {
      for (const len of lengths) {
        const idx = ngKeyIndex(name, len, IDENT_LUT)
        expect(idx).toBeGreaterThanOrEqual(0)
        expect(idx).toBeLessThan(101)
      }
    }
  })

  test('handles length > 2^31 without sign-bit corruption', () => {
    // The dangerous case: u32 with bit 31 set. Result must still be in range.
    const idx = ngKeyIndex('foo.rpf', 0xfffffffe, IDENT_LUT)
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(idx).toBeLessThan(101)
  })
})
