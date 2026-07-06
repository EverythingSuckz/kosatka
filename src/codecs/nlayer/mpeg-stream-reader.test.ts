/**
 * Tests for the streamlined MpegStreamReader. We test against a real
 * Rockstar AWC channel, the canonical input shape for this port,
 * since synthetic frame sequences would be tedious to construct.
 */

import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, test } from 'bun:test'

import { parseAwc } from '../../awc/parser'
import {
  extractAllStreams,
  extractAllStreamsWithBlocks,
} from '../../awc/extract'
import { MpegStreamReader } from './mpeg-stream-reader'
import { MpegLayer, MpegVersion } from './types'

const REAL_SAMPLE = 'samples/hei4_fin_track_a03.awc'
const KEY_FILE = 'samples/.awc_key.json'
const HAS_SAMPLE = existsSync(REAL_SAMPLE) && existsSync(KEY_FILE)

function readKey(): Uint32Array {
  const j = JSON.parse(readFileSync(KEY_FILE, 'utf-8')) as {
    PC_AWC_KEY: Array<string>
  }
  return new Uint32Array(j.PC_AWC_KEY.map((s) => parseInt(s, 16) >>> 0))
}

describe('MpegStreamReader: synthetic', () => {
  test('throws on a buffer with no frames', () => {
    expect(
      () => new MpegStreamReader(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0])),
    ).toThrow()
  })

  test('throws on a buffer with only one frame (needs two to validate)', () => {
    // Construct: 1 valid Rockstar frame header (no payload, won't sync)
    // The constructor calls findNextFrame twice. With only 4 bytes, second
    // call fails. We can use a partial MP3, but easier to just verify
    // it throws.
    const fake = new Uint8Array(8)
    fake.set([0xff, 0xfa, 0x64, 0xc0, 0, 0, 0, 0])
    expect(() => new MpegStreamReader(fake)).toThrow()
  })
})

describe.if(HAS_SAMPLE)('MpegStreamReader: real Rockstar AWC fixture', () => {
  const buf = HAS_SAMPLE ? readFileSync(REAL_SAMPLE) : Buffer.alloc(0)
  const arrayBuf = buf.buffer.slice(
    buf.byteOffset,
    buf.byteOffset + buf.byteLength,
  )
  const key = HAS_SAMPLE ? readKey() : new Uint32Array(4)
  const awc = HAS_SAMPLE ? parseAwc(arrayBuf) : null

  test('parses channel 0 with all frames as V1/LIII/48k', () => {
    const all = extractAllStreams(awc!, arrayBuf, { key })
    const ch0 = all[0]!
    const reader = new MpegStreamReader(ch0)
    expect(reader.sampleRate).toBe(48000)
    // Walk all frames. Each must be MPEG-1 Layer III.
    let count = 0
    let f = reader.getCurrentFrame()
    while (f !== null) {
      expect(f.version).toBe(MpegVersion.Version1)
      expect(f.layer).toBe(MpegLayer.LayerIII)
      count++
      reader.nextFrame()
      f = reader.getCurrentFrame()
    }
    // 11342769 samples / 1152 samples/frame ≈ 9846 frames (V1 LIII).
    expect(count).toBeGreaterThan(9000)
  })

  test('sampleOffset increments by 1152 per frame', () => {
    const all = extractAllStreams(awc!, arrayBuf, { key })
    const reader = new MpegStreamReader(all[0]!)
    const prev = reader.getCurrentFrame()
    expect(prev).not.toBeNull()
    expect(prev!.sampleOffset).toBe(0)
    reader.nextFrame()
    const second = reader.getCurrentFrame()
    expect(second).not.toBeNull()
    expect(second!.sampleOffset).toBe(1152)
  })

  test('seekTo positions on the correct frame', () => {
    const all = extractAllStreams(awc!, arrayBuf, { key })
    const reader = new MpegStreamReader(all[0]!)
    // Seek to sample 1152 * 10 + 500, should land on frame 10.
    const got = reader.seekTo(1152 * 10 + 500)
    expect(got).toBe(1152 * 10)
    const frame = reader.getCurrentFrame()
    expect(frame).not.toBeNull()
    expect(frame!.number).toBe(10)
  })

  test('sampleCount is a multiple of 1152 and ≥ the AWC declared count', () => {
    // Note: the AWC declared sampleCount is the *post-discard* count.
    // The MP3 stream itself carries (declared + Σ per-block discard)
    // samples, typically tens of thousands more. We only assert the
    // raw decoder sees at least as many samples as the AWC promises.
    const all = extractAllStreams(awc!, arrayBuf, { key })
    const reader = new MpegStreamReader(all[0]!)
    const total = reader.sampleCount
    expect(total % 1152).toBe(0)
    expect(total).toBeGreaterThanOrEqual(awc!.streams[0]!.sampleCount)
  })

  test('admits byte-truncated last frame of an AWC block (truncated-tail handling)', () => {
    // Regression test for the click/pop bug on ch7+ block boundaries:
    // the AWC block at ch10/block 18 contains 125 syncable frames, but
    // the last one declares a frameLength that extends ~16 bytes past
    // the block end. Earlier revisions of this reader rejected the
    // frame entirely, which lost ~24 ms of audio at every block
    // boundary and produced an audible click via the persistent IMDCT
    // state in `LayerIIIDecoder`.
    //
    // The overshoot always falls inside the main_data *stuffing*
    // region (beyond `part_2_3_length` bits), so we accept the frame
    // and let `BitReservoir.addBits` zero-pad the missing slots,
    // see `bit-reservoir.ts` for the EOF-tolerant slot-fill.
    const blocks = extractAllStreamsWithBlocks(awc!, arrayBuf, { key })
    const ch10b18 = blocks[10]!.blocks[18]!.bytes
    expect(ch10b18.length).toBe(30000)
    const reader = new MpegStreamReader(ch10b18)
    let count = 0
    let f = reader.nextFrame()
    while (f !== null) {
      count++
      f = reader.nextFrame()
    }
    // All ~125 syncable frames must be admitted, including the truncated tail.
    expect(count).toBeGreaterThanOrEqual(125)
    expect(count).toBeLessThanOrEqual(126)
  })
})
