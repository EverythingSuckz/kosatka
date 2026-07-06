/**
 * Public types for the mixer engine. The engine is the source of truth for
 * per-track / master state. React subscribes via useSyncExternalStore and
 * re-renders on the engine's notify signal.
 */

/**
 * Easing curve into a keyframe from the previous one.
 *
 *  - `linear`: gain ramps from prev keyframe's value to this one across the
 *    interval between them (AudioParam's `linearRampToValueAtTime`).
 *  - `hold`:   gain stays at prev keyframe's value until this keyframe's time,
 *    then snaps to this keyframe's value (a sample-accurate "step").
 */
export type KeyframeEasing = 'linear' | 'hold'

/**
 * One automation keyframe, a point on a per-pair gain envelope.
 *
 * Keyframes are sorted ascending by `time`, and the engine refuses to store
 * duplicates at the same time. The earliest keyframe is the "start" of the
 * envelope, its `easing` value is ignored because there's no previous
 * keyframe to ease from.
 *
 * `gain` is the ABSOLUTE gain value (0..1.5) written directly into the
 * AudioParam. When a pair has any keyframes, the pair slider is bypassed
 * and the keyframe envelope is the source of truth (mute / solo / muteAll
 * still gate the output to zero). When a pair has no keyframes the pair
 * slider drives a constant gain.
 */
export interface Keyframe {
  /** Time in seconds within the song. */
  time: number
  /** Absolute gain, 0..1.5 (same range as the pair gain slider). */
  gain: number
  /** Easing INTO this keyframe from the previous one. */
  easing: KeyframeEasing
}

export interface TrackSpec {
  /** Stable identifier, reused as the React key in the mixer UI. */
  id: string
  /** Human-readable label (typically the stem hash hex). */
  name: string
  /** Decoded audio data. The engine never decodes, the codec layer does. */
  buffer: AudioBuffer
  /** Initial gain in [0, 1.5]. Defaults to 1. */
  gain?: number
  /** Initial stereo pan in [-1, 1]. Defaults to 0. */
  pan?: number
  /** Initial muted state. Defaults to false. */
  muted?: boolean
  /** Initial solo state. Defaults to false. */
  solo?: boolean
  /** Initial loop state. Defaults to false. */
  loop?: boolean
}

export interface TrackSnapshot {
  id: string
  name: string
  gain: number
  pan: number
  muted: boolean
  solo: boolean
  loop: boolean
  durationSeconds: number
}

export interface MixerSnapshot {
  isPlaying: boolean
  masterGain: number
  durationSeconds: number
  tracks: ReadonlyArray<TrackSnapshot>
  /**
   * True iff the engine is currently in a "global mute" panic state, i.e.
   * `muteAll()` was invoked and the previous per-track mute states have
   * been stashed for `restoreFromMuteAll()`. UI uses this to flip the
   * master toggle button label between "MUTE ALL" and "RESTORE".
   */
  wasGlobalMuted: boolean
  /** Loop region in seconds, or null if no loop region active. */
  loopRegion: { start: number; end: number } | null
  /**
   * Per-pair-key keyframe arrays. Key is an opaque pair identifier chosen by
   * the caller (typically `pair-<n>`). Only present for pairs with at least
   * one keyframe. Sorted ascending by time, never two keyframes at the
   * exact same time.
   */
  automation: Record<string, ReadonlyArray<Keyframe>>
  /**
   * The pair key currently in preview mode (only that pair is audible) or
   * `null` if not previewing. UI uses this to render dimming on other pairs.
   */
  previewPair: string | null
}

export const GAIN_MIN = 0
export const GAIN_MAX = 1.5
export const PAN_MIN = -1
export const PAN_MAX = 1

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

/**
 * Effective per-track output gain. Solo overrides mute: if any track is
 * soloed, only soloed tracks are audible, otherwise muted tracks are silent.
 */
export function effectiveTrackGain(
  trackGain: number,
  muted: boolean,
  solo: boolean,
  anyTrackSoloed: boolean,
): number {
  const audible = anyTrackSoloed ? solo : !muted
  return audible ? trackGain : 0
}

/**
 * Compute the gain that should be written into a track's AudioParam.
 *
 * The keyframe semantics shifted again in the round-5 model adjustment to
 * a PIECEWISE rule: keyframes are anchored time-points that own gain
 * INSIDE their range, while the slider owns gain OUTSIDE.
 *
 *   - No keyframes: gain at any t is `slider × gate`.
 *   - With keyframes:
 *       • t < firstKf.time     → `slider × gate`
 *       • t ∈ [first, last]    → `envelope(kfs, t) × gate`  (slider ignored)
 *       • t > lastKf.time      → `slider × gate`
 *
 * `gate` is the mute/solo factor (0 or 1). Mute/solo still gates the output
 * to zero in all three regions.
 *
 * Pure helper. The engine calls this to compute the instantaneous gain it
 * snaps a track to on pause / seek / stop (see
 * `MixerEngine.cancelAndApplyAutomationAt`), AND the tests use it to verify
 * the piecewise transitions without spinning up Web Audio.
 */
export function computeNodeGainAt(args: {
  keyframes: ReadonlyArray<Keyframe>
  trackSlider: number
  muted: boolean
  solo: boolean
  anyTrackSoloed: boolean
  timeSeconds: number
}): number {
  const audible = args.anyTrackSoloed ? args.solo : !args.muted
  const gate = audible ? 1 : 0
  const kfs = args.keyframes
  if (kfs.length === 0) {
    return args.trackSlider * gate
  }
  const firstT = kfs[0]!.time
  const lastT = kfs[kfs.length - 1]!.time
  if (args.timeSeconds < firstT || args.timeSeconds > lastT) {
    return args.trackSlider * gate
  }
  const env = evaluateKeyframesAt(kfs, args.timeSeconds)
  return (env ?? kfs[0]!.gain) * gate
}

/**
 * Normalize a keyframe list: clamp negative times to 0, drop NaN/inf values,
 * sort by time, deduplicate exact-time collisions (last write wins).
 *
 * The engine and hash-state both funnel writes through this so we never have
 * to think about "is this list sorted?" downstream.
 */
export function normalizeKeyframes(
  input: ReadonlyArray<Keyframe>,
): Array<Keyframe> {
  const cleaned: Array<Keyframe> = []
  for (const k of input) {
    if (!Number.isFinite(k.time) || !Number.isFinite(k.gain)) continue
    const time = Math.max(0, k.time)
    const gain = clamp(k.gain, GAIN_MIN, GAIN_MAX)
    const easing: KeyframeEasing = k.easing === 'hold' ? 'hold' : 'linear'
    cleaned.push({ time, gain, easing })
  }
  cleaned.sort((a, b) => a.time - b.time)
  // Collapse exact-time duplicates, last one wins (matches Set behaviour).
  const out: Array<Keyframe> = []
  for (const k of cleaned) {
    const tail = out[out.length - 1]
    if (tail && Math.abs(tail.time - k.time) < 1e-9) {
      out[out.length - 1] = k
    } else {
      out.push(k)
    }
  }
  return out
}

/**
 * Evaluate the envelope's gain value at time `t` seconds.
 *
 * Returns `null` when there are no keyframes, the caller should treat that
 * as "envelope inactive" and use the pair base gain.
 *
 * Before the first keyframe's time the value is the first keyframe's gain
 * (matches the AudioParam `setValueAtTime` behaviour). After the last, the
 * value is the last keyframe's gain. Between keyframes the easing of the
 * SECOND keyframe applies (linear interpolation or held at the previous
 * value).
 */
export function evaluateKeyframesAt(
  keyframes: ReadonlyArray<Keyframe>,
  t: number,
): number | null {
  if (keyframes.length === 0) return null
  if (t <= keyframes[0]!.time) return keyframes[0]!.gain
  for (let i = 1; i < keyframes.length; i++) {
    const prev = keyframes[i - 1]!
    const cur = keyframes[i]!
    if (t < cur.time) {
      if (cur.easing === 'hold') return prev.gain
      const span = cur.time - prev.time
      if (span <= 0) return cur.gain
      const u = (t - prev.time) / span
      return prev.gain + (cur.gain - prev.gain) * u
    }
  }
  return keyframes[keyframes.length - 1]!.gain
}
