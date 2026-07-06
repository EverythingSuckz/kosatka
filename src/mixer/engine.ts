/**
 * MixerEngine wraps an AudioContext, owns per-track gain/pan/analyser nodes
 * and BufferSourceNodes, drives sample-accurate sync.
 *
 * The audio graph per track:
 *   AudioBufferSourceNode → GainNode (channel) → StereoPannerNode → AnalyserNode → master GainNode → destination
 *
 * Sample-accurate start: on `play()` we (a) build all source nodes
 * synchronously, (b) call `.start(ctx.currentTime + LOOKAHEAD_S, offset)` on
 * each in the same tick. NEVER `await` between starts. The audio thread
 * uses the scheduled time to align them to the same sample.
 *
 * `AudioBufferSourceNode` is one-shot. Pause and seek both stop the current
 * sources and rebuild on the next play. Playhead position while playing is
 * `ctx.currentTime - startedAt + offsetAtStart`.
 *
 * Solo overrides mute. With any solo set, only soloed tracks are audible.
 * Otherwise mute applies normally.
 *
 * Automation: per-pair keyframe arrays drive the pair's gain via sample-
 * accurate AudioParam events (setValueAtTime + linearRampToValueAtTime).
 * Keyframe `gain` values are ABSOLUTE (0..1.5, same range as the slider).
 * Round-5 model: keyframes own gain INSIDE the [firstKf.time, lastKf.time]
 * range, the pair slider owns gain OUTSIDE that range. The scheduler writes
 * `slider × gate` as the anchor on either side of the range and snaps to
 * `firstKf.gain × gate` then back to `slider × gate` at the boundaries via
 * setValueAtTime. The snap is instantaneous, so boundary clicks are the
 * documented trade-off. The user can add a kf at the seam to ramp through it.
 * Mute and solo still gate the output regardless of which path is active.
 *
 * Preview mode doubles as a solo gesture invoked from a different UI. When
 * preview is set to a pair, every track NOT in that pair is muted, and the
 * previous mute state is stashed and restored on exit.
 *
 * The engine is framework-agnostic. The React `useMixer` hook in ./hook
 * subscribes to its `notify` signal.
 */

import {
  GAIN_MAX,
  GAIN_MIN,
  PAN_MAX,
  PAN_MIN,
  clamp,
  computeNodeGainAt,
  effectiveTrackGain,
  evaluateKeyframesAt,
  normalizeKeyframes,
} from './types'
import type {
  Keyframe,
  KeyframeEasing,
  MixerSnapshot,
  TrackSnapshot,
  TrackSpec,
} from './types'

const LOOKAHEAD_SECONDS = 0.1
/**
 * Ramp duration for smooth mute/unmute transitions (F2). 120 ms is long
 * enough to eliminate clicks at full amplitude and short enough to still
 * feel like a discrete on/off rather than a fade.
 */
const MUTE_RAMP_SECONDS = 0.12
/** Tiny pre-step on `hold` keyframes. Keeps the previous value held until
 * just before the new keyframe's time, then snaps. AudioParam needs two
 * setValueAtTime events to materialize a step. */
const HOLD_STEP_EPSILON = 1e-6

interface EngineTrack {
  spec: TrackSpec
  gainNode: GainNode
  panNode: StereoPannerNode
  analyserNode: AnalyserNode
  source: AudioBufferSourceNode | null
  gain: number
  pan: number
  muted: boolean
  solo: boolean
  loop: boolean
}

export class MixerEngine {
  private readonly ctx: AudioContext
  private readonly masterNode: GainNode
  private readonly tracks = new Map<string, EngineTrack>()
  private orderedIds: Array<string> = []
  private playing = false
  private startedAt = 0
  private offsetAtStart = 0
  private masterGain = 1
  private listeners = new Set<() => void>()
  private cachedSnapshot: MixerSnapshot | null = null
  /**
   * Snapshot of per-track muted states captured by `muteAll()`. When non-null,
   * the engine is in panic-mute mode and `restoreFromMuteAll()` will replay
   * these into setMuted on each track and then clear this field.
   */
  private mutedSnapshotBeforePanic: Map<string, boolean> | null = null
  /** Loop region bounds in seconds, null when unset. */
  private loopRegionStart: number | null = null
  private loopRegionEnd: number | null = null

  /**
   * Per-pair-key keyframe arrays. Sorted ascending by time, no duplicate
   * times. Empty entries are deleted (so `automation.has(key)` ↔ "has at
   * least one keyframe").
   */
  private automation = new Map<string, Array<Keyframe>>()
  /**
   * Map a pair key to the track IDs the keyframes apply to. Set by the
   * caller via `setAutomationTargets`. Keyframes don't fire audio without
   * targets.
   */
  private automationTargets = new Map<string, Array<string>>()

  /**
   * Pair key currently in preview mode, or null. While set, every track NOT
   * in that pair's target list is muted. The previous mute state is stashed
   * here and restored on exit.
   */
  private previewPair: string | null = null
  private previewMuteSnapshot: Map<string, boolean> | null = null

  /** Subscribers driven by a single shared requestAnimationFrame loop. */
  private frameSubscribers = new Set<(timestamp: number) => void>()
  private rafHandle: number | null = null

  constructor(ctx: AudioContext) {
    this.ctx = ctx
    this.masterNode = ctx.createGain()
    this.masterNode.gain.value = this.masterGain
    this.masterNode.connect(ctx.destination)
  }

  context(): AudioContext {
    return this.ctx
  }

  /** Replace the loaded track set. Stops any current playback. */
  loadTracks(specs: ReadonlyArray<TrackSpec>): void {
    this.stopAllSources()
    for (const t of this.tracks.values()) {
      t.gainNode.disconnect()
      t.panNode.disconnect()
      t.analyserNode.disconnect()
    }
    this.tracks.clear()
    this.orderedIds = []
    this.playing = false
    this.startedAt = 0
    this.offsetAtStart = 0
    this.mutedSnapshotBeforePanic = null
    this.loopRegionStart = null
    this.loopRegionEnd = null
    this.automation.clear()
    this.automationTargets.clear()
    this.previewPair = null
    this.previewMuteSnapshot = null

    const anySolo = specs.some((s) => s.solo === true)
    for (const spec of specs) {
      const gainNode = this.ctx.createGain()
      const panNode = this.ctx.createStereoPanner()
      const analyserNode = this.ctx.createAnalyser()
      analyserNode.fftSize = 1024
      analyserNode.smoothingTimeConstant = 0.4

      gainNode.connect(panNode)
      panNode.connect(analyserNode)
      analyserNode.connect(this.masterNode)

      const t: EngineTrack = {
        spec,
        gainNode,
        panNode,
        analyserNode,
        source: null,
        gain: spec.gain ?? 1,
        pan: spec.pan ?? 0,
        muted: spec.muted ?? false,
        solo: spec.solo ?? false,
        loop: spec.loop ?? false,
      }
      gainNode.gain.value = effectiveTrackGain(t.gain, t.muted, t.solo, anySolo)
      panNode.pan.value = clamp(t.pan, PAN_MIN, PAN_MAX)

      this.tracks.set(spec.id, t)
      this.orderedIds.push(spec.id)
    }
    this.invalidateSnapshot()
  }

  play(fromSeconds: number = this.offsetAtStart): void {
    if (this.tracks.size === 0) return
    if (this.playing) return

    if (this.ctx.state === 'suspended') {
      void this.ctx.resume()
    }

    const startTime = this.ctx.currentTime + LOOKAHEAD_SECONDS
    let playablesStarted = 0
    const regionActive =
      this.loopRegionStart !== null && this.loopRegionEnd !== null

    for (const t of this.tracks.values()) {
      const offset = clamp(fromSeconds, 0, t.spec.buffer.duration)
      if (!t.loop && !regionActive && offset >= t.spec.buffer.duration) continue
      const src = this.ctx.createBufferSource()
      src.buffer = t.spec.buffer
      if (regionActive) {
        src.loop = true
        const ls = clamp(this.loopRegionStart!, 0, t.spec.buffer.duration)
        const le = clamp(this.loopRegionEnd!, 0, t.spec.buffer.duration)
        if (le > ls + 0.01) {
          src.loopStart = ls
          src.loopEnd = le
        } else {
          src.loop = false
        }
      } else {
        src.loop = t.loop
      }
      src.connect(t.gainNode)
      src.start(startTime, offset)
      t.source = src
      playablesStarted++
    }

    if (playablesStarted === 0) {
      return
    }

    this.playing = true
    this.startedAt = startTime
    this.offsetAtStart = fromSeconds
    this.scheduleAllAutomation(fromSeconds, startTime)
    this.invalidateSnapshot()
  }

  pause(): void {
    if (!this.playing) return
    const pos = this.positionSeconds()
    this.stopAllSources()
    this.offsetAtStart = pos
    this.playing = false
    this.cancelAndApplyAutomationAt(pos)
    this.invalidateSnapshot()
  }

  stop(): void {
    if (!this.playing && this.offsetAtStart === 0) return
    this.stopAllSources()
    this.offsetAtStart = 0
    this.playing = false
    this.cancelAndApplyAutomationAt(0)
    this.invalidateSnapshot()
  }

  /**
   * Seek to a target time. Works whether playing or paused. When paused it
   * just records the new offset and refreshes the gain state at that time.
   */
  seek(seconds: number): void {
    const target = clamp(seconds, 0, this.durationSeconds())
    const wasPlaying = this.playing
    if (wasPlaying) this.stopAllSources()
    this.offsetAtStart = target
    this.playing = false
    this.cancelAndApplyAutomationAt(target)
    if (wasPlaying) this.play(target)
    else this.invalidateSnapshot()
  }

  isPlaying(): boolean {
    return this.playing
  }

  positionSeconds(): number {
    if (!this.playing) return this.offsetAtStart
    const elapsed = this.ctx.currentTime - this.startedAt
    return Math.max(0, this.offsetAtStart + elapsed)
  }

  durationSeconds(): number {
    let max = 0
    for (const t of this.tracks.values()) {
      if (t.spec.buffer.duration > max) max = t.spec.buffer.duration
    }
    return max
  }

  setGain(id: string, value: number): void {
    const t = this.tracks.get(id)
    if (!t) return
    t.gain = clamp(value, GAIN_MIN, GAIN_MAX)
    this.recomputeAllGains()
  }

  setPan(id: string, value: number): void {
    const t = this.tracks.get(id)
    if (!t) return
    t.pan = clamp(value, PAN_MIN, PAN_MAX)
    t.panNode.pan.value = t.pan
    this.invalidateSnapshot()
  }

  setMuted(id: string, muted: boolean): void {
    const t = this.tracks.get(id)
    if (!t) return
    if (t.muted === muted) {
      this.recomputeAllGains()
      return
    }
    t.muted = muted
    this.applySmoothGain(t)
    this.invalidateSnapshot()
  }

  toggleMute(id: string): void {
    const t = this.tracks.get(id)
    if (!t) return
    this.setMuted(id, !t.muted)
  }

  setSolo(id: string, solo: boolean): void {
    const t = this.tracks.get(id)
    if (!t) return
    t.solo = solo
    this.recomputeAllGains()
  }

  toggleSolo(id: string): void {
    const t = this.tracks.get(id)
    if (!t) return
    this.setSolo(id, !t.solo)
  }

  setLoop(id: string, loop: boolean): void {
    const t = this.tracks.get(id)
    if (!t) return
    t.loop = loop
    if (t.source) t.source.loop = loop
    this.invalidateSnapshot()
  }

  setMasterGain(value: number): void {
    this.masterGain = clamp(value, GAIN_MIN, GAIN_MAX)
    this.masterNode.gain.value = this.masterGain
    this.invalidateSnapshot()
  }

  muteAll(): void {
    if (this.mutedSnapshotBeforePanic) return
    const snap = new Map<string, boolean>()
    for (const [id, t] of this.tracks) {
      snap.set(id, t.muted)
      if (!t.muted) {
        t.muted = true
        this.applySmoothGain(t)
      }
    }
    this.mutedSnapshotBeforePanic = snap
    this.invalidateSnapshot()
  }

  restoreFromMuteAll(): void {
    const snap = this.mutedSnapshotBeforePanic
    if (!snap) return
    for (const [id, prevMuted] of snap) {
      const t = this.tracks.get(id)
      if (!t) continue
      if (t.muted !== prevMuted) {
        t.muted = prevMuted
        this.applySmoothGain(t)
      }
    }
    this.mutedSnapshotBeforePanic = null
    this.invalidateSnapshot()
  }

  isGloballyMuted(): boolean {
    return this.mutedSnapshotBeforePanic !== null
  }

  toggleMuteAll(): void {
    if (this.isGloballyMuted()) this.restoreFromMuteAll()
    else this.muteAll()
  }

  setLoopRegion(startSec: number, endSec: number): void {
    const dur = this.durationSeconds()
    const s = clamp(Math.min(startSec, endSec), 0, dur)
    const e = clamp(Math.max(startSec, endSec), 0, dur)
    if (e - s < 0.05) {
      this.clearLoopRegion()
      return
    }
    this.loopRegionStart = s
    this.loopRegionEnd = e
    for (const t of this.tracks.values()) {
      if (!t.source) continue
      const ls = clamp(s, 0, t.spec.buffer.duration)
      const le = clamp(e, 0, t.spec.buffer.duration)
      if (le > ls + 0.01) {
        t.source.loopStart = ls
        t.source.loopEnd = le
        t.source.loop = true
      } else {
        t.source.loop = t.loop
      }
    }
    this.invalidateSnapshot()
  }

  clearLoopRegion(): void {
    if (this.loopRegionStart === null && this.loopRegionEnd === null) return
    this.loopRegionStart = null
    this.loopRegionEnd = null
    for (const t of this.tracks.values()) {
      if (!t.source) continue
      t.source.loop = t.loop
    }
    this.invalidateSnapshot()
  }

  tickLoopRegion(): void {
    if (this.loopRegionStart === null || this.loopRegionEnd === null) return
    if (!this.playing) return
    const pos = this.positionSeconds()
    if (pos >= this.loopRegionEnd) {
      const len = this.loopRegionEnd - this.loopRegionStart
      this.startedAt += len
      const wrappedPlayhead = this.loopRegionStart
      const ctxNow = this.ctx.currentTime
      this.scheduleAllAutomation(wrappedPlayhead, ctxNow)
    }
  }

  // Keyframe API

  /**
   * Replace the keyframe list for a single pair. Pass an empty array to clear.
   * The list is normalized (sorted, deduped) before being stored.
   */
  setKeyframes(pairKey: string, keyframes: ReadonlyArray<Keyframe>): void {
    const norm = normalizeKeyframes(keyframes)
    if (norm.length === 0) this.automation.delete(pairKey)
    else this.automation.set(pairKey, norm)
    this.rescheduleAutomationForKey(pairKey)
    this.invalidateSnapshot()
  }

  /**
   * Edit one keyframe in place. If the new time crosses another keyframe's
   * time the list is re-sorted, so the caller should not assume the index
   * stays stable. Pass a partial object to update only the named fields.
   */
  setKeyframe(
    pairKey: string,
    index: number,
    partial: Partial<Keyframe>,
  ): void {
    const list = this.automation.get(pairKey)
    if (!list) return
    const cur = list[index]
    if (!cur) return
    const next: Keyframe = {
      time: partial.time !== undefined ? partial.time : cur.time,
      gain: partial.gain !== undefined ? partial.gain : cur.gain,
      easing: partial.easing !== undefined ? partial.easing : cur.easing,
    }
    const without = list.slice()
    without.splice(index, 1)
    without.push(next)
    const norm = normalizeKeyframes(without)
    if (norm.length === 0) this.automation.delete(pairKey)
    else this.automation.set(pairKey, norm)
    this.rescheduleAutomationForKey(pairKey)
    this.invalidateSnapshot()
  }

  /**
   * Add one keyframe. Returns the inserted index in the normalized list, or
   * -1 if the keyframe was dropped (invalid time / gain).
   */
  addKeyframe(pairKey: string, kf: Keyframe): number {
    const list = this.automation.get(pairKey) ?? []
    const next = list.slice()
    next.push(kf)
    const norm = normalizeKeyframes(next)
    if (norm.length === 0) {
      // the new kf was invalid and there were no existing ones, so no-op.
      this.invalidateSnapshot()
      return -1
    }
    this.automation.set(pairKey, norm)
    this.rescheduleAutomationForKey(pairKey)
    this.invalidateSnapshot()
    // Find the inserted keyframe by exact-time match.
    const targetTime = Math.max(0, kf.time)
    for (let i = 0; i < norm.length; i++) {
      if (Math.abs(norm[i]!.time - targetTime) < 1e-9) return i
    }
    return -1
  }

  deleteKeyframe(pairKey: string, index: number): void {
    const list = this.automation.get(pairKey)
    if (!list) return
    if (index < 0 || index >= list.length) return
    const next = list.slice()
    next.splice(index, 1)
    if (next.length === 0) this.automation.delete(pairKey)
    else this.automation.set(pairKey, next)
    this.rescheduleAutomationForKey(pairKey)
    this.invalidateSnapshot()
  }

  getKeyframes(pairKey: string): Array<Keyframe> {
    const list = this.automation.get(pairKey)
    if (!list) return []
    return list.map((k) => ({ ...k }))
  }

  /** Remove all keyframes for one pair, or all pairs if pairKey is omitted. */
  clearKeyframes(pairKey?: string): void {
    if (pairKey === undefined) {
      if (this.automation.size === 0) return
      this.automation.clear()
      this.recomputeAllGains()
    } else {
      if (!this.automation.has(pairKey)) return
      this.automation.delete(pairKey)
      this.rescheduleAutomationForKey(pairKey)
    }
    this.invalidateSnapshot()
  }

  /**
   * Tell the engine which track ids each pair key's keyframes should drive.
   * Setting an empty array decouples the envelope from audio output.
   */
  setAutomationTargets(pairKey: string, trackIds: ReadonlyArray<string>): void {
    if (trackIds.length === 0) this.automationTargets.delete(pairKey)
    else this.automationTargets.set(pairKey, [...trackIds])
    this.rescheduleAutomationForKey(pairKey)
  }

  // Preview

  /**
   * Enter preview mode: stash every track's current mute state, then mute
   * every track EXCEPT those belonging to `pairKey`'s automation targets.
   * Idempotent. Re-entering preview on the same pair is a no-op. Entering a
   * different pair re-targets without restoring, so toggling between previews
   * stays smooth.
   */
  enterPreview(pairKey: string): void {
    if (this.previewPair === pairKey) return
    // Capture the mute baseline only on first entry. Switching between
    // previews preserves the original baseline so exitPreview is symmetric.
    if (this.previewMuteSnapshot === null) {
      const snap = new Map<string, boolean>()
      for (const [id, t] of this.tracks) snap.set(id, t.muted)
      this.previewMuteSnapshot = snap
    }
    const audibleIds = new Set(this.automationTargets.get(pairKey) ?? [])
    for (const [id, t] of this.tracks) {
      const shouldMute = !audibleIds.has(id)
      if (t.muted !== shouldMute) {
        t.muted = shouldMute
        this.applySmoothGain(t)
      }
    }
    this.previewPair = pairKey
    this.invalidateSnapshot()
  }

  exitPreview(): void {
    if (this.previewPair === null) return
    const snap = this.previewMuteSnapshot
    if (snap) {
      for (const [id, prevMuted] of snap) {
        const t = this.tracks.get(id)
        if (!t) continue
        if (t.muted !== prevMuted) {
          t.muted = prevMuted
          this.applySmoothGain(t)
        }
      }
    }
    this.previewPair = null
    this.previewMuteSnapshot = null
    this.invalidateSnapshot()
  }

  isPreview(): string | null {
    return this.previewPair
  }

  // Meter / render

  readMeter(id: string): { peak: number; rms: number } | null {
    const t = this.tracks.get(id)
    if (!t) return null
    const n = t.analyserNode.fftSize
    const buf = new Float32Array(n)
    t.analyserNode.getFloatTimeDomainData(buf)
    let peak = 0
    let sq = 0
    for (let i = 0; i < n; i++) {
      const v = buf[i]!
      const av = v < 0 ? -v : v
      if (av > peak) peak = av
      sq += v * v
    }
    return { peak, rms: Math.sqrt(sq / n) }
  }

  async renderCurrentState(
    buffersById: ReadonlyMap<string, AudioBuffer>,
  ): Promise<AudioBuffer> {
    const dur = this.durationSeconds()
    if (dur <= 0) throw new Error('mix duration is zero, nothing to render')
    const sampleRate = this.ctx.sampleRate
    const totalSamples = Math.ceil(dur * sampleRate)
    const offlineCtx = new OfflineAudioContext(2, totalSamples, sampleRate)
    const master = offlineCtx.createGain()
    master.gain.value = this.masterGain
    master.connect(offlineCtx.destination)

    let anySolo = false
    for (const t of this.tracks.values()) {
      if (t.solo) {
        anySolo = true
        break
      }
    }

    // Build a per-track keyframe override map so the offline render reflects
    // the envelope even though we're not driving through this engine's nodes.
    const keyframesByTrack = new Map<string, Array<Keyframe>>()
    for (const [key, kfs] of this.automation) {
      const targets = this.automationTargets.get(key) ?? []
      for (const id of targets) keyframesByTrack.set(id, kfs)
    }

    for (const id of this.orderedIds) {
      const t = this.tracks.get(id)
      if (!t) continue
      const buf = buffersById.get(id)
      if (!buf) continue
      const audible = anySolo ? t.solo : !t.muted
      const gate = audible ? 1 : 0
      const eff = effectiveTrackGain(t.gain, t.muted, t.solo, anySolo)
      const kfs = keyframesByTrack.get(id)
      // Silent: skip building the source/gain entirely.
      if (kfs && kfs.length > 0 ? gate === 0 : eff === 0) continue
      const src = offlineCtx.createBufferSource()
      src.buffer = buf
      const gainNode = offlineCtx.createGain()
      if (kfs && kfs.length > 0) {
        // Piecewise path: slider × gate before firstKf, envelope × gate
        // inside the range, slider × gate after lastKf.
        const firstKf = kfs[0]!
        const lastKf = kfs[kfs.length - 1]!
        const sliderGain = t.gain
        // Anchor at t=0 with the slider value.
        gainNode.gain.value = sliderGain * gate
        gainNode.gain.setValueAtTime(sliderGain * gate, 0)
        // programKeyframesOnto handles the firstKf snap, all ramps, and the
        // post-range hand-off to the slider.
        if (kfs.length > 1) {
          this.programKeyframesOnto(gainNode.gain, kfs, gate, 0, 0, sliderGain)
        } else {
          // single keyframe means a degenerate range, so bump value at its
          // time and immediately hand off back to the slider.
          gainNode.gain.setValueAtTime(firstKf.gain * gate, firstKf.time)
          gainNode.gain.setValueAtTime(
            sliderGain * gate,
            lastKf.time + HOLD_STEP_EPSILON,
          )
        }
      } else {
        gainNode.gain.value = eff
      }
      const panNode = offlineCtx.createStereoPanner()
      panNode.pan.value = t.pan
      src.connect(gainNode)
      gainNode.connect(panNode)
      panNode.connect(master)
      src.start(0, 0)
    }

    return offlineCtx.startRendering()
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  snapshot(): MixerSnapshot {
    if (this.cachedSnapshot) return this.cachedSnapshot
    const tracks: Array<TrackSnapshot> = this.orderedIds.map((id) => {
      const t = this.tracks.get(id)!
      return {
        id: t.spec.id,
        name: t.spec.name,
        gain: t.gain,
        pan: t.pan,
        muted: t.muted,
        solo: t.solo,
        loop: t.loop,
        durationSeconds: t.spec.buffer.duration,
      }
    })
    const automation: Record<string, ReadonlyArray<Keyframe>> = {}
    for (const [k, list] of this.automation) {
      automation[k] = list.map((kf) => ({ ...kf }))
    }
    this.cachedSnapshot = {
      isPlaying: this.playing,
      masterGain: this.masterGain,
      durationSeconds: this.durationSeconds(),
      tracks,
      wasGlobalMuted: this.mutedSnapshotBeforePanic !== null,
      loopRegion:
        this.loopRegionStart !== null && this.loopRegionEnd !== null
          ? { start: this.loopRegionStart, end: this.loopRegionEnd }
          : null,
      automation,
      previewPair: this.previewPair,
    }
    return this.cachedSnapshot
  }

  /**
   * Tear down the audio graph. REGRESSION NOTE: the mix route's resume
   * stash reads `positionSeconds()` AFTER dispose() has run (React unmounts
   * parent effects before child effects), so dispose must never mutate
   * `playing`, `startedAt`, or `offsetAtStart`.
   */
  dispose(): void {
    this.stopAllSources()
    for (const t of this.tracks.values()) {
      t.gainNode.disconnect()
      t.panNode.disconnect()
      t.analyserNode.disconnect()
    }
    this.tracks.clear()
    this.orderedIds = []
    this.masterNode.disconnect()
    this.listeners.clear()
    this.cachedSnapshot = null
    this.frameSubscribers.clear()
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle)
      this.rafHandle = null
    }
  }

  private stopAllSources(): void {
    for (const t of this.tracks.values()) {
      if (t.source) {
        try {
          t.source.stop()
        } catch {
          /* already stopped */
        }
        t.source.disconnect()
        t.source = null
      }
    }
  }

  private applySmoothGain(t: EngineTrack): void {
    let anySolo = false
    for (const u of this.tracks.values()) {
      if (u.solo) {
        anySolo = true
        break
      }
    }
    // If this track is under keyframe automation, the slider's smooth-ramp
    // path is bypassed entirely. The keyframe schedule (gated by mute/solo)
    // is the source of truth. Re-arm it past `now` so the mute change is
    // reflected without ever writing the slider value into the param.
    if (this.trackHasAutomation(t.spec.id)) {
      this.rescheduleAutomationForTrack(t.spec.id, this.ctx.currentTime)
      return
    }
    const base = effectiveTrackGain(t.gain, t.muted, t.solo, anySolo)
    const now = this.ctx.currentTime
    const current = t.gainNode.gain.value
    t.gainNode.gain.cancelScheduledValues(now)
    t.gainNode.gain.setValueAtTime(current, now)
    t.gainNode.gain.linearRampToValueAtTime(base, now + MUTE_RAMP_SECONDS)
  }

  private recomputeAllGains(): void {
    let anySolo = false
    for (const t of this.tracks.values()) {
      if (t.solo) {
        anySolo = true
        break
      }
    }
    const now = this.ctx.currentTime
    for (const t of this.tracks.values()) {
      // Tracks with keyframes are driven by the automation schedule below,
      // NOT the slider. Skip the constant-value write for them.
      if (this.trackHasAutomation(t.spec.id)) continue
      const base = effectiveTrackGain(t.gain, t.muted, t.solo, anySolo)
      t.gainNode.gain.cancelScheduledValues(now)
      t.gainNode.gain.setValueAtTime(base, now)
    }
    // Re-arm keyframe scheduling for the future portion of every key.
    for (const key of this.automation.keys()) {
      this.rescheduleAutomationForKey(key)
    }
    this.invalidateSnapshot()
  }

  private invalidateSnapshot(): void {
    this.cachedSnapshot = null
    for (const fn of this.listeners) fn()
  }

  // Automation scheduling (keyframes)

  /**
   * Program a keyframe list onto a destination AudioParam, with all times
   * translated from "song seconds" to "context seconds".
   *
   *   ctxOffset = ctxNow + (kf.time - fromSec)
   *
   * Each keyframe's gain is multiplied by `gate` (0 or 1, the mute/solo
   * gate). The pair slider is NOT applied inside the keyframe range, keyframe
   * gains are absolute.
   *
   * The FIRST keyframe is anchored via setValueAtTime at its translated
   * context time (clamped to ≥ ctxNow so we don't try to schedule in the
   * past).
   *
   * For each subsequent keyframe:
   *   linear → linearRampToValueAtTime
   *   hold   → setValueAtTime(prev.gain, kf.time - ε) then
   *            setValueAtTime(this.gain, kf.time), producing the step.
   *
   * If `postRangeSlider` is non-null, schedule a final
   * `setValueAtTime(postRangeSlider × gate, lastKfCtx + ε)` so control
   * reverts to the slider after the keyframe range ends. The hand-off is an
   * instantaneous step, a documented trade-off. Boundary clicks happen unless
   * the user puts a kf at the seam to ramp through it.
   */
  private programKeyframesOnto(
    param: AudioParam,
    keyframes: ReadonlyArray<Keyframe>,
    gate: number,
    fromSec: number,
    ctxNow: number,
    postRangeSlider: number | null = null,
  ): void {
    if (keyframes.length === 0) return
    const first = keyframes[0]!
    const firstCtx = Math.max(ctxNow, ctxNow + (first.time - fromSec))
    param.setValueAtTime(first.gain * gate, firstCtx)
    let lastCtxWritten = firstCtx
    for (let i = 1; i < keyframes.length; i++) {
      const prev = keyframes[i - 1]!
      const cur = keyframes[i]!
      const curCtx = ctxNow + (cur.time - fromSec)
      if (curCtx <= ctxNow) {
        // entire transition lies in the past, so anchor to its end value.
        param.setValueAtTime(cur.gain * gate, ctxNow)
        lastCtxWritten = ctxNow
        continue
      }
      if (cur.easing === 'hold') {
        const stepBefore = Math.max(ctxNow, curCtx - HOLD_STEP_EPSILON)
        param.setValueAtTime(prev.gain * gate, stepBefore)
        param.setValueAtTime(cur.gain * gate, curCtx)
      } else {
        param.linearRampToValueAtTime(cur.gain * gate, curCtx)
      }
      lastCtxWritten = curCtx
    }
    if (postRangeSlider !== null) {
      // Hand control back to the slider immediately after the last keyframe.
      // 1 µs step. An audible click is possible here, a documented trade-off.
      param.setValueAtTime(
        postRangeSlider * gate,
        lastCtxWritten + HOLD_STEP_EPSILON,
      )
    }
  }

  /**
   * Returns the mute/solo gate for a track, 1 if audible, 0 if silent.
   * The keyframe scheduler multiplies the absolute keyframe values by this
   * so mute/solo still gates automated tracks.
   */
  private trackGateMultiplier(t: EngineTrack, anySolo: boolean): number {
    const audible = anySolo ? t.solo : !t.muted
    return audible ? 1 : 0
  }

  /**
   * Returns true iff the given trackId is targeted by at least one pair's
   * keyframe list. While true, the slider's constant-gain path is bypassed.
   */
  private trackHasAutomation(trackId: string): boolean {
    for (const [pairKey, ids] of this.automationTargets) {
      if (!this.automation.has(pairKey)) continue
      if (ids.indexOf(trackId) !== -1) return true
    }
    return false
  }

  private scheduleAllAutomation(fromSec: number, ctxNow: number): void {
    for (const key of this.automation.keys()) {
      this.scheduleAutomationForKey(key, fromSec, ctxNow)
    }
  }

  private scheduleAutomationForKey(
    pairKey: string,
    fromSec: number,
    ctxNow: number,
  ): void {
    const keyframes = this.automation.get(pairKey)
    const targets = this.automationTargets.get(pairKey)
    if (!targets || targets.length === 0) return
    let anySolo = false
    for (const u of this.tracks.values()) {
      if (u.solo) {
        anySolo = true
        break
      }
    }
    for (const id of targets) {
      const t = this.tracks.get(id)
      if (!t) continue
      t.gainNode.gain.cancelScheduledValues(ctxNow)
      if (!keyframes || keyframes.length === 0) {
        // No keyframes on this pair → slider drives the constant gain.
        const base = effectiveTrackGain(t.gain, t.muted, t.solo, anySolo)
        t.gainNode.gain.setValueAtTime(base, ctxNow)
        continue
      }
      // Round-5 piecewise model. Keyframes own gain inside their range only,
      // outside the range the slider wins. Decide which region `fromSec`
      // sits in and write the correct anchor, then schedule boundary
      // hand-offs as needed.
      const gate = this.trackGateMultiplier(t, anySolo)
      const firstKf = keyframes[0]!
      const lastKf = keyframes[keyframes.length - 1]!
      const sliderGain = t.gain
      if (fromSec < firstKf.time - 1e-9) {
        // BEFORE the keyframe range, slider × gate is the current value.
        // Schedule a snap to the first kf at its translated context time.
        t.gainNode.gain.setValueAtTime(sliderGain * gate, ctxNow)
        if (!this.playing) continue
        // Schedule the entry boundary: setValueAtTime at firstKf time.
        const firstCtx = ctxNow + (firstKf.time - fromSec)
        t.gainNode.gain.setValueAtTime(firstKf.gain * gate, firstCtx)
        // Then ramp through the rest of the keyframes, exiting to slider
        // after the last one.
        if (keyframes.length > 1) {
          this.programKeyframesOnto(
            t.gainNode.gain,
            keyframes,
            gate,
            fromSec,
            ctxNow,
            sliderGain,
          )
        } else {
          // Only one kf means a degenerate range, so hand off back to the
          // slider an instant after firstKf.
          t.gainNode.gain.setValueAtTime(
            sliderGain * gate,
            firstCtx + HOLD_STEP_EPSILON,
          )
        }
      } else if (fromSec > lastKf.time + 1e-9) {
        // AFTER the keyframe range, slider × gate.
        t.gainNode.gain.setValueAtTime(sliderGain * gate, ctxNow)
      } else {
        // INSIDE the keyframe range. Anchor at envelope(fromSec) × gate,
        // walk forward through remaining future keyframes, then hand off
        // to the slider after the last keyframe.
        const envAt = evaluateKeyframesAt(keyframes, fromSec)
        t.gainNode.gain.setValueAtTime((envAt ?? firstKf.gain) * gate, ctxNow)
        if (!this.playing) continue
        const future: Array<Keyframe> = []
        for (const kf of keyframes) {
          if (kf.time > fromSec + 1e-9) future.push(kf)
        }
        if (future.length === 0) {
          // No future keyframes → fromSec ≥ lastKf.time but within tolerance.
          // Hand off to slider immediately.
          t.gainNode.gain.setValueAtTime(
            sliderGain * gate,
            ctxNow + HOLD_STEP_EPSILON,
          )
          continue
        }
        // Synthesize a virtual start at fromSec carrying the current envelope
        // value so the first future ramp interpolates correctly.
        const virtualStart: Keyframe = {
          time: fromSec,
          gain: envAt ?? firstKf.gain,
          easing: 'linear',
        }
        this.programKeyframesOnto(
          t.gainNode.gain,
          [virtualStart, ...future],
          gate,
          fromSec,
          ctxNow,
          sliderGain,
        )
      }
    }
  }

  private rescheduleAutomationForKey(pairKey: string): void {
    const pos = this.positionSeconds()
    this.scheduleAutomationForKey(pairKey, pos, this.ctx.currentTime)
  }

  private rescheduleAutomationForTrack(
    trackId: string,
    ctxNotBefore = this.ctx.currentTime,
  ): void {
    const pos = this.positionSeconds()
    for (const [key, ids] of this.automationTargets) {
      if (ids.indexOf(trackId) === -1) continue
      this.scheduleAutomationForKey(key, pos, ctxNotBefore)
    }
  }

  /**
   * On pause / seek / stop: cancel future automation events on every track
   * and snap the gain to the correct piecewise value at the playhead × gate.
   * Inside the keyframe range that's the envelope value, outside it's the
   * pair slider's value. Future re-schedule happens on the next play().
   */
  private cancelAndApplyAutomationAt(playheadSec: number): void {
    const ctxNow = this.ctx.currentTime
    let anySolo = false
    for (const u of this.tracks.values()) {
      if (u.solo) {
        anySolo = true
        break
      }
    }
    const tracksWithAutomation = new Set<string>()
    for (const [key, keyframes] of this.automation) {
      const targets = this.automationTargets.get(key)
      if (!targets) continue
      if (keyframes.length === 0) continue
      for (const id of targets) {
        const t = this.tracks.get(id)
        if (!t) continue
        // Single source of truth for the piecewise snap value: envelope ×
        // gate inside the keyframe range, slider × gate outside. Shares the
        // exact pure helper the engine tests assert against, so the live
        // snap and the tested contract can't drift apart.
        const target = computeNodeGainAt({
          keyframes,
          trackSlider: t.gain,
          muted: t.muted,
          solo: t.solo,
          anyTrackSoloed: anySolo,
          timeSeconds: playheadSec,
        })
        t.gainNode.gain.cancelScheduledValues(ctxNow)
        t.gainNode.gain.setValueAtTime(target, ctxNow)
        tracksWithAutomation.add(id)
      }
    }
    // Tracks NOT under automation snap back to manual base (slider).
    for (const t of this.tracks.values()) {
      if (tracksWithAutomation.has(t.spec.id)) continue
      const base = effectiveTrackGain(t.gain, t.muted, t.solo, anySolo)
      t.gainNode.gain.cancelScheduledValues(ctxNow)
      t.gainNode.gain.setValueAtTime(base, ctxNow)
    }
  }

  // Shared RAF

  subscribeFrame(fn: (timestamp: number) => void): () => void {
    this.frameSubscribers.add(fn)
    this.ensureRafRunning()
    return () => {
      this.frameSubscribers.delete(fn)
      if (this.frameSubscribers.size === 0 && this.rafHandle !== null) {
        cancelAnimationFrame(this.rafHandle)
        this.rafHandle = null
      }
    }
  }

  private ensureRafRunning(): void {
    if (this.rafHandle !== null) return
    if (this.frameSubscribers.size === 0) return
    const tick = (ts: number): void => {
      this.tickLoopRegion()
      for (const fn of this.frameSubscribers) {
        try {
          fn(ts)
        } catch {
          /* swallow */
        }
      }
      if (this.frameSubscribers.size === 0) {
        this.rafHandle = null
        return
      }
      this.rafHandle = requestAnimationFrame(tick)
    }
    this.rafHandle = requestAnimationFrame(tick)
  }
}

// Re-export the pure helpers for tests / hash-state.
export { normalizeKeyframes, evaluateKeyframesAt }
export type { Keyframe, KeyframeEasing }
