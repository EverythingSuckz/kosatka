/**
 * NLayer port: polyphase synthesis filter (LayerDecoderBase).
 *
 * Verbatim port of the synthesis half of
 * `NLayer/Decoder/LayerDecoderBase.cs`. The tables (DEWINDOW,
 * SYNTH_COS64) are pulled in from `l3-tables.ts` so they can be
 * regenerated from the C# source via `scripts/build-l3-tables.ts`.
 *
 * `inversePolyPhase(channel, data)` is the public entry point: take 32
 * subband samples in `data`, run them through DCT32 → buildUVec →
 * dewindow, and replace `data[0..31]` with the 32 PCM samples for this
 * subband group. Per-channel state lives in `_synBuf` / `_bufOffset`.
 */

import { StereoMode as StereoModeValue } from './types'
import { DEWINDOW, SYNTH_COS64 } from './l3-tables'
import type { IMpegFrame, StereoMode } from './types'

const SBLIMIT = 32
// 1 / sqrt(2). Original C# literal was 7.071067811865474617150084668537e-01f
// which has more digits than a JS double can hold. we trim to the
// representable value (matches a Math.SQRT1_2-equivalent in 32-bit float).
const INV_SQRT_2 = Math.fround(0.7071067811865475)

const f32 = Math.fround

export abstract class LayerDecoderBase {
  private readonly _synBuf: Array<Float32Array> = []
  private readonly _bufOffset: Array<number> = []
  private _eq: Float32Array | null = null

  stereoMode: StereoMode = StereoModeValue.Both

  abstract decodeFrame(
    frame: IMpegFrame,
    ch0: Float32Array,
    ch1: Float32Array,
  ): number

  setEQ(eq: Float32Array | null): void {
    if (eq === null || eq.length === 32) {
      this._eq = eq
    }
  }

  resetForSeek(): void {
    this._synBuf.length = 0
    this._bufOffset.length = 0
  }

  // Scratch buffers reused across calls (matches C# instance fields).
  private readonly ippuv = new Float32Array(512)
  private readonly ei32 = new Float32Array(16)
  private readonly eo32 = new Float32Array(16)
  private readonly oi32 = new Float32Array(16)
  private readonly oo32 = new Float32Array(16)
  private readonly ei16 = new Float32Array(8)
  private readonly eo16 = new Float32Array(8)
  private readonly oi16 = new Float32Array(8)
  private readonly oo16 = new Float32Array(8)
  private readonly ei8 = new Float32Array(4)
  private readonly oi8 = new Float32Array(4)
  private readonly oo8 = new Float32Array(4)
  private readonly tmp8 = new Float32Array(6)

  protected inversePolyPhase(channel: number, data: Float32Array): void {
    const { synBuf, k } = this.getBufAndOffset(channel)

    if (this._eq !== null) {
      for (let i = 0; i < 32; i++) {
        data[i] = data[i]! * this._eq[i]!
      }
    }

    this.dct32(data, synBuf, k)
    this.buildUVec(this.ippuv, synBuf, k)
    this.dewindowOutput(this.ippuv, data)
  }

  private getBufAndOffset(channel: number): {
    synBuf: Float32Array
    k: number
  } {
    while (this._synBuf.length <= channel) {
      this._synBuf.push(new Float32Array(1024))
    }
    while (this._bufOffset.length <= channel) {
      this._bufOffset.push(0)
    }

    const synBuf = this._synBuf[channel]!
    let k = this._bufOffset[channel]!
    k = (k - 32) & 511
    this._bufOffset[channel] = k
    return { synBuf, k }
  }

  private dct32(input: Float32Array, output: Float32Array, k: number): void {
    const ei = this.ei32
    const oi = this.oi32
    const eo = this.eo32
    const oo = this.oo32

    for (let i = 0; i < 16; i++) {
      /* ei[i] = a + b, one float op, store fround.
         oi[i] = (a - b) * cos, 2 float ops. */
      ei[i] = input[i]! + input[31 - i]!
      oi[i] = f32(f32(input[i]! - input[31 - i]!) * SYNTH_COS64[2 * i]!)
    }

    this.dct16(ei, eo)
    this.dct16(oi, oo)

    for (let i = 0; i < 15; i++) {
      output[2 * i + k] = eo[i]!
      output[2 * i + 1 + k] = oo[i]! + oo[i + 1]!
    }
    output[30 + k] = eo[15]!
    output[31 + k] = oo[15]!
  }

  private dct16(input: Float32Array, output: Float32Array): void {
    const ei = this.ei16
    const oi = this.oi16
    const eo = this.eo16
    const oo = this.oo16

    let a: number
    let b: number
    /* ei[i] = a + b, one float op, store fround.
       oi[i] = (a - b) * cos, 2 float ops. */
    a = input[0]!
    b = input[15]!
    ei[0] = a + b
    oi[0] = f32(f32(a - b) * SYNTH_COS64[1]!)
    a = input[1]!
    b = input[14]!
    ei[1] = a + b
    oi[1] = f32(f32(a - b) * SYNTH_COS64[5]!)
    a = input[2]!
    b = input[13]!
    ei[2] = a + b
    oi[2] = f32(f32(a - b) * SYNTH_COS64[9]!)
    a = input[3]!
    b = input[12]!
    ei[3] = a + b
    oi[3] = f32(f32(a - b) * SYNTH_COS64[13]!)
    a = input[4]!
    b = input[11]!
    ei[4] = a + b
    oi[4] = f32(f32(a - b) * SYNTH_COS64[17]!)
    a = input[5]!
    b = input[10]!
    ei[5] = a + b
    oi[5] = f32(f32(a - b) * SYNTH_COS64[21]!)
    a = input[6]!
    b = input[9]!
    ei[6] = a + b
    oi[6] = f32(f32(a - b) * SYNTH_COS64[25]!)
    a = input[7]!
    b = input[8]!
    ei[7] = a + b
    oi[7] = f32(f32(a - b) * SYNTH_COS64[29]!)

    this.dct8(ei, eo)
    this.dct8(oi, oo)

    output[0] = eo[0]!
    output[1] = oo[0]! + oo[1]!
    output[2] = eo[1]!
    output[3] = oo[1]! + oo[2]!
    output[4] = eo[2]!
    output[5] = oo[2]! + oo[3]!
    output[6] = eo[3]!
    output[7] = oo[3]! + oo[4]!
    output[8] = eo[4]!
    output[9] = oo[4]! + oo[5]!
    output[10] = eo[5]!
    output[11] = oo[5]! + oo[6]!
    output[12] = eo[6]!
    output[13] = oo[6]! + oo[7]!
    output[14] = eo[7]!
    output[15] = oo[7]!
  }

  private dct8(input: Float32Array, output: Float32Array): void {
    const ei = this.ei8
    const oi = this.oi8
    const oo = this.oo8
    const tmp = this.tmp8

    /* Even indices */
    ei[0] = input[0]! + input[7]!
    ei[1] = input[3]! + input[4]!
    ei[2] = input[1]! + input[6]!
    ei[3] = input[2]! + input[5]!

    tmp[0] = ei[0] + ei[1]
    tmp[1] = ei[2] + ei[3]
    tmp[2] = f32(f32(ei[0] - ei[1]) * SYNTH_COS64[7]!)
    tmp[3] = f32(f32(ei[2] - ei[3]) * SYNTH_COS64[23]!)
    tmp[4] = f32(f32(tmp[2] - tmp[3]) * INV_SQRT_2)

    output[0] = tmp[0] + tmp[1]
    /* tmp[2] + tmp[3] + tmp[4], left-assoc, 2 float ops. */
    output[2] = f32(tmp[2] + tmp[3]) + tmp[4]
    output[4] = f32(f32(tmp[0] - tmp[1]) * INV_SQRT_2)
    output[6] = tmp[4]!

    /* Odd indices */
    oi[0] = f32(f32(input[0]! - input[7]!) * SYNTH_COS64[3]!)
    oi[1] = f32(f32(input[1]! - input[6]!) * SYNTH_COS64[11]!)
    oi[2] = f32(f32(input[2]! - input[5]!) * SYNTH_COS64[19]!)
    oi[3] = f32(f32(input[3]! - input[4]!) * SYNTH_COS64[27]!)

    tmp[0] = oi[0] + oi[3]
    tmp[1] = oi[1] + oi[2]
    tmp[2] = f32(f32(oi[0] - oi[3]) * SYNTH_COS64[7]!)
    tmp[3] = f32(f32(oi[1] - oi[2]) * SYNTH_COS64[23]!)
    tmp[4] = tmp[2] + tmp[3]
    tmp[5] = f32(f32(tmp[2] - tmp[3]) * INV_SQRT_2)

    oo[0] = tmp[0] + tmp[1]
    oo[1] = tmp[4] + tmp[5]
    oo[2] = f32(f32(tmp[0] - tmp[1]) * INV_SQRT_2)
    oo[3] = tmp[5]!

    output[1] = oo[0] + oo[1]
    output[3] = oo[1] + oo[2]
    output[5] = oo[2] + oo[3]
    output[7] = oo[3]!
  }

  private buildUVec(
    uVec: Float32Array,
    curSynBuf: Float32Array,
    kIn: number,
  ): void {
    let k = kIn
    let uvp = 0

    for (let j = 0; j < 8; j++) {
      for (let i = 0; i < 16; i++) {
        /* Copy first 32 elements */
        uVec[uvp + i] = curSynBuf[k + i + 16]!
        uVec[uvp + i + 17] = -curSynBuf[k + 31 - i]!
      }

      /* k wraps at the synthesis buffer boundary */
      k = (k + 32) & 511

      for (let i = 0; i < 16; i++) {
        /* Copy next 32 elements */
        uVec[uvp + i + 32] = -curSynBuf[k + 16 - i]!
        uVec[uvp + i + 48] = -curSynBuf[k + i]!
      }
      uVec[uvp + 16] = 0

      /* k wraps at the synthesis buffer boundary */
      k = (k + 32) & 511
      uvp += 64
    }
  }

  private dewindowOutput(uVec: Float32Array, samples: Float32Array): void {
    /* C#: u_vec[i] *= DEWINDOW_TABLE[i], one float op, store fround. */
    for (let i = 0; i < 512; i++) {
      uVec[i] = uVec[i]! * DEWINDOW[i]!
    }

    /* C#: float sum = u_vec[i], then sum += u_vec[...] repeatedly.
       sum is a true float32 local, each `+=` rounds back to float32.
       In TS, `let sum: number` is a JS double, so successive accumulation
       is double-precision unless we fround each step. */
    for (let i = 0; i < 32; i++) {
      let sum = uVec[i]!
      sum = f32(sum + uVec[i + (1 << 5)]!)
      sum = f32(sum + uVec[i + (2 << 5)]!)
      sum = f32(sum + uVec[i + (3 << 5)]!)
      sum = f32(sum + uVec[i + (4 << 5)]!)
      sum = f32(sum + uVec[i + (5 << 5)]!)
      sum = f32(sum + uVec[i + (6 << 5)]!)
      sum = f32(sum + uVec[i + (7 << 5)]!)
      sum = f32(sum + uVec[i + (8 << 5)]!)
      sum = f32(sum + uVec[i + (9 << 5)]!)
      sum = f32(sum + uVec[i + (10 << 5)]!)
      sum = f32(sum + uVec[i + (11 << 5)]!)
      sum = f32(sum + uVec[i + (12 << 5)]!)
      sum = f32(sum + uVec[i + (13 << 5)]!)
      sum = f32(sum + uVec[i + (14 << 5)]!)
      sum = f32(sum + uVec[i + (15 << 5)]!)
      uVec[i] = sum
    }

    for (let i = 0; i < 32; i++) {
      samples[i] = uVec[i]!
    }
  }
}

export { SBLIMIT, INV_SQRT_2 }
