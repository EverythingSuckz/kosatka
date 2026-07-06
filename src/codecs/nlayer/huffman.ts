/**
 * NLayer port. Huffman decoder.
 *
 * Verbatim port of the algorithm side of `NLayer/Decoder/Huffman.cs`.
 * The 17 raw code tables are pre-generated and live in
 * `huffman-tables.ts`. Re-run `scripts/build-huffman-tables.ts` to
 * regenerate them from the C# source.
 *
 * The two `Decode(...)` overloads in C# become `decodePair` (big-values
 * region, two non-zero values per symbol) and `decodeQuad` (count1
 * region, four sign-bit values per symbol).
 *
 * Performance / correctness notes:
 *   - The huffman list nodes are built on first use and cached (matches
 *     upstream `_llCache`). Cache miss touches one table. Cache hit is
 *     a single object dereference.
 *   - `_floatLookup` is `Math.pow(i, 4/3)` for i ∈ [0, 8207). Layer III
 *     dequant scales by this table. We precompute as `Float32Array` so
 *     downstream IMDCT / overlap-add stays in 32-bit precision and
 *     matches the C# `float` reference exactly.
 */

import { HUFFMAN_TABLES } from './huffman-tables'
import type { BitReservoir } from './bit-reservoir'

/**
 * Linked-list node built lazily from a raw (skip, value) Uint8Array.
 * Fields mirror upstream `HuffmanListNode` exactly.
 */
interface HuffmanListNode {
  value: number
  length: number
  bits: number
  mask: number
  next: HuffmanListNode | null
}

const TABLE_COUNT = HUFFMAN_TABLES.length // 17
const _llCache: Array<HuffmanListNode | null> = new Array(TABLE_COUNT).fill(
  null,
)
const _llCacheMaxBits = new Int32Array(TABLE_COUNT)

const LIN_BITS = [
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 6, 8, 10, 13, 4,
  5, 6, 7, 8, 9, 11, 13,
] as const

export const FLOAT_LOOKUP = (() => {
  const a = new Float32Array(8207)
  for (let i = 0; i < 8207; i++) {
    a[i] = Math.fround(Math.pow(i, 4 / 3))
  }
  return a
})()

/**
 * Find the previous (parent) node of `idx` in a raw NLayer code table,
 * following continuation pointers (`skip >= 250`) up the tree. Returns
 * the parent's row index and the bit (0/1) that selected `idx` at that
 * parent. Verbatim port of `FindPreviousNode`.
 */
function findPreviousNode(
  tree: Uint8Array,
  idx: number,
): { idx: number; bit: number } {
  for (let i = idx - 1; i >= 0; i--) {
    const skip = tree[i * 2]!
    if (skip !== 0) {
      for (let j = 0; j < 2; j++) {
        // Read the actual byte from the table for BOTH j=0 and j=1. j=0 is
        // the skip nibble. j=1 is the right-child offset (== 1 for most
        // internal-node rows but NOT all, e.g. table 24 row 310 has
        // {0x55, 0xfa}, where 0xfa is a continuation pointer).
        // Hardcoding 1 here caused tables 24..31 to mis-decode leaves at
        // depth ≥ 12, fixed via cross-check vs upstream C# NLayer.
        const off = tree[i * 2 + j]!
        if (i + off === idx) {
          if (off >= 250) {
            // continuation pointer, recurse upward
            const parent = findPreviousNode(tree, i)
            if (parent.bit !== j)
              throw new Error('huffman tree continuation mismatch')
            return parent
          }
          return { idx: i, bit: j }
        }
      }
    }
  }
  throw new Error('findPreviousNode: no parent found')
}

function buildLinkedList(
  values: Array<number>,
  lengths: Array<number>,
  codes: Array<number>,
): { head: HuffmanListNode; maxBits: number } {
  let maxBits = 0
  for (const l of lengths) if (l > maxBits) maxBits = l

  const list: Array<HuffmanListNode> = []
  for (let i = 0; i < lengths.length; i++) {
    const shift = maxBits - lengths[i]!
    list.push({
      value: values[i]!,
      length: lengths[i]!,
      bits: codes[i]! << shift,
      mask: ((1 << lengths[i]!) - 1) << shift,
      next: null,
    })
  }

  // Sort by code length ascending. Upstream relies on a stable sort
  // (entries with equal length keep their original order). Array.sort
  // in modern JS is stable per spec, so this matches.
  list.sort((a, b) => a.length - b.length)

  for (let i = 1; i < list.length; i++) {
    const prev = list[i - 1]!
    const cur = list[i]!
    prev.next = cur
  }

  return { head: list[0]!, maxBits }
}

function initTable(tree: Uint8Array): {
  head: HuffmanListNode
  maxBits: number
} {
  const treeLen = tree.length / 2
  const values: Array<number> = []
  const lengths: Array<number> = []
  const codes: Array<number> = []

  for (let i = 0; i < treeLen; i++) {
    if (tree[i * 2] === 0) {
      // leaf, walk up to the root collecting bits
      let bits = 0
      let len = 0
      let idx = i
      // do-while: in C# the loop runs at least once
      do {
        const parent = findPreviousNode(tree, idx)
        bits |= parent.bit << len
        len++
        idx = parent.idx
      } while (idx > 0)

      values.push(tree[i * 2 + 1]!)
      lengths.push(len)
      codes.push(bits)
    }
  }

  return buildLinkedList(values, lengths, codes)
}

/**
 * Resolve the cache slot for a given upstream `table` index (0..33),
 * including the special-case mapping that collapses 24..31 → 13 etc.
 * Returns the head linked-list node and its maxBits. Verbatim port of
 * `GetNode`.
 */
function getNode(table: number): { head: HuffmanListNode; maxBits: number } {
  let realIdx = table
  if (realIdx > 16) {
    if (realIdx > 31) {
      // tables 32 / 33, last two entries in the table
      realIdx -= 17
    } else if (realIdx >= 24) {
      // tables 24..31, third last entry in the table
      realIdx = 14
    } else {
      // tables 17..23, fourth last entry
      realIdx = 13
    }
  } else {
    // map 0..16 (with gaps: there is no table 4 or table 14)
    if (realIdx > 13) --realIdx
    if (realIdx > 3) --realIdx
    --realIdx
  }

  let head: HuffmanListNode | null = _llCache[realIdx] ?? null
  if (head === null) {
    const init = initTable(HUFFMAN_TABLES[realIdx]!)
    _llCache[realIdx] = init.head
    _llCacheMaxBits[realIdx] = init.maxBits
    head = init.head
  }

  return { head, maxBits: _llCacheMaxBits[realIdx]! }
}

/**
 * Bit-tree symbol decode. Pulls one symbol from the reservoir using
 * `table`. Returns the symbol value (0..255).
 *
 * Implementation mirrors upstream's "peek maxBits then walk the list"
 * trick, faster than a bit-by-bit tree traversal in JS too.
 */
function decodeSymbol(br: BitReservoir, table: number): number {
  const { head, maxBits } = getNode(table)
  const peek = br.tryPeekBits(maxBits)
  let bits = peek.value
  const readBits = peek.readCount
  if (readBits < maxBits) {
    // Pad with zeros on the right so the mask compare still works.
    // Upstream does NOT update readBits here (the while-condition uses
    // the original readBits to decide whether the bit count is even
    // sufficient to match the current node).
    bits <<= maxBits - readBits
  }

  let node: HuffmanListNode | null = head
  while (node !== null && node.length <= readBits) {
    if ((bits & node.mask) === node.bits) {
      br.skipBits(node.length)
      break
    }
    node = node.next
  }

  if (node !== null && node.length <= readBits) {
    return node.value
  }
  return 0
}

/**
 * Decode one "big-values" pair (x, y). For tables 0, 4, and 14 we
 * short-circuit to zero (upstream behaviour). Otherwise we pull a
 * symbol from the Huffman table, optionally read `linBits` more for
 * each over-range coefficient, and then read one sign bit per
 * non-zero coefficient. Returns the float pair directly.
 */
export function decodePair(
  br: BitReservoir,
  table: number,
): { x: number; y: number } {
  if (table === 0 || table === 4 || table === 14) {
    return { x: 0, y: 0 }
  }
  const val = decodeSymbol(br, table)
  let ix = val >> 4
  let iy = val & 15

  const linBits = LIN_BITS[table]!
  if (linBits > 0 && ix === 15) ix += br.getBits(linBits)
  let x: number
  if (ix !== 0 && br.get1Bit() !== 0) {
    x = -FLOAT_LOOKUP[ix]!
  } else {
    x = FLOAT_LOOKUP[ix]!
  }

  if (linBits > 0 && iy === 15) iy += br.getBits(linBits)
  let y: number
  if (iy !== 0 && br.get1Bit() !== 0) {
    y = -FLOAT_LOOKUP[iy]!
  } else {
    y = FLOAT_LOOKUP[iy]!
  }

  return { x, y }
}

/**
 * Decode one "count1" quadruple (v, w, x, y). Each output is either 0
 * or ±1 (no linbits extension). The sign bit is only consumed when
 * the symbol has the corresponding bit set.
 */
export function decodeQuad(
  br: BitReservoir,
  table: number,
): { v: number; w: number; x: number; y: number } {
  const val = decodeSymbol(br, table)

  let v = 0
  let w = 0
  let x = 0
  let y = 0

  if ((val & 0x8) !== 0) {
    v = br.get1Bit() === 1 ? -FLOAT_LOOKUP[1]! : FLOAT_LOOKUP[1]!
  }
  if ((val & 0x4) !== 0) {
    w = br.get1Bit() === 1 ? -FLOAT_LOOKUP[1]! : FLOAT_LOOKUP[1]!
  }
  if ((val & 0x2) !== 0) {
    x = br.get1Bit() === 1 ? -FLOAT_LOOKUP[1]! : FLOAT_LOOKUP[1]!
  }
  if ((val & 0x1) !== 0) {
    y = br.get1Bit() === 1 ? -FLOAT_LOOKUP[1]! : FLOAT_LOOKUP[1]!
  }

  return { v, w, x, y }
}

// Re-export internals used by tests.
export const __test = { decodeSymbol, initTable, findPreviousNode, getNode }
