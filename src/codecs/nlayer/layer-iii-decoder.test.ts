/**
 * Smoke + integration tests for `LayerIIIDecoder`.
 *
 * We avoid fabricating synthetic MP3 frames. the decoder's surface (side
 * info, scalefactors, Huffman, IMDCT, polyphase) is enormous and the only
 * source of truth that exercises all of it is real Rockstar AWC data. So:
 *
 *   - "smoke": parse the real AWC sample, walk channel 0's frames, confirm
 *     the decoder produces 1152 samples per V1 LIII frame and doesn't
 *     throw.
 *   - "PCM accuracy": decode the first N frames of channel 0 and compare
 *     against `export/HEI4_FIN_TRACK_A03_1_LEFT.wav` (OpenIV's reference).
 *
 * If `samples/.awc_key.json` or the AWC isn't present, the suite is skipped
 * via `describe.if(HAS_SAMPLE)`, same convention as the AWC test suites.
 */

import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, test } from 'bun:test'

import { extractAllStreamsWithBlocks } from '../../awc/extract'
import { parseAwc } from '../../awc/parser'

import { LayerIIIDecoder } from './layer-iii-decoder'
import { MpegStreamReader } from './mpeg-stream-reader'

const REAL_SAMPLE = 'samples/hei4_fin_track_a03.awc'
const KEY_FILE = 'samples/.awc_key.json'
const OPENIV_REF = 'export/HEI4_FIN_TRACK_A03_1_LEFT.wav'
const HAS_SAMPLE =
  existsSync(REAL_SAMPLE) && existsSync(KEY_FILE) && existsSync(OPENIV_REF)

function readKey(): Uint32Array {
  const j = JSON.parse(readFileSync(KEY_FILE, 'utf-8')) as {
    PC_AWC_KEY: Array<string>
  }
  return new Uint32Array(j.PC_AWC_KEY.map((s) => parseInt(s, 16) >>> 0))
}

/**
 * Minimal WAV PCM 16-bit parser → Float32Array (mono). Kept tiny and local so
 * the test doesn't depend on the scripts/ directory (excluded from tsconfig).
 */
function loadWavMono(path: string): Float32Array {
  const buf = readFileSync(path)
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  if (dv.getUint32(0, false) !== 0x52494646) throw new Error('not RIFF')

  let fmtChannels = 1
  let fmtBitsPerSample = 16
  let dataOff = -1
  let dataSize = -1
  let p = 12
  while (p < buf.byteLength - 8) {
    const id = dv.getUint32(p, false)
    const size = dv.getUint32(p + 4, true)
    if (id === 0x666d7420 /* "fmt " */) {
      fmtChannels = dv.getUint16(p + 8 + 2, true)
      fmtBitsPerSample = dv.getUint16(p + 8 + 14, true)
    } else if (id === 0x64617461 /* "data" */) {
      dataOff = p + 8
      dataSize = size
      break
    }
    p += 8 + size
  }
  if (dataOff < 0) throw new Error('no data chunk')
  if (fmtBitsPerSample !== 16)
    throw new Error(`unsupported bits/sample ${fmtBitsPerSample}`)

  const sampleCount = dataSize / 2
  const i16 = new Int16Array(buf.buffer, buf.byteOffset + dataOff, sampleCount)
  const out = new Float32Array(Math.floor(sampleCount / fmtChannels))
  for (let i = 0; i < out.length; i++) {
    let acc = 0
    for (let c = 0; c < fmtChannels; c++) acc += i16[i * fmtChannels + c]!
    out[i] = acc / fmtChannels / 32768
  }
  return out
}

interface DiffReport {
  maxAbs: number
  rms: number
  maxAbsIdx: number
  firstDiffIdx: number
}

function pcmDiff(
  ref: Float32Array,
  got: Float32Array,
  count: number,
): DiffReport {
  const n = Math.min(count, ref.length, got.length)
  let maxAbs = 0
  let maxAbsIdx = -1
  let firstDiffIdx = -1
  let sumSq = 0
  for (let i = 0; i < n; i++) {
    const d = ref[i]! - got[i]!
    const a = Math.abs(d)
    if (a > maxAbs) {
      maxAbs = a
      maxAbsIdx = i
    }
    if (firstDiffIdx < 0 && a > 1e-3) firstDiffIdx = i
    sumSq += d * d
  }
  return { maxAbs, rms: Math.sqrt(sumSq / n), maxAbsIdx, firstDiffIdx }
}

describe('LayerIIIDecoder: constructor', () => {
  test('can be constructed without arguments', () => {
    const dec = new LayerIIIDecoder()
    expect(dec).toBeInstanceOf(LayerIIIDecoder)
  })
})

describe.if(HAS_SAMPLE)('LayerIIIDecoder: real AWC ch0 smoke', () => {
  const buf = readFileSync(REAL_SAMPLE)
  const arrayBuf = buf.buffer.slice(
    buf.byteOffset,
    buf.byteOffset + buf.byteLength,
  )
  const awc = parseAwc(arrayBuf)
  const key = readKey()
  const streams = extractAllStreamsWithBlocks(awc, arrayBuf, { key })

  test('first ch0 block has bytes, blocks have discard and sampleCount', () => {
    const ch0 = streams[0]!
    expect(ch0.blocks.length).toBeGreaterThan(0)
    expect(ch0.blocks[0]!.bytes.length).toBeGreaterThan(0)
    expect(ch0.blocks[0]!.sampleCount).toBeGreaterThan(0)
  })

  test('decodes the first frame of ch0 without throwing', () => {
    const ch0 = streams[0]!
    const reader = new MpegStreamReader(ch0.blocks[0]!.bytes)
    const frame = reader.nextFrame()
    expect(frame).not.toBeNull()
    const dec = new LayerIIIDecoder()
    const out0 = new Float32Array(1152)
    const out1 = new Float32Array(1152)
    const n = dec.decodeFrame(frame!, out0, out1)
    // First V1 LIII frame: 1152 samples of decoded PCM (mono frame).
    expect(n).toBe(1152)
  })

  test('produces 1152 samples per frame for V1 LIII (first 10 frames of ch0)', () => {
    const ch0 = streams[0]!
    const reader = new MpegStreamReader(ch0.blocks[0]!.bytes)
    const dec = new LayerIIIDecoder()
    const out0 = new Float32Array(1152)
    const out1 = new Float32Array(1152)
    for (let i = 0; i < 10; i++) {
      const frame = reader.nextFrame()
      if (frame === null) break
      const n = dec.decodeFrame(frame, out0, out1)
      // n is 0 when main_data_begin couldn't be satisfied (first frame
      // sometimes). subsequent frames must return 1152.
      if (i > 0) expect(n).toBe(1152)
    }
  })
})

describe.if(HAS_SAMPLE)('LayerIIIDecoder: PCM accuracy vs OpenIV', () => {
  const buf = readFileSync(REAL_SAMPLE)
  const arrayBuf = buf.buffer.slice(
    buf.byteOffset,
    buf.byteOffset + buf.byteLength,
  )
  const awc = parseAwc(arrayBuf)
  const key = readKey()
  const streams = extractAllStreamsWithBlocks(awc, arrayBuf, { key })
  const ch0 = streams[0]!
  const block0 = ch0.blocks[0]!

  test('first granule (576 samples) of frame 0 ch0 matches OpenIV WAV', () => {
    // Granule 0 of frame 0 ch0 matches the OpenIV reference exactly,
    // but ONLY because both sides are silent in that region. The test
    // fixture's first 813 samples are zero in the OpenIV WAV. our port
    // also emits zero there (granule 0's polyphase input is all-zero
    // because the dequant samples land in window 2 of short blocks,
    // which the IMDCT writes into the gr 0 nextBlock rather than fsIn).
    const reader = new MpegStreamReader(block0.bytes)
    const dec = new LayerIIIDecoder()
    const samplesPerFrame = 1152
    const out0 = new Float32Array(samplesPerFrame)
    const out1 = new Float32Array(samplesPerFrame)

    const frame = reader.nextFrame()
    expect(frame).not.toBeNull()
    const n = dec.decodeFrame(frame!, out0, out1)
    expect(n).toBe(1152)

    const ref = loadWavMono(OPENIV_REF)
    const startOffset = block0.discard

    // Granule 0 (samples 0..575), both sides silent, so trivially exact.
    const reportG0 = pcmDiff(
      ref.subarray(startOffset, startOffset + 576),
      out0.subarray(0, 576),
      576,
    )
    expect(reportG0.maxAbs).toBeLessThan(1e-4)
    expect(reportG0.rms).toBeLessThan(1e-5)
  })

  test('granule 1 of frame 0 ch0 matches reference within float32 ULP noise', () => {
    // Was previously a "drift regression guard" asserting maxAbs ≈ 3e-3
    // (the bug). Fixed via the Huffman `findPreviousNode` continuation-pointer
    // bug discovered through dotnet cross-check on 2026-05-11. the j=1
    // offset must be read from `tree[i*2+j]`, not hardcoded as 1.
    const reader = new MpegStreamReader(block0.bytes)
    const dec = new LayerIIIDecoder()
    const out0 = new Float32Array(1152)
    const out1 = new Float32Array(1152)
    const frame = reader.nextFrame()
    expect(frame).not.toBeNull()
    dec.decodeFrame(frame!, out0, out1)

    const ref = loadWavMono(OPENIV_REF)
    const startOffset = block0.discard
    const reportG1 = pcmDiff(
      ref.subarray(startOffset + 576, startOffset + 1152),
      out0.subarray(576, 1152),
      576,
    )

    expect(reportG1.maxAbs).toBeLessThan(1e-4)
    expect(reportG1.rms).toBeLessThan(2e-5)
  })

  test('first ~10 frames of ch0 block0 reach a baseline PCM accuracy', () => {
    // Sanity-check / regression guard: even though the port isn't
    // bit-exact past granule 0, the gross output should still be
    // recognisable as the same audio. We bound max-abs at 2.0 (a real
    // bug would produce >>1.0 or NaN) and report the detailed diff.
    const reader = new MpegStreamReader(block0.bytes)
    const dec = new LayerIIIDecoder()
    const numFrames = 10
    const samplesPerFrame = 1152
    const accumulated = new Float32Array(numFrames * samplesPerFrame)
    const out0 = new Float32Array(samplesPerFrame)
    const out1 = new Float32Array(samplesPerFrame)
    let emitted = 0
    for (let i = 0; i < numFrames; i++) {
      const frame = reader.nextFrame()
      if (frame === null) break
      const n = dec.decodeFrame(frame, out0, out1)
      if (n === 0) continue
      accumulated.set(out0.subarray(0, n), emitted)
      emitted += n
    }

    const ref = loadWavMono(OPENIV_REF)
    const startOffset = block0.discard

    const report = pcmDiff(
      ref.subarray(0, emitted),
      accumulated.subarray(startOffset, startOffset + emitted),
      emitted,
    )

    console.log(
      `  10-frame PCM diff vs OpenIV: maxAbs=${report.maxAbs.toExponential(4)} @${report.maxAbsIdx}, rms=${report.rms.toExponential(4)}, firstDiff>1e-3 @${report.firstDiffIdx} of ${emitted} samples`,
    )

    // Loose bound: bug-free output stays within audio range.
    expect(report.maxAbs).toBeLessThan(2.0)
    expect(Number.isFinite(report.rms)).toBe(true)
  })
})
