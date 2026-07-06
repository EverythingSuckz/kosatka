/**
 * F8. Export the eight stereo pairs as individual WAV files bundled in a
 * single ZIP. Each pair becomes one stereo file with L channel hard-left and
 * R channel hard-right, no master gain, no per-pair mute, no per-pair gain
 * applied (so the user always gets the raw audible content).
 *
 * If a pair is missing one side (decode failure), the missing channel is
 * filled with silence so playback in DAWs that expect stereo still works.
 */

import JSZip from 'jszip'

import { audioBufferToWavBlob } from './export'

export interface PairExportInput {
  pairIndex: number
  /** Friendly label, e.g. "1 LEFT+RIGHT" or "-" for unknown. */
  label: string
  leftBuffer: AudioBuffer | null
  rightBuffer: AudioBuffer | null
}

/**
 * Combine two mono AudioBuffers (L and R) into a single stereo AudioBuffer.
 * Buffers may have differing lengths, output is the max, silence-padded.
 * Sample rate is taken from whichever side is present, if neither side is
 * present we throw (the caller should filter those pairs out).
 */
function buildStereoPair(
  ctx: BaseAudioContext,
  left: AudioBuffer | null,
  right: AudioBuffer | null,
): AudioBuffer {
  const ref = left ?? right
  if (!ref) throw new Error('cannot build stereo pair with no buffers')
  const sampleRate = ref.sampleRate
  const length = Math.max(left?.length ?? 0, right?.length ?? 0)
  const out = ctx.createBuffer(2, length, sampleRate)
  if (left) out.getChannelData(0).set(left.getChannelData(0))
  if (right) out.getChannelData(1).set(right.getChannelData(0))
  return out
}

/** Sanitise text for use inside a filename. */
function safeName(s: string): string {
  return s.replace(/[^a-z0-9._+-]+/gi, '_').replace(/^_+|_+$/g, '')
}

/**
 * Render all pairs as stereo WAVs and bundle into a ZIP Blob. Pairs with
 * both sides missing are skipped silently.
 */
export async function exportStemsAsZip(
  ctx: BaseAudioContext,
  baseName: string,
  pairs: ReadonlyArray<PairExportInput>,
): Promise<Blob> {
  const zip = new JSZip()
  const folder = zip.folder(safeName(baseName) || 'stems') ?? zip
  for (const pair of pairs) {
    if (!pair.leftBuffer && !pair.rightBuffer) continue
    const stereo = buildStereoPair(ctx, pair.leftBuffer, pair.rightBuffer)
    const wav = audioBufferToWavBlob(stereo)
    const num = String(pair.pairIndex).padStart(2, '0')
    const tag = safeName(pair.label.toLowerCase()) || 'pair'
    folder.file(`pair_${num}_${tag}.wav`, await wav.arrayBuffer())
  }
  return zip.generateAsync({ type: 'blob' })
}
