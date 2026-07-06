/**
 * Phase 2 parser tests. Run with `bun test`.
 *
 * Most assertions run against either:
 *   - small hand-built synthetic AWCs (exercise fast paths, error paths, and
 *     the mono single-channel layout for which we have no real-world sample),
 *   - the real Cayo Perico prep track sample that lives in samples/, gated
 *     by a `fs.statSync` so CI without samples still passes.
 */

import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, test } from 'bun:test'

import { awcFileSchema, streamSchema } from './schema'
import { parseAwc } from './parser'
import {
  AwcParseError,
  CHUNK_DATA,
  CHUNK_FORMAT,
  CODEC_ADPCM,
  CODEC_MP3,
  CODEC_PCM,
  MAGIC_LE,
  codecFromId,
} from './types'

// Fixture builder. Emits valid AWC byte sequences for unit tests.

interface MonoFixture {
  kind: 'mono'
  endianness?: 'LE' | 'BE'
  streams: Array<{
    id: number
    /** [type, sizeBytes][]. The size is what the chunk reports. Payload
     *  bytes for data chunks are zeros, format chunks are filled below. */
    chunks: Array<{ type: number; payload: Uint8Array }>
  }>
  formats: Map<number, { sampleRate: number; samples: number; codecId: number }>
  flags?: number
}

function buildMonoAwc(spec: MonoFixture): ArrayBuffer {
  const isLE = (spec.endianness ?? 'LE') === 'LE'
  const flags = spec.flags ?? 0
  const streamCount = spec.streams.length

  // First pass: lay out chunks into the data section, recording offsets.
  const chunkLayout: Array<{
    streamIdx: number
    type: number
    payload: Uint8Array
    offset: number // filled below
  }> = []
  for (let s = 0; s < spec.streams.length; s++) {
    const stream = spec.streams[s]!
    for (const c of stream.chunks) {
      chunkLayout.push({
        streamIdx: s,
        type: c.type,
        payload: c.payload,
        offset: 0,
      })
    }
  }

  const headerSize = 16
  const streamInfoBytes = streamCount * 4
  const chunkInfoBytes = chunkLayout.length * 8
  const dataStart = headerSize + streamInfoBytes + chunkInfoBytes

  let cursor = dataStart
  for (const c of chunkLayout) {
    c.offset = cursor
    cursor += c.payload.length
  }
  const totalSize = cursor

  const buf = new ArrayBuffer(totalSize)
  const view = new DataView(buf)
  const u8 = new Uint8Array(buf)

  // Header
  view.setUint32(0, MAGIC_LE, true) // raw little-endian
  if (!isLE) {
    // For BE fixtures we'd write 0x41444154 here. We don't currently exercise
    // that path because all our real samples are LE.
    view.setUint32(0, 0x41444154, true)
  }
  view.setUint16(4, 1, isLE) // version
  view.setUint16(6, flags, isLE)
  view.setUint32(8, streamCount, isLE)
  view.setUint32(12, dataStart, isLE)

  // Stream-info array
  let off = headerSize
  for (const stream of spec.streams) {
    const raw = (stream.id & 0x1fffffff) | ((stream.chunks.length & 0x7) << 29)
    view.setUint32(off, raw >>> 0, isLE)
    off += 4
  }

  // Chunk-info array
  for (const c of chunkLayout) {
    // type (top byte) + size (28b) + offset (28b)
    const sizeMasked = c.payload.length & 0x0fffffff
    const offMasked = c.offset & 0x0fffffff
    const lo = ((sizeMasked & 0xf) << 28) | offMasked
    const hi = ((c.type & 0xff) << 24) | (sizeMasked >>> 4)
    if (isLE) {
      view.setUint32(off, lo >>> 0, true)
      view.setUint32(off + 4, hi >>> 0, true)
    } else {
      view.setUint32(off, hi >>> 0, false)
      view.setUint32(off + 4, lo >>> 0, false)
    }
    off += 8
  }

  // Chunk payloads (formats already encoded into payloads by caller, data chunks zero-filled)
  for (const c of chunkLayout) {
    u8.set(c.payload, c.offset)
  }

  return buf
}

function encodeFormatChunk(opts: {
  samples: number
  sampleRate: number
  codecId: number
}): Uint8Array {
  const buf = new ArrayBuffer(20)
  const v = new DataView(buf)
  v.setUint32(0, opts.samples, true)
  v.setInt32(4, -1, true) // loopPoint
  v.setUint16(8, opts.sampleRate, true)
  v.setInt16(10, 0, true) // headroom
  v.setUint16(12, 0, true) // loopBegin
  v.setUint16(14, 0, true) // loopEnd
  v.setUint16(16, 0, true) // playEnd
  v.setUint8(18, 0) // playBegin
  v.setUint8(19, opts.codecId)
  return new Uint8Array(buf)
}

describe('codecFromId', () => {
  test('maps known codecs', () => {
    expect(codecFromId(CODEC_PCM)).toBe('pcm')
    expect(codecFromId(CODEC_ADPCM)).toBe('adpcm')
    expect(codecFromId(CODEC_MP3)).toBe('mp3')
  })

  test("falls through to 'unknown' for everything else", () => {
    for (const id of [1, 2, 3, 5, 6, 8, 99, 255]) {
      expect(codecFromId(id)).toBe('unknown')
    }
  })
})

describe('parseAwc: error paths', () => {
  test('buffer too small throws with offset 0', () => {
    expect(() => parseAwc(new ArrayBuffer(8))).toThrow(AwcParseError)
  })

  test('bad magic throws with offset 0 and a hint about whole-file encryption', () => {
    const buf = new ArrayBuffer(16)
    new DataView(buf).setUint32(0, 0xdeadbeef, true)
    let err: unknown
    try {
      parseAwc(buf)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(AwcParseError)
    const msg = (err as Error).message
    expect(msg).toContain('0xdeadbeef')
    expect(msg).toContain('Whole-file XXTEA')
  })

  test('wrong version throws', () => {
    const buf = new ArrayBuffer(16)
    const v = new DataView(buf)
    v.setUint32(0, MAGIC_LE, true)
    v.setUint16(4, 99, true) // bad version
    v.setUint16(6, 0, true)
    v.setUint32(8, 0, true)
    v.setUint32(12, 16, true)
    expect(() => parseAwc(buf)).toThrow(/version 99/)
  })
})

describe('parseAwc: synthetic mono single-stream', () => {
  test('parses a single-stream PCM mono fixture', () => {
    const dataPayload = new Uint8Array(256) // 256 zero bytes posing as PCM
    const fmtPayload = encodeFormatChunk({
      samples: 128,
      sampleRate: 48000,
      codecId: CODEC_PCM,
    })
    const buf = buildMonoAwc({
      kind: 'mono',
      streams: [
        {
          id: 0xabc1234,
          chunks: [
            { type: CHUNK_FORMAT, payload: fmtPayload },
            { type: CHUNK_DATA, payload: dataPayload },
          ],
        },
      ],
      formats: new Map(),
      flags: 0,
    })

    const awc = parseAwc(buf)
    expect(awc.header.endianness).toBe('LE')
    expect(awc.header.streamCount).toBe(1)
    expect(awc.header.flagBits.multiChannel).toBe(false)

    expect(awc.streams).toHaveLength(1)
    const s = awc.streams[0]!
    expect(s.codec).toBe('pcm')
    expect(s.sampleRate).toBe(48000)
    expect(s.sampleCount).toBe(128)
    expect(s.layout.kind).toBe('mono')
    if (s.layout.kind === 'mono') {
      expect(s.layout.dataSize).toBe(256)
      expect(s.layout.encrypted).toBe(false)
      // Payload is zero-filled. Sanity-check the offset points inside the buffer.
      expect(s.layout.dataOffset).toBeGreaterThanOrEqual(16)
      expect(s.layout.dataOffset + s.layout.dataSize).toBeLessThanOrEqual(
        buf.byteLength,
      )
    }

    expect(streamSchema.parse(s)).toBeDefined()
    expect(awcFileSchema.parse(awc)).toBeDefined()
  })

  test('parses a single-stream ADPCM mono fixture and reports codec correctly', () => {
    const fmtPayload = encodeFormatChunk({
      samples: 1024,
      sampleRate: 24000,
      codecId: CODEC_ADPCM,
    })
    const buf = buildMonoAwc({
      kind: 'mono',
      streams: [
        {
          id: 0x1,
          chunks: [
            { type: CHUNK_FORMAT, payload: fmtPayload },
            { type: CHUNK_DATA, payload: new Uint8Array(2048) },
          ],
        },
      ],
      formats: new Map(),
    })
    const awc = parseAwc(buf)
    expect(awc.streams[0]?.codec).toBe('adpcm')
    expect(awc.streams[0]?.sampleRate).toBe(24000)
  })
})

// Real-file integration: hei4_prep_track_a02.awc (Cayo Perico, 16 stems, MP3)

// Tests are expected to run from the project root (the bun test default).
const REAL_SAMPLE = 'samples/hei4_prep_track_a02.awc'
const HAS_SAMPLE = existsSync(REAL_SAMPLE)

describe.if(HAS_SAMPLE)(
  'parseAwc: Cayo Perico hei4_prep_track_a02 (real sample)',
  () => {
    const buf = HAS_SAMPLE ? readFileSync(REAL_SAMPLE) : Buffer.alloc(0)
    const arrayBuf = buf.buffer.slice(
      buf.byteOffset,
      buf.byteOffset + buf.byteLength,
    )
    const awc = HAS_SAMPLE ? parseAwc(arrayBuf) : null

    test('header: Legacy/LE, version 1, multi-channel + per-block encrypted', () => {
      expect(awc?.header.endianness).toBe('LE')
      expect(awc?.header.version).toBe(1)
      expect(awc?.header.flagBits.multiChannel).toBe(true)
      expect(awc?.header.flagBits.multiChannelEncrypt).toBe(true)
      expect(awc?.header.flagBits.chunkIndices).toBe(true)
    })

    test('streamformat: 16 channels, 48 kHz, codec 7 (mp3)', () => {
      expect(awc?.streamFormat).not.toBeNull()
      const sf = awc!.streamFormat!
      expect(sf.channelCount).toBe(16)
      for (const ch of sf.channels) {
        expect(ch.sampleRate).toBe(48000)
        expect(ch.codecId).toBe(CODEC_MP3)
      }
    })

    test('aggregated stems: 16 mc-channel entries, all codec=mp3, all ~3:52', () => {
      expect(awc?.streams).toHaveLength(16)
      for (const s of awc!.streams) {
        expect(s.codec).toBe('mp3')
        expect(s.sampleRate).toBe(48000)
        expect(s.layout.kind).toBe('mc-channel')
        // Track is roughly 3:50–3:56 across stems, just check it lands in that band.
        expect(s.durationSeconds).toBeGreaterThan(220)
        expect(s.durationSeconds).toBeLessThan(240)
      }
    })

    test('source layout: blockCount=77, blockSize=524288, encrypted', () => {
      expect(awc?.streams[0]?.layout.kind).toBe('mc-channel')
      if (awc?.streams[0]?.layout.kind === 'mc-channel') {
        const src = awc.streams[0].layout.source
        expect(src.blockCount).toBe(77)
        expect(src.blockSize).toBe(524288)
        expect(src.channelCount).toBe(16)
        expect(src.encrypted).toBe(true)
        // Data chunk extends to end of file (or near it), just check it fits.
        expect(src.dataOffset + src.dataSize).toBeLessThanOrEqual(
          arrayBuf.byteLength,
        )
      }
    })

    test('zod schema: full AwcFile is well-formed', () => {
      expect(awcFileSchema.parse(awc)).toBeDefined()
    })
  },
)
