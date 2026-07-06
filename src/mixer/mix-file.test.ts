/**
 * Tests for the `.mix` preset file parser, builder, and apply helper.
 */

import { describe, expect, test } from 'bun:test'

import {
  MIX_FILE_FORMAT,
  MIX_FILE_VERSION,
  applyMixFile,
  buildMixFile,
  parseMixFile,
} from './mix-file'
import type { MixerEngine } from './engine'

describe('buildMixFile', () => {
  test('produces the canonical wire shape', () => {
    const file = buildMixFile({
      awcName: 'hei4_fin_track_a03.awc',
      awcSize: 41847248,
      streamCount: 16,
      sampleRate: 48000,
      state: {
        m: [1, 1, 0, 1, 1, 0, 1, 0],
        g: [100, 100, 100, 80, 100, 100, 100, 100],
        p: [100, 100, 100, 100, 100, 100, 100, 100],
        M: 100,
      },
    })
    expect(file.format).toBe(MIX_FILE_FORMAT)
    expect(file.version).toBe(MIX_FILE_VERSION)
    expect(file.awc).toEqual({
      name: 'hei4_fin_track_a03.awc',
      size: 41847248,
      streamCount: 16,
      sampleRate: 48000,
    })
    expect(file.state.m).toEqual([1, 1, 0, 1, 1, 0, 1, 0])
    expect(file.appVersion).toBeTruthy()
    expect(file.savedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})

describe('parseMixFile', () => {
  test('round-trips a built file with keyframes', () => {
    const built = buildMixFile({
      awcName: 'song.awc',
      awcSize: 1024,
      streamCount: 4,
      sampleRate: 48000,
      state: {
        m: [1, 0],
        g: [120, 80],
        p: [100, 50],
        M: 100,
        a: [
          [
            { time: 1.5, gain: 0, easing: 'linear' },
            { time: 3.5, gain: 1, easing: 'hold' },
          ],
          null,
        ],
      },
    })
    // The route hand-encodes the on-disk shape (flat-int triples). For the
    // round-trip test we craft the flat form directly:
    const onDisk = {
      ...built,
      state: {
        ...built.state,
        a: [[150, 0, 0, 350, 100, 1], 0],
      },
    }
    const parsed = parseMixFile(JSON.stringify(onDisk))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.mix.awc.name).toBe('song.awc')
    expect(parsed.mix.state.m).toEqual([1, 0])
    expect(parsed.mix.state.a).toEqual([
      [
        { time: 1.5, gain: 0, easing: 'linear' },
        { time: 3.5, gain: 1, easing: 'hold' },
      ],
      null,
    ])
  })

  test('rejects non-JSON input', () => {
    const parsed = parseMixFile('not json at all')
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error.toLowerCase()).toContain('json')
  })

  test('rejects wrong format magic', () => {
    const json = JSON.stringify({
      format: 'something-else',
      version: 1,
      awc: { name: 'x', size: 0, streamCount: 0, sampleRate: 48000 },
      state: { m: [], g: [], p: [], M: 100 },
    })
    const parsed = parseMixFile(json)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error.toLowerCase()).toContain('format')
  })

  test('rejects unsupported version', () => {
    const json = JSON.stringify({
      format: 'awc-mix',
      version: 99,
      awc: { name: 'x', size: 0, streamCount: 0, sampleRate: 48000 },
      state: { m: [], g: [], p: [], M: 100 },
    })
    const parsed = parseMixFile(json)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error.toLowerCase()).toContain('version')
  })

  test('rejects v1 with a semantics-aware error message', () => {
    // v1 files used envelope-multiplier semantics for keyframe gain. v2 is
    // absolute. The wire bytes look identical, so re-applying a v1 file as
    // v2 would silently mis-route audio. We refuse to load and explain why.
    const json = JSON.stringify({
      format: 'awc-mix',
      version: 1,
      awc: { name: 'x', size: 0, streamCount: 0, sampleRate: 48000 },
      state: { m: [], g: [], p: [], M: 100 },
    })
    const parsed = parseMixFile(json)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error.toLowerCase()).toContain('version 1')
    expect(parsed.error.toLowerCase()).toContain('absolute')
  })

  test('rejects missing state block', () => {
    const json = JSON.stringify({
      format: 'awc-mix',
      version: 2,
      awc: { name: 'x', size: 0, streamCount: 0, sampleRate: 48000 },
    })
    const parsed = parseMixFile(json)
    expect(parsed.ok).toBe(false)
  })

  test('ignores extra unknown fields (forward compat)', () => {
    const json = JSON.stringify({
      format: 'awc-mix',
      version: 2,
      awc: {
        name: 'song.awc',
        size: 1,
        streamCount: 2,
        sampleRate: 48000,
        future: 'whatever',
      },
      state: { m: [1, 0], g: [100, 100], p: [0, 0], M: 100, future: 'x' },
      savedAt: '2026-01-01T00:00:00.000Z',
      appVersion: '0.0.0',
      future: 'whatever',
    })
    const parsed = parseMixFile(json)
    expect(parsed.ok).toBe(true)
  })

  test('parses keyframe flat-int triples', () => {
    const json = JSON.stringify({
      format: 'awc-mix',
      version: 2,
      awc: { name: 'x.awc', size: 1, streamCount: 4, sampleRate: 48000 },
      state: {
        m: [1, 1],
        g: [100, 100],
        p: [0, 0],
        M: 100,
        a: [[1000, 50, 0, 2000, 100, 1], 0],
      },
    })
    const parsed = parseMixFile(json)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.mix.state.a).toEqual([
      [
        { time: 10, gain: 0.5, easing: 'linear' },
        { time: 20, gain: 1, easing: 'hold' },
      ],
      null,
    ])
  })

  test('drops legacy segment automation silently', () => {
    const json = JSON.stringify({
      format: 'awc-mix',
      version: 2,
      awc: { name: 'x.awc', size: 1, streamCount: 4, sampleRate: 48000 },
      state: {
        m: [1, 1],
        g: [100, 100],
        p: [0, 0],
        M: 100,
        // 2-int-per-segment legacy form, length 2 → not divisible by 3.
        a: [[100, 500], 0],
      },
    })
    const parsed = parseMixFile(json)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.legacyAutomationDropped).toBe(true)
    expect(parsed.mix.state.a?.[0]).toBeNull()
  })
})

describe('applyMixFile', () => {
  interface StubCall {
    op: string
    args: Array<unknown>
  }

  function makeStubEngine(): {
    engine: MixerEngine
    calls: Array<StubCall>
  } {
    const calls: Array<StubCall> = []
    const stub = {
      setMuted: (id: string, muted: boolean) => {
        calls.push({ op: 'setMuted', args: [id, muted] })
      },
      setGain: (id: string, value: number) => {
        calls.push({ op: 'setGain', args: [id, value] })
      },
      setPan: (id: string, value: number) => {
        calls.push({ op: 'setPan', args: [id, value] })
      },
      setMasterGain: (value: number) => {
        calls.push({ op: 'setMasterGain', args: [value] })
      },
      setKeyframes: (key: string, keyframes: unknown) => {
        calls.push({ op: 'setKeyframes', args: [key, keyframes] })
      },
      clearKeyframes: (key?: string) => {
        calls.push({
          op: 'clearKeyframes',
          args: key !== undefined ? [key] : [],
        })
      },
    }
    return { engine: stub as unknown as MixerEngine, calls }
  }

  test('applies mute, gain, pan, master, and keyframes', () => {
    const { engine, calls } = makeStubEngine()
    const mix = buildMixFile({
      awcName: 'song.awc',
      awcSize: 1,
      streamCount: 4,
      sampleRate: 48000,
      state: {
        m: [1, 0],
        g: [100, 80],
        p: [100, 50],
        M: 90,
        a: [[{ time: 1, gain: 1, easing: 'linear' }], null],
      },
    })
    const trackIds = new Map([
      [1, { left: 'L1', right: 'R1' }],
      [2, { left: 'L2', right: 'R2' }],
    ])
    const result = applyMixFile(mix, engine, {
      pairCount: 2,
      trackIdsForPair: (n) => trackIds.get(n) ?? { left: null, right: null },
    })
    expect(result.applied).toBe(true)
    expect(result.warnings).toEqual([])

    expect(calls).toContainEqual({ op: 'setMuted', args: ['L1', false] })
    expect(calls).toContainEqual({ op: 'setMuted', args: ['R1', false] })
    expect(calls).toContainEqual({ op: 'setGain', args: ['L1', 1] })
    expect(calls).toContainEqual({ op: 'setGain', args: ['R1', 1] })
    expect(calls).toContainEqual({ op: 'setPan', args: ['L1', -1] })
    expect(calls).toContainEqual({ op: 'setPan', args: ['R1', 1] })

    expect(calls).toContainEqual({ op: 'setMuted', args: ['L2', true] })
    expect(calls).toContainEqual({ op: 'setMuted', args: ['R2', true] })
    expect(calls).toContainEqual({ op: 'setGain', args: ['L2', 0.8] })
    expect(calls).toContainEqual({ op: 'setPan', args: ['L2', -0.5] })
    expect(calls).toContainEqual({ op: 'setPan', args: ['R2', 0.5] })

    expect(calls).toContainEqual({ op: 'setMasterGain', args: [0.9] })

    // Automation cleared first, then keyframes applied to pair-1 only.
    expect(calls.find((c) => c.op === 'clearKeyframes')).toBeDefined()
    const kfCall = calls.find(
      (c) => c.op === 'setKeyframes' && c.args[0] === 'pair-1',
    )
    expect(kfCall).toBeDefined()
    expect(kfCall!.args[1]).toEqual([{ time: 1, gain: 1, easing: 'linear' }])
    // pair-2 (null) → no setKeyframes call
    expect(
      calls.some((c) => c.op === 'setKeyframes' && c.args[0] === 'pair-2'),
    ).toBe(false)
  })

  test('warns when saved pair count differs from current', () => {
    const { engine } = makeStubEngine()
    const mix = buildMixFile({
      awcName: 'song.awc',
      awcSize: 1,
      streamCount: 16,
      sampleRate: 48000,
      state: {
        m: [1, 1, 1, 1, 1, 1, 1, 1],
        g: [100, 100, 100, 100, 100, 100, 100, 100],
        p: [100, 100, 100, 100, 100, 100, 100, 100],
        M: 100,
      },
    })
    const result = applyMixFile(mix, engine, {
      pairCount: 4,
      trackIdsForPair: () => ({ left: null, right: null }),
    })
    expect(result.applied).toBe(true)
    expect(result.warnings.length).toBeGreaterThan(0)
    expect(result.warnings[0]).toMatch(/pairs/i)
  })

  test('tolerates pairs with no decoded tracks', () => {
    const { engine, calls } = makeStubEngine()
    const mix = buildMixFile({
      awcName: 'song.awc',
      awcSize: 1,
      streamCount: 2,
      sampleRate: 48000,
      state: {
        m: [1],
        g: [100],
        p: [100],
        M: 100,
      },
    })
    const result = applyMixFile(mix, engine, {
      pairCount: 1,
      trackIdsForPair: () => ({ left: null, right: null }),
    })
    expect(result.applied).toBe(true)
    expect(calls.some((c) => c.op === 'setMasterGain')).toBe(true)
    expect(calls.some((c) => c.op === 'setMuted')).toBe(false)
  })

  test('clears existing keyframes even when saved mix has none', () => {
    const { engine, calls } = makeStubEngine()
    const mix = buildMixFile({
      awcName: 'song.awc',
      awcSize: 1,
      streamCount: 2,
      sampleRate: 48000,
      state: { m: [1], g: [100], p: [100], M: 100 },
    })
    applyMixFile(mix, engine, {
      pairCount: 1,
      trackIdsForPair: () => ({ left: 'L1', right: 'R1' }),
    })
    expect(calls.some((c) => c.op === 'clearKeyframes')).toBe(true)
    expect(calls.some((c) => c.op === 'setKeyframes')).toBe(false)
  })
})
