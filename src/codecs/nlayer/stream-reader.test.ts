/**
 * Tests for the streamlined byte source. The class is intentionally a thin
 * slice over Uint8Array, so these are basic, but they catch the common
 * bounds-check regressions that would mask real decoder bugs.
 */

import { describe, expect, test } from 'bun:test'

import { ByteSource } from './stream-reader'

describe('ByteSource', () => {
  test('readByte returns each byte and −1 past end', () => {
    const src = new ByteSource(new Uint8Array([0xde, 0xad, 0xbe, 0xef]))
    expect(src.readByte(0)).toBe(0xde)
    expect(src.readByte(3)).toBe(0xef)
    expect(src.readByte(4)).toBe(-1)
    expect(src.readByte(100)).toBe(-1)
  })

  test('readByte rejects negative offsets', () => {
    const src = new ByteSource(new Uint8Array([0]))
    expect(() => src.readByte(-1)).toThrow(RangeError)
  })

  test('read copies the requested range and returns the actual count', () => {
    const src = new ByteSource(new Uint8Array([1, 2, 3, 4, 5]))
    const dest = new Uint8Array(8)
    const n = src.read(1, dest, 2, 3)
    expect(n).toBe(3)
    expect(Array.from(dest)).toEqual([0, 0, 2, 3, 4, 0, 0, 0])
  })

  test('read clamps at end-of-source', () => {
    const src = new ByteSource(new Uint8Array([1, 2, 3]))
    const dest = new Uint8Array(10)
    const n = src.read(1, dest, 0, 10)
    expect(n).toBe(2)
    expect(Array.from(dest.subarray(0, 2))).toEqual([2, 3])
  })

  test('read of past-EOF range returns 0', () => {
    const src = new ByteSource(new Uint8Array([1]))
    const dest = new Uint8Array(4)
    expect(src.read(10, dest, 0, 4)).toBe(0)
  })

  test('read rejects out-of-range dest indices', () => {
    const src = new ByteSource(new Uint8Array([1, 2, 3]))
    const dest = new Uint8Array(4)
    expect(() => src.read(0, dest, 3, 4)).toThrow(RangeError) // 3 + 4 > 4
    expect(() => src.read(0, dest, -1, 1)).toThrow(RangeError)
  })
})
