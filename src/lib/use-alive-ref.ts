/**
 * `useAliveRef`, a mount-liveness flag for guarding async work that must not
 * commit side effects after its component has unmounted.
 *
 * The drop / entry-load pipelines await multi-second work (openRpf, parse +
 * extract) and then persist a session + navigate. If the user leaves
 * mid-pipeline, those trailing side effects must be skipped. A React ref
 * flipped in an effect cleanup is the standard tool, but there is a footgun
 * this hook exists to eliminate:
 *
 *   A cleanup-only effect (`useEffect(() => () => { ref.current = false }, [])`)
 *   relies on `useRef(true)` for the truthy value. That initial value is
 *   applied ONCE. The ref object survives effect RE-RUNS (React dev-mode
 *   double-invocation, Fast Refresh, any remount), so once the cleanup has
 *   fired the flag is stuck `false` forever, silently bailing the pipeline
 *   on every hot reload. (This shipped once and hung the whole drop flow in
 *   dev, see the regression test.)
 *
 * The fix is to set `true` in the effect SETUP, so every (re)mount restores
 * liveness. Returns a stable accessor so it can sit in dependency arrays.
 */

import { useCallback, useEffect, useRef } from 'react'

export function useAliveRef(): () => boolean {
  const ref = useRef(true)
  useEffect(() => {
    ref.current = true
    return () => {
      ref.current = false
    }
  }, [])
  return useCallback(() => ref.current, [])
}
