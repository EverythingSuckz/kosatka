/**
 * NLayer port: MPEG frame header + bit reader.
 *
 * Verbatim port of `NLayer/Decoder/MpegFrame.cs` (the parts we need for
 * Layer III decode). Drops the Layer I / II / VBR-tag bits, those
 * codepaths are unreachable for the Rockstar MPEG-1 LIII streams the
 * AWC pipeline produces.
 *
 * Key porting fixups vs upstream C#:
 *
 *  - JS bitwise `&` and `|` produce signed int32. Comparing a 32-bit
 *    sync word against 0xFFE00000 (>0x7FFFFFFF) directly returns false
 *    on JS because the left side comes out negative. We coerce with
 *    `>>> 0` on every sync-bit compare to keep both sides unsigned.
 *
 *  - MPEG version arithmetic uses `Math.floor(this.version / 10) - 1`
 *    for the bitrate table index (since V1=10, V2=20, V2.5=25). The
 *    bitrate table only has rows for V1 and V2, and V2.5 reuses V2's
 *    row, so `version === V25 ? 1 : (version/10 - 1)` would have been
 *    wrong for the V2.5 case. Clamp via `Math.min(...)` instead.
 *
 *  - Rockstar streams DO have CRC (bit 15 of byte 1 is 0). The bit
 *    reader's `_readOffset` therefore starts at 6, not 4. The reset
 *    path handles this, do not assume "Rockstar = no CRC".
 *
 *  - The `Channels` getter on upstream is `internal int`. We expose it
 *    as a public method to keep the surface explicit.
 */

import { FrameBase } from './frame-base'
import { MpegChannelMode, MpegLayer, MpegVersion } from './types'
import type { ByteSource } from './stream-reader'
import type { IMpegFrame } from './types'

// Layer I, II, III bitrate tables, indexed [versionIdx][layerIdx][bitrateIdx].
// versionIdx: 0 = V1, 1 = V2 (V2.5 reuses V2). layerIdx: 0..2 maps to I/II/III.
const BIT_RATE_TABLE: ReadonlyArray<ReadonlyArray<ReadonlyArray<number>>> = [
  [
    [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
    [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
    [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  ],
  [
    [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
    [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  ],
]

/**
 * CRC update, polynomial 0x8005, MSB-first. Verbatim from upstream
 * `MpegFrame.UpdateCRC`. The state is passed in and returned (we don't
 * have C# `ref` parameters).
 */
export function updateCrc(data: number, length: number, crc: number): number {
  let mask = 1 << length
  let c = crc & 0xffff
  while (((mask >>>= 1) | 0) !== 0) {
    const carry = c & 0x8000
    c = (c << 1) & 0xffff
    if ((carry === 0) !== ((data & mask) === 0)) {
      c ^= 0x8005
    }
  }
  return c & 0xffff
}

export class MpegFrame extends FrameBase implements IMpegFrame {
  /**
   * Inspect a candidate 4-byte sync word and either return a new
   * `MpegFrame` (positioned, but not yet validated) or `null` if the
   * bits aren't a plausible header. Matches upstream `TrySync` exactly.
   *
   * `syncMark` is the 32-bit big-endian word at the candidate offset.
   * callers pass it as a JS number, which may be signed (top bit set).
   * The `>>> 0` coercions below normalise the comparisons.
   */
  static trySync(syncMark: number): MpegFrame | null {
    const u = syncMark >>> 0
    if (
      (u & 0xffe00000) >>> 0 !== 0xffe00000 || // frame sync
      (u & 0x00180000) === 0x00080000 || // MPEG version != reserved
      (u & 0x00060000) === 0x00000000 || // layer version != reserved
      (u & 0x0000f000) === 0x0000f000 || // bitrate != bad
      (u & 0x00000c00) === 0x00000c00 // sample rate != reserved
    ) {
      return null
    }

    switch ((u >>> 4) & 0xf) {
      case 0x0: // stereo
      case 0x4: // joint stereo
      case 0x5:
      case 0x6:
      case 0x7:
      case 0x8: // dual channel
      case 0xc: // mono
        return MpegFrame.fromSyncBits(u | 0)
      default:
        return null
    }
  }

  /** Frame number assigned by the stream reader. */
  number = 0
  /** Linked-list pointer used by `MpegStreamReader`. */
  next: MpegFrame | null = null
  /** Cumulative sample offset (set by the stream reader). */
  sampleOffset = 0

  private syncBits: number
  private _readOffset = 0
  private _bitsRead = 0
  private _bitBucket = 0 // up to 64 bits worth, held as JS number is OK since we never have > 32 bits queued at once
  private _isMuted = false

  private constructor(syncBits: number) {
    super()
    this.syncBits = syncBits
  }

  private static fromSyncBits(syncBits: number): MpegFrame {
    return new MpegFrame(syncBits)
  }

  /** Bind a frame to an offset / source without going through `trySync`. */
  static atOffset(
    syncBits: number,
    offset: number,
    source: ByteSource,
  ): MpegFrame {
    const f = new MpegFrame(syncBits | 0)
    f.offset = offset
    // FrameBase.source is protected. use the validate-style assignment
    // path via a tiny accessor, not validating, just attaching.
    ;(f as unknown as { source: ByteSource }).source = source
    return f
  }

  protected validateImpl(): number {
    // TrySync has already validated version, layer, bitrate, and samplerate.
    // We only support Layer III streams (Rockstar AWC). other layers fall
    // through the same way upstream does.

    let frameSize: number
    if (this.bitRateIndex > 0) {
      if (this.layer === MpegLayer.LayerI) {
        frameSize = ((12 * this.bitRate) / this.sampleRate + this.padding) * 4
        frameSize = Math.floor(frameSize)
      } else {
        frameSize =
          Math.floor((144 * this.bitRate) / this.sampleRate) + this.padding
      }
    } else {
      // "free" frame, calculated later by the stream reader. We return a
      // lower-bound size here so caller can step past us.
      frameSize = this._readOffset + this.getSideDataSize() + this.padding
    }

    if (this.hasCrc) {
      this._readOffset = 4 + 2
      this._bitBucket = 0
      this._bitsRead = 0

      if (!this.validateCRC()) {
        this._isMuted = true
        return 6 // header + crc, force the reader to re-sync
      }
    }

    this.reset()

    return frameSize
  }

  /**
   * Layer-III-only side data size. Mirrors upstream
   * `GetSideDataSize()`'s LayerIII branch. we never reach the Layer I
   * or II branches because TrySync would have to admit those layers
   * for this code to run, and the AWC pipeline rejects non-LIII streams
   * upstream.
   */
  getSideDataSize(): number {
    switch (this.layer) {
      case MpegLayer.LayerI:
        if (this.channelMode === MpegChannelMode.Mono) return 16
        if (
          this.channelMode === MpegChannelMode.Stereo ||
          this.channelMode === MpegChannelMode.DualChannel
        ) {
          return 32
        }
        switch (this.channelModeExtension) {
          case 0:
            return 18
          case 1:
            return 20
          case 2:
            return 22
          case 3:
            return 24
          default:
            return 0
        }
      case MpegLayer.LayerII:
        return 0
      case MpegLayer.LayerIII:
        if (
          this.channelMode === MpegChannelMode.Mono &&
          this.version >= MpegVersion.Version2
        ) {
          return 9
        } else if (
          this.channelMode !== MpegChannelMode.Mono &&
          this.version < MpegVersion.Version2
        ) {
          return 32
        }
        return 17
      default:
        return 0
    }
  }

  private validateCRC(): boolean {
    let crc = 0xffff

    crc = updateCrc(this.syncBits, 16, crc)

    // For LayerIII (the only layer we exercise from the AWC pipeline),
    // GetCRC walks the side data bytes through UpdateCRC. We do that
    // inline rather than dispatch through a Layer III decoder.
    if (this.layer === MpegLayer.LayerIII) {
      let cnt = this.getSideDataSize()
      while (--cnt >= 0) {
        crc = updateCrc(this.readBits(8), 8, crc)
      }
      const checkCrc =
        ((this.readByte(4) & 0xff) << 8) | (this.readByte(5) & 0xff)
      return checkCrc === crc
    }
    // Layer I / II not supported. treat the CRC as passing so the
    // frame is accepted (the stream reader will reject these via the
    // layer enum if we ever care).
    return true
  }

  // header getters

  get frameLength(): number {
    return this.length
  }

  get version(): MpegVersion {
    switch ((this.syncBits >> 19) & 3) {
      case 0:
        return MpegVersion.Version25
      case 2:
        return MpegVersion.Version2
      case 3:
        return MpegVersion.Version1
      default:
        return MpegVersion.Unknown
    }
  }

  get layer(): MpegLayer {
    // The order is backwards, and "0" is invalid. upstream uses
    // `(4 - ((sync >> 17) & 3)) % 4`. Values: 0=>Unknown, 1=>III, 2=>II, 3=>I.
    return ((4 - ((this.syncBits >> 17) & 3)) % 4) as MpegLayer
  }

  get hasCrc(): boolean {
    return (this.syncBits & 0x10000) === 0
  }

  get bitRate(): number {
    if (this.bitRateIndex > 0) {
      // versionIdx: V1 → 0, V2 / V2.5 → 1
      const vIdx = Math.min(Math.floor(this.version / 10) - 1, 1)
      const lIdx = this.layer - 1
      return BIT_RATE_TABLE[vIdx]![lIdx]![this.bitRateIndex]! * 1000
    }
    // bitrate is always an even multiple of 1000, so round
    const raw = (this.frameLength * 8 * this.sampleRate) / this.sampleCount
    return (Math.floor((raw + 499 + 500) / 1000) * 1000) | 0
  }

  get bitRateIndex(): number {
    return (this.syncBits >> 12) & 0xf
  }

  get sampleRate(): number {
    let sr: number
    switch (this.sampleRateIndex) {
      case 0:
        sr = 44100
        break
      case 1:
        sr = 48000
        break
      case 2:
        sr = 32000
        break
      default:
        sr = 0
        break
    }
    if (this.version > MpegVersion.Version1) {
      if (this.version === MpegVersion.Version25) {
        sr = Math.floor(sr / 4)
      } else {
        sr = Math.floor(sr / 2)
      }
    }
    return sr
  }

  get sampleRateIndex(): number {
    return (this.syncBits >> 10) & 0x3
  }

  private get padding(): number {
    return (this.syncBits >> 9) & 0x1
  }

  get channelMode(): MpegChannelMode {
    return ((this.syncBits >> 6) & 0x3) as MpegChannelMode
  }

  get channelModeExtension(): number {
    return (this.syncBits >> 4) & 0x3
  }

  channels(): number {
    return this.channelMode === MpegChannelMode.Mono ? 1 : 2
  }

  get isCopyrighted(): boolean {
    return (this.syncBits & 0x8) === 0x8
  }

  get isOriginal(): boolean {
    return (this.syncBits & 0x4) === 0x4
  }

  get emphasisMode(): number {
    return this.syncBits & 0x3
  }

  get isCorrupted(): boolean {
    return this._isMuted
  }

  get sampleCount(): number {
    if (this.layer === MpegLayer.LayerI) return 384
    if (
      this.layer === MpegLayer.LayerIII &&
      this.version > MpegVersion.Version1
    )
      return 576
    return 1152
  }

  // bit reader

  reset(): void {
    this._readOffset = 4 + (this.hasCrc ? 2 : 0)
    this._bitBucket = 0
    this._bitsRead = 0
  }

  readBits(bitCount: number): number {
    if (bitCount < 1 || bitCount > 32) {
      throw new RangeError('bitCount out of range')
    }
    if (this._isMuted) return 0

    while (this._bitsRead < bitCount) {
      const b = this.readByte(this._readOffset)
      if (b === -1) {
        // Match upstream: throw end-of-stream so callers can choose
        // whether to swallow it (mostly during CRC validation).
        throw new Error('EndOfStream')
      }
      ++this._readOffset

      // _bitBucket may legitimately use more than 32 bits when we
      // accumulate multiple bytes before extracting. we model it with
      // a JS number (53-bit safe integer range). 32 bits worth fits
      // comfortably below 2^53.
      this._bitBucket = this._bitBucket * 256 + (b & 0xff)
      this._bitsRead += 8
    }

    // Extract `bitCount` bits from the top of `_bitBucket`. JS bitwise
    // ops are signed int32, so for the 32-bit case we use plain
    // arithmetic to stay unsigned across the whole range.
    const shift = this._bitsRead - bitCount
    const divisor = Math.pow(2, shift)
    const mask = Math.pow(2, bitCount) // value range = [0, mask)
    let temp = Math.floor(this._bitBucket / divisor)
    temp = temp - Math.floor(temp / mask) * mask
    // Subtract those bits from the bucket so the next read starts
    // cleanly. Equivalent to `_bitBucket &= (1 << shift) - 1` when shift
    // would fit in 32 bits.
    this._bitBucket -= Math.floor(this._bitBucket / divisor) * divisor
    this._bitsRead -= bitCount
    return temp
  }
}
