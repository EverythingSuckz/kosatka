/**
 * Jenkins one-at-a-time hash. Used here for one specific case: hashing the
 * 32-byte PC_AES_KEY into a u32 seed for .NET Random (which generates the
 * obfuscation streams over magic.dat).
 *
 * Verbatim port of CodeWalker's `JenkHash.GenHash(byte[])` (Jenk.cs).
 */
export function jenkHashBytes(bytes: Uint8Array): number {
  let h = 0
  for (const b of bytes) {
    h = (h + b) >>> 0
    h = (h + (h << 10)) >>> 0
    h = (h ^ (h >>> 6)) >>> 0
  }
  h = (h + (h << 3)) >>> 0
  h = (h ^ (h >>> 11)) >>> 0
  h = (h + (h << 15)) >>> 0
  return h >>> 0
}

/**
 * 29-bit Jenkins-one-at-a-time hash of an ASCII string (lowercase). Used to
 * reverse the AWC stream-ID naming convention (`<basename>_<N>_<left|right>`)
 * so the mixer UI can show friendly labels instead of raw hex hashes. AWC
 * stream IDs are stored masked to 29 bits in the container, see
 * `src/awc/parser.ts` (`id: raw & 0x1fffffff`).
 */
export function jenkHash29(s: string): number {
  const bytes = new TextEncoder().encode(s.toLowerCase())
  return jenkHashBytes(bytes) & 0x1fffffff
}
