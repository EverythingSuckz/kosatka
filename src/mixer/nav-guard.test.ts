import { describe, expect, test } from 'bun:test'

import { isMixDirty } from './nav-guard'
import type { MixDirtyArgs } from './nav-guard'

describe('isMixDirty', () => {
  // full 8-row truth table: dirty iff ANY input is true (plain OR).
  // rows: [canUndo, hasAutomation, isPlaying, expected]
  const rows: ReadonlyArray<readonly [boolean, boolean, boolean, boolean]> = [
    [false, false, false, false],
    [false, false, true, true],
    [false, true, false, true],
    [false, true, true, true],
    [true, false, false, true],
    [true, false, true, true],
    [true, true, false, true],
    [true, true, true, true],
  ]

  for (const [canUndo, hasAutomation, isPlaying, expected] of rows) {
    const label =
      `canUndo=${canUndo} hasAutomation=${hasAutomation} ` +
      `isPlaying=${isPlaying} -> ${expected ? 'dirty' : 'clean'}`
    test(label, () => {
      const args: MixDirtyArgs = { canUndo, hasAutomation, isPlaying }
      expect(isMixDirty(args)).toBe(expected)
    })
  }

  test('fresh untouched session exits silently (the rpf audition loop)', () => {
    expect(
      isMixDirty({ canUndo: false, hasAutomation: false, isPlaying: false }),
    ).toBe(false)
  })
})
