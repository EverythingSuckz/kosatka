/**
 * AES-256-ECB decryption for RPF7's archive- and entry-level encryption.
 * Single round, no padding, matching CodeWalker's
 * `GTACrypto.DecryptAESData(data, key, rounds = 1)`.
 *
 * Web Crypto exposes CBC/CTR/GCM but not ECB, so we synthesise ECB out of
 * CBC the same way the AWC key derivation does (see src/keys/derive.ts).
 * Trailing bytes (data.length % 16) pass through unchanged.
 *
 * The "AES key" here is the 32-byte `PC_AES_KEY`. We do not ship it. It lives
 * only in the user's exe and is recovered by
 * {@link import('../keys/derive').deriveKeys} at session-init time. The RPF
 * AES path is the first runtime consumer of `PC_AES_KEY`, so this module
 * re-derives it from the user's exe via {@link setRpfAesKey}. Callers with no
 * AES-encrypted RPF can skip this.
 */

import { NG_ROUNDS, decryptNgWithKeyIndex } from './feistel'
import { ngKeyIndex } from './gta5-hash'
import type { NgContext } from './feistel'

/** Module-level cache of the runtime PC_AES_KEY. Caller supplies. */
let pcAesKey: Uint8Array | null = null

/**
 * Inject the 32-byte PC_AES_KEY (the one used to AES-decrypt magic.dat).
 * Only needed for AES-encrypted RPFs, which are rare in stock GTAV (mostly
 * modded or update.rpf-style archives). Most stock content is NG-encrypted.
 * Idempotent, safe to call multiple times.
 */
export function setRpfAesKey(key: Uint8Array): void {
  if (key.length !== 32) {
    throw new Error(`PC_AES_KEY must be 32 bytes (got ${key.length})`)
  }
  pcAesKey = new Uint8Array(key)
}

/**
 * Reset the cached AES key. Primarily for tests.
 */
export function clearRpfAesKey(): void {
  pcAesKey = null
}

/**
 * Decrypt `data` with AES-256-ECB using the previously-injected key. Returns
 * a fresh `Uint8Array` (the original is not modified).
 *
 * Throws if {@link setRpfAesKey} has not been called.
 */
export async function decryptAes(data: Uint8Array): Promise<Uint8Array> {
  if (!pcAesKey) {
    throw new Error(
      'RPF AES decryption requested but no AES key has been set. Call setRpfAesKey() with the PC_AES_KEY from key derivation.',
    )
  }
  return decryptAesWithKey(data, pcAesKey)
}

/**
 * Stateless variant, useful for tests or callers that hold the key locally
 * instead of relying on the module cache.
 */
export async function decryptAesWithKey(
  data: Uint8Array,
  key: Uint8Array,
): Promise<Uint8Array> {
  if (key.length !== 32) {
    throw new Error(`AES key must be 32 bytes (got ${key.length})`)
  }
  const blocks = (data.length / 16) | 0
  const trimmed = blocks * 16
  const out = new Uint8Array(data.length)
  // Copy tail (untouched bytes) up front.
  if (trimmed < data.length) {
    out.set(data.subarray(trimmed), trimmed)
  }
  if (blocks === 0) return out

  // The CBC-with-synthesised-padding trick: we ask Web Crypto to do AES-CBC
  // decryption with IV=0. CBC says pt[i] = AES_dec(ct[i]) XOR ct[i-1]. XORing
  // back with ct[i-1] (which we know) cancels the chaining and recovers the
  // ECB plaintext. We append a synthesised final ciphertext block C_pad
  // chosen so the resulting plaintext is [0x10]×16 (a valid PKCS#7 padding
  // block that Web Crypto will strip).
  const zeroIv = new Uint8Array(16)
  const importedDec = await crypto.subtle.importKey(
    'raw',
    toAB(key),
    { name: 'AES-CBC', length: 256 },
    false,
    ['decrypt'],
  )
  const importedEnc = await crypto.subtle.importKey(
    'raw',
    toAB(key),
    { name: 'AES-CBC', length: 256 },
    false,
    ['encrypt'],
  )

  const lastReal = data.subarray(trimmed - 16, trimmed)
  const padTarget = new Uint8Array(16)
  for (let i = 0; i < 16; i++) padTarget[i] = 0x10 ^ lastReal[i]!
  const padCt = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-CBC', iv: zeroIv },
      importedEnc,
      toAB(padTarget),
    ),
  )
  const padBlock = padCt.subarray(0, 16)

  const combined = new Uint8Array(trimmed + 16)
  combined.set(data.subarray(0, trimmed), 0)
  combined.set(padBlock, trimmed)
  const cbcPlain = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-CBC', iv: zeroIv },
      importedDec,
      toAB(combined),
    ),
  )

  for (let off = 0; off < trimmed; off += 16) {
    const prev = off === 0 ? zeroIv : data.subarray(off - 16, off)
    for (let j = 0; j < 16; j++) out[off + j] = cbcPlain[off + j]! ^ prev[j]!
  }
  return out
}

/**
 * NG-decrypt convenience for the RPF parser. Returns a fresh array, the
 * input is not modified. Tail bytes (< 16) pass through.
 */
export function decryptNgCopy(
  data: Uint8Array,
  name: string,
  length: number,
  ctx: NgContext,
): Uint8Array {
  const out = new Uint8Array(data.length)
  out.set(data)
  const keyIdx = ngKeyIndex(name, length, ctx.lut)
  // sanity check on table dimensions while we're here
  if (ctx.subKeys.length < (keyIdx + 1) * NG_ROUNDS * 4) {
    throw new Error(
      `NG context sub-keys array too small (keyIdx=${keyIdx}, length=${ctx.subKeys.length})`,
    )
  }
  decryptNgWithKeyIndex(out, keyIdx, ctx)
  return out
}

function toAB(u: Uint8Array): ArrayBuffer {
  const ab = new ArrayBuffer(u.byteLength)
  new Uint8Array(ab).set(u)
  return ab
}
