/**
 * Per-stream byte extraction. Given a parsed AwcFile and the source
 * ArrayBuffer (and a key if any stream is encrypted), produce the raw codec
 * byte stream per stem, ready to feed to a codec decoder.
 *
 * Single-channel streams are a one-shot slice (with optional XXTEA decrypt
 * of the chunk).
 *
 * Multi-channel streams require walking every block. Each block is
 * XXTEA-decrypted independently if `MultiChannelEncryptFlag` is set, then
 * the channel headers are read to find each channel's `audioBytes` and the
 * combined audioBytes prefix sums for the channels before it. Per-channel
 * audio is packed back-to-back at exactly audioBytes width inside each
 * block. See docs/awc-format.md §5.3.
 *
 * `extractAllStreams` is the efficient primary API: one block-walk produces
 * every channel's bytes. `extractStreamBytes` is a convenience that returns
 * a single channel. For multi-channel files it internally extracts all
 * streams and picks one, fine for one-shot diagnostics, slow if you call it
 * in a loop.
 */

import { decryptRSXXTEA } from './decrypt'
import type { AwcFile } from './types'

/**
 * Per-block metadata captured during the mc-channel block walk. `discard` is
 * the leading-sample drop count (`f2`, offset 8 of each 24-byte channel
 * header, the field CodeWalker labels "reserved/zero". In reality it's how
 * many decoded samples to skip at the start of this block to realign the
 * channel onto the global timeline). `sampleCount` is `f3` (offset 12), the
 * number of decoded samples the block contributes pre-discard.
 *
 * For every channel of every mc-channel stream:
 *   `Σ sampleCount − Σ discard  =  streamformat.channels[ch].samples`
 *
 * exactly. After MP3-decoding the byte stream, a post-decode walk must take
 * `sampleCount` samples per block and drop the first `discard` of them. The
 * remainder is the channel's real audio. See
 * `docs/awc-mixing-investigation.md` for the full proof.
 */
export interface BlockMeta {
  /** Raw codec bytes for this block (one self-contained MP3 sub-stream). */
  bytes: Uint8Array
  discard: number
  sampleCount: number
}

export class AwcKeyMissingError extends Error {
  readonly streamHash: number
  constructor(streamHash: number) {
    super(
      `AWC key required to decrypt stream 0x${streamHash.toString(16).padStart(8, '0')}, provide one via the key derivation flow`,
    )
    this.name = 'AwcKeyMissingError'
    this.streamHash = streamHash
  }
}

export interface ExtractOptions {
  /**
   * 4 × u32 = 128-bit PC_AWC_KEY. Required for any stream whose layout
   * reports `encrypted: true`. May be omitted for unencrypted files.
   */
  key?: Uint32Array | null
}

/**
 * Extract raw codec bytes for every stream in one pass. Output is indexed
 * by `awc.streams[i]`, so `result[i]` is the byte stream for stream `i`.
 *
 * For multi-channel files this walks the data chunk once: decrypts each
 * block in place on a private copy, parses channel headers, and slices
 * each channel's audioBytes prefix.
 *
 * @throws {@link AwcKeyMissingError} if any stream is encrypted but no key.
 */
export function extractAllStreams(
  awc: AwcFile,
  buffer: ArrayBuffer,
  options: ExtractOptions = {},
): Array<Uint8Array> {
  const key = options.key ?? null
  const result: Array<Uint8Array> = new Array<Uint8Array>(awc.streams.length)

  // Group streams by layout. mc-channel streams all reference the same
  // source, so we walk the source data exactly once.
  const monoIndices: Array<number> = []
  const mcIndices: Array<number> = []
  for (let i = 0; i < awc.streams.length; i++) {
    const s = awc.streams[i]!
    if (s.layout.kind === 'mono') monoIndices.push(i)
    else mcIndices.push(i)
  }

  // Mono streams: per-stream slice.
  for (const i of monoIndices) {
    const s = awc.streams[i]!
    if (s.layout.kind !== 'mono') continue
    const { dataOffset, dataSize, encrypted } = s.layout
    const slice = new Uint8Array(
      buffer.slice(dataOffset, dataOffset + dataSize),
    )
    if (encrypted) {
      if (!key) throw new AwcKeyMissingError(s.hash)
      decryptRSXXTEA(slice, key)
    }
    result[i] = slice
  }

  // mc-channel streams: one block-walk for the whole source.
  if (mcIndices.length > 0) {
    const firstMc = awc.streams[mcIndices[0]!]!
    if (firstMc.layout.kind !== 'mc-channel') {
      throw new Error('internal: mc-channel layout expected')
    }
    const { source } = firstMc.layout
    const {
      blockCount,
      blockSize,
      channelCount,
      dataOffset,
      dataSize,
      encrypted,
    } = source

    if (encrypted && !key) throw new AwcKeyMissingError(firstMc.hash)

    const channelChunks: Array<Array<Uint8Array>> = Array.from(
      { length: channelCount },
      () => [],
    )

    for (let b = 0; b < blockCount; b++) {
      const srcoff = b * blockSize
      const blen = Math.max(Math.min(blockSize, dataSize - srcoff), 0)
      if (blen === 0) break
      const blockAbs = dataOffset + srcoff
      const block = new Uint8Array(buffer.slice(blockAbs, blockAbs + blen))
      if (encrypted) {
        if (blen % 4 !== 0) {
          throw new Error(
            `block ${b} length ${blen} is not 4-aligned (cannot XXTEA-decrypt)`,
          )
        }
        decryptRSXXTEA(block, key!)
      }

      const view = new DataView(
        block.buffer,
        block.byteOffset,
        block.byteLength,
      )

      // Channel headers are 24 bytes each. Field at offset 4 = subBlockCount,
      // field at offset 20 = audioBytes.
      let offsetsBytes = 0
      const audioBytes = new Int32Array(channelCount)
      for (let ch = 0; ch < channelCount; ch++) {
        audioBytes[ch] = view.getInt32(ch * 24 + 20, true)
        offsetsBytes += view.getInt32(ch * 24 + 4, true) * 4
      }

      // Header section: 24*N channel headers + offsets array, padded up to 0x800.
      let p = 24 * channelCount + offsetsBytes
      p = (p + 0x7ff) & ~0x7ff

      let audioCursor = p
      for (let ch = 0; ch < channelCount; ch++) {
        const want = audioBytes[ch]!
        const audioStart = audioCursor
        const audioEnd = Math.min(audioStart + want, blen)
        if (audioStart < blen && audioEnd > audioStart) {
          channelChunks[ch]!.push(block.slice(audioStart, audioEnd))
        }
        audioCursor = audioEnd
      }
    }

    // Map channelIndex → output index (= position in awc.streams).
    for (const i of mcIndices) {
      const s = awc.streams[i]!
      if (s.layout.kind !== 'mc-channel') continue
      const chunks = channelChunks[s.layout.channelIndex]!
      let total = 0
      for (const c of chunks) total += c.length
      const out = new Uint8Array(total)
      let pos = 0
      for (const c of chunks) {
        out.set(c, pos)
        pos += c.length
      }
      result[i] = out
    }
  }

  return result
}

/**
 * Like {@link extractAllStreams}, but also returns per-block `(discard,
 * sampleCount)` metadata for every channel, required to undo the per-block
 * leading-sample priming that AWC stores in the channel header at offset 8.
 *
 * For mono streams the `blocks` array is empty (the byte stream is already a
 * single self-contained MP3 stream with no per-block alignment metadata).
 *
 * For mc-channel streams `blocks[b]` describes block `b` of the channel.
 */
export function extractAllStreamsWithBlocks(
  awc: AwcFile,
  buffer: ArrayBuffer,
  options: ExtractOptions = {},
): Array<{ bytes: Uint8Array; blocks: Array<BlockMeta> }> {
  const key = options.key ?? null
  const result: Array<{ bytes: Uint8Array; blocks: Array<BlockMeta> }> =
    new Array(awc.streams.length)

  const monoIndices: Array<number> = []
  const mcIndices: Array<number> = []
  for (let i = 0; i < awc.streams.length; i++) {
    const s = awc.streams[i]!
    if (s.layout.kind === 'mono') monoIndices.push(i)
    else mcIndices.push(i)
  }

  for (const i of monoIndices) {
    const s = awc.streams[i]!
    if (s.layout.kind !== 'mono') continue
    const { dataOffset, dataSize, encrypted } = s.layout
    const slice = new Uint8Array(
      buffer.slice(dataOffset, dataOffset + dataSize),
    )
    if (encrypted) {
      if (!key) throw new AwcKeyMissingError(s.hash)
      decryptRSXXTEA(slice, key)
    }
    result[i] = { bytes: slice, blocks: [] }
  }

  if (mcIndices.length > 0) {
    const firstMc = awc.streams[mcIndices[0]!]!
    if (firstMc.layout.kind !== 'mc-channel') {
      throw new Error('internal: mc-channel layout expected')
    }
    const { source } = firstMc.layout
    const {
      blockCount,
      blockSize,
      channelCount,
      dataOffset,
      dataSize,
      encrypted,
    } = source

    if (encrypted && !key) throw new AwcKeyMissingError(firstMc.hash)

    const channelChunks: Array<Array<Uint8Array>> = Array.from(
      { length: channelCount },
      () => [],
    )
    const channelBlocks: Array<Array<BlockMeta>> = Array.from(
      { length: channelCount },
      () => [],
    )

    for (let b = 0; b < blockCount; b++) {
      const srcoff = b * blockSize
      const blen = Math.max(Math.min(blockSize, dataSize - srcoff), 0)
      if (blen === 0) break
      const blockAbs = dataOffset + srcoff
      const block = new Uint8Array(buffer.slice(blockAbs, blockAbs + blen))
      if (encrypted) {
        if (blen % 4 !== 0) {
          throw new Error(
            `block ${b} length ${blen} is not 4-aligned (cannot XXTEA-decrypt)`,
          )
        }
        decryptRSXXTEA(block, key!)
      }

      const view = new DataView(
        block.buffer,
        block.byteOffset,
        block.byteLength,
      )

      let offsetsBytes = 0
      const audioBytes = new Int32Array(channelCount)
      const discard = new Int32Array(channelCount)
      const sampleCount = new Int32Array(channelCount)
      for (let ch = 0; ch < channelCount; ch++) {
        discard[ch] = view.getInt32(ch * 24 + 8, true)
        sampleCount[ch] = view.getInt32(ch * 24 + 12, true)
        audioBytes[ch] = view.getInt32(ch * 24 + 20, true)
        offsetsBytes += view.getInt32(ch * 24 + 4, true) * 4
      }

      let p = 24 * channelCount + offsetsBytes
      p = (p + 0x7ff) & ~0x7ff

      let audioCursor = p
      for (let ch = 0; ch < channelCount; ch++) {
        const want = audioBytes[ch]!
        const audioStart = audioCursor
        const audioEnd = Math.min(audioStart + want, blen)
        const blockBytes =
          audioStart < blen && audioEnd > audioStart
            ? block.slice(audioStart, audioEnd)
            : new Uint8Array(0)
        if (blockBytes.length > 0) channelChunks[ch]!.push(blockBytes)
        channelBlocks[ch]!.push({
          bytes: blockBytes,
          discard: discard[ch]!,
          sampleCount: sampleCount[ch]!,
        })
        audioCursor = audioEnd
      }
    }

    for (const i of mcIndices) {
      const s = awc.streams[i]!
      if (s.layout.kind !== 'mc-channel') continue
      const chunks = channelChunks[s.layout.channelIndex]!
      let total = 0
      for (const c of chunks) total += c.length
      const out = new Uint8Array(total)
      let pos = 0
      for (const c of chunks) {
        out.set(c, pos)
        pos += c.length
      }
      result[i] = { bytes: out, blocks: channelBlocks[s.layout.channelIndex]! }
    }
  }

  return result
}

/**
 * Extract bytes for a single stream. Convenience wrapper around
 * {@link extractAllStreams}. For multi-channel files this triggers a full
 * block-walk under the hood. If you need more than one channel, call
 * `extractAllStreams` once and pick from the result.
 */
export function extractStreamBytes(
  awc: AwcFile,
  buffer: ArrayBuffer,
  streamIndex: number,
  options: ExtractOptions = {},
): Uint8Array {
  const stream = awc.streams[streamIndex]
  if (!stream) {
    throw new RangeError(
      `stream index ${streamIndex} out of range (have ${awc.streams.length})`,
    )
  }
  // Mono fast-path: single slice + optional decrypt, no block walk.
  if (stream.layout.kind === 'mono') {
    const { dataOffset, dataSize, encrypted } = stream.layout
    const slice = new Uint8Array(
      buffer.slice(dataOffset, dataOffset + dataSize),
    )
    if (encrypted) {
      const key = options.key ?? null
      if (!key) throw new AwcKeyMissingError(stream.hash)
      decryptRSXXTEA(slice, key)
    }
    return slice
  }
  // mc-channel: defer to extractAllStreams.
  const all = extractAllStreams(awc, buffer, options)
  return all[streamIndex]!
}
