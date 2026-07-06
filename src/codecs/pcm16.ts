/**
 * PCM16 codec. AWC codec ID 0 = signed 16-bit PCM in the file's endianness,
 * one mono channel per stream. Decoding is a direct byte → Int16 pass.
 */

/**
 * Decode raw PCM16 bytes to Int16 samples. Pure function, no AudioContext
 * needed, useful in tests.
 */
export function decodePcm16Samples(
  bytes: Uint8Array,
  littleEndian: boolean,
): Int16Array {
  const sampleCount = Math.floor(bytes.length / 2)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out = new Int16Array(sampleCount)
  for (let i = 0; i < sampleCount; i++) {
    out[i] = view.getInt16(i * 2, littleEndian)
  }
  return out
}

/** Build a mono AudioBuffer at the given sample rate from raw PCM16 bytes. */
export function decodePcm16(
  bytes: Uint8Array,
  sampleRate: number,
  littleEndian: boolean,
  ctx: BaseAudioContext,
): AudioBuffer {
  const samples = decodePcm16Samples(bytes, littleEndian)
  const buf = ctx.createBuffer(1, samples.length, sampleRate)
  const ch = buf.getChannelData(0)
  for (let i = 0; i < samples.length; i++) {
    ch[i] = samples[i]! / 32768
  }
  return buf
}
