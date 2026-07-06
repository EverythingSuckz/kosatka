/**
 * Tests for the drop-zone classification helper. The React state machine
 * lives in `./index.tsx`. We cover the file-classification gate and the
 * LoadStage shape contract here so the component can stay focused on JSX.
 */

import { describe, expect, test } from 'bun:test'

import { NAVIGATE_HOLD_MS, classifyFile } from './-dropStage'
import type { LoadStage } from './-dropStage'

describe('classifyFile', () => {
  test('recognises .awc (lowercase)', () => {
    expect(classifyFile('foo.awc')).toBe('awc')
  })
  test('recognises .AWC (uppercase)', () => {
    expect(classifyFile('FOO.AWC')).toBe('awc')
  })
  test('recognises .rpf (lowercase)', () => {
    expect(classifyFile('dlc.rpf')).toBe('rpf')
  })
  test('recognises .Rpf (mixed case)', () => {
    expect(classifyFile('Pack.Rpf')).toBe('rpf')
  })
  test('returns null for unknown extensions', () => {
    expect(classifyFile('foo.txt')).toBe(null)
    expect(classifyFile('foo.exe')).toBe(null)
    expect(classifyFile('foo')).toBe(null)
    expect(classifyFile('')).toBe(null)
  })
  test('does NOT match if .awc/.rpf appear mid-name', () => {
    expect(classifyFile('not.awc.txt')).toBe(null)
    expect(classifyFile('not.rpf.bak')).toBe(null)
  })
  test('handles paths with directory separators', () => {
    expect(classifyFile('subdir/foo.awc')).toBe('awc')
  })
})

describe('NAVIGATE_HOLD_MS', () => {
  test('is a short human-perceptible beat, not a stall', () => {
    expect(NAVIGATE_HOLD_MS).toBeGreaterThanOrEqual(100)
    expect(NAVIGATE_HOLD_MS).toBeLessThanOrEqual(500)
  })
})

describe('LoadStage discriminated-union shape', () => {
  // Compile-time shape checks: each variant must carry the fields documented
  // in index.tsx so the reducer can transition between them.
  const blankFile = new File([new Uint8Array(0)], 'x.rpf', {
    type: 'application/octet-stream',
  })

  test('idle has no extra fields', () => {
    const s: LoadStage = { kind: 'idle' }
    expect(s.kind).toBe('idle')
  })
  test('parsing carries a file', () => {
    const s: LoadStage = { kind: 'parsing', file: blankFile }
    expect(s.kind).toBe('parsing')
    expect(s.file.name).toBe('x.rpf')
  })
  test('needs-key carries file and intent', () => {
    const s: LoadStage = { kind: 'needs-key', file: blankFile, intent: 'rpf' }
    expect(s.intent).toBe('rpf')
  })
  test('rpf-opening carries file', () => {
    const s: LoadStage = { kind: 'rpf-opening', file: blankFile }
    expect(s.kind).toBe('rpf-opening')
  })
  test('navigating carries file and display name', () => {
    const s: LoadStage = {
      kind: 'navigating',
      file: blankFile,
      displayName: 'a.awc',
    }
    expect(s.displayName).toBe('a.awc')
  })
  test('error carries an optional file + message', () => {
    const s: LoadStage = {
      kind: 'error',
      file: null,
      message: 'expected .awc or .rpf, got foo.txt',
    }
    expect(s.message).toMatch(/expected/)
  })
})
