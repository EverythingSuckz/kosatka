/**
 * NLayer port: HybridMDCT (Layer III IMDCT + overlap-add).
 *
 * Verbatim port of the `HybridMDCT` inner class from
 * `NLayer/Decoder/LayerIIIDecoder.cs`. The window tables (`_swin[0..3]`)
 * are computed once on first use to match upstream's static constructor,
 * see `getSwin` below.
 *
 * Public entry point: `apply(fsIn, channel, blockType, doMixed)`.
 * Mutates `fsIn` in place: input is the dequantized subband samples
 * (576 floats laid out as 32 subbands × 18 samples). Output is the
 * polyphase-ready subband samples plus the carryover from the
 * previous block. Per-channel state lives in `prevBlock` / `nextBlock`.
 */

import { ICOS72 } from './l3-tables'

const SSLIMIT = 18
const SBLIMIT = 32

const PI = Math.PI

// Window tables built lazily so reading the module never blocks.
// `_swin[0..3]` are the four 36-element window tables. types 0/1/3 use
// the long-block windowing, type 2 uses the short-block windowing.
let _swin: ReadonlyArray<Float32Array> | null = null
function getSwin(): ReadonlyArray<Float32Array> {
  if (_swin !== null) return _swin
  const a: Array<Float32Array> = [
    new Float32Array(36),
    new Float32Array(36),
    new Float32Array(36),
    new Float32Array(36),
  ]
  let i = 0

  /* type 0 */
  for (i = 0; i < 36; i++) {
    a[0]![i] = Math.fround(Math.sin((PI / 36) * (i + 0.5)))
  }

  /* type 1 */
  for (i = 0; i < 18; i++) {
    a[1]![i] = Math.fround(Math.sin((PI / 36) * (i + 0.5)))
  }
  for (i = 18; i < 24; i++) {
    a[1]![i] = 1
  }
  for (i = 24; i < 30; i++) {
    a[1]![i] = Math.fround(Math.sin((PI / 12) * (i + 0.5 - 18)))
  }
  for (i = 30; i < 36; i++) {
    a[1]![i] = 0
  }

  /* type 3 */
  for (i = 0; i < 6; i++) {
    a[3]![i] = 0
  }
  for (i = 6; i < 12; i++) {
    a[3]![i] = Math.fround(Math.sin((PI / 12) * (i + 0.5 - 6)))
  }
  for (i = 12; i < 18; i++) {
    a[3]![i] = 1
  }
  for (i = 18; i < 36; i++) {
    a[3]![i] = Math.fround(Math.sin((PI / 36) * (i + 0.5)))
  }

  /* type 2 */
  for (i = 0; i < 12; i++) {
    a[2]![i] = Math.fround(Math.sin((PI / 12) * (i + 0.5)))
  }
  for (i = 12; i < 36; i++) {
    a[2]![i] = 0
  }

  _swin = a
  return _swin
}

function icos72a(i: number): number {
  return ICOS72[2 * i]!
}
function icos36a(i: number): number {
  return ICOS72[4 * i + 1]!
}

const sqrt32 = 0.8660254037844385965883020617184229195117950439453125

export class HybridMDCT {
  private readonly _prevBlock: Array<Float32Array> = []
  private readonly _nextBlock: Array<Float32Array> = []

  private readonly _imdctTemp = new Float32Array(SSLIMIT)
  private readonly _imdctResult = new Float32Array(SSLIMIT * 2)

  reset(): void {
    this._prevBlock.length = 0
    this._nextBlock.length = 0
  }

  private getPrevBlock(channel: number): {
    prevBlock: Float32Array
    nextBlock: Float32Array
  } {
    while (this._prevBlock.length <= channel) {
      this._prevBlock.push(new Float32Array(SSLIMIT * SBLIMIT))
    }
    while (this._nextBlock.length <= channel) {
      this._nextBlock.push(new Float32Array(SSLIMIT * SBLIMIT))
    }
    const prevBlock = this._prevBlock[channel]!
    const nextBlock = this._nextBlock[channel]!

    // swap them, see apply below. we carry the buffer that was just
    // emitted into `_prevBlock` so the next call can overlap-add it.
    this._nextBlock[channel] = prevBlock
    this._prevBlock[channel] = nextBlock
    return { prevBlock, nextBlock }
  }

  apply(
    fsIn: Float32Array,
    channel: number,
    blockType: number,
    doMixed: boolean,
  ): void {
    const { prevBlock, nextBlock } = this.getPrevBlock(channel)

    let start = 0
    if (doMixed) {
      // A mixed block always has the first two subbands as blocktype 0.
      this.longImpl(fsIn, 0, 2, nextBlock, 0)
      start = 2
    }

    if (blockType === 2) {
      this.shortImpl(fsIn, start, nextBlock)
    } else {
      this.longImpl(fsIn, start, SBLIMIT, nextBlock, blockType)
    }

    // overlap-add. C#: fsIn[i] += prevblck[i], store does fround.
    for (let i = 0; i < SSLIMIT * SBLIMIT; i++) {
      fsIn[i] = fsIn[i]! + prevBlock[i]!
    }
  }

  private longImpl(
    fsIn: Float32Array,
    sbStart: number,
    sbLimit: number,
    nextBlock: Float32Array,
    blockType: number,
  ): void {
    const swin = getSwin()
    const tmp = this._imdctTemp
    const res = this._imdctResult

    for (let sb = sbStart, ofs = sbStart * SSLIMIT; sb < sbLimit; sb++) {
      // IMDCT
      for (let k = 0; k < SSLIMIT; k++) tmp[k] = fsIn[ofs + k]!
      HybridMDCT.longIMDCT(tmp, res)

      // window
      const win = swin[blockType]!
      let i = 0
      for (; i < SSLIMIT; i++) {
        fsIn[ofs++] = res[i]! * win[i]!
      }
      ofs -= 18
      for (; i < SSLIMIT * 2; i++) {
        nextBlock[ofs++] = res[i]! * win[i]!
      }
    }
  }

  private static longIMDCT(invec: Float32Array, outvec: Float32Array): void {
    const f = Math.fround
    const H = new Float32Array(17)
    const h = new Float32Array(18)
    const even = new Float32Array(9)
    const odd = new Float32Array(9)
    const evenIdct = new Float32Array(9)
    const oddIdct = new Float32Array(9)

    let i = 0
    /* C#: H[i] = invec[i] + invec[i+1], single float op, store fround. */
    for (i = 0; i < 17; i++) H[i] = invec[i]! + invec[i + 1]!

    even[0] = invec[0]!
    odd[0] = H[0]!
    let idx = 0
    for (i = 1; i < 9; i++, idx += 2) {
      even[i] = H[idx + 1]!
      odd[i] = H[idx]! + H[idx + 2]!
    }

    HybridMDCT.imdct9pt(even, evenIdct)
    HybridMDCT.imdct9pt(odd, oddIdct)

    for (i = 0; i < 9; i++) {
      /* C#: odd_idct[i] *= ICOS36_A(i) is 1 float op.
             h[i] = (even_idct[i] + odd_idct[i]) * ICOS72_A(i) is 2 float ops. */
      oddIdct[i] = f(oddIdct[i]! * icos36a(i))
      h[i] = f(f(evenIdct[i]! + oddIdct[i]!) * icos72a(i))
    }
    for (; /* i = 9 */ i < 18; i++) {
      h[i] = f(f(evenIdct[17 - i]! - oddIdct[17 - i]!) * icos72a(i))
    }

    /* Rearrange the 18 values from the IDCT to the output vector */
    outvec[0] = h[9]!
    outvec[1] = h[10]!
    outvec[2] = h[11]!
    outvec[3] = h[12]!
    outvec[4] = h[13]!
    outvec[5] = h[14]!
    outvec[6] = h[15]!
    outvec[7] = h[16]!
    outvec[8] = h[17]!

    outvec[9] = -h[17]!
    outvec[10] = -h[16]!
    outvec[11] = -h[15]!
    outvec[12] = -h[14]!
    outvec[13] = -h[13]!
    outvec[14] = -h[12]!
    outvec[15] = -h[11]!
    outvec[16] = -h[10]!
    outvec[17] = -h[9]!

    outvec[35] = outvec[18] = -h[8]!
    outvec[34] = outvec[19] = -h[7]!
    outvec[33] = outvec[20] = -h[6]!
    outvec[32] = outvec[21] = -h[5]!
    outvec[31] = outvec[22] = -h[4]!
    outvec[30] = outvec[23] = -h[3]!
    outvec[29] = outvec[24] = -h[2]!
    outvec[28] = outvec[25] = -h[1]!
    outvec[27] = outvec[26] = -h[0]!
  }

  private static imdct9pt(invec: Float32Array, outvec: Float32Array): void {
    const f = Math.fround
    const evenIdct = new Float32Array(5)
    const oddIdct = new Float32Array(4)

    /* BEGIN 5 Point IMDCT.
       C#:
         t0 = invec[6] / 2.0f + invec[0]     (2 float ops)
         t1 = invec[0] - invec[6]            (1 float op)
         t2 = invec[2] - invec[4] - invec[8]  (2 float ops, left-assoc) */
    let t0 = f(f(invec[6]! / 2) + invec[0]!)
    const t1 = f(invec[0]! - invec[6]!)
    const t2 = f(f(invec[2]! - invec[4]!) - invec[8]!)

    /* even_idct[0] = t0 + invec[2]*0.93... + invec[4]*0.76... + invec[8]*0.17...
       In C# this is (((t0 + (i2*K1)) + (i4*K2)) + (i8*K3)), 6 float ops. */
    evenIdct[0] = f(
      f(f(t0 + f(invec[2]! * 0.939692621)) + f(invec[4]! * 0.766044443)) +
        f(invec[8]! * 0.173648178),
    )

    /* even_idct[1] = t2 / 2.0f + t1, 2 float ops. */
    evenIdct[1] = f(f(t2 / 2) + t1)

    /* even_idct[2] = t0 - invec[2]*0.17... - invec[4]*0.93... + invec[8]*0.76...
       In C#: (((t0 - (i2*K1)) - (i4*K2)) + (i8*K3)), 6 float ops. */
    evenIdct[2] = f(
      f(f(t0 - f(invec[2]! * 0.173648178)) - f(invec[4]! * 0.939692621)) +
        f(invec[8]! * 0.766044443),
    )

    /* even_idct[3] = t0 - invec[2]*0.76... + invec[4]*0.17... - invec[8]*0.93... */
    evenIdct[3] = f(
      f(f(t0 - f(invec[2]! * 0.766044443)) + f(invec[4]! * 0.173648178)) -
        f(invec[8]! * 0.939692621),
    )

    evenIdct[4] = f(t1 - t2)
    /* END 5 Point IMDCT */

    /* BEGIN 4 Point IMDCT */
    const odd1 = f(invec[1]! + invec[3]!)
    const odd2 = f(invec[3]! + invec[5]!)
    /* t0 = (invec[5] + invec[7]) * 0.5f + invec[1], 3 float ops. */
    t0 = f(f(f(invec[5]! + invec[7]!) * 0.5) + invec[1]!)

    /* odd_idct[0] = t0 + odd1*K + odd2*K, 4 float ops. */
    oddIdct[0] = f(f(t0 + f(odd1 * 0.939692621)) + f(odd2 * 0.766044443))
    /* odd_idct[1] = (invec[1] - invec[5]) * 1.5f - invec[7], 3 float ops. */
    oddIdct[1] = f(f(f(invec[1]! - invec[5]!) * 1.5) - invec[7]!)
    oddIdct[2] = f(f(t0 - f(odd1 * 0.173648178)) - f(odd2 * 0.939692621))
    oddIdct[3] = f(f(t0 - f(odd1 * 0.766044443)) + f(odd2 * 0.173648178))
    /* END 4 Point IMDCT */

    /* Adjust for non power of 2 IDCT.
       C#: odd_idct[0] += invec[7] * 0.17...  is two float ops,
       inner multiply then accumulate. */
    oddIdct[0] = f(oddIdct[0] + f(invec[7]! * 0.173648178))
    oddIdct[1] = f(oddIdct[1] - f(invec[7]! * 0.5))
    oddIdct[2] = f(oddIdct[2] + f(invec[7]! * 0.766044443))
    oddIdct[3] = f(oddIdct[3] - f(invec[7]! * 0.939692621))

    /* Post-Twiddle. C#: odd_idct[i] *= 0.5f / Kf. the literal `0.5f / Kf`
       is folded at compile time to a single float32 constant. we use the
       JS double-precision quotient, but the result is stored back via
       fround (Float32Array store), so this matches C# exactly. */
    oddIdct[0] = f(oddIdct[0] * f(0.5 / 0.984807753))
    oddIdct[1] = f(oddIdct[1] * f(0.5 / 0.866025404))
    oddIdct[2] = f(oddIdct[2] * f(0.5 / 0.64278761))
    oddIdct[3] = f(oddIdct[3] * f(0.5 / 0.342020143))

    for (let i = 0; i < 4; i++) {
      outvec[i] = f(evenIdct[i]! + oddIdct[i]!)
    }
    outvec[4] = evenIdct[4]!
    /* Mirror into the other half of the vector */
    for (let i = 5; i < 9; i++) {
      outvec[i] = f(evenIdct[8 - i]! - oddIdct[8 - i]!)
    }
  }

  private shortImpl(
    fsIn: Float32Array,
    sbStart: number,
    nextBlock: Float32Array,
  ): void {
    const swin = getSwin()
    const win2 = swin[2]!
    const tmp = this._imdctTemp
    const res = this._imdctResult

    for (
      let sb = sbStart, ofs = sbStart * SSLIMIT;
      sb < SBLIMIT;
      sb++, ofs += SSLIMIT
    ) {
      // Rearrange vectors.
      for (let i = 0, tmpptr = 0; i < 3; i++) {
        let v = ofs + i
        for (let j = 0; j < 6; j++) {
          tmp[tmpptr + j] = fsIn[v]!
          v += 3
        }
        tmpptr += 6
      }

      // Short blocks: 3 separate IMDCT's with overlap in two different buffers.
      for (let k = 0; k < 6; k++) fsIn[ofs + k] = 0

      // First 6 samples.
      HybridMDCT.shortIMDCT(tmp, 0, res, win2)
      for (let k = 0; k < 12; k++) fsIn[ofs + 6 + k] = res[k]!

      // Next 6.
      HybridMDCT.shortIMDCT(tmp, 6, res, win2)
      for (let i = 0; i < 6; i++) {
        fsIn[ofs + i + 12] = fsIn[ofs + i + 12]! + res[i]!
      }
      for (let k = 0; k < 6; k++) nextBlock[ofs + k] = res[6 + k]!

      // Final 6.
      HybridMDCT.shortIMDCT(tmp, 12, res, win2)
      for (let i = 0; i < 6; i++) {
        nextBlock[ofs + i] = nextBlock[ofs + i]! + res[i]!
      }
      for (let k = 0; k < 6; k++) nextBlock[ofs + 6 + k] = res[6 + k]!
      for (let k = 0; k < 6; k++) nextBlock[ofs + 12 + k] = 0
    }
  }

  private static shortIMDCT(
    invec: Float32Array,
    inIdx: number,
    outvec: Float32Array,
    win2: Float32Array,
  ): void {
    const f = Math.fround
    const H = new Float32Array(6)
    const h = new Float32Array(6)
    const evenIdct = new Float32Array(3)
    const oddIdct = new Float32Array(3)

    /* Preprocess the input to the two 3-point IDCT's.
       C#: H[i] = invec[idx] then H[i] += invec[++idx].
       Storing into H (Float32Array) does the fround automatically. */
    let idx = inIdx
    for (let i = 1; i < 6; i++) {
      H[i] = invec[idx]!
      H[i] = H[i]! + invec[++idx]!
    }

    /* 3-point IMDCT.
       C#: t0 = H[4] / 2.0f + invec[inIdx]   (2 float ops)
           t1 = H[2] * sqrt32
           even_idct[0] = t0 + t1
           even_idct[1] = invec[inIdx] - H[4]
           even_idct[2] = t0 - t1 */
    let t0 = f(f(H[4]! / 2) + invec[inIdx]!)
    let t1 = f(H[2]! * sqrt32)
    evenIdct[0] = f(t0 + t1)
    evenIdct[1] = f(invec[inIdx]! - H[4]!)
    evenIdct[2] = f(t0 - t1)

    /* 3-point IMDCT */
    const t2 = f(H[3]! + H[5]!)
    t0 = f(f(t2 / 2) + H[1]!)
    t1 = f(f(H[1]! + H[3]!) * sqrt32)
    oddIdct[0] = f(t0 + t1)
    oddIdct[1] = f(H[1]! - t2)
    oddIdct[2] = f(t0 - t1)

    /* Post-Twiddle. odd_idct[i] *= K is one float op. */
    oddIdct[0] = f(oddIdct[0] * 0.51763809)
    oddIdct[1] = f(oddIdct[1] * 0.707106781)
    oddIdct[2] = f(oddIdct[2] * 1.931851653)

    /* h[i] = (even_idct[i] +/- odd_idct[i]) * K, two float ops. */
    h[0] = f(f(evenIdct[0] + oddIdct[0]) * 0.50431448)
    h[1] = f(f(evenIdct[1] + oddIdct[1]) * 0.5411961)
    h[2] = f(f(evenIdct[2] + oddIdct[2]) * 0.630236207)

    h[3] = f(f(evenIdct[2] - oddIdct[2]) * 0.821339816)
    h[4] = f(f(evenIdct[1] - oddIdct[1]) * 1.306562965)
    h[5] = f(f(evenIdct[0] - oddIdct[0]) * 3.830648788)

    /* Rearrange the 6 values from the IDCT to the output vector.
       Each `h[i] * win2[i]` is one float op. The unary negation of a float
       in C# produces a float (no widening), so `-h[5] * win2[3]` is also
       one float op. Store to Float32Array gives the final fround. */
    outvec[0] = h[3] * win2[0]!
    outvec[1] = h[4] * win2[1]!
    outvec[2] = h[5] * win2[2]!
    outvec[3] = -h[5] * win2[3]!
    outvec[4] = -h[4] * win2[4]!
    outvec[5] = -h[3] * win2[5]!
    outvec[6] = -h[2] * win2[6]!
    outvec[7] = -h[1] * win2[7]!
    outvec[8] = -h[0] * win2[8]!
    outvec[9] = -h[0] * win2[9]!
    outvec[10] = -h[1] * win2[10]!
    outvec[11] = -h[2] * win2[11]!
  }
}
