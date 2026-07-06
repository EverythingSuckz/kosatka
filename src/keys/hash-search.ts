/**
 * Sliding-window SHA-1 hash search across an exe. CodeWalker's
 * `HashSearch.SearchHash` looks for a 32-byte sequence whose SHA-1 matches
 * a known target. We use it to extract `PC_AES_KEY` from a user-supplied
 * `gta5_enhanced.exe` (or `gta5.exe`).
 *
 * Same alignment (8-byte stride) as CodeWalker. Web Crypto's `subtle.digest`
 * returns a Promise per call, so the scan runs millions of digests, but
 * modern hardware SHA-1 is ~2 GiB/s and the exe is ~150 MB so it stays fast.
 *
 * Practical performance: typical exe scan completes in ~5-15 s with a
 * progress callback fired every ~1 MB.
 */

const ALIGN = 8
const KEY_LEN = 32 // expected PC_AES_KEY size in bytes

export interface HashSearchOptions {
  /**
   * 0..1 progress reports during the scan. `windowHex` is the current
   * candidate window (first bytes as hex) so the UI can show what's being
   * tested, the real bytes at the current scan position.
   */
  onProgress?: (progress: number, windowHex: string) => void
}

const HEX = '0123456789abcdef'
function toHex(bytes: Uint8Array, n: number): string {
  let s = ''
  const count = Math.min(n, bytes.length)
  for (let i = 0; i < count; i++) {
    const b = bytes[i]!
    s += HEX[b >> 4]! + HEX[b & 0xf]! + ' '
  }
  return s.trimEnd()
}

/**
 * Returns the 32-byte sequence whose SHA-1 matches `targetHash`, or null if
 * no match is found. The target must be exactly 20 bytes (SHA-1 size).
 */
export async function searchHash(
  exeBytes: Uint8Array,
  targetHash: Uint8Array,
  options: HashSearchOptions = {},
): Promise<Uint8Array | null> {
  if (targetHash.length !== 20) {
    throw new Error(`SHA-1 hash must be 20 bytes (got ${targetHash.length})`)
  }
  const len = exeBytes.length
  const total = Math.floor((len - KEY_LEN) / ALIGN)
  const reportEvery = Math.max(1, Math.floor(total / 100))

  for (let i = 0; i < total; i++) {
    const off = i * ALIGN
    const window = exeBytes.subarray(off, off + KEY_LEN)
    // crypto.subtle.digest accepts BufferSource. An ArrayBuffer copy avoids
    // SharedArrayBuffer typing issues and any view-aliasing concerns.
    const buf = new ArrayBuffer(KEY_LEN)
    new Uint8Array(buf).set(window)
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', buf))
    if (bytesEqual(digest, targetHash)) {
      // Return a fresh copy so callers can hold onto it past the scan.
      return new Uint8Array(window)
    }
    if (options.onProgress && i % reportEvery === 0) {
      options.onProgress(i / total, toHex(window, 12))
    }
  }
  options.onProgress?.(1, '')
  return null
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}
