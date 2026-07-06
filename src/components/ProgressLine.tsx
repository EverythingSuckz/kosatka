/**
 * The one progress line used everywhere a load is in flight: drop-zone
 * parse/extract, mix-route decode, RPF entry-load and archive-open. Keeping a
 * single component means the four surfaces can't drift apart in bar height,
 * track colour, or label layout (they used to be hand-copied and slowly
 * diverged).
 *
 * Two bar modes:
 *   - determinate: a filled bar driven by `pct` (0-100)
 *   - indeterminate: a sliding block, for work with no measurable progress
 *
 * `error` recolours label, readout and bar to danger, used when a decode
 * bottoms out with nothing to show.
 */

export function ProgressLine({
  label,
  readout,
  pct = 0,
  indeterminate = false,
  error = false,
}: {
  label: string
  /** Right-aligned readout: a filename, a percentage, a status. */
  readout?: React.ReactNode
  pct?: number
  indeterminate?: boolean
  error?: boolean
}): React.ReactNode {
  const bar = error ? 'var(--color-danger)' : 'var(--color-accent)'
  const clamped = Math.max(0, Math.min(100, pct))
  return (
    <div className="mx-auto w-full max-w-[560px]">
      <div className="flex items-baseline justify-between gap-3">
        <p
          className={`text-[11px] uppercase tracking-[0.16em] ${
            error ? 'text-[var(--color-danger)]' : 'text-[var(--color-fg-dim)]'
          }`}
        >
          {label}
        </p>
        {readout !== undefined && (
          <span
            className={`truncate pl-3 text-[10px] tabular-nums uppercase tracking-[0.12em] ${
              error
                ? 'text-[var(--color-danger)]'
                : 'text-[var(--color-fg-mute)]'
            }`}
          >
            {readout}
          </span>
        )}
      </div>
      <div className="mt-2 h-0.5 w-full overflow-hidden bg-[var(--color-bg-2)]">
        {indeterminate ? (
          <div
            className="loading-indeterminate h-full w-1/3"
            style={{ background: bar }}
          />
        ) : (
          <div
            className="h-full transition-[width] duration-200"
            style={{ width: `${clamped}%`, background: bar }}
          />
        )}
      </div>
    </div>
  )
}
