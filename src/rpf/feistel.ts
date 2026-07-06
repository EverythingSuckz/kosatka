/**
 * NG decryption. Rockstar's 17-round Feistel-style block cipher used for the
 * encrypted entries+names blob of every stock GTA V RPF (and for per-entry
 * encryption inside such archives).
 *
 * Verbatim port of CodeWalker's `GTACrypto.DecryptNG*` (GTACrypto.cs lines
 * 104-250). Decryption only, we never need to encrypt.
 *
 * Cipher shape:
 *   - 16-byte blocks (4 × u32 LE).
 *   - 17 rounds. Round 1, 2, 16 use "RoundA" (column-aligned table lookups),
 *     rounds 3..15 use "RoundB" (a different byte-permutation but same 16
 *     XOR-of-table-lookups core).
 *   - The 272-byte sub-key picks one of 101 hard-coded sub-keys (see
 *     `gta5-hash.ts` / `ngKeyIndex`).
 *   - Trailing bytes < 16 in the input pass through unchanged (CodeWalker
 *     behaviour, see GTACrypto.cs:127-130).
 *
 * The 17 × 16 × 256 × u32 = 272 KB lookup table is supplied as a `Uint32Array`
 * in row-major order (round, column, byte). Use {@link buildNgTables} to slice
 * it out of the magic.dat-derived 278 528-byte blob.
 */

import { ngKeyIndex } from './gta5-hash'

export const NG_ROUNDS = 17
export const NG_COLS = 16
/** One entry per input byte value. */
export const NG_ENTRIES = 256

/**
 * Flat NG decrypt-table view, indexed as `tables[round * NG_COLS * NG_ENTRIES + col * NG_ENTRIES + byte]`.
 * The raw bytes from `magic.dat` are already in this exact order (CodeWalker
 * writes them sequentially via `ReadNgTables`), so we just reinterpret as
 * u32 with no copy.
 */
export interface NgDecryptTables {
  /** 17 * 16 * 256 = 69632 u32 entries (= 278528 bytes). */
  readonly data: Uint32Array
}

/**
 * Build an {@link NgDecryptTables} view over the 278528-byte tables slice
 * returned by {@link import('../keys/derive').DerivedKeys.ngTables}. Zero-copy:
 * the resulting view aliases the input buffer.
 *
 * @throws if `tables.length !== 17 * 16 * 256 * 4`.
 */
export function buildNgTables(tables: Uint8Array): NgDecryptTables {
  const expected = NG_ROUNDS * NG_COLS * NG_ENTRIES * 4
  if (tables.length !== expected) {
    throw new Error(
      `NG tables: expected ${expected} bytes (17×16×256×4), got ${tables.length}`,
    )
  }
  // ngTables is built as a standalone Uint8Array in derive.ts so the byte
  // offset will be aligned for a Uint32Array. Defensively check.
  if ((tables.byteOffset & 3) !== 0) {
    // Fall back to a copy. Cheap (~300 KB once).
    const copy = new Uint8Array(expected)
    copy.set(tables)
    return { data: new Uint32Array(copy.buffer) }
  }
  return {
    data: new Uint32Array(tables.buffer, tables.byteOffset, expected / 4),
  }
}

/**
 * Pre-resolve the 101 × (17 × 4) sub-keys array out of the 27472-byte
 * `ngKeys` blob from magic.dat. Each NG sub-key is 272 bytes = 68 × u32.
 *
 * Returns a flat `Uint32Array` of length `101 * 17 * 4 = 6868`, addressable
 * as `subKeys[keyIdx * 17 * 4 + round * 4 + i]`.
 */
export function buildNgSubKeys(ngKeys: Uint8Array): Uint32Array {
  if (ngKeys.length !== 101 * 272) {
    throw new Error(
      `NG keys: expected ${101 * 272} bytes (101×272), got ${ngKeys.length}`,
    )
  }
  // Force-align the read via a copy if necessary (byteOffset may not be /4).
  if ((ngKeys.byteOffset & 3) !== 0) {
    const copy = new Uint8Array(ngKeys.length)
    copy.set(ngKeys)
    return new Uint32Array(copy.buffer)
  }
  return new Uint32Array(ngKeys.buffer, ngKeys.byteOffset, ngKeys.length / 4)
}

/**
 * Bundle of everything needed to NG-decrypt one byte stream. Construct once
 * per archive (cheap, slices into the keys/tables blobs) and reuse for both
 * entries+names and any per-entry encrypted payloads.
 */
export interface NgContext {
  /** PC_LUT, 256-byte permutation used by {@link ngKeyIndex}. */
  readonly lut: Uint8Array
  /** All 101 × 17 × 4 u32 sub-keys, flat (101 × 68 u32 each). */
  readonly subKeys: Uint32Array
  /** 17 × 16 × 256 u32 decrypt tables, flat. */
  readonly tables: NgDecryptTables
}

/**
 * Convenience: build an {@link NgContext} from the raw derived-keys slices.
 * O(constant), just zero-copy Uint32Array views (or a single ~300 KB copy
 * if buffers aren't 4-aligned).
 */
export function buildNgContext(
  ngKeys: Uint8Array,
  ngTables: Uint8Array,
  lut: Uint8Array,
): NgContext {
  return {
    lut,
    subKeys: buildNgSubKeys(ngKeys),
    tables: buildNgTables(ngTables),
  }
}

/**
 * NG-decrypt `data` in place. `name` and `length` pick the sub-key in
 * the same way as `GTACrypto.DecryptNG(byte[] data, string name, uint length)`.
 *
 * Trailing < 16-byte tail passes through untouched.
 */
export function decryptNg(
  data: Uint8Array,
  name: string,
  length: number,
  ctx: NgContext,
): void {
  const keyIdx = ngKeyIndex(name, length, ctx.lut)
  decryptNgWithKeyIndex(data, keyIdx, ctx)
}

/** Same as {@link decryptNg} but with a precomputed sub-key index. */
export function decryptNgWithKeyIndex(
  data: Uint8Array,
  keyIdx: number,
  ctx: NgContext,
): void {
  const subKeyBase = keyIdx * NG_ROUNDS * 4
  const blocks = (data.length / 16) | 0
  for (let b = 0; b < blocks; b++) {
    decryptBlock(data, b * 16, subKeyBase, ctx)
  }
  // Trailing bytes (data.length % 16) are intentionally left alone, exactly
  // what CodeWalker does (GTACrypto.cs:127-130).
}

/**
 * Decrypt a single 16-byte block in place. Reads/writes through a DataView
 * so we don't have to worry about Uint8Array buffer alignment (the input
 * `data` is the user's payload, not our own).
 *
 * `subKeyBase` is the flat offset in `ctx.subKeys` where this archive's
 * 17 × 4 sub-keys live. `tablesBase` for each round is `round * 16 * 256`.
 */
function decryptBlock(
  data: Uint8Array,
  off: number,
  subKeyBase: number,
  ctx: NgContext,
): void {
  // Use a temporary u32 quartet so we don't have to write back between
  // rounds. All endianness is LE, CodeWalker's BitConverter is LE on x86.
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let x0 = view.getUint32(off, true)
  let x1 = view.getUint32(off + 4, true)
  let x2 = view.getUint32(off + 8, true)
  let x3 = view.getUint32(off + 12, true)

  const tbl = ctx.tables.data
  const subKeys = ctx.subKeys
  const TBL_PER_ROUND = NG_COLS * NG_ENTRIES // 4096 u32 per round

  // At each round we re-extract the 16 bytes of the current state via shifts.
  // Faster than rebuilding a Uint8Array view.

  // ---- Round 0 (RoundA) ----
  let kb = subKeyBase
  ;({ x0, x1, x2, x3 } = roundA(
    x0,
    x1,
    x2,
    x3,
    tbl,
    0 * TBL_PER_ROUND,
    subKeys,
    kb,
  ))
  // ---- Round 1 (RoundA) ----
  kb = subKeyBase + 4
  ;({ x0, x1, x2, x3 } = roundA(
    x0,
    x1,
    x2,
    x3,
    tbl,
    1 * TBL_PER_ROUND,
    subKeys,
    kb,
  ))
  // ---- Rounds 2..15 (RoundB) ----
  for (let r = 2; r <= 15; r++) {
    kb = subKeyBase + r * 4
    ;({ x0, x1, x2, x3 } = roundB(
      x0,
      x1,
      x2,
      x3,
      tbl,
      r * TBL_PER_ROUND,
      subKeys,
      kb,
    ))
  }
  // ---- Round 16 (RoundA) ----
  kb = subKeyBase + 16 * 4
  ;({ x0, x1, x2, x3 } = roundA(
    x0,
    x1,
    x2,
    x3,
    tbl,
    16 * TBL_PER_ROUND,
    subKeys,
    kb,
  ))

  view.setUint32(off, x0, true)
  view.setUint32(off + 4, x1, true)
  view.setUint32(off + 8, x2, true)
  view.setUint32(off + 12, x3, true)
}

/**
 * RoundA, used in rounds 0, 1, 16. Each output u32 is the XOR of 4 table
 * lookups indexed by 4 consecutive input bytes plus a sub-key.
 *
 *   x1' = tbl[0][b0] ^ tbl[1][b1] ^ tbl[2][b2]  ^ tbl[3][b3]  ^ k[0]
 *   x2' = tbl[4][b4] ^ tbl[5][b5] ^ tbl[6][b6]  ^ tbl[7][b7]  ^ k[1]
 *   x3' = tbl[8][b8] ^ tbl[9][b9] ^ tbl[10][b10]^ tbl[11][b11]^ k[2]
 *   x4' = tbl[12][b12]^tbl[13][b13]^tbl[14][b14]^tbl[15][b15] ^ k[3]
 */
function roundA(
  x0: number,
  x1: number,
  x2: number,
  x3: number,
  tbl: Uint32Array,
  tbase: number,
  subKeys: Uint32Array,
  kb: number,
): { x0: number; x1: number; x2: number; x3: number } {
  // Extract the 16 bytes of state (little-endian u32 → byte order b0..b15).
  const b0 = x0 & 0xff
  const b1 = (x0 >>> 8) & 0xff
  const b2 = (x0 >>> 16) & 0xff
  const b3 = (x0 >>> 24) & 0xff
  const b4 = x1 & 0xff
  const b5 = (x1 >>> 8) & 0xff
  const b6 = (x1 >>> 16) & 0xff
  const b7 = (x1 >>> 24) & 0xff
  const b8 = x2 & 0xff
  const b9 = (x2 >>> 8) & 0xff
  const b10 = (x2 >>> 16) & 0xff
  const b11 = (x2 >>> 24) & 0xff
  const b12 = x3 & 0xff
  const b13 = (x3 >>> 8) & 0xff
  const b14 = (x3 >>> 16) & 0xff
  const b15 = (x3 >>> 24) & 0xff

  const y0 =
    (tbl[tbase + 0 * NG_ENTRIES + b0]! ^
      tbl[tbase + 1 * NG_ENTRIES + b1]! ^
      tbl[tbase + 2 * NG_ENTRIES + b2]! ^
      tbl[tbase + 3 * NG_ENTRIES + b3]! ^
      subKeys[kb]!) >>>
    0
  const y1 =
    (tbl[tbase + 4 * NG_ENTRIES + b4]! ^
      tbl[tbase + 5 * NG_ENTRIES + b5]! ^
      tbl[tbase + 6 * NG_ENTRIES + b6]! ^
      tbl[tbase + 7 * NG_ENTRIES + b7]! ^
      subKeys[kb + 1]!) >>>
    0
  const y2 =
    (tbl[tbase + 8 * NG_ENTRIES + b8]! ^
      tbl[tbase + 9 * NG_ENTRIES + b9]! ^
      tbl[tbase + 10 * NG_ENTRIES + b10]! ^
      tbl[tbase + 11 * NG_ENTRIES + b11]! ^
      subKeys[kb + 2]!) >>>
    0
  const y3 =
    (tbl[tbase + 12 * NG_ENTRIES + b12]! ^
      tbl[tbase + 13 * NG_ENTRIES + b13]! ^
      tbl[tbase + 14 * NG_ENTRIES + b14]! ^
      tbl[tbase + 15 * NG_ENTRIES + b15]! ^
      subKeys[kb + 3]!) >>>
    0
  return { x0: y0, x1: y1, x2: y2, x3: y3 }
}

/**
 * RoundB, used in rounds 2..15. Same structure as RoundA but with a
 * different byte→table mapping (the 4 source bytes per output u32 are
 * scattered across the 16-byte state instead of being column-aligned).
 *
 *   x1' = tbl[0][b0]  ^ tbl[7][b7]   ^ tbl[10][b10] ^ tbl[13][b13] ^ k[0]
 *   x2' = tbl[1][b1]  ^ tbl[4][b4]   ^ tbl[11][b11] ^ tbl[14][b14] ^ k[1]
 *   x3' = tbl[2][b2]  ^ tbl[5][b5]   ^ tbl[8][b8]   ^ tbl[15][b15] ^ k[2]
 *   x4' = tbl[3][b3]  ^ tbl[6][b6]   ^ tbl[9][b9]   ^ tbl[12][b12] ^ k[3]
 */
function roundB(
  x0: number,
  x1: number,
  x2: number,
  x3: number,
  tbl: Uint32Array,
  tbase: number,
  subKeys: Uint32Array,
  kb: number,
): { x0: number; x1: number; x2: number; x3: number } {
  const b0 = x0 & 0xff
  const b1 = (x0 >>> 8) & 0xff
  const b2 = (x0 >>> 16) & 0xff
  const b3 = (x0 >>> 24) & 0xff
  const b4 = x1 & 0xff
  const b5 = (x1 >>> 8) & 0xff
  const b6 = (x1 >>> 16) & 0xff
  const b7 = (x1 >>> 24) & 0xff
  const b8 = x2 & 0xff
  const b9 = (x2 >>> 8) & 0xff
  const b10 = (x2 >>> 16) & 0xff
  const b11 = (x2 >>> 24) & 0xff
  const b12 = x3 & 0xff
  const b13 = (x3 >>> 8) & 0xff
  const b14 = (x3 >>> 16) & 0xff
  const b15 = (x3 >>> 24) & 0xff

  const y0 =
    (tbl[tbase + 0 * NG_ENTRIES + b0]! ^
      tbl[tbase + 7 * NG_ENTRIES + b7]! ^
      tbl[tbase + 10 * NG_ENTRIES + b10]! ^
      tbl[tbase + 13 * NG_ENTRIES + b13]! ^
      subKeys[kb]!) >>>
    0
  const y1 =
    (tbl[tbase + 1 * NG_ENTRIES + b1]! ^
      tbl[tbase + 4 * NG_ENTRIES + b4]! ^
      tbl[tbase + 11 * NG_ENTRIES + b11]! ^
      tbl[tbase + 14 * NG_ENTRIES + b14]! ^
      subKeys[kb + 1]!) >>>
    0
  const y2 =
    (tbl[tbase + 2 * NG_ENTRIES + b2]! ^
      tbl[tbase + 5 * NG_ENTRIES + b5]! ^
      tbl[tbase + 8 * NG_ENTRIES + b8]! ^
      tbl[tbase + 15 * NG_ENTRIES + b15]! ^
      subKeys[kb + 2]!) >>>
    0
  const y3 =
    (tbl[tbase + 3 * NG_ENTRIES + b3]! ^
      tbl[tbase + 6 * NG_ENTRIES + b6]! ^
      tbl[tbase + 9 * NG_ENTRIES + b9]! ^
      tbl[tbase + 12 * NG_ENTRIES + b12]! ^
      subKeys[kb + 3]!) >>>
    0
  return { x0: y0, x1: y1, x2: y2, x3: y3 }
}
