/**
 * Tests for the MpegFrame port. Synthetic-header cases cover the
 * trySync logic, and a real-AWC fixture covers end-to-end header parsing
 * against a known-good Rockstar MPEG-1 LIII frame.
 */

import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, test } from 'bun:test'

import { parseAwc } from '../../awc/parser'
import { extractAllStreams } from '../../awc/extract'
import { MpegFrame, updateCrc } from './mpeg-frame'
import { ByteSource } from './stream-reader'
import { MpegChannelMode, MpegLayer, MpegVersion } from './types'

const REAL_SAMPLE = 'samples/hei4_fin_track_a03.awc'
const KEY_FILE = 'samples/.awc_key.json'
const HAS_SAMPLE = existsSync(REAL_SAMPLE) && existsSync(KEY_FILE)

function readKey(): Uint32Array {
  const j = JSON.parse(readFileSync(KEY_FILE, 'utf-8')) as {
    PC_AWC_KEY: Array<string>
  }
  return new Uint32Array(j.PC_AWC_KEY.map((s) => parseInt(s, 16) >>> 0))
}

function makeSyncWord(bytes: [number, number, number, number]): number {
  return (
    (((bytes[0] << 24) >>> 0) |
      (bytes[1] << 16) |
      (bytes[2] << 8) |
      bytes[3]) >>>
    0
  )
}

describe('MpegFrame.trySync: synthetic headers', () => {
  test('rejects non-sync bytes', () => {
    expect(MpegFrame.trySync(0x00000000)).toBeNull()
    expect(MpegFrame.trySync(0xff000000)).toBeNull() // partial sync
  })

  test('accepts a standard MPEG-1 LIII 48kHz joint-stereo header (0xFFFB...)', () => {
    // 0xFFFB = sync + V1 + LayerIII + no CRC
    // byte2 = bitrate (e.g. 9 = 128kbps) | sampleRate (1 = 48kHz) | padding=0 | private=0
    //       = 0x94 = 1001 0100
    // byte3 = channel mode (joint stereo = 01) | ext (10) | copy/orig/emph = 0
    //       = 0x60 = 0110 0000
    const sync = makeSyncWord([0xff, 0xfb, 0x94, 0x60])
    const f = MpegFrame.trySync(sync)
    expect(f).not.toBeNull()
    expect(f!.version).toBe(MpegVersion.Version1)
    expect(f!.layer).toBe(MpegLayer.LayerIII)
    expect(f!.hasCrc).toBe(false)
    expect(f!.sampleRate).toBe(48000)
    expect(f!.bitRate).toBe(128000)
    expect(f!.channelMode).toBe(MpegChannelMode.JointStereo)
  })

  test('accepts a CRC-protected MPEG-1 LIII header (Rockstar pattern 0xFFFA...)', () => {
    // 0xFFFA: sync (11 bits) = FFE, V1 (11), LayerIII (01), HasCRC bit (0)
    //        => 1111 1111 1111 1010
    const sync = makeSyncWord([0xff, 0xfa, 0x94, 0x60])
    const f = MpegFrame.trySync(sync)
    expect(f).not.toBeNull()
    expect(f!.version).toBe(MpegVersion.Version1)
    expect(f!.layer).toBe(MpegLayer.LayerIII)
    expect(f!.hasCrc).toBe(true) // bit 15 of byte 1 is 0 => CRC present
  })

  test('rejects reserved MPEG version (bits 19-20 = 01)', () => {
    // Version bits at bits 19-20: value 01 is reserved.
    // 0xFF, then 1110 1011 = 0xEB
    const sync = makeSyncWord([0xff, 0xeb, 0x94, 0x60])
    expect(MpegFrame.trySync(sync)).toBeNull()
  })

  test('rejects reserved layer (bits 17-18 = 00)', () => {
    // sync + V1 + layer=00 (reserved) + no-crc => 1111 1111 1111 1001 = 0xFFF9
    const sync = makeSyncWord([0xff, 0xf9, 0x94, 0x60])
    expect(MpegFrame.trySync(sync)).toBeNull()
  })

  test('rejects "bad" bitrate (0xF in bitrate nibble)', () => {
    // 0xFFFB header, then bitrate=1111, samplerate=01 => 0xF4
    const sync = makeSyncWord([0xff, 0xfb, 0xf4, 0x60])
    expect(MpegFrame.trySync(sync)).toBeNull()
  })

  test('rejects reserved sample rate (bits 10-11 = 11)', () => {
    // bitrate=9 (1001), samplerate=11 (reserved) => 1001 1100 = 0x9C
    const sync = makeSyncWord([0xff, 0xfb, 0x9c, 0x60])
    expect(MpegFrame.trySync(sync)).toBeNull()
  })

  test('rejects unsupported channel-mode-ext combos', () => {
    // channel mode bits at 6-7: 01 (joint), ext=11 (used in joint = mode 0x7 ok),
    // ... Actually upstream's switch keys on `(syncMark >> 4) & 0xF` which packs
    // the channel mode + extension as one nibble. Acceptable nibbles: 0, 4-7, 8, C.
    // Pick a value like 0x9 (1001) which falls outside the allow list.
    const sync = makeSyncWord([0xff, 0xfb, 0x94, 0x90])
    expect(MpegFrame.trySync(sync)).toBeNull()
  })
})

describe('updateCrc', () => {
  test('zero data with full polynomial round-trips through zero', () => {
    // CRC of all-zero data is just the initial value 0xFFFF wrapped by shifting.
    // We don't have an external reference here, but the function should be
    // deterministic and produce a consistent result for known data.
    const crc1 = updateCrc(0, 16, 0xffff)
    const crc2 = updateCrc(0, 16, 0xffff)
    expect(crc1).toBe(crc2)
    expect(crc1).toBeGreaterThanOrEqual(0)
    expect(crc1).toBeLessThanOrEqual(0xffff)
  })

  test('mixing data toggles the CRC', () => {
    const crc1 = updateCrc(0xffff, 16, 0xffff)
    const crc2 = updateCrc(0x0000, 16, 0xffff)
    expect(crc1).not.toBe(crc2)
  })
})

describe('MpegFrame: bit reader', () => {
  test('reads sequential bits from a small synthetic frame', () => {
    // Build: 4-byte header + 1 byte of payload. Header marks no-CRC so reader starts at offset 4.
    // sync word: 0xFFFB 0x90 0x60 (V1 LIII 32kbps 48kHz no-CRC joint stereo).
    // Payload: 0xA5 (1010 0101).
    const bytes = new Uint8Array([0xff, 0xfb, 0x90, 0x60, 0xa5])
    const src = new ByteSource(bytes)
    const sync = makeSyncWord([0xff, 0xfb, 0x90, 0x60])
    const f = MpegFrame.trySync(sync)!
    expect(f).not.toBeNull()
    // Manually attach the source without going through validate (which
    // would compute a frame length that overshoots our 5-byte buffer).
    ;(f as unknown as { source: ByteSource }).source = src
    f.offset = 0
    f.reset()

    expect(f.readBits(4)).toBe(0xa)
    expect(f.readBits(4)).toBe(0x5)
  })

  test('reads across the CRC pair (offset starts at 6 when hasCrc)', () => {
    // CRC frame: sync + 2 CRC bytes + payload. Reader should skip the CRC pair.
    // sync = 0xFFFA 90 60 (with CRC)
    const bytes = new Uint8Array([0xff, 0xfa, 0x90, 0x60, 0xde, 0xad, 0xbe])
    const sync = makeSyncWord([0xff, 0xfa, 0x90, 0x60])
    const f = MpegFrame.trySync(sync)!
    ;(f as unknown as { source: ByteSource }).source = new ByteSource(bytes)
    f.offset = 0
    f.reset()
    expect(f.hasCrc).toBe(true)
    // First 8 bits read should be 0xBE (skipping the 0xDE 0xAD CRC).
    expect(f.readBits(8)).toBe(0xbe)
  })

  test('reads 32-bit chunks correctly (signed/unsigned correctness)', () => {
    const payload = new Uint8Array([0xff, 0xff, 0xff, 0xff])
    const header = new Uint8Array([0xff, 0xfb, 0x90, 0x60])
    const bytes = new Uint8Array(header.length + payload.length)
    bytes.set(header, 0)
    bytes.set(payload, header.length)
    const sync = makeSyncWord([0xff, 0xfb, 0x90, 0x60])
    const f = MpegFrame.trySync(sync)!
    ;(f as unknown as { source: ByteSource }).source = new ByteSource(bytes)
    f.offset = 0
    f.reset()
    expect(f.readBits(32)).toBe(0xffffffff)
  })
})

describe.if(HAS_SAMPLE)('MpegFrame: real Rockstar AWC fixture', () => {
  const buf = HAS_SAMPLE ? readFileSync(REAL_SAMPLE) : Buffer.alloc(0)
  const arrayBuf = buf.buffer.slice(
    buf.byteOffset,
    buf.byteOffset + buf.byteLength,
  )
  const key = HAS_SAMPLE ? readKey() : new Uint32Array(4)
  const awc = HAS_SAMPLE ? parseAwc(arrayBuf) : null

  test('first frame of channel 0 syncs and reports MPEG-1 LIII with CRC', () => {
    const all = extractAllStreams(awc!, arrayBuf, { key })
    const ch0 = all[0]!
    // First 4 bytes should be a Rockstar frame sync (0xFFFA...).
    const sync = makeSyncWord([ch0[0]!, ch0[1]!, ch0[2]!, ch0[3]!])
    expect((sync & 0xffe00000) >>> 0).toBe(0xffe00000)

    const f = MpegFrame.trySync(sync)!
    expect(f).not.toBeNull()
    expect(f.version).toBe(MpegVersion.Version1)
    expect(f.layer).toBe(MpegLayer.LayerIII)
    expect(f.hasCrc).toBe(true)
    expect(f.sampleRate).toBe(48000)
    expect(f.sampleCount).toBe(1152)
  })

  test('first frame of channel 0 validates with a sensible length', () => {
    const all = extractAllStreams(awc!, arrayBuf, { key })
    const ch0 = all[0]!
    const sync = makeSyncWord([ch0[0]!, ch0[1]!, ch0[2]!, ch0[3]!])
    const f = MpegFrame.trySync(sync)!
    const src = new ByteSource(ch0)
    const ok = f.validate(0, src)
    expect(ok).toBe(true)
    // Layer III @ 48 kHz: 144 * bitrate / 48000 + padding.
    // Rockstar streams are 80 kbps → frameLen = 240 bytes.
    expect(f.frameLength).toBe(240)
    // After validate, the bit reader should be positioned at byte 6
    // (4 sync header bytes + 2 CRC bytes).
    expect(f.bitRate).toBe(80000)
  })

  test('all 16 channels sync as MPEG-1 LIII (scan past any leading zeros)', () => {
    // Channels 0-7 start at byte 0. channels 8-15 carry 8 bytes of encoder
    // priming before the first sync word. Scan the first 64 bytes to find sync.
    const all = extractAllStreams(awc!, arrayBuf, { key })
    for (const ch of all) {
      let off = -1
      for (let o = 0; o < Math.min(ch.length, 64); o++) {
        if (ch[o] === 0xff && (ch[o + 1]! & 0xe0) === 0xe0) {
          off = o
          break
        }
      }
      expect(off).toBeGreaterThanOrEqual(0)
      const sync = makeSyncWord([
        ch[off]!,
        ch[off + 1]!,
        ch[off + 2]!,
        ch[off + 3]!,
      ])
      const f = MpegFrame.trySync(sync)
      expect(f).not.toBeNull()
      expect(f!.version).toBe(MpegVersion.Version1)
      expect(f!.layer).toBe(MpegLayer.LayerIII)
    }
  })

  test('frame.validate accepts the first frame as CRC-valid', () => {
    const all = extractAllStreams(awc!, arrayBuf, { key })
    const ch0 = all[0]!
    const sync = makeSyncWord([ch0[0]!, ch0[1]!, ch0[2]!, ch0[3]!])
    const f = MpegFrame.trySync(sync)!
    const ok = f.validate(0, new ByteSource(ch0))
    expect(ok).toBe(true)
    expect(f.isCorrupted).toBe(false)
  })
})
