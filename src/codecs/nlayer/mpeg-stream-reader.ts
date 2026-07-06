/**
 * NLayer port. Streamlined MPEG frame stream reader.
 *
 * Port of `NLayer/Decoder/MpegStreamReader.cs` cut down to what the AWC
 * pipeline needs. We drop, per the porting plan:
 *
 *   - The ReadBuffer ring + thread locks (no async I/O, bytes are
 *     already in memory).
 *   - ID3 v1 / v2 tag parsing (`ID3Frame.TrySync`).
 *   - RIFF header probing (`RiffHeaderFrame.TrySync`).
 *   - Xing / Info / VBRI VBR-tag parsing.
 *   - Free-bitrate "last frame" length resolution (we never see free
 *     frames in Rockstar streams, and re-adding the heuristic would
 *     mean a forward-only scan we can't run with our seekable source).
 *
 * What's kept:
 *   - Frame-by-frame sync walk over a `Uint8Array` source.
 *   - The linked list (`_first` → `next` → ... → `_last`) of validated
 *     `MpegFrame`s plus `_current` cursor.
 *   - `sampleOffset` chaining (each frame records its cumulative
 *     sample count for seek logic).
 *   - `seekTo(sampleNumber)`, used by `MpegFile`-equivalent code.
 *
 * Behaviour-wise: constructing a reader on a buffer that contains no
 * MPEG frames throws, mirrors upstream "Not a valid MPEG file!".
 */

import { MpegFrame } from './mpeg-frame'
import { ByteSource } from './stream-reader'
import { MpegLayer, MpegVersion } from './types'

export class MpegStreamReader {
  private readonly source: ByteSource
  private readOffset = 0
  private endFound = false
  private mixedFrameSize = false

  private first: MpegFrame | null = null
  private current: MpegFrame | null = null
  private last: MpegFrame | null = null

  constructor(source: ByteSource | Uint8Array) {
    this.source = source instanceof ByteSource ? source : new ByteSource(source)

    // Find the first MPEG frame (and the next one, per upstream, the
    // "the very next frame should be an mpeg frame" gate).
    const f1 = this.findNextFrame()
    if (f1 === null) throw new Error('Not a valid MPEG file!')

    const f2 = this.findNextFrame()
    if (f2 === null) throw new Error('Not a valid MPEG file!')

    this.current = this.first
  }

  /**
   * Scan from the current `readOffset` for the next valid MPEG frame.
   * Returns the frame or null if EOF was reached without a match.
   * Appends the frame to the linked list and advances `readOffset`.
   */
  private findNextFrame(): MpegFrame | null {
    if (this.endFound) return null

    const syncBuf = new Uint8Array(4)
    if (this.source.read(this.readOffset, syncBuf, 0, 4) !== 4) {
      this.endFound = true
      return null
    }

    for (;;) {
      const sync =
        ((syncBuf[0]! << 24) >>> 0) |
        (syncBuf[1]! << 16) |
        (syncBuf[2]! << 8) |
        syncBuf[3]!

      const candidate = MpegFrame.trySync(sync >>> 0)
      // Strict layer/version filter for the AWC pipeline: Rockstar streams
      // are MPEG-1 Layer III only. `trySync` admits any layer/version that
      // *could* be valid MPEG audio, necessary at the upstream-library
      // level, but inside an AWC block, runs of bytes occasionally happen
      // to look like a valid Layer I / II / V2 / V2.5 sync pattern. If we
      // admit one, `LayerIIIDecoder.decodeFrame` then trips on its
      // unsupported side-info layout (manifests as a `BitReservoir count
      // out of range` underrun later in the granule). Reject anything that
      // isn't V1 LIII at the reader level so we keep scanning for the
      // next legit frame.
      const layerOk =
        candidate !== null &&
        candidate.layer === MpegLayer.LayerIII &&
        candidate.version === MpegVersion.Version1
      if (layerOk && candidate.validate(this.readOffset, this.source)) {
        // The LAST frame of many AWC blocks on ch7+ is byte-truncated by
        // a small amount (8-16 bytes on the test fixture, well within
        // the stuffing region of the main_data, never overlapping the
        // huffman bits indicated by `part_2_3_length`). Dropping the
        // frame entirely costs ~24 ms of audio per affected block and
        // produces an audible click at every block boundary because the
        // decoder's IMDCT state still expects the frame's contribution.
        //
        // Instead, accept the frame and let `MpegFrame.readBits` /
        // `BitReservoir.addBits` walk off the end of the byte source. We
        // detect that case during `addBits` (see `bit-reservoir.ts`,
        // the slot-fill loop returns -1 on EOF and we treat the missing
        // bytes as zero stuffing). The huffman section only reads
        // `part_2_3_length` bits which sit comfortably within the real
        // (non-padded) part of the frame. The zero-padded tail is
        // unreachable by any conforming bitstream.
        this.readOffset += candidate.frameLength

        if (this.first === null) {
          candidate.number = 0
          this.first = candidate
          this.last = candidate
        } else {
          if (candidate.sampleCount !== this.first.sampleCount) {
            this.mixedFrameSize = true
          }
          const last = this.last!
          candidate.sampleOffset = last.sampleCount + last.sampleOffset
          candidate.number = last.number + 1
          last.next = candidate
          this.last = candidate
        }

        return candidate
      }

      // Slide the 4-byte window forward by 1 and read the next byte.
      ++this.readOffset
      syncBuf[0] = syncBuf[1]!
      syncBuf[1] = syncBuf[2]!
      syncBuf[2] = syncBuf[3]!
      const nextByte = this.source.read(this.readOffset + 3, syncBuf, 3, 1)
      if (nextByte !== 1) {
        this.endFound = true
        return null
      }
    }
  }

  /** Force-walk to the end of the stream, populating the frame list. */
  readToEnd(): void {
    while (!this.endFound) {
      this.findNextFrame()
    }
  }

  /** Total decoded sample count across all frames in the stream. */
  get sampleCount(): number {
    this.readToEnd()
    if (this.last === null) return -1
    return this.last.sampleCount + this.last.sampleOffset
  }

  get sampleRate(): number {
    if (this.first === null) return 0
    return this.first.sampleRate
  }

  get channels(): number {
    if (this.first === null) return 0
    return this.first.channels()
  }

  get firstFrameSampleCount(): number {
    return this.first !== null ? this.first.sampleCount : 0
  }

  /**
   * Position the read cursor on the frame containing the requested
   * sample number. Returns the sample offset of that frame, or −1 if
   * past the end. Mirrors upstream `SeekTo`.
   */
  seekTo(sampleNumber: number): number {
    if (this.first === null) return -1

    // first try to "seek" by calculating the frame number
    let cnt = Math.floor(sampleNumber / this.first.sampleCount)
    let frame: MpegFrame | null = this.first
    if (
      this.current !== null &&
      this.current.number <= cnt &&
      this.current.sampleOffset <= sampleNumber
    ) {
      frame = this.current
      cnt -= frame.number
    }
    // ESLint can't see through `findNextFrame()`'s side-effects on
    // `this.last` / `this.endFound` / `this.mixedFrameSize`. The reads
    // through a getter alias defeat the unnecessary-condition warning
    // without changing semantics.
    const isMixed = (): boolean => this.mixedFrameSize
    const isEnd = (): boolean => this.endFound
    const lastFrame = (): MpegFrame | null => this.last

    while (!isMixed() && --cnt >= 0 && frame !== null) {
      if (frame === lastFrame() && !isEnd()) {
        do {
          this.findNextFrame()
        } while (frame === lastFrame() && !isEnd())
      }
      if (isMixed()) break
      frame = frame.next
    }

    while (
      frame !== null &&
      frame.sampleOffset + frame.sampleCount < sampleNumber
    ) {
      if (frame === lastFrame() && !isEnd()) {
        do {
          this.findNextFrame()
        } while (frame === lastFrame() && !isEnd())
      }
      frame = frame.next
    }
    if (frame === null) return -1
    this.current = frame
    return frame.sampleOffset
  }

  /** Advance to the next frame and return the *previous* current frame. */
  nextFrame(): MpegFrame | null {
    const frame = this.current
    if (frame !== null) {
      // Indirect through getters so ESLint doesn't flag the inner
      // condition as "unnecessary", findNextFrame mutates them.
      const lastFrame = (): MpegFrame | null => this.last
      const isEnd = (): boolean => this.endFound
      if (frame === lastFrame() && !isEnd()) {
        do {
          this.findNextFrame()
        } while (frame === lastFrame() && !isEnd())
      }
      this.current = frame.next
    }
    return frame
  }

  getCurrentFrame(): MpegFrame | null {
    return this.current
  }
}
