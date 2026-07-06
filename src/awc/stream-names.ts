/**
 * Reverse-resolve AWC stream hashes to friendly labels.
 *
 * Rockstar names stems by an internal convention. For the GTA V Cayo Perico
 * heist tracks the layout is `<basename>_<N>_<LEFT|RIGHT>` where `<basename>`
 * matches the file's name (e.g. `hei4_fin_track_a03`) and N is 1..K for K
 * stereo pairs (so a 16-channel AWC has N=1..8). Each name is Jenkins-29
 * hashed into the stream ID stored in the container.
 *
 * Given the file's basename and the parsed AWC, this builds a map from
 * stream-hash to the human-readable label so the mixer UI can show
 * "1 LEFT" / "1 RIGHT" instead of `0x0491ef38`.
 *
 * Fallback: streams whose hash doesn't match the expected pattern are left
 * out of the returned map. The caller should fall back to the hex hash for
 * those. This way unknown or non-standard AWC layouts don't break, they just
 * don't get friendly labels.
 */

import { jenkHash29 } from '../keys/jenk-hash'
import type { AwcFile } from './types'

export interface StemLabel {
  /** e.g. "1 LEFT", "3 RIGHT". Short form for tight UI. */
  short: string
  /** Pair index, 1-based. */
  pair: number
  side: 'L' | 'R'
}

/**
 * Strip the file extension from a filename. Case-insensitive on `.awc`.
 */
function basenameFromFilename(filename: string): string {
  return filename.replace(/\.awc$/i, '')
}

/**
 * Build a hash → label map by enumerating `<basename>_<N>_<left|right>` for
 * N=1..pairCount and matching against the AWC's stream hashes.
 */
export function resolveStreamLabels(
  awc: AwcFile,
  filename: string,
): Map<number, StemLabel> {
  const labels = new Map<number, StemLabel>()
  const basename = basenameFromFilename(filename)
  // AWC stream count is always even for paired layouts. For odd counts we
  // still try, but only the even-half pairings will resolve.
  const pairCount = Math.ceil(awc.streams.length / 2)
  const hashToStream = new Map<number, true>()
  for (const s of awc.streams) hashToStream.set(s.hash, true)

  for (let n = 1; n <= pairCount; n++) {
    const leftHash = jenkHash29(`${basename}_${n}_left`)
    const rightHash = jenkHash29(`${basename}_${n}_right`)
    if (hashToStream.has(leftHash)) {
      labels.set(leftHash, { short: `${n} LEFT`, pair: n, side: 'L' })
    }
    if (hashToStream.has(rightHash)) {
      labels.set(rightHash, { short: `${n} RIGHT`, pair: n, side: 'R' })
    }
  }
  return labels
}
