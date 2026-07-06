/**
 * Rockstar's XXTEA variant, used for both whole-file and per-block AWC
 * encryption. The variant constant `^ 0x7B3A207F` mixed into the round
 * function is what makes it incompatible with stock XXTEA. Decrypts in place.
 *
 * Verbatim port of CodeWalker's AwcFile.Decrypt_RSXXTEA (lines 43-65).
 * Validated end-to-end against the Cayo Perico sample.
 *
 * @param data uint8 buffer. length MUST be a multiple of 4
 * @param key  4 × uint32 = 128-bit AWC key (PC_AWC_KEY)
 */
export function decryptRSXXTEA(data: Uint8Array, key: Uint32Array): void {
  const n = data.length / 4
  if (!Number.isInteger(n)) {
    throw new Error(`XXTEA: data length ${data.length} is not a multiple of 4`)
  }
  if (n < 2) {
    throw new Error(
      `XXTEA: data length must be at least 8 bytes (got ${data.length})`,
    )
  }
  if (key.length !== 4) {
    throw new Error(
      `XXTEA: key must have exactly 4 u32 elements (got ${key.length})`,
    )
  }

  const blocks = new Uint32Array(n)
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  for (let k = 0; k < n; k++) blocks[k] = view.getUint32(k * 4, true)

  const DELTA = 0x9e3779b9
  let i = (DELTA * (6 + Math.floor(52 / n))) >>> 0
  let b = blocks[0]!

  do {
    for (let bi = n - 1; bi >= 0; bi--) {
      const a = blocks[(bi > 0 ? bi : n) - 1]!
      const A = ((a >>> 5) ^ (b << 2)) >>> 0
      const B = ((b >>> 3) ^ (a << 4)) >>> 0
      const C = (i ^ b) >>> 0
      const keyIdx = ((bi & 3) ^ ((i >>> 2) & 3)) >>> 0
      const D = (key[keyIdx]! ^ a ^ 0x7b3a207f) >>> 0
      const sub = (((A + B) >>> 0) ^ ((C + D) >>> 0)) >>> 0
      blocks[bi] = (blocks[bi]! - sub) >>> 0
      b = blocks[bi]!
    }
    i = (i - DELTA) >>> 0
  } while (i !== 0)

  for (let k = 0; k < n; k++) view.setUint32(k * 4, blocks[k]!, true)
}
