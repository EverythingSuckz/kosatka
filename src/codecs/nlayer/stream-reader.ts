/**
 * Minimal in-memory byte reader (NLayer port).
 *
 * NOT a verbatim port. Upstream's `MpegStreamReader` wraps a generic
 * .NET `Stream` with a ring-buffered `ReadBuffer` (1.5 KLOC of seek /
 * discard / lock handling). Our AWC pipeline hands us a single
 * `Uint8Array` per stream so we drop all of that and expose just what
 * `FrameBase` and `MpegStreamReader` need:
 *
 *   - random-access `read(offset, dest, destIdx, count)` / `readByte(offset)`
 *   - knowledge of the source `length` so we can detect EOF.
 *
 * Keeping it as a thin class (instead of passing the Uint8Array around
 * directly) preserves the same API shape the C# code uses, which makes
 * the downstream port read 1:1.
 */

export class ByteSource {
  readonly data: Uint8Array
  readonly length: number

  constructor(data: Uint8Array) {
    this.data = data
    this.length = data.length
  }

  /**
   * Copy bytes from `offset` into `dest[destIdx..destIdx+count]`.
   * Returns the number actually copied (may be less than `count` if
   * the source has fewer bytes available). Mirrors the C# `Read`
   * signature so the frame port can call it unchanged.
   */
  read(
    offset: number,
    dest: Uint8Array,
    destIdx: number,
    count: number,
  ): number {
    if (offset < 0) throw new RangeError('offset must be non-negative')
    if (destIdx < 0 || destIdx + count > dest.length) {
      throw new RangeError('dest index out of range')
    }
    if (offset >= this.length) return 0

    const available = Math.min(count, this.length - offset)
    dest.set(this.data.subarray(offset, offset + available), destIdx)
    return available
  }

  /**
   * Return the byte at `offset`, or -1 if past the end. Matches C#
   * `ReadByte(long)`.
   */
  readByte(offset: number): number {
    if (offset < 0) throw new RangeError('offset must be non-negative')
    if (offset >= this.length) return -1
    return this.data[offset]!
  }
}
