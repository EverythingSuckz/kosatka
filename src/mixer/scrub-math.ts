/**
 * Pure helpers for the scrub-input drag math. Extracted from
 * ./scrub-input.tsx so they can be unit-tested without a DOM.
 *
 * The drag formula is:
 *   nextValue = clamp(startValue + accumPx * sensitivity * modifier)
 *
 * where `modifier` is:
 *   - 1   default
 *   - 10  shift held (coarser steps)
 *   - 0.1 alt held   (finer steps)
 *   - 1   shift+alt (they cancel, both pressed is treated as the default,
 *         since the user clearly wants to over-specify and we pick the
 *         neutral interpretation)
 *
 * `parseDraft` mirrors the input's commit behavior: empty / NaN / Infinity
 * is treated as "no change requested" and returned as null.
 */

export interface DragModifiers {
  shift?: boolean
  alt?: boolean
}

export function modifierFor(mods: DragModifiers): number {
  const s = mods.shift === true
  const a = mods.alt === true
  if (s && a) return 1
  if (s) return 10
  if (a) return 0.1
  return 1
}

export function clampValue(
  v: number,
  min: number | undefined,
  max: number | undefined,
): number {
  let out = v
  if (min !== undefined && out < min) out = min
  if (max !== undefined && out > max) out = max
  return out
}

export function dragDeltaToValue(
  startValue: number,
  accumPx: number,
  sensitivity: number,
  mods: DragModifiers,
  min?: number,
  max?: number,
): number {
  const delta = accumPx * sensitivity * modifierFor(mods)
  return clampValue(startValue + delta, min, max)
}

export function parseDraft(input: string): number | null {
  const trimmed = input.trim()
  if (trimmed.length === 0) return null
  const v = parseFloat(trimmed)
  if (!Number.isFinite(v)) return null
  return v
}

export function formatValue(value: number, precision: number): string {
  if (!Number.isFinite(value)) return '0'
  return value.toFixed(precision)
}
