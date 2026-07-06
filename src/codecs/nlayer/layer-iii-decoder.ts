/**
 * NLayer port: Layer III decoder orchestrator.
 *
 * Verbatim port of `NLayer/Decoder/LayerIIIDecoder.cs`, minus the
 * `HybridMDCT` inner class which lives in `hybrid-mdct.ts`. Ties the bit
 * reservoir, side-info parser, scalefactor decode, Huffman and dequant,
 * stereo decode, reorder/anti-alias/freq-inversion, the HybridMDCT, and the
 * polyphase synthesis filter into a single `decodeFrame(frame, ch0, ch1)`
 * call.
 *
 * Names (`gr`, `ch`, `sb`, `ss`, `sfBand`, etc.) are kept verbatim from
 * upstream to keep audit against the C# tractable.
 */

import { BitReservoir } from './bit-reservoir'
import { decodePair, decodeQuad } from './huffman'
import { HybridMDCT } from './hybrid-mdct'
import { LayerDecoderBase, SBLIMIT } from './layer-decoder-base'
import {
  GAIN_TAB,
  IS_RATIO,
  LSF_RATIO,
  POW2,
  PRETAB,
  SCA,
  SCS,
  SFB_BLOCK_CNT_TAB,
  SF_BAND_INDEX_L,
  SF_BAND_INDEX_S,
  SLEN,
} from './l3-tables'
import { MpegChannelMode, MpegVersion, StereoMode } from './types'
import type { IMpegFrame } from './types'

const SSLIMIT = 18

// Float32 coercion helper. Upstream C# does dequant arithmetic as `float`.
// matching that precision keeps the bit-reservoir, huffman, and dequant
// output numerically identical to the C# reference, modulo Math.fround
// rounding of intermediate products.
const f32 = Math.fround

/** Per-granule, per-channel side-info, mirroring upstream's loose state. */
function make2dInt(): Array<Array<number>> {
  return [
    [0, 0],
    [0, 0],
  ]
}
function make2dFloat(): Array<Array<number>> {
  return [
    [0, 0],
    [0, 0],
  ]
}
function make2dBool(): Array<Array<boolean>> {
  return [
    [false, false],
    [false, false],
  ]
}
function make3dInt(): Array<Array<Array<number>>> {
  return [
    [
      [0, 0, 0],
      [0, 0, 0],
    ],
    [
      [0, 0, 0],
      [0, 0, 0],
    ],
  ]
}
function make3dFloat(): Array<Array<Array<number>>> {
  return [
    [
      [0, 0, 0],
      [0, 0, 0],
    ],
    [
      [0, 0, 0],
      [0, 0, 0],
    ],
  ]
}

export class LayerIIIDecoder extends LayerDecoderBase {
  // side-info state
  private _channels = 0
  private _mainDataBegin = 0

  private readonly _scfsi: Array<Array<number>> = [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]
  private readonly _part23Length = make2dInt()
  private readonly _bigValues = make2dInt()
  private readonly _globalGain = make2dFloat() // GAIN_TAB[idx] stored
  private readonly _scalefacCompress = make2dInt()
  private readonly _blockSplitFlag = make2dBool()
  private readonly _mixedBlockFlag = make2dBool()
  private readonly _blockType = make2dInt()
  private readonly _tableSelect = make3dInt() // [gr][ch][region]
  private readonly _subblockGain = make3dFloat() // [gr][ch][window]
  private readonly _regionAddress1 = make2dInt()
  private readonly _regionAddress2 = make2dInt()
  private readonly _preflag = make2dInt()
  private readonly _scalefacScale = make2dFloat() // 0.5 or 1.0
  private readonly _count1TableSelect = make2dInt()

  // sample-rate precalc tables
  private _sfBandIndexL: Readonly<Int32Array> | null = null
  private _sfBandIndexS: Readonly<Int32Array> | null = null
  private readonly _cbLookupL = new Uint8Array(SSLIMIT * SBLIMIT)
  private readonly _cbLookupS = new Uint8Array(SSLIMIT * SBLIMIT)
  private readonly _cbwLookupS = new Uint8Array(SSLIMIT * SBLIMIT)
  private _cbLookupSR = 0

  // scalefactors
  // [ch][window 0..3][cb], window 3 is the long-block array (length 23)
  private readonly _scalefac: Array<Array<Array<number>>> = [
    [
      new Array<number>(13).fill(0),
      new Array<number>(13).fill(0),
      new Array<number>(13).fill(0),
      new Array<number>(23).fill(0),
    ],
    [
      new Array<number>(13).fill(0),
      new Array<number>(13).fill(0),
      new Array<number>(13).fill(0),
      new Array<number>(23).fill(0),
    ],
  ]

  // huffman + dequant
  // 576-sample buffer per channel (+3 to cover Huffman lookahead per upstream)
  private readonly _samples: Array<Float32Array> = [
    new Float32Array(SSLIMIT * SBLIMIT + 3),
    new Float32Array(SSLIMIT * SBLIMIT + 3),
  ]

  // stereo, reorder, polyphase scratch
  private readonly _reorderBuf = new Float32Array(SBLIMIT * SSLIMIT)
  private readonly _polyPhase = new Float32Array(SBLIMIT)

  // hybrid mdct + bit reservoir
  private readonly _hybrid = new HybridMDCT()
  private readonly _bitRes = new BitReservoir()

  override resetForSeek(): void {
    super.resetForSeek()
    this._hybrid.reset()
    this._bitRes.reset()
  }

  decodeFrame(frame: IMpegFrame, ch0: Float32Array, ch1: Float32Array): number {
    this.readSideInfo(frame)

    if (!this._bitRes.addBits(frame, this._mainDataBegin)) {
      return 0
    }

    this.prepTables(frame)

    const chanBufs: Array<Float32Array | null> = [null, null]
    let startChannel = 0
    let endChannel = this._channels - 1
    const sm = this.stereoMode
    if (
      this._channels === 1 ||
      sm === StereoMode.LeftOnly ||
      sm === StereoMode.DownmixToMono
    ) {
      chanBufs[0] = ch0
      endChannel = 0
    } else if (sm === StereoMode.RightOnly) {
      // if there's only a single channel output, it goes in channel 0's buffer
      chanBufs[1] = ch0
      startChannel = 1
    } else {
      chanBufs[0] = ch0
      chanBufs[1] = ch1
    }

    const granules = frame.version === MpegVersion.Version1 ? 2 : 1

    let offset = 0
    for (let gr = 0; gr < granules; gr++) {
      for (let ch = 0; ch < this._channels; ch++) {
        let sfbits: number
        if (frame.version === MpegVersion.Version1) {
          sfbits = this.readScalefactors(gr, ch)
        } else {
          sfbits = this.readLsfScalefactors(gr, ch, frame.channelModeExtension)
        }

        this.readSamples(sfbits, gr, ch)
      }

      this.stereo(
        frame.channelMode,
        frame.channelModeExtension,
        gr,
        frame.version !== MpegVersion.Version1,
      )

      for (let ch = startChannel; ch <= endChannel; ch++) {
        const buf = this._samples[ch]!
        const blockType = this._blockType[gr]![ch]!
        const blockSplit = this._blockSplitFlag[gr]![ch]!
        const mixedBlock = this._mixedBlockFlag[gr]![ch]!

        if (blockSplit && blockType === 2) {
          if (mixedBlock) {
            this.reorder(buf, true)
            this.antiAlias(buf, true)
          } else {
            this.reorder(buf, false)
          }
        } else {
          this.antiAlias(buf, false)
        }

        this._hybrid.apply(buf, ch, blockType, blockSplit && mixedBlock)

        this.frequencyInversion(buf)

        this.inversePolyphase(buf, ch, offset, chanBufs[ch]!)
      }

      offset += SBLIMIT * SSLIMIT
    }

    return offset
  }

  private readSideInfo(frame: IMpegFrame): void {
    if (frame.version === MpegVersion.Version1) {
      // main_data_begin      9
      this._mainDataBegin = frame.readBits(9)

      // private_bits         3 or 5
      if (frame.channelMode === MpegChannelMode.Mono) {
        frame.readBits(5)
        this._channels = 1
      } else {
        frame.readBits(3)
        this._channels = 2
      }

      for (let ch = 0; ch < this._channels; ch++) {
        // scfsi[ch][0..3]   1 x4
        const s = this._scfsi[ch]!
        s[0] = frame.readBits(1)
        s[1] = frame.readBits(1)
        s[2] = frame.readBits(1)
        s[3] = frame.readBits(1)
      }

      for (let gr = 0; gr < 2; gr++) {
        for (let ch = 0; ch < this._channels; ch++) {
          // part2_3_length[gr][ch]  12
          this._part23Length[gr]![ch] = frame.readBits(12)
          // big_values[gr][ch]      9
          this._bigValues[gr]![ch] = frame.readBits(9)
          // global_gain[gr][ch]     8
          this._globalGain[gr]![ch] = GAIN_TAB[frame.readBits(8)]!
          // scalefac_compress[gr][ch] 4
          this._scalefacCompress[gr]![ch] = frame.readBits(4)
          // blocksplit_flag[gr][ch] 1
          const bsf = frame.readBits(1) === 1
          this._blockSplitFlag[gr]![ch] = bsf
          if (bsf) {
            //   block_type[gr][ch]              2
            const bt = frame.readBits(2)
            this._blockType[gr]![ch] = bt
            //   switch_point[gr][ch]            1
            const mb = frame.readBits(1) === 1
            this._mixedBlockFlag[gr]![ch] = mb
            //   table_select[gr][ch][0..1]      5 x2
            this._tableSelect[gr]![ch]![0] = frame.readBits(5)
            this._tableSelect[gr]![ch]![1] = frame.readBits(5)
            this._tableSelect[gr]![ch]![2] = 0
            if (bt === 2 && !mb) {
              this._regionAddress1[gr]![ch] = 8
            } else {
              this._regionAddress1[gr]![ch] = 7
            }
            this._regionAddress2[gr]![ch] = 20 - this._regionAddress1[gr]![ch]!
            //   subblock_gain[gr][ch][0..2]     3 x3
            this._subblockGain[gr]![ch]![0] = f32(frame.readBits(3) * -2)
            this._subblockGain[gr]![ch]![1] = f32(frame.readBits(3) * -2)
            this._subblockGain[gr]![ch]![2] = f32(frame.readBits(3) * -2)
          } else {
            //   table_select[0..2][gr][ch]      5 x3
            this._tableSelect[gr]![ch]![0] = frame.readBits(5)
            this._tableSelect[gr]![ch]![1] = frame.readBits(5)
            this._tableSelect[gr]![ch]![2] = frame.readBits(5)
            //   region_address1[gr][ch]         4
            this._regionAddress1[gr]![ch] = frame.readBits(4)
            //   region_address2[gr][ch]         3
            this._regionAddress2[gr]![ch] = frame.readBits(3)
            // set the block type so it doesn't accidentally carry
            this._blockType[gr]![ch] = 0
            // unity subblock gain
            this._subblockGain[gr]![ch]![0] = 0
            this._subblockGain[gr]![ch]![1] = 0
            this._subblockGain[gr]![ch]![2] = 0
          }
          // preflag[gr][ch]               1
          this._preflag[gr]![ch] = frame.readBits(1)
          // scalefac_scale[gr][ch]        1
          this._scalefacScale[gr]![ch] = f32(0.5 * (1 + frame.readBits(1)))
          // count1table_select[gr][ch]    1
          this._count1TableSelect[gr]![ch] = frame.readBits(1)
        }
      }
    } else {
      // MPEG 2+
      // main_data_begin      8
      this._mainDataBegin = frame.readBits(8)

      // private_bits         1 or 2
      if (frame.channelMode === MpegChannelMode.Mono) {
        frame.readBits(1)
        this._channels = 1
      } else {
        frame.readBits(2)
        this._channels = 2
      }

      const gr = 0
      for (let ch = 0; ch < this._channels; ch++) {
        // part2_3_length[gr][ch]        12
        this._part23Length[gr]![ch] = frame.readBits(12)
        // big_values[gr][ch]            9
        this._bigValues[gr]![ch] = frame.readBits(9)
        // global_gain[gr][ch]           8
        this._globalGain[gr]![ch] = GAIN_TAB[frame.readBits(8)]!
        // scalefac_compress[gr][ch]     9
        this._scalefacCompress[gr]![ch] = frame.readBits(9)
        // blocksplit_flag[gr][ch]       1
        const bsf = frame.readBits(1) === 1
        this._blockSplitFlag[gr]![ch] = bsf
        if (bsf) {
          const bt = frame.readBits(2)
          this._blockType[gr]![ch] = bt
          const mb = frame.readBits(1) === 1
          this._mixedBlockFlag[gr]![ch] = mb
          this._tableSelect[gr]![ch]![0] = frame.readBits(5)
          this._tableSelect[gr]![ch]![1] = frame.readBits(5)
          this._tableSelect[gr]![ch]![2] = 0
          if (bt === 2 && !mb) {
            this._regionAddress1[gr]![ch] = 8
          } else {
            this._regionAddress1[gr]![ch] = 7
          }
          this._regionAddress2[gr]![ch] = 20 - this._regionAddress1[gr]![ch]!
          this._subblockGain[gr]![ch]![0] = f32(frame.readBits(3) * -2)
          this._subblockGain[gr]![ch]![1] = f32(frame.readBits(3) * -2)
          this._subblockGain[gr]![ch]![2] = f32(frame.readBits(3) * -2)
        } else {
          this._tableSelect[gr]![ch]![0] = frame.readBits(5)
          this._tableSelect[gr]![ch]![1] = frame.readBits(5)
          this._tableSelect[gr]![ch]![2] = frame.readBits(5)
          this._regionAddress1[gr]![ch] = frame.readBits(4)
          this._regionAddress2[gr]![ch] = frame.readBits(3)
          this._blockType[gr]![ch] = 0
          this._subblockGain[gr]![ch]![0] = 0
          this._subblockGain[gr]![ch]![1] = 0
          this._subblockGain[gr]![ch]![2] = 0
        }
        // scalefac_scale[gr][ch]        1
        this._scalefacScale[gr]![ch] = f32(0.5 * (1 + frame.readBits(1)))
        // count1table_select[gr][ch]    1
        this._count1TableSelect[gr]![ch] = frame.readBits(1)
      }
    }
  }

  private prepTables(frame: IMpegFrame): void {
    if (this._cbLookupSR === frame.sampleRate) return

    switch (frame.sampleRate) {
      case 44100:
        this._sfBandIndexL = SF_BAND_INDEX_L[0]!
        this._sfBandIndexS = SF_BAND_INDEX_S[0]!
        break
      case 48000:
        this._sfBandIndexL = SF_BAND_INDEX_L[1]!
        this._sfBandIndexS = SF_BAND_INDEX_S[1]!
        break
      case 32000:
        this._sfBandIndexL = SF_BAND_INDEX_L[2]!
        this._sfBandIndexS = SF_BAND_INDEX_S[2]!
        break
      case 22050:
        this._sfBandIndexL = SF_BAND_INDEX_L[3]!
        this._sfBandIndexS = SF_BAND_INDEX_S[3]!
        break
      case 24000:
        this._sfBandIndexL = SF_BAND_INDEX_L[4]!
        this._sfBandIndexS = SF_BAND_INDEX_S[4]!
        break
      case 16000:
        this._sfBandIndexL = SF_BAND_INDEX_L[5]!
        this._sfBandIndexS = SF_BAND_INDEX_S[5]!
        break
      case 11025:
        this._sfBandIndexL = SF_BAND_INDEX_L[6]!
        this._sfBandIndexS = SF_BAND_INDEX_S[6]!
        break
      case 12000:
        this._sfBandIndexL = SF_BAND_INDEX_L[7]!
        this._sfBandIndexS = SF_BAND_INDEX_S[7]!
        break
      case 8000:
        this._sfBandIndexL = SF_BAND_INDEX_L[8]!
        this._sfBandIndexS = SF_BAND_INDEX_S[8]!
        break
      default:
        throw new Error(`unsupported sample rate ${frame.sampleRate}`)
    }

    // precalculate the critical bands per bucket. the switch above sets
    // both indices and default throws, so they are non-null here.
    const sfL = this._sfBandIndexL
    const sfS = this._sfBandIndexS
    let cbL = 0
    let cbS = 0
    let nextCbL = sfL[1]!
    let nextCbS = sfS[1]! * 3
    for (let i = 0; i < 576; i++) {
      if (i === nextCbL) {
        ++cbL
        nextCbL = sfL[cbL + 1]!
      }
      if (i === nextCbS) {
        ++cbS
        nextCbS = sfS[cbS + 1]! * 3
      }
      this._cbLookupL[i] = cbL
      this._cbLookupS[i] = cbS
    }

    // set up the short block windows
    let idx = 0
    for (let cb = 0; cb < 12; cb++) {
      const width = sfS[cb + 1]! - sfS[cb]!
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < width; j++, idx++) {
          this._cbwLookupS[idx] = i
        }
      }
    }

    this._cbLookupSR = frame.sampleRate
  }

  private readScalefactors(gr: number, ch: number): number {
    const sfc = this._scalefacCompress[gr]![ch]!
    const slen0 = SLEN[0]![sfc]!
    const slen1 = SLEN[1]![sfc]!
    let bits: number

    let cb = 0
    if (this._blockSplitFlag[gr]![ch]! && this._blockType[gr]![ch]! === 2) {
      if (slen0 > 0) {
        bits = slen0 * 18

        if (this._mixedBlockFlag[gr]![ch]!) {
          // mixed has bands 0..7 of long, then 3..11 of short
          for (; cb < 8; cb++) {
            this._scalefac[ch]![3]![cb] = this._bitRes.getBits(slen0)
          }
          cb = 3
          bits -= slen0
        }

        // short / mixed: just read from wherever cb happens to be through 11
        for (; cb < 6; cb++) {
          this._scalefac[ch]![0]![cb] = this._bitRes.getBits(slen0)
          this._scalefac[ch]![1]![cb] = this._bitRes.getBits(slen0)
          this._scalefac[ch]![2]![cb] = this._bitRes.getBits(slen0)
        }
      } else {
        for (let i = 0; i < 8; i++) this._scalefac[ch]![3]![i] = 0
        for (let i = 0; i < 6; i++) {
          this._scalefac[ch]![0]![i] = 0
          this._scalefac[ch]![1]![i] = 0
          this._scalefac[ch]![2]![i] = 0
        }
        bits = 0
      }

      if (slen1 > 0) {
        bits += slen1 * 18

        for (cb = 6; cb < 12; cb++) {
          this._scalefac[ch]![0]![cb] = this._bitRes.getBits(slen1)
          this._scalefac[ch]![1]![cb] = this._bitRes.getBits(slen1)
          this._scalefac[ch]![2]![cb] = this._bitRes.getBits(slen1)
        }
      } else {
        for (let i = 6; i < 12; i++) {
          this._scalefac[ch]![0]![i] = 0
          this._scalefac[ch]![1]![i] = 0
          this._scalefac[ch]![2]![i] = 0
        }
      }
    } else {
      // long: read if gr == 0, otherwise honor scfsi for the channel
      bits = 0
      if (gr === 0 || this._scfsi[ch]![0]! === 0) {
        if (slen0 > 0) {
          bits += slen0 * 6
          this._scalefac[ch]![3]![0] = this._bitRes.getBits(slen0)
          this._scalefac[ch]![3]![1] = this._bitRes.getBits(slen0)
          this._scalefac[ch]![3]![2] = this._bitRes.getBits(slen0)
          this._scalefac[ch]![3]![3] = this._bitRes.getBits(slen0)
          this._scalefac[ch]![3]![4] = this._bitRes.getBits(slen0)
          this._scalefac[ch]![3]![5] = this._bitRes.getBits(slen0)
        } else {
          for (let i = 0; i < 6; i++) this._scalefac[ch]![3]![i] = 0
        }
      }
      if (gr === 0 || this._scfsi[ch]![1]! === 0) {
        if (slen0 > 0) {
          bits += slen0 * 5
          this._scalefac[ch]![3]![6] = this._bitRes.getBits(slen0)
          this._scalefac[ch]![3]![7] = this._bitRes.getBits(slen0)
          this._scalefac[ch]![3]![8] = this._bitRes.getBits(slen0)
          this._scalefac[ch]![3]![9] = this._bitRes.getBits(slen0)
          this._scalefac[ch]![3]![10] = this._bitRes.getBits(slen0)
        } else {
          for (let i = 6; i < 11; i++) this._scalefac[ch]![3]![i] = 0
        }
      }
      if (gr === 0 || this._scfsi[ch]![2]! === 0) {
        if (slen1 > 0) {
          bits += slen1 * 5
          this._scalefac[ch]![3]![11] = this._bitRes.getBits(slen1)
          this._scalefac[ch]![3]![12] = this._bitRes.getBits(slen1)
          this._scalefac[ch]![3]![13] = this._bitRes.getBits(slen1)
          this._scalefac[ch]![3]![14] = this._bitRes.getBits(slen1)
          this._scalefac[ch]![3]![15] = this._bitRes.getBits(slen1)
        } else {
          for (let i = 11; i < 16; i++) this._scalefac[ch]![3]![i] = 0
        }
      }
      if (gr === 0 || this._scfsi[ch]![3]! === 0) {
        if (slen1 > 0) {
          bits += slen1 * 5
          this._scalefac[ch]![3]![16] = this._bitRes.getBits(slen1)
          this._scalefac[ch]![3]![17] = this._bitRes.getBits(slen1)
          this._scalefac[ch]![3]![18] = this._bitRes.getBits(slen1)
          this._scalefac[ch]![3]![19] = this._bitRes.getBits(slen1)
          this._scalefac[ch]![3]![20] = this._bitRes.getBits(slen1)
        } else {
          for (let i = 16; i < 21; i++) this._scalefac[ch]![3]![i] = 0
        }
      }
    }

    return bits
  }

  private readLsfScalefactors(
    gr: number,
    ch: number,
    chanModeExt: number,
  ): number {
    const sfc = this._scalefacCompress[gr]![ch]!

    // block type number = 2 if mixed short, 1 if pure short, otherwise 0
    let blockTypeNumber: number
    if (this._blockType[gr]![ch]! === 2) {
      if (this._mixedBlockFlag[gr]![ch]!) blockTypeNumber = 2
      else blockTypeNumber = 1
    } else {
      blockTypeNumber = 0
    }

    const slen = [0, 0, 0, 0]
    let blockNumber: number
    if ((chanModeExt & 1) === 1 && ch === 1) {
      const tsfc = sfc >> 1
      if (tsfc < 180) {
        slen[0] = Math.floor(tsfc / 36)
        slen[1] = Math.floor((tsfc % 36) / 6)
        slen[2] = tsfc % 6
        slen[3] = 0
        this._preflag[gr]![ch] = 0
        blockNumber = 3
      } else if (tsfc < 244) {
        slen[0] = ((tsfc - 180) % 64) >> 4
        slen[1] = ((tsfc - 180) % 16) >> 2
        slen[2] = (tsfc - 180) % 4
        slen[3] = 0
        this._preflag[gr]![ch] = 0
        blockNumber = 4
      } else if (tsfc < 255) {
        slen[0] = Math.floor((tsfc - 244) / 3)
        slen[1] = (tsfc - 244) % 3
        slen[2] = 0
        slen[3] = 0
        this._preflag[gr]![ch] = 0
        blockNumber = 5
      } else {
        blockNumber = 0
      }
    } else {
      if (sfc < 400) {
        slen[0] = Math.floor((sfc >> 4) / 5)
        slen[1] = (sfc >> 4) % 5
        slen[2] = (sfc & 15) >> 2
        slen[3] = sfc & 3
        this._preflag[gr]![ch] = 0
        blockNumber = 0
      } else if (sfc < 500) {
        slen[0] = Math.floor(((sfc - 400) >> 2) / 5)
        slen[1] = ((sfc - 400) >> 2) % 5
        slen[2] = (sfc - 400) & 3
        slen[3] = 0
        this._preflag[gr]![ch] = 0
        blockNumber = 1
      } else if (sfc < 512) {
        slen[0] = Math.floor((sfc - 500) / 3)
        slen[1] = (sfc - 500) % 3
        slen[2] = 0
        slen[3] = 0
        this._preflag[gr]![ch] = 1
        blockNumber = 2
      } else {
        blockNumber = 0
      }
    }

    const buffer = new Int32Array(54)
    let k = 0
    const blkCnt = SFB_BLOCK_CNT_TAB[blockNumber]![blockTypeNumber]!
    for (let i = 0; i < 4; i++) {
      const sl = slen[i]!
      if (sl !== 0) {
        const bc = blkCnt[i]!
        for (let j = 0; j < bc; j++, k++) {
          buffer[k] = this._bitRes.getBits(sl)
        }
      } else {
        k += blkCnt[i]!
      }
    }

    k = 0
    let sfb = 0
    if (this._blockSplitFlag[gr]![ch]! && this._blockType[gr]![ch]! === 2) {
      if (this._mixedBlockFlag[gr]![ch]!) {
        for (; sfb < 8; sfb++) {
          this._scalefac[ch]![3]![sfb] = buffer[k++]!
        }
        sfb = 3
      }

      for (; sfb < 12; sfb++) {
        for (let window = 0; window < 3; window++) {
          this._scalefac[ch]![window]![sfb] = buffer[k++]!
        }
      }
      this._scalefac[ch]![0]![12] = 0
      this._scalefac[ch]![1]![12] = 0
      this._scalefac[ch]![2]![12] = 0
    } else {
      for (; sfb < 21; sfb++) {
        this._scalefac[ch]![3]![sfb] = buffer[k++]!
      }
      this._scalefac[ch]![3]![22] = 0
    }

    return (
      slen[0]! * blkCnt[0]! +
      slen[1]! * blkCnt[1]! +
      slen[2]! * blkCnt[2]! +
      slen[3]! * blkCnt[3]!
    )
  }

  private readSamples(sfBits: number, gr: number, ch: number): void {
    let region1Start: number
    let region2Start: number
    if (this._blockSplitFlag[gr]![ch]! && this._blockType[gr]![ch]! === 2) {
      region1Start = 36
      region2Start = 576
    } else {
      const r1 = this._regionAddress1[gr]![ch]!
      const r2 = this._regionAddress2[gr]![ch]!
      region1Start = this._sfBandIndexL![r1 + 1]!
      region2Start = this._sfBandIndexL![Math.min(r1 + r2 + 2, 22)]!
    }

    const part3end =
      this._bitRes.bitsRead - sfBits + this._part23Length[gr]![ch]!

    let idx = 0
    let h = this._tableSelect[gr]![ch]![0]!

    // bigvalues section
    const bigValueCount = this._bigValues[gr]![ch]! * 2
    const sampCh = this._samples[ch]!

    while (idx < bigValueCount && idx < region1Start) {
      const pair = decodePair(this._bitRes, h)
      sampCh[idx] = this.dequantize(idx, pair.x, gr, ch)
      ++idx
      sampCh[idx] = this.dequantize(idx, pair.y, gr, ch)
      ++idx
    }
    h = this._tableSelect[gr]![ch]![1]!
    while (idx < bigValueCount && idx < region2Start) {
      const pair = decodePair(this._bitRes, h)
      sampCh[idx] = this.dequantize(idx, pair.x, gr, ch)
      ++idx
      sampCh[idx] = this.dequantize(idx, pair.y, gr, ch)
      ++idx
    }
    h = this._tableSelect[gr]![ch]![2]!
    while (idx < bigValueCount) {
      const pair = decodePair(this._bitRes, h)
      sampCh[idx] = this.dequantize(idx, pair.x, gr, ch)
      ++idx
      sampCh[idx] = this.dequantize(idx, pair.y, gr, ch)
      ++idx
    }

    // count1 section
    h = this._count1TableSelect[gr]![ch]! + 32

    // - 3 to ensure that we never get an out of range exception
    while (part3end > this._bitRes.bitsRead && idx < SBLIMIT * SSLIMIT - 3) {
      const quad = decodeQuad(this._bitRes, h)
      sampCh[idx] = this.dequantize(idx, quad.v, gr, ch)
      ++idx
      sampCh[idx] = this.dequantize(idx, quad.w, gr, ch)
      ++idx
      sampCh[idx] = this.dequantize(idx, quad.x, gr, ch)
      ++idx
      sampCh[idx] = this.dequantize(idx, quad.y, gr, ch)
      ++idx
    }

    // adjust the bit stream if we're off somehow
    if (this._bitRes.bitsRead > part3end) {
      this._bitRes.rewindBits(this._bitRes.bitsRead - part3end)
      idx -= 4
      if (idx < 0) idx = 0
    }

    if (this._bitRes.bitsRead < part3end) {
      this._bitRes.skipBits(part3end - this._bitRes.bitsRead)
    }

    // zero out the highest samples (defined as 0 in the standard)
    if (idx < SBLIMIT * SSLIMIT) {
      const stop = SBLIMIT * SSLIMIT + 3
      for (let i = idx; i < stop; i++) sampCh[i] = 0
    }
  }

  /**
   * Per-sample dequant. C# casts `(int)x` which truncates toward zero. we
   * use `| 0` for the same semantics. the values are always positive within
   * Float32 range here, so this matches C# for any plausible scalefactor or
   * subblock-gain combination.
   */
  private dequantize(idx: number, val: number, gr: number, ch: number): number {
    if (val === 0) return 0

    const blockSplit = this._blockSplitFlag[gr]![ch]!
    const blockType = this._blockType[gr]![ch]!
    const mixed = this._mixedBlockFlag[gr]![ch]!
    const globalGain = this._globalGain[gr]![ch]!
    const sfScale = this._scalefacScale[gr]![ch]!

    if (
      blockSplit &&
      blockType === 2 &&
      !(mixed && idx < this._sfBandIndexL![8]!)
    ) {
      // short / mixed short section
      const cb = this._cbLookupS[idx]!
      const window = this._cbwLookupS[idx]!
      const sgWindow = this._subblockGain[gr]![ch]![window]!
      const sfacVal = this._scalefac[ch]![window]![cb]!
      /* C#: (int)(-2 * (sgWindow - (sfScale * sfacVal)))
             sgWindow and sfScale are float, sfacVal is int. operations are
             promoted to float left-to-right. */
      const expr = f32(-2 * f32(sgWindow - f32(sfScale * sfacVal)))
      const i = expr | 0
      return f32(f32(val * globalGain) * POW2[i]!)
    }
    // long / mixed long section
    const cb = this._cbLookupL[idx]!
    const sfacVal = this._scalefac[ch]![3]![cb]!
    const pref = this._preflag[gr]![ch]!
    /* C#: (int)(2 * sfScale * (sfacVal + pref * PRETAB[cb]))
       Inner `(sfacVal + pref*PRETAB[cb])` is pure int. Outer is two float
       ops: `2 * sfScale` (int*float → float) then `(...) * intVal` (float*int → float). */
    const inner = sfacVal + pref * PRETAB[cb]!
    const expr = f32(f32(2 * sfScale) * inner)
    const i = expr | 0
    return f32(f32(val * globalGain) * POW2[i]!)
  }

  private stereo(
    channelMode: MpegChannelMode,
    chanModeExt: number,
    gr: number,
    lsf: boolean,
  ): void {
    if (channelMode === MpegChannelMode.JointStereo && chanModeExt !== 0) {
      const midSide = (chanModeExt & 0x2) === 2

      if ((chanModeExt & 0x1) === 1) {
        // do the intensity stereo processing

        // find the highest sample index with a value in channel 1
        let lastValueIdx = -1
        const samp1 = this._samples[1]!
        for (let i = SBLIMIT * SSLIMIT - (SBLIMIT + 1); i >= 0; i--) {
          if (samp1[i]! !== 0) {
            lastValueIdx = i
            break
          }
        }

        // figure up which passes we'll need and for which ranges
        let lEnd = -1
        let sStart = -1
        if (this._blockSplitFlag[gr]![0]! && this._blockType[gr]![0]! === 2) {
          if (this._mixedBlockFlag[gr]![0]!) {
            if (lastValueIdx < this._sfBandIndexL![8]!) {
              lEnd = 8
            }
            sStart = 3
          } else {
            sStart = 0
          }
        } else {
          lEnd = 21
        }

        // long processing
        let sfb = 0
        if (lastValueIdx > -1) {
          sfb = this._cbLookupL[lastValueIdx]! + 1
        }

        if (sfb > 0 && sStart === -1) {
          if (midSide) {
            this.applyMidSide(0, this._sfBandIndexL![sfb]!)
          } else {
            this.applyFullStereo(0, this._sfBandIndexL![sfb]!)
          }
        }

        // now process the intensity bands
        for (; sfb < lEnd; sfb++) {
          const i = this._sfBandIndexL![sfb]!
          const width =
            this._sfBandIndexL![sfb + 1]! - this._sfBandIndexL![sfb]!
          const isPos = this._scalefac[1]![3]![sfb]!
          if (isPos === 7) {
            if (midSide) this.applyMidSide(i, width)
            else this.applyFullStereo(i, width)
          } else if (lsf) {
            this.applyLsfIStereo(
              i,
              width,
              isPos,
              this._scalefacCompress[gr]![0]!,
            )
          } else {
            this.applyIStereo(i, width, isPos)
          }
        }

        if (sStart <= -1) {
          // do final long processing
          const isPos = this._scalefac[1]![3]![20]!
          const i = this._sfBandIndexL![21]!
          const width = 576 - i
          if (isPos === 7) {
            if (midSide) this.applyMidSide(i, width)
            else this.applyFullStereo(i, width)
          } else if (lsf) {
            this.applyLsfIStereo(
              i,
              width,
              isPos,
              this._scalefacCompress[gr]![0]!,
            )
          } else {
            this.applyIStereo(i, width, isPos)
          }
        } else {
          // short processing
          const sSfb = [-1, -1, -1]
          let window: number
          if (lastValueIdx > -1) {
            sfb = this._cbLookupS[lastValueIdx]!
            window = this._cbwLookupS[lastValueIdx]!
            sSfb[window] = sfb
          } else {
            sfb = 12
            window = 3 // NB: 3 is correct!
          }

          // Upstream:
          //   window = (window - 1) % 3;
          //   for (; sfb >= sStart && window >= 0; window = (window - 1) % 3)
          //
          // JS `%` returns negative for negative dividend (same as C#), so
          // `(0 - 1) % 3 === -1` here too. the `window >= 0` guard exits
          // when we step past window=0.
          window = (window - 1) % 3
          for (; sfb >= sStart && window >= 0; window = (window - 1) % 3) {
            if (sSfb[window]! !== -1) {
              if (sSfb[0]! !== -1 && sSfb[1]! !== -1 && sSfb[2]! !== -1) {
                break
              }
              continue
            }

            const width =
              this._sfBandIndexS![sfb + 1]! - this._sfBandIndexS![sfb]!
            let i = this._sfBandIndexS![sfb]! * 3 + width * (window + 1)

            let w2 = width
            while (--w2 >= -1) {
              if (samp1[--i]! !== 0) {
                sSfb[window] = sfb
                break
              }
            }

            if (window === 0) {
              --sfb
            }
          }

          // now apply the intensity processing for each window & scalefactor band
          sfb = sStart
          for (; sfb < 12; sfb++) {
            const width =
              this._sfBandIndexS![sfb + 1]! - this._sfBandIndexS![sfb]!
            let i = this._sfBandIndexS![sfb]! * 3

            for (let w = 0; w < 3; w++) {
              if (sfb > sSfb[w]!) {
                const isPos = this._scalefac[1]![w]![sfb]!
                if (isPos === 7) {
                  if (midSide) this.applyMidSide(i, width)
                  else this.applyFullStereo(i, width)
                } else if (lsf) {
                  this.applyLsfIStereo(
                    i,
                    width,
                    isPos,
                    this._scalefacCompress[gr]![0]!,
                  )
                } else {
                  this.applyIStereo(i, width, isPos)
                }
              } else if (midSide) {
                this.applyMidSide(i, width)
              } else {
                this.applyFullStereo(i, width)
              }

              i += width
            }
          }

          // do final short processing
          const finalWidth = this._sfBandIndexS![13]! - this._sfBandIndexS![12]!
          for (let w = 0; w < 3; w++) {
            const isPos = this._scalefac[1]![w]![11]!
            const baseI = this._sfBandIndexS![11]! * 3 + finalWidth * w
            if (isPos === 7) {
              if (midSide) this.applyMidSide(baseI, finalWidth)
              else this.applyFullStereo(baseI, finalWidth)
            } else if (lsf) {
              this.applyLsfIStereo(
                baseI,
                finalWidth,
                isPos,
                this._scalefacCompress[gr]![0]!,
              )
            } else {
              this.applyIStereo(baseI, finalWidth, isPos)
            }
          }
        }
      } else if (midSide) {
        this.applyMidSide(0, SBLIMIT * SSLIMIT)
      } else {
        this.applyFullStereo(0, SBLIMIT * SSLIMIT)
      }
    } else if (this._channels !== 1) {
      this.applyFullStereo(0, SBLIMIT * SSLIMIT)
    }
  }

  private applyIStereo(i: number, sb: number, isPos: number): void {
    const samp0 = this._samples[0]!
    const samp1 = this._samples[1]!
    if (this.stereoMode === StereoMode.DownmixToMono) {
      for (; sb > 0; sb--, i++) {
        samp0[i] = samp0[i]! / 2
      }
    } else {
      const ratio0 = IS_RATIO[0]![isPos]!
      const ratio1 = IS_RATIO[1]![isPos]!
      for (; sb > 0; sb--, i++) {
        samp1[i] = samp0[i]! * ratio1
        samp0[i] = samp0[i]! * ratio0
      }
    }
  }

  private applyLsfIStereo(
    i: number,
    sb: number,
    isPos: number,
    scalefacCompress: number,
  ): void {
    const k0 = LSF_RATIO[scalefacCompress % 2]![0]![isPos]!
    const k1 = LSF_RATIO[scalefacCompress % 2]![1]![isPos]!
    const samp0 = this._samples[0]!
    const samp1 = this._samples[1]!
    if (this.stereoMode === StereoMode.DownmixToMono) {
      /* C#: var ratio = 1 / (k0 + k1), two float ops. */
      const ratio = f32(1 / f32(k0 + k1))
      for (; sb > 0; sb--, i++) {
        samp0[i] = samp0[i]! * ratio
      }
    } else {
      for (; sb > 0; sb--, i++) {
        samp1[i] = samp0[i]! * k1
        samp0[i] = samp0[i]! * k0
      }
    }
  }

  private applyMidSide(i: number, sb: number): void {
    const samp0 = this._samples[0]!
    const samp1 = this._samples[1]!
    /* C#: const float C = 0.707106781f, single-prec constant. */
    const C = f32(0.707106781)
    if (this.stereoMode === StereoMode.DownmixToMono) {
      for (; sb > 0; sb--, i++) {
        samp0[i] = samp0[i]! * C
      }
    } else {
      for (; sb > 0; sb--, i++) {
        const a = samp0[i]!
        const b = samp1[i]!
        /* C#: (a + b) * C, two float ops. */
        samp0[i] = f32(a + b) * C
        samp1[i] = f32(a - b) * C
      }
    }
  }

  private applyFullStereo(i: number, sb: number): void {
    if (this.stereoMode === StereoMode.DownmixToMono) {
      const samp0 = this._samples[0]!
      const samp1 = this._samples[1]!
      for (; sb > 0; sb--, i++) {
        samp0[i] = f32(samp0[i]! + samp1[i]!) / 2
      }
    }
    // else: full stereo is a no-op when both channels are emitted unchanged
  }

  private reorder(buf: Float32Array, mixedBlock: boolean): void {
    const reorderBuf = this._reorderBuf
    let sfb = 0
    const sfS = this._sfBandIndexS!

    if (mixedBlock) {
      // mixed: copy the first two bands and reorder the rest
      for (let i = 0; i < SSLIMIT * 2; i++) reorderBuf[i] = buf[i]!
      sfb = 3
    }

    while (sfb < 13) {
      const sfb_start = sfS[sfb]!
      const sfb_lines = sfS[sfb + 1]! - sfb_start

      for (let window = 0; window < 3; window++) {
        for (let freq = 0; freq < sfb_lines; freq++) {
          const src_line = sfb_start * 3 + window * sfb_lines + freq
          const des_line = sfb_start * 3 + window + freq * 3
          reorderBuf[des_line] = buf[src_line]!
        }
      }

      ++sfb
    }

    for (let i = 0; i < SSLIMIT * SBLIMIT; i++) buf[i] = reorderBuf[i]!
  }

  private antiAlias(buf: Float32Array, mixedBlock: boolean): void {
    const sblim = mixedBlock ? 1 : SBLIMIT - 1

    for (let sb = 0, offset = 0; sb < sblim; sb++, offset += SSLIMIT) {
      for (
        let ss = 0, buOfs = offset + SSLIMIT - 1, bdOfs = offset + SSLIMIT;
        ss < 8;
        ss++, buOfs--, bdOfs++
      ) {
        const bu = buf[buOfs]!
        const bd = buf[bdOfs]!
        /* C#: (bu*scs) - (bd*sca), three float ops.
              a = bu * scs, then b = bd * sca, then c = a - b. */
        buf[buOfs] = f32(f32(bu * SCS[ss]!) - f32(bd * SCA[ss]!))
        buf[bdOfs] = f32(f32(bd * SCS[ss]!) + f32(bu * SCA[ss]!))
      }
    }
  }

  private frequencyInversion(buf: Float32Array): void {
    for (let ss = 1; ss < SSLIMIT; ss += 2) {
      for (let sb = 1; sb < SBLIMIT; sb += 2) {
        buf[sb * SSLIMIT + ss] = -buf[sb * SSLIMIT + ss]!
      }
    }
  }

  private inversePolyphase(
    buf: Float32Array,
    ch: number,
    ofsIn: number,
    outBuf: Float32Array,
  ): void {
    let ofs = ofsIn
    const polyPhase = this._polyPhase
    for (let ss = 0; ss < SSLIMIT; ss++, ofs += SBLIMIT) {
      for (let sb = 0; sb < SBLIMIT; sb++) {
        polyPhase[sb] = buf[sb * SSLIMIT + ss]!
      }
      this.inversePolyPhase(ch, polyPhase)
      for (let i = 0; i < SBLIMIT; i++) outBuf[ofs + i] = polyPhase[i]!
    }
  }
}
