/**
 * Client-side derivation of the AWC XXTEA key (`PC_AWC_KEY`) from the user's
 * GTA V exe. This is option C′ from docs/scope.md, the production flow.
 *
 * Pipeline (mirrors CodeWalker's GTAKeys.UseMagicData / GenerateV2):
 *
 *   1. SHA-1 sliding-window search over `gta5_enhanced.exe` for the 32-byte
 *      `PC_AES_KEY` (matches a known SHA-1 hash).
 *   2. Read our embedded `magic.dat` (passed in as bytes, or fetched from
 *      `/magic.dat` by the convenience wrapper).
 *   3. Seed a .NET-compatible `Random` with `JenkHash(PC_AES_KEY)`. Generate
 *      four byte streams the same length as magic.dat. Subtract them from
 *      magic.dat byte-wise to get the encrypted blob.
 *   4. AES-256-ECB decrypt the blob (no padding, single round).
 *   5. DEFLATE-decompress (raw deflate, no zlib/gzip header).
 *   6. Slice off the last 16 bytes, the four u32 of `PC_AWC_KEY`.
 *
 * Browser-only. Uses `crypto.subtle` for SHA-1 / AES and
 * `DecompressionStream` for deflate.
 *
 * Note: Web Crypto's BufferSource type is overly strict in current TS lib
 * defs. The `toAB` helper at the bottom copies any Uint8Array into a fresh
 * ArrayBuffer. Runtime cost is negligible at the sizes we deal with.
 */

import { DotNetRandom } from './dotnet-random'
import { searchHash } from './hash-search'
import { jenkHashBytes } from './jenk-hash'

/** SHA-1 of the 32-byte AES key, exactly as embedded in CodeWalker's GTAKeys.cs. */
const PC_AES_KEY_HASH = new Uint8Array([
  0xa0, 0x79, 0x61, 0x28, 0xa7, 0x75, 0x72, 0x0a, 0xc2, 0x04, 0xd9, 0x81, 0x9f,
  0x68, 0xc1, 0x72, 0xe3, 0x95, 0x2c, 0x6d,
])

/** Path the browser fetches the embedded magic.dat from. */
export const MAGIC_URL = '/magic.dat'

export type DeriveStage = 'aes-search' | 'decrypt' | 'inflate'

export interface DeriveOptions {
  /**
   * Progress callback fired during the slow exe scan and short crypto stages
   * (0..1). `sampleHex` (aes-search only) is the current candidate window's
   * leading bytes, for a live scan display.
   */
  onProgress?: (
    stage: DeriveStage,
    progress: number,
    sampleHex?: string,
  ) => void
}

export class KeyDerivationError extends Error {
  readonly stage: DeriveStage | 'fetch'
  constructor(stage: DeriveStage | 'fetch', message: string) {
    super(`AWC key derivation failed at ${stage}: ${message}`)
    this.name = 'KeyDerivationError'
    this.stage = stage
  }
}

/**
 * Full set of keys recovered from `magic.dat`. The blob layout (mirrors
 * CodeWalker `GTAKeys.UseMagicData`) is, in order:
 *
 *   [0 .. 27472)        PC_NG_KEYS         101 × 272 bytes (per-archive sub-keys)
 *   [27472 .. 306000)   PC_NG_TABLES       17 × 16 × 256 × u32 = 278528 bytes
 *   [306000 .. 306256)  PC_LUT             256 bytes (GTA5Hash LUT)
 *   [306256 .. 306272)  PC_AWC_KEY         16 bytes = 4 × u32 (RSXXTEA key)
 *
 * The first three are required for RPF7 NG decryption. The last is the
 * RSXXTEA key used by the AWC pipeline. We expose the slices as raw bytes
 * (and as the cooked `awcKey` u32 array) so callers can re-slice without
 * re-running the full derivation.
 */
export interface DerivedKeys {
  /** 4 × u32 RSXXTEA key for AWC stream decryption. */
  awcKey: Uint32Array
  /** PC_NG_KEYS. 101 × 272 bytes of per-archive NG sub-keys (raw, concatenated). */
  ngKeys: Uint8Array
  /** PC_NG_DECRYPT_TABLES. 17 × 16 × 256 × u32 = 278528 bytes (raw, concatenated). */
  ngTables: Uint8Array
  /** PC_LUT. 256-byte byte permutation used by the per-archive name hash. */
  lut: Uint8Array
}

const NG_KEYS_LEN = 27472
const NG_TABLES_LEN = 278528
const LUT_LEN = 256
const AWC_KEY_LEN = 16
const EXPECTED_INFLATED_LEN =
  NG_KEYS_LEN + NG_TABLES_LEN + LUT_LEN + AWC_KEY_LEN

/**
 * Pure derivation: takes both the exe bytes and the magic.dat bytes. Used
 * by the browser flow (which fetches magic.dat from /magic.dat) and by
 * Node-style tests (which read it from disk).
 *
 * Returns the full {@link DerivedKeys} bundle. The convenience wrapper
 * {@link deriveAwcKeyFromBytes} just picks the `awcKey` field.
 */
export async function deriveKeysFromBytes(
  exeBytes: Uint8Array,
  magic: Uint8Array,
  options: DeriveOptions = {},
): Promise<DerivedKeys> {
  // Step 1: hash-search the AES key in the exe.
  const aesKey = await searchHash(exeBytes, PC_AES_KEY_HASH, {
    onProgress: (p, hex) => options.onProgress?.('aes-search', p, hex),
  })
  if (!aesKey) {
    throw new KeyDerivationError(
      'aes-search',
      'PC_AES_KEY not found in the supplied exe. Is this really gta5_enhanced.exe (or gta5.exe)?',
    )
  }

  // Step 2: deobfuscate magic.dat by subtracting four .NET-Random byte streams
  // seeded by JenkHash(aesKey).
  options.onProgress?.('decrypt', 0)
  const seed = jenkHashBytes(aesKey)
  const rng = new DotNetRandom(seed | 0)
  const len = magic.length
  const rb1 = new Uint8Array(len)
  const rb2 = new Uint8Array(len)
  const rb3 = new Uint8Array(len)
  const rb4 = new Uint8Array(len)
  rng.nextBytes(rb1)
  rng.nextBytes(rb2)
  rng.nextBytes(rb3)
  rng.nextBytes(rb4)
  const encrypted = new Uint8Array(len)
  for (let i = 0; i < len; i++) {
    encrypted[i] = (magic[i]! - rb1[i]! - rb2[i]! - rb3[i]! - rb4[i]!) & 0xff
  }

  // Step 3: AES-256-ECB decrypt. Web Crypto exposes CBC/CTR/GCM but not ECB,
  // so we recover ECB plaintext from a CBC pass:
  //   ecb_plain[i] = cbc_plain[i] XOR ciphertext[i-1]
  // (CBC defines cbc_plain[i] = AES_decrypt(ct[i]) XOR ct[i-1]. XORing back
  // with ct[i-1] cancels the chaining.)
  // We synthesise a final PKCS#7-padding ciphertext block so Web Crypto's
  // mandatory PKCS#7-strip succeeds.
  options.onProgress?.('decrypt', 0.5)
  const decryptedTrim = encrypted.length - (encrypted.length % 16)
  const decrypted = new Uint8Array(encrypted.length)
  const zero = new Uint8Array(16)

  const aesKeyDec = await crypto.subtle.importKey(
    'raw',
    toAB(aesKey),
    { name: 'AES-CBC', length: 256 },
    false,
    ['decrypt'],
  )
  const aesKeyEnc = await crypto.subtle.importKey(
    'raw',
    toAB(aesKey),
    { name: 'AES-CBC', length: 256 },
    false,
    ['encrypt'],
  )
  // We need a synthesised final ciphertext block C_pad such that, when CBC-
  // decrypted as the last block of our stream, the resulting plaintext is
  // exactly [0x10]×16 (a valid PKCS#7 padding block that Web Crypto will
  // strip). CBC says:
  //
  //   pt[last] = AES_dec(C_pad) XOR ct[last-1]
  //
  // Setting pt[last] = [0x10]×16 gives:
  //
  //   AES_dec(C_pad) = [0x10]×16 XOR ct[last-1]
  //   C_pad         = AES_enc([0x10]×16 XOR ct[last-1])
  //
  // We compute AES_enc(...) by CBC-encrypting one block with IV=0 and taking
  // the first 16 bytes of the result.
  const lastRealBlock = encrypted.subarray(decryptedTrim - 16, decryptedTrim)
  const padPlainTarget = new Uint8Array(16)
  for (let j = 0; j < 16; j++) padPlainTarget[j] = 0x10 ^ lastRealBlock[j]!
  const padCt = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-CBC', iv: zero },
      aesKeyEnc,
      toAB(padPlainTarget),
    ),
  )
  const padBlockCt = padCt.subarray(0, 16)

  const combined = new Uint8Array(decryptedTrim + 16)
  combined.set(encrypted.subarray(0, decryptedTrim), 0)
  combined.set(padBlockCt, decryptedTrim)
  const cbcPlain = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-CBC', iv: zero },
      aesKeyDec,
      toAB(combined),
    ),
  )
  // cbcPlain length = decryptedTrim (PKCS#7 strip done by Web Crypto).
  for (let off = 0; off < decryptedTrim; off += 16) {
    const prev = off === 0 ? zero : encrypted.subarray(off - 16, off)
    for (let j = 0; j < 16; j++) {
      decrypted[off + j] = cbcPlain[off + j]! ^ prev[j]!
    }
  }
  // Trailing bytes (if blob length not a multiple of 16) pass through
  // unchanged, same as CodeWalker's behaviour.
  for (let i = decryptedTrim; i < encrypted.length; i++) {
    decrypted[i] = encrypted[i]!
  }

  // Step 4: DEFLATE-decompress (raw, no zlib/gzip wrapper).
  options.onProgress?.('inflate', 0)
  const inflated = await rawInflate(decrypted)
  options.onProgress?.('inflate', 1)

  // Step 5: slice all four sub-blobs in fixed order. Layout is fully
  // documented on {@link DerivedKeys}.
  if (inflated.length < EXPECTED_INFLATED_LEN) {
    throw new KeyDerivationError(
      'inflate',
      `inflated blob too short (${inflated.length} < ${EXPECTED_INFLATED_LEN}), derivation pipeline produced wrong bytes`,
    )
  }
  let bp = 0
  // Copy each slice into a fresh standalone Uint8Array. We intentionally
  // don't keep references into the inflated buffer because callers store
  // these long-term (IndexedDB, module state) and we want to release the
  // ~300 KB inflated blob.
  const ngKeys = new Uint8Array(NG_KEYS_LEN)
  ngKeys.set(inflated.subarray(bp, bp + NG_KEYS_LEN))
  bp += NG_KEYS_LEN
  const ngTables = new Uint8Array(NG_TABLES_LEN)
  ngTables.set(inflated.subarray(bp, bp + NG_TABLES_LEN))
  bp += NG_TABLES_LEN
  const lut = new Uint8Array(LUT_LEN)
  lut.set(inflated.subarray(bp, bp + LUT_LEN))
  bp += LUT_LEN
  const awcKeyBytes = inflated.subarray(bp, bp + AWC_KEY_LEN)
  const awcKey = new Uint32Array(4)
  const view = new DataView(
    awcKeyBytes.buffer,
    awcKeyBytes.byteOffset,
    awcKeyBytes.byteLength,
  )
  for (let i = 0; i < 4; i++) awcKey[i] = view.getUint32(i * 4, true)
  return { awcKey, ngKeys, ngTables, lut }
}

/**
 * Backwards-compatible AWC-key-only entry point. Equivalent to
 * `(await deriveKeysFromBytes(exe, magic, opts)).awcKey`.
 */
export async function deriveAwcKeyFromBytes(
  exeBytes: Uint8Array,
  magic: Uint8Array,
  options: DeriveOptions = {},
): Promise<Uint32Array> {
  return (await deriveKeysFromBytes(exeBytes, magic, options)).awcKey
}

/**
 * Browser convenience: fetches `/magic.dat` and calls
 * {@link deriveKeysFromBytes} with the user-supplied exe. Returns the full
 * bundle (AWC key + RPF NG decryption material).
 */
export async function deriveKeys(
  exeBytes: Uint8Array,
  options: DeriveOptions = {},
): Promise<DerivedKeys> {
  const magicResp = await fetch(MAGIC_URL)
  if (!magicResp.ok) {
    throw new KeyDerivationError(
      'fetch',
      `magic.dat fetch failed (${magicResp.status})`,
    )
  }
  const magic = new Uint8Array(await magicResp.arrayBuffer())
  return deriveKeysFromBytes(exeBytes, magic, options)
}

function toAB(u: Uint8Array): ArrayBuffer {
  const ab = new ArrayBuffer(u.byteLength)
  new Uint8Array(ab).set(u)
  return ab
}

async function rawInflate(input: Uint8Array): Promise<Uint8Array> {
  // .NET's DeflateStream uses raw deflate (no zlib/gzip header).
  const blob = new Blob([toAB(input)])
  const ds = new DecompressionStream('deflate-raw')
  const inflated = await new Response(
    blob.stream().pipeThrough(ds),
  ).arrayBuffer()
  return new Uint8Array(inflated)
}
