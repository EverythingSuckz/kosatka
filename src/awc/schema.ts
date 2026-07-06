/**
 * Zod schemas mirroring the public types in ./types. Runtime shape validators
 * for tests, dev builds, and any boundary that ingests a serialised AwcFile
 * (e.g. IndexedDB hydration). Production parser output is not validated by
 * default, it's already typed at compile time.
 */

import { z } from 'zod'
import { CODEC_ADPCM, CODEC_MP3, CODEC_PCM, MAGIC_BE, MAGIC_LE } from './types'

const codec = z.enum(['pcm', 'adpcm', 'mp3', 'unknown'])
const endianness = z.enum(['LE', 'BE'])

const flagBitsSchema = z.object({
  chunkIndices: z.boolean(),
  singleChannelEncrypt: z.boolean(),
  multiChannel: z.boolean(),
  multiChannelEncrypt: z.boolean(),
})

export const headerSchema = z.object({
  magic: z.union([z.literal(MAGIC_LE), z.literal(MAGIC_BE)]),
  endianness,
  version: z.literal(1),
  flags: z.number().int().min(0).max(0xffff),
  streamCount: z.number().int().min(0),
  dataOffset: z.number().int().min(16),
  flagBits: flagBitsSchema,
})

export const streamInfoSchema = z.object({
  id: z.number().int().min(0).max(0x1fffffff),
  chunkCount: z.number().int().min(0).max(7),
})

export const chunkInfoSchema = z.object({
  type: z.number().int().min(0).max(0xff),
  size: z.number().int().min(0).max(0x0fffffff),
  offset: z.number().int().min(0).max(0x0fffffff),
})

export const formatSchema = z.object({
  samples: z.number().int().min(0),
  loopPoint: z.number().int(),
  sampleRate: z.number().int().min(0).max(0xffff),
  headroom: z.number().int().min(-32768).max(32767),
  loopBegin: z.number().int().min(0).max(0xffff),
  loopEnd: z.number().int().min(0).max(0xffff),
  playEnd: z.number().int().min(0).max(0xffff),
  playBegin: z.number().int().min(0).max(0xff),
  codecId: z.number().int().min(0).max(0xff),
})

export const streamFormatChannelSchema = z.object({
  id: z.number().int().min(0),
  samples: z.number().int().min(0),
  headroom: z.number().int().min(-32768).max(32767),
  sampleRate: z.number().int().min(0).max(0xffff),
  codecId: z.number().int().min(0).max(0xff),
})

export const streamFormatSchema = z.object({
  blockCount: z.number().int().min(0),
  blockSize: z.number().int().min(0),
  channelCount: z.number().int().min(0),
  channels: z.array(streamFormatChannelSchema),
})

const mcSourceSchema = z.object({
  blockCount: z.number().int().min(0),
  blockSize: z.number().int().min(0),
  channelCount: z.number().int().min(0),
  dataOffset: z.number().int().min(0),
  dataSize: z.number().int().min(0),
  encrypted: z.boolean(),
})

const layoutSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('mono'),
    dataOffset: z.number().int().min(0),
    dataSize: z.number().int().min(0),
    encrypted: z.boolean(),
  }),
  z.object({
    kind: z.literal('mc-channel'),
    channelIndex: z.number().int().min(0),
    source: mcSourceSchema,
  }),
])

export const streamSchema = z.object({
  hash: z.number().int().min(0).max(0x1fffffff),
  hashHex: z.string().regex(/^0x[0-9a-f]{8}$/),
  name: z.string().min(1),
  codec,
  codecId: z.number().int().min(0).max(0xff),
  sampleRate: z.number().int().min(0).max(0xffff),
  sampleCount: z.number().int().min(0),
  durationSeconds: z.number().min(0),
  layout: layoutSchema,
})

export const awcFileSchema = z.object({
  header: headerSchema,
  streamInfos: z.array(streamInfoSchema),
  chunkInfos: z.array(chunkInfoSchema),
  streamFormat: streamFormatSchema.nullable(),
  formatChunks: z.instanceof(Map<number, unknown>),
  streams: z.array(streamSchema),
})

/** Re-exports for test convenience. */
export const KNOWN_CODEC_IDS = [CODEC_PCM, CODEC_ADPCM, CODEC_MP3] as const
