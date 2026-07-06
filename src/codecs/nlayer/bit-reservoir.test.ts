/**
 * Tests for the bit-reservoir port. Goal: cover every public method on
 * synthetic inputs so a regression in the ring-buffer arithmetic shows
 * up here before it corrupts a real decode.
 *
 * Strategy:
 *   - Build a minimal stub `IMpegFrame` whose `readBits(8)` walks a
 *     supplied byte buffer. `getSlots(frame)` ends up reading
 *     `frameLength - 4 - {0|2 if CRC} - {32|17|9}` bytes per call to
 *     `addBits`, so we tune `frameLength` to control exactly how many
 *     bytes land in the reservoir.
 */

import { describe, expect, test } from 'bun:test'

import { BitReservoir } from './bit-reservoir'
import { MpegChannelMode, MpegLayer, MpegVersion } from './types'
import type { IMpegFrame } from './types'

function makeFrame(
  bytes: Uint8Array,
  opts?: { hasCrc?: boolean; mono?: boolean },
): IMpegFrame {
  const hasCrc = opts?.hasCrc ?? false
  const mono = opts?.mono ?? false
  let pos = 0
  // Frame length tuned so slots == bytes.length:
  //   slots = frameLength - 4 - (hasCrc ? 2 : 0) - 32 (stereo MPEG1)
  // Solve: frameLength = bytes.length + 4 + (hasCrc ? 2 : 0) + 32
  const sideInfo = mono ? 17 : 32 // mono treated as MPEG1-mono: 17 slot subtraction
  // For MPEG1 mono in the C# code: `if (version == V1 && mode != Mono) ... -32`
  // mono path falls through to `cnt - 17`.
  const frameLength = bytes.length + 4 + (hasCrc ? 2 : 0) + sideInfo
  const frame: IMpegFrame = {
    sampleRate: 48000,
    sampleRateIndex: 1,
    frameLength,
    bitRate: 128000,
    version: MpegVersion.Version1,
    layer: MpegLayer.LayerIII,
    channelMode: mono ? MpegChannelMode.Mono : MpegChannelMode.Stereo,
    channelModeExtension: 0,
    sampleCount: 1152,
    bitRateIndex: 9,
    isCopyrighted: false,
    hasCrc,
    isCorrupted: false,
    reset() {
      pos = 0
    },
    readBits(bitCount: number): number {
      // We only test the 8-bit path used by addBits.
      if (bitCount !== 8) throw new Error('test stub only supports 8-bit reads')
      if (pos >= bytes.length) return -1
      return bytes[pos++]!
    },
  }
  return frame
}

describe('BitReservoir.addBits + tryPeekBits', () => {
  test('adds bytes and reads them back bit-by-bit', () => {
    const r = new BitReservoir()
    // 0xA5 = 10100101, 0x3C = 00111100
    const bytes = new Uint8Array([0xa5, 0x3c])
    r.addBits(makeFrame(bytes), 0)
    expect(r.bitsAvailable).toBe(16)

    const peek4 = r.tryPeekBits(4)
    expect(peek4.value).toBe(0xa)
    expect(peek4.readCount).toBe(4)
    // Peek does NOT advance.
    expect(r.bitsAvailable).toBe(16)

    expect(r.getBits(4)).toBe(0xa) // 1010
    expect(r.getBits(4)).toBe(0x5) // 0101
    expect(r.getBits(8)).toBe(0x3c)
    // Note: bitsAvailable is only meaningful while data remains. After
    // consuming all bytes via getBits/skipBits, _bitsLeft stays at 8 (the
    // refill path doesn't clear it) so the value here is intentionally
    // non-zero, matches upstream C# semantics.
  })

  test('tryPeekBits across byte boundary', () => {
    const r = new BitReservoir()
    r.addBits(makeFrame(new Uint8Array([0xff, 0x00])), 0)
    // First 12 bits should be 1111 1111 0000 = 0xFF0
    const peek = r.tryPeekBits(12)
    expect(peek.value).toBe(0xff0)
    expect(peek.readCount).toBe(12)
  })

  test('tryPeekBits with count === 0 returns zero', () => {
    const r = new BitReservoir()
    r.addBits(makeFrame(new Uint8Array([0xff])), 0)
    const peek = r.tryPeekBits(0)
    expect(peek.value).toBe(0)
    expect(peek.readCount).toBe(0)
  })

  test('tryPeekBits on empty reservoir returns readCount === 0', () => {
    const r = new BitReservoir()
    const peek = r.tryPeekBits(8)
    expect(peek.readCount).toBe(0)
  })

  test('tryPeekBits rejects out-of-range count', () => {
    const r = new BitReservoir()
    r.addBits(makeFrame(new Uint8Array([0xff])), 0)
    expect(() => r.tryPeekBits(33)).toThrow(RangeError)
    expect(() => r.tryPeekBits(-1)).toThrow(RangeError)
  })

  test('getBits returns zero and advances when reservoir lacks bytes', () => {
    // Pre-fix this threw "Reservoir did not have enough bytes!". See
    // the `get1Bit` companion test and `bit-reservoir.ts` for the
    // truncated-frame rationale.
    const r = new BitReservoir()
    r.addBits(makeFrame(new Uint8Array([0xff])), 0)
    expect(r.getBits(16)).toBe(0)
    expect(r.bitsRead).toBe(16)
  })
})

describe('BitReservoir.get1Bit', () => {
  test('reads bits MSB-first', () => {
    const r = new BitReservoir()
    r.addBits(makeFrame(new Uint8Array([0b10110100])), 0)
    expect(r.get1Bit()).toBe(1)
    expect(r.get1Bit()).toBe(0)
    expect(r.get1Bit()).toBe(1)
    expect(r.get1Bit()).toBe(1)
    expect(r.get1Bit()).toBe(0)
    expect(r.get1Bit()).toBe(1)
    expect(r.get1Bit()).toBe(0)
    expect(r.get1Bit()).toBe(0)
  })

  test('returns zero and advances bitsRead when empty (truncated-frame tolerant)', () => {
    // Pre-fix this threw "Reservoir did not have enough bytes!". The
    // AWC pipeline now relies on a graceful zero-return so the
    // byte-truncated last frame of a block keeps the huffman count1
    // loop converging on its `part3end > bitsRead` exit condition.
    // See `bit-reservoir.ts` for rationale.
    const r = new BitReservoir()
    expect(r.get1Bit()).toBe(0)
    expect(r.bitsRead).toBe(1)
  })

  test('refills bitsLeft when moving across byte boundary with more data available', () => {
    const r = new BitReservoir()
    r.addBits(makeFrame(new Uint8Array([0xff, 0x00])), 0)
    // Pull 8 bits, should leave us positioned on the second byte with 8 bits left.
    for (let i = 0; i < 8; i++) r.get1Bit()
    expect(r.bitsAvailable).toBe(8)
    expect(r.get1Bit()).toBe(0)
  })
})

describe('BitReservoir.skipBits / bitsRead / rewindBits', () => {
  test('skipBits advances cursor and increments bitsRead', () => {
    const r = new BitReservoir()
    r.addBits(makeFrame(new Uint8Array([0xab, 0xcd, 0xef, 0x12])), 0)
    r.skipBits(12)
    expect(r.bitsRead).toBe(12)
    // Next 4 bits should be the low nibble of 0xCD = 0xD = 1101
    expect(r.getBits(4)).toBe(0xd)
    expect(r.bitsRead).toBe(16)
  })

  test('skipBits with 0 is a no-op', () => {
    const r = new BitReservoir()
    r.addBits(makeFrame(new Uint8Array([0xff])), 0)
    r.skipBits(0)
    expect(r.bitsRead).toBe(0)
    expect(r.bitsAvailable).toBe(8)
  })

  test('skipBits beyond available drains the reservoir but still advances bitsRead', () => {
    // Pre-fix this threw RangeError. The truncated-tail handling now
    // makes skipBits idempotent past EOF so the `skipBits(part3end -
    // bitsRead)` cleanup in `LayerIIIDecoder.readSamples` does not
    // crash on the last frame of a truncated AWC block.
    const r = new BitReservoir()
    r.addBits(makeFrame(new Uint8Array([0xff])), 0)
    r.skipBits(9)
    expect(r.bitsRead).toBe(9)
    expect(r.bitsAvailable).toBe(0)
  })

  test('rewindBits undoes skipBits', () => {
    const r = new BitReservoir()
    r.addBits(makeFrame(new Uint8Array([0xab, 0xcd])), 0)
    r.skipBits(12)
    r.rewindBits(8)
    expect(r.bitsRead).toBe(4)
    // After rewinding 8 bits from position 12, we should be at bit 4.
    // High 4 bits of 0xAB = 0xA, low 4 = 0xB. The rewound 8 bits cover the
    // low nibble of 0xAB and the high nibble of 0xCD.
    expect(r.getBits(8)).toBe(0xbc)
  })
})

describe('BitReservoir.flushBits + reset', () => {
  test('flushBits aligns to next byte boundary', () => {
    const r = new BitReservoir()
    r.addBits(makeFrame(new Uint8Array([0xff, 0x00])), 0)
    r.skipBits(3)
    r.flushBits()
    expect(r.bitsRead).toBe(8)
    expect(r.getBits(8)).toBe(0x00)
  })

  test('flushBits on aligned cursor is a no-op', () => {
    const r = new BitReservoir()
    r.addBits(makeFrame(new Uint8Array([0xff])), 0)
    r.flushBits()
    expect(r.bitsRead).toBe(0)
    expect(r.bitsAvailable).toBe(8)
  })

  test('reset clears state', () => {
    const r = new BitReservoir()
    r.addBits(makeFrame(new Uint8Array([0xff, 0x00])), 0)
    r.skipBits(4)
    r.reset()
    expect(r.bitsRead).toBe(4) // bitsRead isn't reset (matches upstream C#)
    expect(r.bitsAvailable).toBe(0)
  })
})

describe('BitReservoir.addBits: overlap semantics', () => {
  test('first add with overlap=0 returns true', () => {
    const r = new BitReservoir()
    const ok = r.addBits(makeFrame(new Uint8Array([0xff])), 0)
    expect(ok).toBe(true)
  })

  test('first add with overlap>0 returns false (no previous data)', () => {
    const r = new BitReservoir()
    const ok = r.addBits(makeFrame(new Uint8Array([0xff])), 1)
    expect(ok).toBe(false)
  })

  test('second add respects overlap', () => {
    const r = new BitReservoir()
    r.addBits(makeFrame(new Uint8Array([0xaa, 0xbb, 0xcc])), 0)
    // Now add a second frame with overlap=2: caller wants 2 bytes from
    // the *previous* frame to be re-readable. We already consumed 0 bits,
    // so the start should rewind to byte index 1 (0xBB).
    const ok = r.addBits(makeFrame(new Uint8Array([0x11, 0x22])), 2)
    expect(ok).toBe(true)
    // First two bytes available should be 0xBB, 0xCC followed by the new data.
    expect(r.getBits(8)).toBe(0xbb)
    expect(r.getBits(8)).toBe(0xcc)
    expect(r.getBits(8)).toBe(0x11)
    expect(r.getBits(8)).toBe(0x22)
  })
})
