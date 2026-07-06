/**
 * Regression test for the mount-liveness footgun (see use-alive-ref.ts).
 *
 * The bug: a cleanup-only effect leaves the flag stuck `false` after any
 * effect re-run (Fast Refresh / dev double-invoke / remount), because the
 * `useRef(true)` initial value is applied only once. That silently bailed
 * the whole drop pipeline in dev. The fix sets `true` in effect setup. These
 * tests pin that behavior by simulating the effect lifecycle.
 */

import '../mixer/jsdom-setup'

import { describe, expect, test } from 'bun:test'
import { act, renderHook } from '@testing-library/react'

import { useAliveRef } from './use-alive-ref'

describe('useAliveRef', () => {
  test('reports alive while mounted', () => {
    const { result } = renderHook(() => useAliveRef())
    expect(result.current()).toBe(true)
  })

  test('reports not-alive after unmount', () => {
    const { result, unmount } = renderHook(() => useAliveRef())
    act(() => unmount())
    expect(result.current()).toBe(false)
  })

  test('restores alive after a remount (the Fast-Refresh footgun)', () => {
    // Simulate an effect re-run: unmount fires the cleanup (flag → false),
    // a fresh mount must restore it. A cleanup-only effect that trusted the
    // useRef initial value would stay false here, the exact dev stall.
    const first = renderHook(() => useAliveRef())
    act(() => first.unmount())
    expect(first.result.current()).toBe(false)

    const second = renderHook(() => useAliveRef())
    expect(second.result.current()).toBe(true)
  })

  test('the accessor identity is stable across re-renders', () => {
    const { result, rerender } = renderHook(() => useAliveRef())
    const a = result.current
    rerender()
    expect(result.current).toBe(a)
  })
})
