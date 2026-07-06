/**
 * Phase 3 codec tests. Only the pure (non-AudioContext) paths are tested
 * here under bun:test. MP3 decoding is browser-native via decodeAudioData
 * and is exercised by the mixer end-to-end in the dev server.
 */

import { describe, expect, test } from 'bun:test'

import { decodePcm16Samples } from './pcm16'

describe('decodePcm16Samples', () => {
  test('decodes little-endian Int16 bytes', () => {
    // Two samples: 1 (= 0x0001 LE = 01 00) and -2 (= 0xFFFE LE = FE FF).
    const bytes = new Uint8Array([0x01, 0x00, 0xfe, 0xff])
    const samples = decodePcm16Samples(bytes, true)
    expect(samples.length).toBe(2)
    expect(samples[0]).toBe(1)
    expect(samples[1]).toBe(-2)
  })

  test('decodes big-endian Int16 bytes', () => {
    const bytes = new Uint8Array([0x00, 0x01, 0xff, 0xfe])
    const samples = decodePcm16Samples(bytes, false)
    expect(samples[0]).toBe(1)
    expect(samples[1]).toBe(-2)
  })

  test('odd-byte input drops the trailing byte', () => {
    const bytes = new Uint8Array([0x01, 0x00, 0x42])
    const samples = decodePcm16Samples(bytes, true)
    expect(samples.length).toBe(1)
    expect(samples[0]).toBe(1)
  })
})
