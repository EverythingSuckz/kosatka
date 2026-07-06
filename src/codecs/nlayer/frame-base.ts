/**
 * Abstract frame base, a verbatim port of `NLayer/Decoder/FrameBase.cs`.
 * Holds the (offset, length, source) tuple and exposes a `read` / `readByte`
 * pair that delegate to the underlying `ByteSource`, or after `saveBuffer()`
 * has been called, to a frame-local copy of the bytes (needed when the source
 * can't seek and we must retain frame data after the read cursor moves on).
 *
 * Differences from upstream:
 *   - `_totalAllocation` is dropped, we don't enforce a memory cap.
 *   - `_savedBuffer` is a `Uint8Array | null` instead of `byte[]`.
 *   - `Validate(offset, reader)` becomes `validate(offset, source)`.
 */

import type { ByteSource } from './stream-reader'

export abstract class FrameBase {
  offset = 0
  length = 0
  protected source: ByteSource | null = null
  private savedBuffer: Uint8Array | null = null

  validate(offset: number, source: ByteSource): boolean {
    this.offset = offset
    this.source = source

    const len = this.validateImpl()

    if (len > 0) {
      this.length = len
      return true
    }
    return false
  }

  /**
   * Subclass hook: returns the frame length in bytes (including any
   * sync header), or -1 if the frame is invalid.
   */
  protected abstract validateImpl(): number

  protected read(
    offset: number,
    buffer: Uint8Array,
    index: number,
    count: number,
  ): number {
    if (this.savedBuffer !== null) {
      if (index < 0 || index + count > buffer.length) return 0
      if (offset < 0 || offset >= this.savedBuffer.length) return 0
      let actualCount = count
      if (offset + actualCount > this.savedBuffer.length) {
        // Mirrors the C# quirk verbatim: it subtracts `index` rather than
        // `offset`. We keep that intact since the upstream Layer III code
        // never relies on the truncation path here.
        actualCount = this.savedBuffer.length - index
      }
      buffer.set(this.savedBuffer.subarray(offset, offset + actualCount), index)
      return actualCount
    }
    if (this.source === null) return 0
    return this.source.read(this.offset + offset, buffer, index, count)
  }

  protected readByte(offset: number): number {
    if (this.savedBuffer !== null) {
      if (offset < 0) throw new RangeError('offset must be non-negative')
      if (offset >= this.savedBuffer.length) return -1
      return this.savedBuffer[offset]!
    }
    if (this.source === null) return -1
    return this.source.readByte(this.offset + offset)
  }

  saveBuffer(): void {
    if (this.source === null) return
    const buf = new Uint8Array(this.length)
    this.source.read(this.offset, buf, 0, this.length)
    this.savedBuffer = buf
  }

  clearBuffer(): void {
    this.savedBuffer = null
  }

  /** Called when the stream is not seek-able. No-op by default. */
  parse(): void {}
}
