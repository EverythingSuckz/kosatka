/**
 * Pure AWC parser. See docs/awc-format.md for the byte-level spec.
 * parseAwc(buffer) → AwcFile. Does not mutate the input. All multi-byte reads
 * use the file's declared endianness. The magic is the exception, read as raw
 * little-endian to discriminate LE from BE. Throws AwcParseError with a
 * byte-offset on any structural problem.
 */

import {
  AwcParseError,
  CHUNK_DATA,
  CHUNK_FORMAT,
  CHUNK_STREAMFORMAT,
  MAGIC_BE,
  MAGIC_LE,
  codecFromId,
} from './types'
import type {
  AwcChunkInfo,
  AwcEndianness,
  AwcFile,
  AwcFlagBits,
  AwcFormat,
  AwcHeader,
  AwcMultiChannelSource,
  AwcStream,
  AwcStreamFormat,
  AwcStreamFormatChannel,
  AwcStreamInfo,
  AwcStreamLayout,
} from './types'

const HEADER_SIZE = 16
const STREAM_INFO_SIZE = 4
const CHUNK_INFO_SIZE = 8

interface Reader {
  readonly v: DataView
  readonly littleEndian: boolean
  readonly len: number
  /** Read u32 in file endianness. Throws if out of bounds. */
  u32: (off: number) => number
  u16: (off: number) => number
  i16: (off: number) => number
  u8: (off: number) => number
  /** Read u64 split into low and high u32 halves (file endianness). */
  u64lh: (off: number) => { lo: number; hi: number }
}

function makeReader(view: DataView, littleEndian: boolean): Reader {
  const len = view.byteLength
  const guard = (off: number, size: number) => {
    if (off < 0 || off + size > len) {
      throw new AwcParseError(
        off,
        `read of ${size} byte(s) out of bounds (len ${len})`,
      )
    }
  }
  return {
    v: view,
    littleEndian,
    len,
    u32: (off) => {
      guard(off, 4)
      return view.getUint32(off, littleEndian)
    },
    u16: (off) => {
      guard(off, 2)
      return view.getUint16(off, littleEndian)
    },
    i16: (off) => {
      guard(off, 2)
      return view.getInt16(off, littleEndian)
    },
    u8: (off) => {
      guard(off, 1)
      return view.getUint8(off)
    },
    u64lh: (off) => {
      guard(off, 8)
      const lo = view.getUint32(littleEndian ? off : off + 4, littleEndian)
      const hi = view.getUint32(littleEndian ? off + 4 : off, littleEndian)
      return { lo, hi }
    },
  }
}

function parseHeader(view: DataView): AwcHeader {
  if (view.byteLength < HEADER_SIZE) {
    throw new AwcParseError(
      0,
      `buffer too small for AWC header (${view.byteLength} < ${HEADER_SIZE})`,
    )
  }

  // Magic is read as little-endian regardless of file endianness. The value
  // determines which endianness applies to all subsequent reads.
  const magic = view.getUint32(0, true)
  let endianness: AwcEndianness
  if (magic === MAGIC_LE) {
    endianness = 'LE'
  } else if (magic === MAGIC_BE) {
    endianness = 'BE'
  } else {
    throw new AwcParseError(
      0,
      `unrecognized magic 0x${magic.toString(16).padStart(8, '0')} (expected 0x54414441 'ADAT' or 0x41444154 'TADA'). ` +
        `Whole-file XXTEA encryption is not supported in v1.`,
    )
  }

  const littleEndian = endianness === 'LE'
  const version = view.getUint16(4, littleEndian)
  const flags = view.getUint16(6, littleEndian)
  const streamCount = view.getUint32(8, littleEndian)
  const dataOffset = view.getUint32(12, littleEndian)

  if (version !== 1) {
    throw new AwcParseError(4, `unexpected version ${version} (expected 1)`)
  }
  if (streamCount < 0 || streamCount > 0xffff) {
    throw new AwcParseError(8, `implausible streamCount ${streamCount}`)
  }
  if (dataOffset < HEADER_SIZE || dataOffset > view.byteLength) {
    throw new AwcParseError(12, `dataOffset ${dataOffset} out of range`)
  }

  const flagBits: AwcFlagBits = {
    chunkIndices: (flags & 1) !== 0,
    singleChannelEncrypt: (flags & 2) !== 0,
    multiChannel: (flags & 4) !== 0,
    multiChannelEncrypt: (flags & 8) !== 0,
  }

  return {
    magic,
    endianness,
    version,
    flags,
    streamCount,
    dataOffset,
    flagBits,
  }
}

function parseStreamInfos(
  r: Reader,
  start: number,
  count: number,
): Array<AwcStreamInfo> {
  const out: Array<AwcStreamInfo> = []
  for (let i = 0; i < count; i++) {
    const off = start + i * STREAM_INFO_SIZE
    const raw = r.u32(off)
    out.push({
      id: raw & 0x1fffffff,
      chunkCount: raw >>> 29,
    })
  }
  return out
}

function parseChunkInfo(r: Reader, off: number): AwcChunkInfo {
  const { lo, hi } = r.u64lh(off)
  // u64 layout: [type:8][size:28][offset:28]
  // hi (top 32) = [type:8][size_hi:24], lo (low 32) = [size_lo:4][offset:28]
  const type = (hi >>> 24) & 0xff
  const size = ((hi & 0x00ffffff) << 4) | (lo >>> 28)
  const offset = lo & 0x0fffffff
  return { type, size, offset }
}

function parseFormat(r: Reader, off: number): AwcFormat {
  return {
    samples: r.u32(off),
    loopPoint: r.u32(off + 4) | 0, // i32, reinterpret as signed via | 0
    sampleRate: r.u16(off + 8),
    headroom: r.i16(off + 10),
    loopBegin: r.u16(off + 12),
    loopEnd: r.u16(off + 14),
    playEnd: r.u16(off + 16),
    playBegin: r.u8(off + 18),
    codecId: r.u8(off + 19),
  }
}

function parseStreamFormat(r: Reader, off: number): AwcStreamFormat {
  const blockCount = r.u32(off)
  const blockSize = r.u32(off + 4)
  const channelCount = r.u32(off + 8)
  if (channelCount > 0x10000) {
    throw new AwcParseError(off + 8, `implausible channelCount ${channelCount}`)
  }
  const channels: Array<AwcStreamFormatChannel> = []
  for (let i = 0; i < channelCount; i++) {
    const co = off + 12 + i * 16
    channels.push({
      id: r.u32(co),
      samples: r.u32(co + 4),
      headroom: r.i16(co + 8),
      sampleRate: r.u16(co + 10),
      codecId: r.u8(co + 12),
    })
  }
  return { blockCount, blockSize, channelCount, channels }
}

function hashHex(id: number): string {
  return `0x${id.toString(16).padStart(8, '0')}`
}

function buildStreams(
  streamInfos: Array<AwcStreamInfo>,
  flagBits: AwcFlagBits,
  formatChunks: Map<number, AwcFormat>,
  monoDataChunks: Map<number, { offset: number; size: number }>,
  streamFormat: AwcStreamFormat | null,
  mcDataChunk: { offset: number; size: number } | null,
): Array<AwcStream> {
  if (flagBits.multiChannel) {
    if (!streamFormat || !mcDataChunk) {
      // The MultiChannel flag was set but we never found a streamformat+data
      // pair. Empty stems list rather than throw, the caller can decide.
      return []
    }
    const source: AwcMultiChannelSource = {
      blockCount: streamFormat.blockCount,
      blockSize: streamFormat.blockSize,
      channelCount: streamFormat.channelCount,
      dataOffset: mcDataChunk.offset,
      dataSize: mcDataChunk.size,
      encrypted: flagBits.multiChannelEncrypt,
    }
    return streamFormat.channels.map((ch, channelIndex) => {
      const layout: AwcStreamLayout = {
        kind: 'mc-channel',
        channelIndex,
        source,
      }
      return {
        hash: ch.id,
        hashHex: hashHex(ch.id),
        name: hashHex(ch.id),
        codec: codecFromId(ch.codecId),
        codecId: ch.codecId,
        sampleRate: ch.sampleRate,
        sampleCount: ch.samples,
        durationSeconds: ch.sampleRate > 0 ? ch.samples / ch.sampleRate : 0,
        layout,
      }
    })
  }

  // Single-channel layout: one stem per stream that owns a format + data pair.
  const out: Array<AwcStream> = []
  for (const si of streamInfos) {
    const fmt = formatChunks.get(si.id)
    const dat = monoDataChunks.get(si.id)
    if (!fmt || !dat) continue
    const layout: AwcStreamLayout = {
      kind: 'mono',
      dataOffset: dat.offset,
      dataSize: dat.size,
      encrypted: flagBits.singleChannelEncrypt,
    }
    out.push({
      hash: si.id,
      hashHex: hashHex(si.id),
      name: hashHex(si.id),
      codec: codecFromId(fmt.codecId),
      codecId: fmt.codecId,
      sampleRate: fmt.sampleRate,
      sampleCount: fmt.samples,
      durationSeconds: fmt.sampleRate > 0 ? fmt.samples / fmt.sampleRate : 0,
      layout,
    })
  }
  return out
}

/**
 * Parse an AWC file (raw bytes) into structural metadata. Pure function, the
 * input buffer is not retained or modified. Audio data lives at the byte
 * ranges referenced by `AwcStream.layout`. Throws {@link AwcParseError} on
 * structural failure.
 */
export function parseAwc(buffer: ArrayBuffer): AwcFile {
  const view = new DataView(buffer)
  const header = parseHeader(view)
  const r = makeReader(view, header.endianness === 'LE')

  let pos = HEADER_SIZE

  if (header.flagBits.chunkIndices) {
    // u16 × streamCount chunk-index array, skipped. chunk membership is
    // derivable from the per-stream chunkCount.
    pos += header.streamCount * 2
  }

  const streamInfos = parseStreamInfos(r, pos, header.streamCount)
  pos += header.streamCount * STREAM_INFO_SIZE

  // Chunk-info records are flat in stream order: stream 0's chunks, then
  // stream 1's, etc. We map each chunk back to its owning stream so we can
  // assign per-stream data/format chunks in single-channel files.
  const chunkInfos: Array<AwcChunkInfo> = []
  const chunkOwner = new Map<AwcChunkInfo, number>() // chunk -> stream id
  for (const si of streamInfos) {
    for (let i = 0; i < si.chunkCount; i++) {
      const ci = parseChunkInfo(r, pos)
      pos += CHUNK_INFO_SIZE
      chunkInfos.push(ci)
      chunkOwner.set(ci, si.id)
    }
  }

  // Validate chunk offsets/sizes lie within the buffer.
  for (const ci of chunkInfos) {
    if (ci.offset < 0 || ci.offset > view.byteLength) {
      throw new AwcParseError(ci.offset, `chunk offset out of range`)
    }
    if (ci.size < 0 || ci.offset + ci.size > view.byteLength) {
      throw new AwcParseError(
        ci.offset,
        `chunk size ${ci.size} extends past buffer`,
      )
    }
  }

  // Sweep for the typed chunks we care about.
  let streamFormat: AwcStreamFormat | null = null
  let mcDataChunk: { offset: number; size: number } | null = null
  const formatChunks = new Map<number, AwcFormat>()
  const monoDataChunks = new Map<number, { offset: number; size: number }>()

  for (const ci of chunkInfos) {
    const ownerId = chunkOwner.get(ci) ?? 0
    switch (ci.type) {
      case CHUNK_FORMAT:
        formatChunks.set(ownerId, parseFormat(r, ci.offset))
        break
      case CHUNK_STREAMFORMAT:
        // First streamformat wins (there should only be one in a multi-channel file).
        if (streamFormat === null) {
          streamFormat = parseStreamFormat(r, ci.offset)
        }
        break
      case CHUNK_DATA:
        if (header.flagBits.multiChannel) {
          // The single multi-channel data chunk (owned by the source stream).
          if (mcDataChunk === null) {
            mcDataChunk = { offset: ci.offset, size: ci.size }
          }
        } else {
          monoDataChunks.set(ownerId, { offset: ci.offset, size: ci.size })
        }
        break
      default:
        // Recognised types we don't decode in v1: seektable, peak, markers,
        // mid, animation, gesture, granulargrains, granularloops. We leave
        // them visible via chunkInfos but don't parse their bodies.
        break
    }
  }

  const streams = buildStreams(
    streamInfos,
    header.flagBits,
    formatChunks,
    monoDataChunks,
    streamFormat,
    mcDataChunk,
  )

  return {
    header,
    streamInfos,
    chunkInfos,
    streamFormat,
    formatChunks,
    streams,
  }
}
