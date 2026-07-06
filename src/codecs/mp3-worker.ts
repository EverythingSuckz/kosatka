/**
 * MP3 decode worker (Vite module-worker entry).
 *
 * Runs the same NLayer pipeline as `decodeMp3` but off the main thread so
 * the UI can keep painting / handling input while ~80 blocks per channel
 * are crunched. Receives `{ blocks, sampleRate }` and posts back `{
 * samples: Float32Array, length, sampleRate }`. We don't construct an
 * `AudioBuffer` here because that constructor lives on `BaseAudioContext`,
 * which doesn't exist inside Workers, so the route reconstitutes the buffer
 * on the main thread from the transferred Float32 PCM.
 *
 * Wire protocol:
 *   in:  { kind: 'decode', blocks: BlockMeta[], sampleRate: number }
 *   out: { kind: 'progress', blocksDone: number, blocksTotal: number }  (per block)
 *        { kind: 'ok',  samples: Float32Array, length: number, sampleRate: number }
 *        { kind: 'err', message: string }
 *
 * Progress granularity matters: 16 stems decode in PARALLEL workers, so
 * whole-stem completion events all land near the end, so a stem-count
 * progress bar sits at 0/16 for most of the wall time. Per-block messages
 * (~80 per stem) start ticking within ~100 ms of kickoff.
 *
 * Transferables: response only. We transfer the Float32Array buffer back
 * (zero-copy). The request side is structured-cloned because `blocks`
 * comes from React state (`streamBytes`) and we don't want to detach it
 * for other consumers, see comment in `mp3.ts`.
 */

import { LayerIIIDecoder } from './nlayer/layer-iii-decoder'
import { MpegStreamReader } from './nlayer/mpeg-stream-reader'
import type { BlockMeta } from '../awc/extract'

export interface DecodeRequest {
  kind: 'decode'
  blocks: Array<BlockMeta>
  sampleRate: number
}

export type DecodeResponse =
  | {
      kind: 'ok'
      samples: Float32Array
      length: number
      sampleRate: number
    }
  | { kind: 'progress'; blocksDone: number; blocksTotal: number }
  | { kind: 'err'; message: string }

function decode(
  blocks: Array<BlockMeta>,
  onBlock?: (blocksDone: number, blocksTotal: number) => void,
): { samples: Float32Array; length: number } {
  const decoder = new LayerIIIDecoder()

  let totalExpected = 0
  for (const b of blocks)
    totalExpected += Math.max(0, b.sampleCount - b.discard)

  const samples = new Float32Array(Math.max(totalExpected, 1))
  let cursor = 0
  let blocksDone = 0

  const out0 = new Float32Array(1152)
  const out1 = new Float32Array(1152)

  for (const b of blocks) {
    const reader = new MpegStreamReader(b.bytes)
    const buf = new Float32Array(b.sampleCount)
    let pos = 0
    let frame = reader.nextFrame()
    while (frame !== null) {
      const n = decoder.decodeFrame(frame, out0, out1)
      if (n > 0 && pos < b.sampleCount) {
        const take = Math.min(n, b.sampleCount - pos)
        buf.set(out0.subarray(0, take), pos)
        pos += take
      }
      frame = reader.nextFrame()
    }

    const keep = b.sampleCount - b.discard
    if (keep > 0) {
      samples.set(buf.subarray(b.discard, b.discard + keep), cursor)
      cursor += keep
    }
    blocksDone++
    onBlock?.(blocksDone, blocks.length)
  }

  return { samples, length: Math.max(cursor, 1) }
}

// `self` inside a DedicatedWorkerGlobalScope is the global. We structurally
// type the surface we use (addEventListener + postMessage with optional
// transfer list) instead of pulling in the `WebWorker` lib, which conflicts
// with the `DOM` lib on shared names. Casting through `unknown` keeps the
// boundary explicit.
interface WorkerCtx {
  addEventListener: (
    type: 'message',
    listener: (ev: MessageEvent<DecodeRequest>) => void,
  ) => void
  postMessage: (message: DecodeResponse, transfer?: Array<Transferable>) => void
}

const ctx = self as unknown as WorkerCtx

ctx.addEventListener('message', (ev: MessageEvent<DecodeRequest>) => {
  const msg = ev.data
  try {
    const { samples, length } = decode(
      msg.blocks,
      (blocksDone, blocksTotal) => {
        ctx.postMessage({ kind: 'progress', blocksDone, blocksTotal })
      },
    )
    const response: DecodeResponse = {
      kind: 'ok',
      samples,
      length,
      sampleRate: msg.sampleRate,
    }
    // Transfer the underlying buffer so the main thread takes ownership
    // without copying (Float32Array's `.buffer` is an ArrayBuffer).
    ctx.postMessage(response, [samples.buffer])
  } catch (e) {
    const response: DecodeResponse = {
      kind: 'err',
      message: e instanceof Error ? e.message : String(e),
    }
    ctx.postMessage(response)
  }
})
