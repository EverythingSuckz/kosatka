/**
 * Port of .NET Framework's `System.Random` (subtractive generator, Knuth's
 * algorithm). CodeWalker uses this to deobfuscate magic.dat: the `Random`
 * is seeded with `JenkHash(PC_AES_KEY)`, four byte streams are generated
 * via `NextBytes(...)`, and those streams are subtracted from magic.dat
 * before AES decryption.
 *
 * Reference (.NET Framework 4.8 reference source):
 *   https://referencesource.microsoft.com/#mscorlib/system/random.cs
 *
 * Constants and arithmetic match exactly. Uses int32 throughout (Int32Array
 * coerces JS numbers to signed 32-bit on read/write).
 */

const MBIG = 0x7fffffff // Int32.MaxValue
const MSEED = 161803398
const MZ = 0

export class DotNetRandom {
  private seedArray = new Int32Array(56)
  private inext = 0
  private inextp = 0

  /** @param seed signed 32-bit seed (matches `new Random(int seed)`). */
  constructor(seed: number) {
    seed = seed | 0 // coerce to int32
    const subtraction = seed === -2147483648 ? 2147483647 : Math.abs(seed)
    // `| 0` after every arithmetic op mimics .NET's signed int32 silent
    // wraparound. Without it, when a subtraction crosses the int32 range
    // boundary the subsequent `if (v < 0) v += MBIG` over-corrects and
    // leaves negative values stored in seedArray.
    let mj = (MSEED - subtraction) | 0
    this.seedArray[55] = mj
    let mk = 1
    for (let i = 1; i < 55; i++) {
      const ii = (21 * i) % 55
      this.seedArray[ii] = mk
      mk = (mj - mk) | 0
      if (mk < 0) mk += MBIG
      mj = this.seedArray[ii]!
    }
    for (let k = 1; k < 5; k++) {
      for (let i = 1; i < 56; i++) {
        let v = (this.seedArray[i]! - this.seedArray[1 + ((i + 30) % 55)]!) | 0
        if (v < 0) v += MBIG
        this.seedArray[i] = v
      }
    }
    this.inext = 0
    this.inextp = 21
  }

  private internalSample(): number {
    let locINext = this.inext
    let locINextp = this.inextp
    if (++locINext >= 56) locINext = 1
    if (++locINextp >= 56) locINextp = 1
    let retVal = (this.seedArray[locINext]! - this.seedArray[locINextp]!) | 0
    if (retVal === MBIG) retVal--
    if (retVal < 0) retVal += MBIG
    this.seedArray[locINext] = retVal
    this.inext = locINext
    this.inextp = locINextp
    return retVal
  }

  /** Fills `buf` with bytes from the generator (byte = sample % 256). */
  nextBytes(buf: Uint8Array): void {
    for (let i = 0; i < buf.length; i++) {
      buf[i] = this.internalSample() % 256
    }
  }

  /** Returns next non-negative int (= sample value). */
  next(): number {
    return this.internalSample()
  }

  // Suppress "unused" warning for MZ. The .NET reference defines it but
  // the actual algorithm path used here doesn't reference it. Keeping the
  // import-shaped name for fidelity with the reference source.
  static readonly _MZ = MZ
}
