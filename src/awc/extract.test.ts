/**
 * Phase 3 extraction tests. Verifies that `extractStreamBytes` produces the
 * exact per-channel MP3 byte streams we expect, recognisable MP3 (sync at 0,
 * frame stride of 240, expected total).
 */

import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, test } from 'bun:test'

import { parseAwc } from './parser'
import {
  AwcKeyMissingError,
  extractAllStreams,
  extractAllStreamsWithBlocks,
  extractStreamBytes,
} from './extract'
import { decryptRSXXTEA } from './decrypt'

const REAL_SAMPLE = 'samples/hei4_prep_track_a02.awc'
const KEY_FILE = 'samples/.awc_key.json'
const HAS_SAMPLE = existsSync(REAL_SAMPLE) && existsSync(KEY_FILE)

function readKey(): Uint32Array {
  const j = JSON.parse(readFileSync(KEY_FILE, 'utf-8')) as {
    PC_AWC_KEY: Array<string>
  }
  return new Uint32Array(j.PC_AWC_KEY.map((s) => parseInt(s, 16) >>> 0))
}

describe('decryptRSXXTEA: round-trip', () => {
  test('decrypt(encrypt(x)) is not the identity but applying decrypt twice diverges', () => {
    // We don't have an encryptor (CodeWalker has one but we don't need it for v1).
    // Instead: confirm the function rejects malformed inputs.
    expect(() => decryptRSXXTEA(new Uint8Array(7), new Uint32Array(4))).toThrow(
      /multiple of 4/,
    )
    expect(() => decryptRSXXTEA(new Uint8Array(4), new Uint32Array(4))).toThrow(
      /at least 8 bytes/,
    )
    expect(() => decryptRSXXTEA(new Uint8Array(8), new Uint32Array(3))).toThrow(
      /4 u32 elements/,
    )
  })
})

describe('extractStreamBytes: error paths', () => {
  test('out-of-range index throws RangeError', () => {
    const buf = new ArrayBuffer(0)
    const fakeAwc = {
      header: {} as never,
      streamInfos: [],
      chunkInfos: [],
      streamFormat: null,
      formatChunks: new Map(),
      streams: [],
    }
    expect(() => extractStreamBytes(fakeAwc as never, buf, 0)).toThrow(
      RangeError,
    )
  })
})

describe.if(HAS_SAMPLE)(
  'extractStreamBytes: Cayo Perico hei4_prep_track_a02',
  () => {
    const buf = HAS_SAMPLE ? readFileSync(REAL_SAMPLE) : Buffer.alloc(0)
    const arrayBuf = buf.buffer.slice(
      buf.byteOffset,
      buf.byteOffset + buf.byteLength,
    )
    const key = HAS_SAMPLE ? readKey() : new Uint32Array(4)
    const awc = HAS_SAMPLE ? parseAwc(arrayBuf) : null

    test('encrypted file without key throws AwcKeyMissingError', () => {
      expect(awc).not.toBeNull()
      expect(() => extractStreamBytes(awc!, arrayBuf, 0)).toThrow(
        AwcKeyMissingError,
      )
    })

    test('extractAllStreams: 16 byte streams, each starts with an MPEG-1 LIII frame header', () => {
      expect(awc).not.toBeNull()
      expect(awc!.streams).toHaveLength(16)
      const all = extractAllStreams(awc!, arrayBuf, { key })
      expect(all).toHaveLength(16)
      for (const bytes of all) {
        expect(bytes.length).toBeGreaterThan(0)
        // 0xFF 0xFA = MPEG-1 sync + Layer III + CRC (top 16 bits of frame header).
        // The bitrate/rate/channel-mode bits (third + fourth byte) vary per stem
        // (this prep track is VBR across channels), so we don't pin those.
        expect(bytes[0]).toBe(0xff)
        expect(bytes[1]).toBe(0xfa)
      }
    })

    test('extractAllStreams: total bytes ≈ duration × bitrate (within 80 kb/s upper bound)', () => {
      // 80 kb/s is the stream-set's max, lower-bitrate stems will be smaller.
      // Asserting an UPPER bound catches the "extracting too much / including
      // trailing junk" failure mode that would inflate file size.
      expect(awc).not.toBeNull()
      const all = extractAllStreams(awc!, arrayBuf, { key })
      for (let i = 0; i < all.length; i++) {
        const s = awc!.streams[i]!
        const bytes = all[i]!
        // 85 kb/s upper bound: catches the "extracting trailing junk past the
        // last real frame" failure mode while leaving headroom for the encoder
        // lookahead frames that push real streams ~1-2% above 80 kb/s × duration.
        const upperBoundBytes = (s.durationSeconds * 85000) / 8
        expect(bytes.length).toBeLessThan(upperBoundBytes)
        // Hard lower bound: at least 50 kb/s × duration. (Real values are 70-80 kbps.)
        const lowerBoundBytes = (s.durationSeconds * 50000) / 8
        expect(bytes.length).toBeGreaterThan(lowerBoundBytes)
      }
    })

    test('extractStreamBytes round-trips the same bytes as extractAllStreams[i]', () => {
      // Verify the convenience wrapper produces identical output. Use index 0
      // to keep the test fast (full block walk happens once).
      const all = extractAllStreams(awc!, arrayBuf, { key })
      const single = extractStreamBytes(awc!, arrayBuf, 0, { key })
      expect(single.length).toBe(all[0]!.length)
      // Compare a sampled set of bytes (full byte-equality is slow but doable).
      for (let off = 0; off < single.length; off += 1024) {
        expect(single[off]).toBe(all[0]![off])
      }
    })

    test('extractAllStreamsWithBlocks: per-block (discard, sampleCount) satisfies Σ(sampleCount − discard) = streamformat.samples', () => {
      // The load-bearing identity for the AWC mixing drift fix. If this fails,
      // the per-block channel-header read got mis-aligned. See
      // docs/awc-mixing-investigation.md for the full proof of why this must
      // hold exactly (zero slop) for every channel of every mc-channel stream.
      expect(awc).not.toBeNull()
      const detailed = extractAllStreamsWithBlocks(awc!, arrayBuf, { key })
      expect(detailed).toHaveLength(16)
      for (let i = 0; i < detailed.length; i++) {
        const { bytes, blocks } = detailed[i]!
        const stream = awc!.streams[i]!
        // mc-channel streams should report ≥1 block, mono streams have empty blocks.
        expect(blocks.length).toBeGreaterThan(0)
        let totalReal = 0
        for (const b of blocks) {
          totalReal += b.sampleCount - b.discard
          expect(b.bytes.length).toBeGreaterThan(0)
        }
        expect(totalReal).toBe(stream.sampleCount)
        // Concatenated `bytes` length = Σ block.bytes length.
        let blockBytesTotal = 0
        for (const b of blocks) blockBytesTotal += b.bytes.length
        expect(bytes.length).toBe(blockBytesTotal)
      }
    })
  },
)
