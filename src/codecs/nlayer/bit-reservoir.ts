/**
 * NLayer port. Bit reservoir.
 *
 * Verbatim port of `NLayer/Decoder/BitReservoir.cs`. The reservoir is a
 * fixed-size ring buffer of bytes (8192) with bit-level read/peek/skip
 * cursor semantics. Layer III feeds each frame's main_data into it and
 * pulls scalefactor + huffman bits back out.
 *
 * Layout mirrors upstream exactly:
 *   - `_buf` 8192-byte ring
 *   - `_start` / `_end` are byte cursors. `_end === -1` marks "empty"
 *   - `_bitsLeft` ∈ [0, 8] is the remaining bits in `_buf[_start]`
 *
 * JS signed-bitwise notes:
 *   - All bit operations here stay within 32-bit signed range. The
 *     widest single read is 32 bits, and we never compare against a
 *     value > 0x7FFFFFFF, so no `>>> 0` coercions are needed here.
 *     (Frame sync comparisons in `MpegFrame.trySync` do need them.)
 */

import { MpegChannelMode, MpegVersion } from './types'
import type { IMpegFrame } from './types'

const BUF_SIZE = 8192

function getSlots(frame: IMpegFrame): number {
  let cnt = frame.frameLength - 4
  if (frame.hasCrc) cnt -= 2

  if (
    frame.version === MpegVersion.Version1 &&
    frame.channelMode !== MpegChannelMode.Mono
  ) {
    return cnt - 32
  }
  if (
    frame.version > MpegVersion.Version1 &&
    frame.channelMode === MpegChannelMode.Mono
  ) {
    return cnt - 9
  }
  return cnt - 17
}

export class BitReservoir {
  // Per the spec, the maximum buffer size for Layer III is 7680 bits, which is 960 bytes.
  // The only catch is if we're decoding a "free" frame, which could be a lot more (since
  // some encoders allow higher bitrates to maintain audio transparency).
  private readonly _buf = new Uint8Array(BUF_SIZE)
  private _start = 0
  private _end = -1
  private _bitsLeft = 0
  private _bitsRead = 0

  /**
   * Append the main-data slots of `frame` to the reservoir, then position
   * the read cursor so that `overlap` bytes precede `_end + 1`.
   *
   * Returns false if we did not have enough preceding bytes to satisfy
   * `overlap` (i.e. we skipped a frame and the caller should treat this
   * frame as a re-sync point).
   */
  addBits(frame: IMpegFrame, overlap: number): boolean {
    const originalEnd = this._end

    let slots = getSlots(frame)
    // AWC blocks pack the last frame byte-truncated by up to ~16 bytes
    // (see `src/codecs/nlayer/mpeg-stream-reader.ts` for the rationale).
    // The truncated tail always falls inside the main_data *stuffing*
    // region, beyond what `part_2_3_length` bits the huffman section
    // actually reads. Zero-pad the missing slots rather than crashing so
    // the audio content survives. `MpegFrame.readBits` throws
    // `EndOfStream` once the underlying byte source is exhausted, and we
    // catch that here and fill the remainder with zeros.
    let truncated = false
    while (--slots >= 0) {
      let temp = 0
      if (!truncated) {
        try {
          temp = frame.readBits(8)
        } catch {
          truncated = true
          temp = 0
        }
      }
      if (temp === -1) throw new Error('Frame did not have enough bytes!')
      this._end = this._end + 1
      this._buf[this._end] = temp & 0xff
      if (this._end === BUF_SIZE - 1) this._end = -1
    }

    this._bitsLeft = 8
    if (originalEnd === -1) {
      // it's either the start of the stream or we've reset...  only return true if overlap says this frame is enough
      return overlap === 0
    }
    // it's not the start of the stream so calculate _start based on whether we have enough bytes left

    // if we have enough bytes, reset start to match overlap
    if ((originalEnd + 1 - this._start + BUF_SIZE) % BUF_SIZE >= overlap) {
      this._start = (originalEnd + 1 - overlap + BUF_SIZE) % BUF_SIZE
      return true
    }
    // otherwise, just set start to match the start of the frame (we probably skipped a frame)
    this._start = originalEnd + overlap
    return false
  }

  /**
   * Read `count` bits (1..32) and advance the cursor. If the reservoir
   * is exhausted before `count` bits are available, which only happens
   * on the byte-truncated last frame of an AWC block, returns zero
   * and conceptually advances `_bitsRead` past the EOF so the caller
   * (huffman) terminates cleanly via `part3end > bitsRead` guards. The
   * truncated tail bits encode bits beyond `part_2_3_length` in normal
   * frames. For the truncated frame we trade a tiny bit of last-frame
   * distortion for a clean IMDCT-state transition into the next block
   * (which otherwise produced a click on ch7+ at every block boundary).
   */
  getBits(count: number): number {
    const peek = this.tryPeekBits(count)
    if (peek.readCount < count) {
      // EOF case: pretend we consumed all `count` bits but return zero.
      // Empty the reservoir so subsequent reads stay in the EOF branch.
      this._bitsRead += count
      this._bitsLeft = 0
      return 0
    }

    this.skipBits(count)

    return peek.value
  }

  /**
   * Optimised single-bit read. Matches upstream `Get1Bit` exactly,
   * including the side-effect of advancing `_start` and refilling
   * `_bitsLeft` to 8 when the current byte is exhausted. When the
   * reservoir is exhausted, returns 0 and advances `_bitsRead` (so
   * count1-loop termination via `part3end > bitsRead` still fires).
   */
  get1Bit(): number {
    if (this._bitsLeft === 0) {
      ++this._bitsRead
      return 0
    }

    --this._bitsLeft
    ++this._bitsRead
    const val = (this._buf[this._start]! >> this._bitsLeft) & 1

    if (this._bitsLeft === 0) {
      this._start = (this._start + 1) % BUF_SIZE
      if (this._start !== this._end + 1) {
        this._bitsLeft = 8
      }
    }

    return val
  }

  /**
   * Peek up to `count` bits without advancing the cursor. Returns the
   * value (right-aligned) plus how many bits were actually available.
   *
   * Behaviour matches C# `TryPeekBits(int, out int)` including the
   * "no bits left → readCount = 0" early-exit.
   */
  tryPeekBits(count: number): { value: number; readCount: number } {
    if (count < 0 || count > 32) {
      throw new RangeError('Must return between 0 and 32 bits!')
    }

    // if we don't have any bits left, just return no bits read
    if (this._bitsLeft === 0 || count === 0) {
      return { value: 0, readCount: 0 }
    }

    // get bits from the current start of the reservoir
    let bits = this._buf[this._start]!
    if (count < this._bitsLeft) {
      // just grab the bits, adjust the "left" count, and return
      bits >>= this._bitsLeft - count
      bits &= (1 << count) - 1
      return { value: bits, readCount: count }
    }

    // we have to do it the hard way...
    bits &= (1 << this._bitsLeft) - 1
    let remaining = count - this._bitsLeft
    let readCount = this._bitsLeft

    let resStart = this._start

    // arg... gotta grab some more bits...
    while (remaining > 0) {
      // advance the start marker, and if we just advanced it past the end of the buffer, bail
      resStart = (resStart + 1) % BUF_SIZE
      if (resStart === this._end + 1) {
        break
      }

      const bitsToRead = Math.min(remaining, 8)

      bits <<= bitsToRead
      bits |= this._buf[resStart]! >> ((8 - bitsToRead) % 8)

      remaining -= bitsToRead

      readCount += bitsToRead
    }

    return { value: bits, readCount }
  }

  get bitsAvailable(): number {
    if (this._bitsLeft > 0) {
      return (
        ((this._end + BUF_SIZE - this._start) % BUF_SIZE) * 8 + this._bitsLeft
      )
    }
    return 0
  }

  get bitsRead(): number {
    return this._bitsRead
  }

  skipBits(count: number): void {
    if (count > 0) {
      const avail = this.bitsAvailable
      if (count > avail) {
        // EOF-tolerant skip: see `getBits` / `get1Bit` rationale. Empty
        // the reservoir but advance `_bitsRead` so the LayerIIIDecoder's
        // `if (_bitsRead < part3end)` skip-to-end pass on a truncated
        // frame is a no-op rather than throwing.
        this._bitsRead += count
        this._bitsLeft = 0
        return
      }

      const offset = 8 - this._bitsLeft + count
      this._start = (Math.floor(offset / 8) + this._start) % BUF_SIZE
      this._bitsLeft = 8 - (offset % 8)

      this._bitsRead += count
    }
  }

  rewindBits(count: number): void {
    this._bitsLeft += count
    this._bitsRead -= count
    while (this._bitsLeft > 8) {
      --this._start
      this._bitsLeft -= 8
    }
    while (this._start < 0) {
      this._start += BUF_SIZE
    }
  }

  flushBits(): void {
    if (this._bitsLeft < 8) {
      this.skipBits(this._bitsLeft)
    }
  }

  reset(): void {
    this._start = 0
    this._end = -1
    this._bitsLeft = 0
  }
}
