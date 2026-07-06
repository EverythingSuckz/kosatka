/**
 * MP3 codec (AWC codec id 7 = MPEG-1 Layer III).
 *
 * Decodes one channel of an AWC mc-channel stream through the NLayer TS
 * port (`src/codecs/nlayer/`). One stateful `LayerIIIDecoder` per channel
 * so IMDCT overlap and polyphase synth state carries across block
 * boundaries, eliminating per-block warmup glitches. Each block uses its
 * own `MpegStreamReader` since AWC blocks are self-contained at the bit
 * reservoir layer (every block's first frame has `mainDataBegin == 0`).
 *
 * Per AWC convention, every block's first `discard` decoded samples are
 * priming and must be dropped (see `docs/awc-mixing-investigation.md`).
 * Remaining `sampleCount − discard` samples per block are the channel's
 * real audio.
 *
 * NLayer is the only known decoder family that handles Rockstar's MP3
 * bitstream without dropping frames (libavcodec and libmpg123 both drop
 * ~25-30 frames per channel on ch7+). See `nlayer_port_status.md` and
 * `docs/mp3-decoder-investigation.md` for the cross-decoder
 * verification that ruled out every other JS/WASM family.
 *
 * # Threading
 *
 * Decoding ~80 blocks per channel × 16 channels takes ~30 s wallclock on
 * the main thread and froze the UI completely until the mix was ready.
 * To fix the UX bug, we now dispatch each channel's decode to a fresh
 * `Worker` (Vite module-worker, see `mp3-worker.ts`). The main thread
 * only does the trivial post-message + AudioBuffer copy. Everything
 * expensive happens off-thread, and the browser can paint progress
 * updates / process input throughout.
 *
 * For test environments (Bun's runner, Node) where `globalThis.Worker`
 * isn't defined we fall through to the synchronous in-process decoder so
 * unit tests can still exercise the pipeline directly.
 */

import { LayerIIIDecoder } from './nlayer/layer-iii-decoder'
import { MpegStreamReader } from './nlayer/mpeg-stream-reader'
import type { BlockMeta } from '../awc/extract'
import type { DecodeRequest, DecodeResponse } from './mp3-worker'

/** Per-block progress: `blocksDone`/`blocksTotal` for THIS channel. */
export type DecodeProgress = (blocksDone: number, blocksTotal: number) => void

export async function decodeMp3(
  blocks: Array<BlockMeta>,
  sampleRate: number,
  ctx: BaseAudioContext,
  onProgress?: DecodeProgress,
): Promise<AudioBuffer> {
  // Browser path: hand the heavy lifting to a worker so the UI thread
  // stays responsive while ~80 blocks per channel decode.
  if (typeof Worker !== 'undefined') {
    return decodeMp3InWorker(blocks, sampleRate, ctx, onProgress)
  }
  // Test / Node path: synchronous in-process decode.
  return decodeMp3InProcess(blocks, sampleRate, ctx)
}

async function decodeMp3InWorker(
  blocks: Array<BlockMeta>,
  sampleRate: number,
  ctx: BaseAudioContext,
  onProgress?: DecodeProgress,
): Promise<AudioBuffer> {
  // Vite resolves this import-meta-URL form at build time and bundles
  // the worker module with its own dependency graph. `type: 'module'`
  // lets the worker use ES imports (NLayer modules).
  const worker = new Worker(new URL('./mp3-worker.ts', import.meta.url), {
    type: 'module',
  })

  try {
    const { samples, length } = await new Promise<{
      samples: Float32Array
      length: number
    }>((resolve, reject) => {
      // NOT once: progress messages stream in before the terminal ok/err.
      const onMessage = (ev: MessageEvent<DecodeResponse>): void => {
        const msg = ev.data
        if (msg.kind === 'progress') {
          onProgress?.(msg.blocksDone, msg.blocksTotal)
          return
        }
        if (msg.kind === 'ok') {
          resolve({ samples: msg.samples, length: msg.length })
        } else {
          reject(new Error(msg.message))
        }
      }
      const onError = (ev: ErrorEvent): void => {
        reject(new Error(ev.message || 'mp3 worker error'))
      }
      const onMessageError = (): void => {
        reject(new Error('mp3 worker messageerror (deserialization failed)'))
      }
      worker.addEventListener('message', onMessage)
      worker.addEventListener('error', onError, { once: true })
      worker.addEventListener('messageerror', onMessageError, { once: true })

      // We structured-clone `blocks` instead of transferring their
      // ArrayBuffers. The clone of ~MB-scale bytes is sub-100ms vs.
      // seconds for the decode itself, so it's not the bottleneck, and
      // transferring would detach `streamBytes` in React state, which
      // is fragile if any other consumer later reads those bytes (e.g.
      // a re-render, devtools, future export path). The response
      // direction is still transferred (Float32Array buffer), the
      // bigger payload and owned solely by the worker.
      const request: DecodeRequest = { kind: 'decode', blocks, sampleRate }
      worker.postMessage(request)
    })

    const buf = ctx.createBuffer(1, length, sampleRate)
    // `samples` arrives as `Float32Array<ArrayBufferLike>` after the
    // structured/transferred clone, but `copyToChannel` is typed for
    // `Float32Array<ArrayBuffer>`. The buffer is always a real
    // ArrayBuffer (never SharedArrayBuffer, we never create one in
    // the worker), so a cast is sound.
    const view = samples.subarray(0, length) as Float32Array<ArrayBuffer>
    buf.copyToChannel(view, 0)
    return buf
  } finally {
    // One-shot worker per channel: terminate so 16 spawned workers
    // don't leak after the mix is ready.
    worker.terminate()
  }
}

function decodeMp3InProcess(
  blocks: Array<BlockMeta>,
  sampleRate: number,
  ctx: BaseAudioContext,
): Promise<AudioBuffer> {
  const decoder = new LayerIIIDecoder()

  let totalExpected = 0
  for (const b of blocks)
    totalExpected += Math.max(0, b.sampleCount - b.discard)

  const samples = new Float32Array(Math.max(totalExpected, 1))
  let cursor = 0

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
  }

  const length = Math.max(cursor, 1)
  const buf = ctx.createBuffer(1, length, sampleRate)
  buf.copyToChannel(samples.subarray(0, length), 0)
  return Promise.resolve(buf)
}
