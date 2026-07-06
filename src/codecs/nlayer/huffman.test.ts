/**
 * Tests for the Huffman decoder port. Strategy:
 *   - Use a stub IMpegFrame to load a precise bit pattern into the
 *     BitReservoir.
 *   - For decodePair, feed bits that match a known leaf in the
 *     specified table and verify the (x, y) output.
 *   - For decodeQuad, feed a known count1 symbol + its sign bits and
 *     verify all four outputs.
 *
 * The expected bit codes are derived by walking the raw tables and
 * confirming the linked-list build via `__test.initTable`. We then
 * pack the synthetic bytes so the high-order bits of the first byte
 * carry the code.
 */

import { describe, expect, test } from 'bun:test'

import { BitReservoir } from './bit-reservoir'
import { FLOAT_LOOKUP, __test, decodePair, decodeQuad } from './huffman'
import { MpegChannelMode, MpegLayer, MpegVersion } from './types'
import type { IMpegFrame } from './types'

function makeFrameWithBytes(bytes: Uint8Array): IMpegFrame {
  let pos = 0
  // Mono so getSlots subtracts only 17 (per MPEG-1 / channelMode==Mono branch).
  const sideInfo = 17
  const frameLength = bytes.length + 4 + sideInfo
  return {
    sampleRate: 48000,
    sampleRateIndex: 1,
    frameLength,
    bitRate: 80000,
    version: MpegVersion.Version1,
    layer: MpegLayer.LayerIII,
    channelMode: MpegChannelMode.Mono,
    channelModeExtension: 0,
    sampleCount: 1152,
    bitRateIndex: 9,
    isCopyrighted: false,
    hasCrc: false,
    isCorrupted: false,
    reset() {
      pos = 0
    },
    readBits(_n: number) {
      if (pos >= bytes.length) return -1
      return bytes[pos++]!
    },
  }
}

/**
 * Build a reservoir holding `bits` packed MSB-first into the next
 * available bytes (zero-padded to the byte boundary).
 */
function reservoirWithBits(bits: string): BitReservoir {
  // Pack the bit string into bytes (MSB first).
  const padded = bits + '0'.repeat((8 - (bits.length % 8)) % 8)
  const out = new Uint8Array(padded.length / 8)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(padded.slice(i * 8, i * 8 + 8), 2)
  }
  const r = new BitReservoir()
  r.addBits(makeFrameWithBytes(out), 0)
  return r
}

describe('huffman: table initialization', () => {
  test('table 1 (smallest) builds a 4-leaf linked list with max code length 3', () => {
    // Table 1 from the C# source:
    //   {0x02, 0x01}, {0x00, 0x00}, {0x02, 0x01}, {0x00, 0x10},
    //   {0x02, 0x01}, {0x00, 0x01}, {0x00, 0x11},
    // Tree shape:
    //   row 0: internal (skip=2 → right=2)  left = row 1, right = row 2
    //   row 1: leaf, value=0x00 (bits "0")
    //   row 2: internal, skip=2 → right=4
    //   row 3: leaf, value=0x10 (bits "10")
    //   row 4: internal, skip=2 → right=6
    //   row 5: leaf, value=0x01 (bits "110")
    //   row 6: leaf, value=0x11 (bits "111")
    const init = __test.getNode(1)
    // The cache maps upstream `table` 1 to internal index 0.
    expect(init.maxBits).toBe(3)
    const values: Array<number> = []
    let node: typeof init.head | null = init.head
    while (node !== null) {
      values.push(node.value)
      node = node.next
    }
    expect(values).toContain(0x00)
    expect(values).toContain(0x10)
    expect(values).toContain(0x01)
    expect(values).toContain(0x11)
    expect(values.length).toBe(4)
  })
})

describe('huffman.decodePair', () => {
  test('tables 0, 4, 14 short-circuit to (0, 0) without consuming bits', () => {
    const r = reservoirWithBits('11111111')
    const before = r.bitsRead
    expect(decodePair(r, 0)).toEqual({ x: 0, y: 0 })
    expect(decodePair(r, 4)).toEqual({ x: 0, y: 0 })
    expect(decodePair(r, 14)).toEqual({ x: 0, y: 0 })
    expect(r.bitsRead).toBe(before)
  })

  test('table 1: code "1" → value 0x00 → (0, 0) without sign bits', () => {
    // Symbol value 0x00 means ix=0, iy=0. No sign bits consumed.
    // Code "1" is one bit.
    const r = reservoirWithBits('10000000')
    const { x, y } = decodePair(r, 1)
    expect(x).toBe(0)
    expect(y).toBe(0)
    expect(r.bitsRead).toBe(1)
  })

  test('table 1: code "01" → value 0x10 (ix=1, iy=0) + 1 sign bit', () => {
    // "01" selects value 0x10. ix=1 ≠ 0 → consume 1 sign bit.
    // We append "1" (negative). Total bits consumed = 3.
    const r = reservoirWithBits('01100000')
    const { x, y } = decodePair(r, 1)
    expect(x).toBe(-FLOAT_LOOKUP[1]!)
    expect(y).toBe(0)
    expect(r.bitsRead).toBe(3)
  })

  test('table 1: code "000" → value 0x11 (ix=1, iy=1) + 2 sign bits', () => {
    // "000" selects 0x11 → ix=1 (+sign) iy=1 (+sign).
    // Append sign bits "00" → both positive.
    const r = reservoirWithBits('00000000')
    const { x, y } = decodePair(r, 1)
    expect(x).toBe(FLOAT_LOOKUP[1]!)
    expect(y).toBe(FLOAT_LOOKUP[1]!)
    expect(r.bitsRead).toBe(5)
  })
})

describe('huffman.decodeQuad', () => {
  test('table 32: code "1" decodes to 0x00 → all zeros, no sign bits', () => {
    // From the linked-list dump, value 0x00 has code "1" (length 1).
    const r = reservoirWithBits('10000000')
    const { v, w, x, y } = decodeQuad(r, 32)
    expect(v).toBe(0)
    expect(w).toBe(0)
    expect(x).toBe(0)
    expect(y).toBe(0)
    expect(r.bitsRead).toBe(1)
  })

  test('table 32: symbol with all bits set consumes 4 sign bits', () => {
    // Symbol 0xF (= 1111) is at the leaf with bits "1011" in table 32:
    //   row 30: leaf value = 0x0f.
    // Computing the code requires walking the tree. Rather than hard-code
    // the bit pattern, find a leaf whose value is 0x0F and walk back up.
    const init = __test.initTable(
      // re-use the helper to find the bit pattern for value 0x0F
      // by traversing the linked list (which already encodes (bits, mask))
      new Uint8Array(0), // placeholder, replaced below
    )
    // Easier: use __test.getNode and find the node for 0xF.
    const { head, maxBits } = __test.getNode(32)
    let node: typeof init.head | null = head
    let target: typeof init.head | null = null
    while (node !== null) {
      if (node.value === 0x0f) {
        target = node
        break
      }
      node = node.next
    }
    expect(target).not.toBeNull()
    // Bits are MSB-aligned at width maxBits.
    const codeBits = target!.bits >>> (maxBits - target!.length)
    const codeStr = codeBits.toString(2).padStart(target!.length, '0')
    // Append 4 sign bits (all "1" = all negative).
    const r = reservoirWithBits(codeStr + '1111' + '0'.repeat(8))
    const { v, w, x, y } = decodeQuad(r, 32)
    expect(v).toBe(-FLOAT_LOOKUP[1]!)
    expect(w).toBe(-FLOAT_LOOKUP[1]!)
    expect(x).toBe(-FLOAT_LOOKUP[1]!)
    expect(y).toBe(-FLOAT_LOOKUP[1]!)
    expect(r.bitsRead).toBe(target!.length + 4)
  })
})

describe('huffman: LIN_BITS escape for large coefficients', () => {
  test('table 16 (linBits=1): code that emits ix=15 reads 1 extra linBit', () => {
    // Find a leaf in table 16 with value 0xF0 (ix=15, iy=0).
    const { head, maxBits } = __test.getNode(16)
    let node: typeof head | null = head
    let target: typeof head | null = null
    while (node !== null) {
      if (node.value === 0xf0) {
        target = node
        break
      }
      node = node.next
    }
    expect(target).not.toBeNull()
    const codeBits = target!.bits >>> (maxBits - target!.length)
    const codeStr = codeBits.toString(2).padStart(target!.length, '0')
    // ix=15: read linBits (1 bit) extension + 1 sign bit. iy=0: no sign.
    // Linbits "1" gives ix += 1 → ix = 16. Sign "0" → positive.
    const padded = codeStr + '1' + '0' + '0'.repeat(16)
    const r = reservoirWithBits(padded)
    const { x, y } = decodePair(r, 16)
    expect(x).toBe(FLOAT_LOOKUP[16]!)
    expect(y).toBe(0)
    expect(r.bitsRead).toBe(target!.length + 2)
  })
})
