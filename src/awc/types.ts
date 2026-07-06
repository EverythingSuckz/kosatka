/**
 * Public types for the AWC parser. See docs/awc-format.md for byte-level
 * details. Parser output is metadata-only. Actual audio bytes live in the
 * source ArrayBuffer and are referenced via byte offsets and sizes. Codec
 * decoders consume these references.
 */

/** Magic-byte constants. See awc-format.md §1. */
export const MAGIC_LE = 0x54414441 // "ADAT", Legacy/Gen8 little-endian file
export const MAGIC_BE = 0x41444154 // "TADA", Enhanced/Gen9 big-endian file

export type AwcEndianness = 'LE' | 'BE'

/** Codec IDs observed in the wild (CodeWalker only knows 0 and 4). */
export const CODEC_PCM = 0
export const CODEC_ADPCM = 4
/** First seen in Cayo Perico (mpHeist4). MPEG-1 Layer III. */
export const CODEC_MP3 = 7

export type AwcCodec = 'pcm' | 'adpcm' | 'mp3' | 'unknown'

export function codecFromId(id: number): AwcCodec {
  switch (id) {
    case CODEC_PCM:
      return 'pcm'
    case CODEC_ADPCM:
      return 'adpcm'
    case CODEC_MP3:
      return 'mp3'
    default:
      return 'unknown'
  }
}

/** Known chunk-type bytes (last byte of the chunk-name's Jenkins hash). */
export const CHUNK_DATA = 0x55
export const CHUNK_FORMAT = 0xfa
export const CHUNK_STREAMFORMAT = 0x48
export const CHUNK_SEEKTABLE = 0xa3
export const CHUNK_PEAK = 0x36
export const CHUNK_MARKERS = 0xbd
export const CHUNK_MID = 0x68
export const CHUNK_ANIMATION = 0x5c
export const CHUNK_GESTURE = 0x2b
export const CHUNK_GRANULARGRAINS = 0x5a
export const CHUNK_GRANULARLOOPS = 0xd9

export interface AwcHeader {
  magic: number
  endianness: AwcEndianness
  version: number
  flags: number
  streamCount: number
  dataOffset: number
  flagBits: AwcFlagBits
}

export interface AwcFlagBits {
  /** bit 0: header is followed by a u16[StreamCount] chunk-index array. */
  chunkIndices: boolean
  /** bit 1: per-data-chunk XXTEA on every mono stream's data. */
  singleChannelEncrypt: boolean
  /** bit 2: file uses multi-channel grouping (one source + N channel refs). */
  multiChannel: boolean
  /** bit 3: per-block XXTEA on the multi-channel data chunk. */
  multiChannelEncrypt: boolean
}

export interface AwcStreamInfo {
  /** 29-bit Jenkins hash. 0 indicates the multi-channel source stream. */
  id: number
  chunkCount: number
}

export interface AwcChunkInfo {
  type: number
  size: number
  offset: number
}

export interface AwcFormat {
  samples: number
  loopPoint: number
  sampleRate: number
  headroom: number
  loopBegin: number
  loopEnd: number
  playEnd: number
  playBegin: number
  codecId: number
}

export interface AwcStreamFormat {
  blockCount: number
  blockSize: number
  channelCount: number
  channels: Array<AwcStreamFormatChannel>
}

export interface AwcStreamFormatChannel {
  id: number
  samples: number
  headroom: number
  sampleRate: number
  codecId: number
}

/**
 * One independently-decodable audio stream, the unit the mixer presents as
 * a channel strip. Built by the parser from either a mono `format` chunk or
 * a `streamformat` channel record.
 */
export interface AwcStream {
  /** 29-bit Jenkins hash (or 0 for the synthetic source, never exposed). */
  hash: number
  hashHex: string
  name: string
  codec: AwcCodec
  codecId: number
  sampleRate: number
  sampleCount: number
  durationSeconds: number
  layout: AwcStreamLayout
}

export type AwcStreamLayout =
  | {
      kind: 'mono'
      /** Byte offset of the per-stream data chunk in the source buffer. */
      dataOffset: number
      dataSize: number
      encrypted: boolean
    }
  | {
      kind: 'mc-channel'
      /** Index in source's streamformat.channels[] (and in source's per-block layout). */
      channelIndex: number
      source: AwcMultiChannelSource
    }

export interface AwcMultiChannelSource {
  blockCount: number
  blockSize: number
  channelCount: number
  dataOffset: number
  dataSize: number
  encrypted: boolean
}

export interface AwcFile {
  header: AwcHeader
  streamInfos: Array<AwcStreamInfo>
  chunkInfos: Array<AwcChunkInfo>
  /** Multi-channel source's streamformat, when MultiChannel is set. */
  streamFormat: AwcStreamFormat | null
  /** Mono streams: format-chunk metadata keyed by stream id. */
  formatChunks: ReadonlyMap<number, AwcFormat>
  /** Aggregated playable stems, what the mixer iterates. */
  streams: Array<AwcStream>
}

/**
 * Thrown by parseAwc on any structural failure. `offset` is the byte offset
 * within the input buffer where the error was detected, useful for hex-dump
 * post-mortem.
 */
export class AwcParseError extends Error {
  readonly offset: number
  constructor(offset: number, message: string) {
    super(
      `AwcParseError @ 0x${offset.toString(16).padStart(8, '0')}: ${message}`,
    )
    this.name = 'AwcParseError'
    this.offset = offset
  }
}
