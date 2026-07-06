/**
 * Codec dispatch. Given an AwcStream + its extracted-stream payload
 * (`{ bytes, blocks }` from src/awc/extract.ts), produce an AudioBuffer
 * ready for the mixer. Codec choice comes from the parser's `stream.codec`
 * field.
 *
 * v1 supports:
 *   - 'mp3'  (codec id 7):  NLayer port (`src/codecs/nlayer/`), stateful per
 *                            channel, per-block f2 discard applied (see
 *                            docs/decoder.md)
 *   - 'pcm'  (codec id 0):  direct Int16 → AudioBuffer
 * Deferred:
 *   - 'adpcm' (codec id 4):  needs the byte-comparison gate against
 *                            CodeWalker's WAV export before we ship.
 */

import { decodeMp3 } from './mp3'
import { decodePcm16 } from './pcm16'
import type { AwcEndianness, AwcStream } from '../awc/types'
import type { BlockMeta } from '../awc/extract'

export class UnsupportedCodecError extends Error {
  readonly codec: string
  readonly codecId: number
  constructor(codec: string, codecId: number, hint?: string) {
    super(
      `unsupported codec '${codec}' (id=${codecId})${hint ? `, ${hint}` : ''}`,
    )
    this.name = 'UnsupportedCodecError'
    this.codec = codec
    this.codecId = codecId
  }
}

export interface ExtractedStream {
  bytes: Uint8Array
  blocks: Array<BlockMeta>
}

export async function decodeStream(
  stream: AwcStream,
  extracted: ExtractedStream,
  ctx: BaseAudioContext,
  endianness: AwcEndianness,
  onProgress?: (blocksDone: number, blocksTotal: number) => void,
): Promise<AudioBuffer> {
  switch (stream.codec) {
    case 'mp3': {
      // For mono mp3 streams (no mc-channel layout) `blocks` is empty.
      // Synthesise a single virtual block so the per-block discard walk
      // still applies (with discard=0 it's a no-op).
      const blocks =
        extracted.blocks.length > 0
          ? extracted.blocks
          : [
              {
                bytes: extracted.bytes,
                discard: 0,
                sampleCount: stream.sampleCount,
              },
            ]
      return decodeMp3(blocks, stream.sampleRate, ctx, onProgress)
    }
    case 'pcm':
      return decodePcm16(
        extracted.bytes,
        stream.sampleRate,
        endianness === 'LE',
        ctx,
      )
    case 'adpcm':
    case 'unknown':
      throw new UnsupportedCodecError(stream.codec, stream.codecId)
  }
}

export { decodeMp3 } from './mp3'
export { decodePcm16, decodePcm16Samples } from './pcm16'
