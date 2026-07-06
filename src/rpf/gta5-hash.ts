/**
 * GTA5Hash. A tiny custom hash that selects which of the 101 per-archive
 * NG sub-keys to use for a given RPF or per-entry filename.
 *
 * Port of CodeWalker's `GTA5Hash.CalculateHash`:
 *
 *   func CalculateHash(filename string, lut []byte) uint32 {
 *       var result uint32
 *       for _, c := range filename {
 *           temp := 1025 * (uint32(lut[c]) + result)
 *           result = (temp >> 6) ^ temp
 *       }
 *       return 32769 * (((9 * result) >> 11) ^ (9 * result))
 *   }
 *
 * Inputs are ASCII filenames (CodeWalker reads C# `string` as char-bytes
 * mod 256). RPF names are always ASCII, any stray non-ASCII would be a
 * parser bug elsewhere.
 *
 * All arithmetic is u32. We use `>>> 0` after every multiplication because
 * JS's `*` can blow past 2^32 even on small inputs (1025 × 0xFFFFFFFF).
 */

/**
 * Compute the GTA5Hash of `name` using the 256-byte permutation table `lut`
 * (slice 3 of magic.dat, see {@link import('../keys/derive').DerivedKeys}).
 *
 * @param name ASCII filename, case-sensitive. CodeWalker passes the archive's
 *             `Name` field verbatim, NOT lower-cased.
 * @param lut  256-byte permutation, `PC_LUT` from the derived keys bundle.
 * @returns 32-bit unsigned hash.
 */
export function gta5Hash(name: string, lut: Uint8Array): number {
  if (lut.length !== 256) {
    throw new Error(`gta5Hash: LUT must be 256 bytes (got ${lut.length})`)
  }
  let result = 0
  for (let i = 0; i < name.length; i++) {
    const cc = name.charCodeAt(i) & 0xff
    // Math.imul matches C# unchecked u32 multiplication via the low 32 bits.
    const temp = Math.imul(1025, (lut[cc]! + result) | 0) >>> 0
    result = ((temp >>> 6) ^ temp) >>> 0
  }
  const r9 = Math.imul(9, result) >>> 0
  return Math.imul(32769, ((r9 >>> 11) ^ r9) >>> 0) >>> 0
}

/**
 * Select the 272-byte NG sub-key for an archive named `name` with on-disk
 * `length` bytes. Mirrors `GTACrypto.GetNGKey`:
 *
 *   keyidx = (gta5Hash(name) + length + 61) % 101
 *
 * (`101 - 40 = 61`, CodeWalker spells it that way for historical reasons.)
 */
export function ngKeyIndex(
  name: string,
  length: number,
  lut: Uint8Array,
): number {
  const h = gta5Hash(name, lut)
  // All math in u32 to avoid sign-bit surprises when h is ≥ 0x80000000.
  // Modulo by 101 fits in a regular safe int after the add.
  const sum = ((h >>> 0) + (length >>> 0) + 61) >>> 0
  return sum % 101
}
