/**
 * Pure types + classification helpers backing the drop-zone state machine in
 * `./index.tsx`. Kept React-free so unit tests don't need a DOM.
 *
 * See `./index.tsx` for the producer (a stateful React component) and the
 * exhaustive state-transition diagram. The RPF *explorer* states used to live
 * here too. they moved to the `/rpf/$rpfId` route (`./rpf/$rpfId.tsx`) when
 * the explorer became a real navigation destination. the drop zone now only
 * carries an archive as far as `rpf-opening`, then hands off via navigation.
 */

export type DropKind = 'awc' | 'rpf'

export type LoadStage =
  | { kind: 'idle' }
  | { kind: 'parsing'; file: File }
  | { kind: 'needs-key'; file: File; intent: DropKind }
  | { kind: 'extracting'; file: File }
  | { kind: 'rpf-opening'; file: File }
  /**
   * Brief "loading complete" beat shown after extract + attachParsed
   * succeed, before handing off to the mix route. The bar holds at 100% and
   * the box fades so the swap doesn't feel sudden.
   */
  | { kind: 'navigating'; file: File; displayName: string }
  | { kind: 'error'; file: File | null; message: string }

/**
 * Length (ms) of the "loading complete, navigating now" beat shown before a
 * route swap. Short enough that the user doesn't perceive a stall, long
 * enough that the eye can register the 100% progress bar. Shared by the
 * drop zone and the `/rpf/$rpfId` entry-pick pipeline so both hand-offs
 * feel identical.
 */
export const NAVIGATE_HOLD_MS = 220

/**
 * Classify a dropped file by extension (case-insensitive). Returns `null`
 * for unknown extensions, which the drop zone surfaces as an error stage.
 */
export function classifyFile(name: string): DropKind | null {
  const lower = name.toLowerCase()
  if (lower.endsWith('.awc')) return 'awc'
  if (lower.endsWith('.rpf')) return 'rpf'
  return null
}
