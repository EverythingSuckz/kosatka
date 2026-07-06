/**
 * Shared enums and frame interface (NLayer port).
 *
 * Verbatim port of `NLayer/Enums.cs` plus a TS-flavoured equivalent of
 * `NLayer/IMpegFrame.cs`. The numeric values matter: BitReservoir uses
 * `version > MpegVersion.Version1` and `version === MpegVersion.Version1`
 * comparisons, so the underlying ordinal ordering must match upstream
 * (Unknown < Version1 < Version2 < Version25 → 0 < 10 < 20 < 25).
 */

export const MpegVersion = {
  Unknown: 0,
  Version1: 10,
  Version2: 20,
  Version25: 25,
} as const
export type MpegVersion = (typeof MpegVersion)[keyof typeof MpegVersion]

export const MpegLayer = {
  Unknown: 0,
  LayerI: 1,
  LayerII: 2,
  LayerIII: 3,
} as const
export type MpegLayer = (typeof MpegLayer)[keyof typeof MpegLayer]

export const MpegChannelMode = {
  Stereo: 0,
  JointStereo: 1,
  DualChannel: 2,
  Mono: 3,
} as const
export type MpegChannelMode =
  (typeof MpegChannelMode)[keyof typeof MpegChannelMode]

export const StereoMode = {
  Both: 0,
  LeftOnly: 1,
  RightOnly: 2,
  DownmixToMono: 3,
} as const
export type StereoMode = (typeof StereoMode)[keyof typeof StereoMode]

/**
 * TypeScript flavour of `NLayer.IMpegFrame`. The bit-reservoir and
 * Layer III decoder consume frames through this surface so synthetic
 * test frames can be wired up without instantiating MpegFrame.
 *
 * `readBits` returns -1 when the end of the frame has been reached. This
 * matches the C# convention and is cleaner than a separate "available" call.
 */
export interface IMpegFrame {
  readonly sampleRate: number
  readonly sampleRateIndex: number
  readonly frameLength: number
  readonly bitRate: number
  readonly version: MpegVersion
  readonly layer: MpegLayer
  readonly channelMode: MpegChannelMode
  readonly channelModeExtension: number
  readonly sampleCount: number
  readonly bitRateIndex: number
  readonly isCopyrighted: boolean
  readonly hasCrc: boolean
  readonly isCorrupted: boolean
  reset: () => void
  readBits: (bitCount: number) => number
}
