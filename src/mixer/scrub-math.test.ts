import { describe, expect, test } from 'bun:test'

import {
  clampValue,
  dragDeltaToValue,
  formatValue,
  modifierFor,
  parseDraft,
} from './scrub-math'

describe('modifierFor', () => {
  test('default is 1×', () => {
    expect(modifierFor({})).toBe(1)
  })
  test('shift is 10×', () => {
    expect(modifierFor({ shift: true })).toBe(10)
  })
  test('alt is 0.1×', () => {
    expect(modifierFor({ alt: true })).toBe(0.1)
  })
  test('shift+alt cancels to 1×', () => {
    expect(modifierFor({ shift: true, alt: true })).toBe(1)
  })
})

describe('clampValue', () => {
  test('no bounds → passthrough', () => {
    expect(clampValue(42, undefined, undefined)).toBe(42)
  })
  test('clamps to min', () => {
    expect(clampValue(-5, 0, undefined)).toBe(0)
  })
  test('clamps to max', () => {
    expect(clampValue(100, undefined, 50)).toBe(50)
  })
  test('clamps to both', () => {
    expect(clampValue(-5, 0, 10)).toBe(0)
    expect(clampValue(15, 0, 10)).toBe(10)
    expect(clampValue(5, 0, 10)).toBe(5)
  })
})

describe('dragDeltaToValue', () => {
  test('100 px × 0.01 sens = +1 from start', () => {
    expect(dragDeltaToValue(0.5, 100, 0.01, {})).toBeCloseTo(1.5)
  })
  test('negative delta moves down', () => {
    expect(dragDeltaToValue(0.5, -50, 0.01, {})).toBeCloseTo(0.0)
  })
  test('shift multiplies by 10', () => {
    expect(dragDeltaToValue(0, 10, 0.01, { shift: true })).toBeCloseTo(1.0)
  })
  test('alt divides by 10', () => {
    expect(dragDeltaToValue(0, 100, 0.01, { alt: true })).toBeCloseTo(0.1)
  })
  test('respects min', () => {
    expect(dragDeltaToValue(0.5, -1000, 0.01, {}, 0, 1)).toBe(0)
  })
  test('respects max', () => {
    expect(dragDeltaToValue(0.5, 1000, 0.01, {}, 0, 1)).toBe(1)
  })
})

describe('parseDraft', () => {
  test('parses a normal number', () => {
    expect(parseDraft('1.25')).toBe(1.25)
  })
  test('parses negative', () => {
    expect(parseDraft('-3.5')).toBe(-3.5)
  })
  test('empty input → null', () => {
    expect(parseDraft('')).toBeNull()
    expect(parseDraft('   ')).toBeNull()
  })
  test('non-numeric → null', () => {
    expect(parseDraft('hello')).toBeNull()
  })
  test('NaN → null', () => {
    expect(parseDraft('NaN')).toBeNull()
  })
  test('Infinity → null', () => {
    expect(parseDraft('Infinity')).toBeNull()
  })
})

describe('formatValue', () => {
  test('formats to precision', () => {
    expect(formatValue(1.23456, 2)).toBe('1.23')
  })
  test('zero precision', () => {
    expect(formatValue(1.7, 0)).toBe('2')
  })
  test('NaN → "0"', () => {
    expect(formatValue(NaN, 2)).toBe('0')
  })
})
