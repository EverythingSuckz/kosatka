/**
 * Inspector panel. The right-side properties pane.
 *
 * Renders one of three states driven by the current Selection:
 *
 *   - none     : keyboard-shortcut quick reference
 *   - pair     : the selected pair's on/off, gain, spread, hashes, keyframe summary
 *   - keyframe : the selected keyframe's time / gain / easing / delete
 *
 * The component is pure presentation. The view-model (what to render, given
 * selection + snapshot) is split into `buildInspectorVM` so it can be
 * unit-tested without React.
 */

import { ArrowLeft, Eraser } from '@phosphor-icons/react'

import { PairMeter } from './meter'
import { ScrubInput } from './scrub-input'
import { GAIN_MAX } from './types'
import type { MixerEngine } from './engine'
import type { Selection } from './selection'
import type { Keyframe } from './types'

/** Minimal pair info the inspector needs. Mirrors the route's PairVM subset. */
export interface InspectorPairInfo {
  pairIndex: number
  /** Current effective gain (per-pair, applied to both L and R). */
  gain: number
  /** Pan spread 0..1 (0 = mono, 1 = hard L / hard R). */
  spread: number
  /** True iff the pair is currently audible (not muted). */
  enabled: boolean
  /** True iff neither L nor R decoded. controls are disabled. */
  unavailable: boolean
  leftHashHex: string | null
  rightHashHex: string | null
  leftTrackId: string | null
  rightTrackId: string | null
  leftLabel: string | null
  rightLabel: string | null
  /** Keyframes on this pair (sorted ascending by time). */
  keyframes: ReadonlyArray<Keyframe>
  /** Total song duration in seconds. Used by the keyframe time slider. */
  durationSeconds: number
}

export type InspectorVM =
  | { kind: 'none' }
  | { kind: 'pair'; pair: InspectorPairInfo }
  | {
      kind: 'keyframe'
      pair: InspectorPairInfo
      keyframe: Keyframe
      keyframeIndex: number
    }
  | {
      kind: 'keyframes-multi'
      /** Total number of selected keyframes across all pairs. */
      count: number
      /** Pairs represented in the selection (for display). */
      pairIndices: ReadonlyArray<number>
    }

export function buildInspectorVM(
  selection: Selection,
  lookupPair: (pairIndex: number) => InspectorPairInfo | null,
): InspectorVM {
  if (selection.kind === 'none') return { kind: 'none' }
  if (selection.kind === 'pair') {
    const info = lookupPair(selection.pairIndex)
    if (!info) return { kind: 'none' }
    return { kind: 'pair', pair: info }
  }
  // keyframes. could be one or many.
  const items = selection.items
  if (items.length === 0) return { kind: 'none' }
  if (items.length === 1) {
    const only = items[0]!
    const info = lookupPair(only.pairIndex)
    if (!info) return { kind: 'none' }
    const kf = info.keyframes[only.keyframeIndex]
    if (!kf) {
      return { kind: 'pair', pair: info }
    }
    return {
      kind: 'keyframe',
      pair: info,
      keyframe: kf,
      keyframeIndex: only.keyframeIndex,
    }
  }
  const seen = new Set<number>()
  for (const r of items) seen.add(r.pairIndex)
  return {
    kind: 'keyframes-multi',
    count: items.length,
    pairIndices: Array.from(seen).sort((a, b) => a - b),
  }
}

function fmtTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0
  const min = Math.floor(s / 60)
  const sec = s % 60
  return `${min}:${sec.toFixed(2).padStart(5, '0')}`
}

export function gainToDb(g: number): string {
  if (g <= 0.0001) return '-∞'
  const db = 20 * Math.log10(g)
  if (db >= 0) return `+${db.toFixed(1)}`
  return db.toFixed(1)
}

/**
 * Format an absolute gain value (0..1.5) as a percentage. Retained for
 * tests and any legacy display sites. Most call sites now use `gainToDb`
 * since keyframe gain is the actual playback amplitude.
 */
export function gainToPercent(g: number): string {
  return `${Math.round(g * 100)}%`
}

/**
 * Whether the LINEAR easing option should be disabled in the inspector for
 * a given keyframe. Keyframes are stored sorted ascending by time, so the
 * earliest keyframe is always index 0 and a `linear` ramp into it has
 * nothing to ramp from. The engine treats it as a setValueAtTime in that
 * case, so the radio choice is meaningless. Disabling it prevents user
 * confusion.
 */
export function isLinearEasingDisabled(keyframeIndex: number): boolean {
  return keyframeIndex === 0
}

/**
 * Compute the inline styles for an easing radio button. We use inline
 * styles instead of Tailwind utility classes because the global
 * `button:disabled` selector in `styles.css` was beating the utility
 * border/colour rules via specificity, leaving the "selected" linear
 * button visually identical to the unselected hold button for the first
 * keyframe in a pair. Inline styles always win the cascade, which
 * sidesteps the issue without touching the global stylesheet.
 *
 * Exported so the inspector test can assert the active styling without
 * needing a full DOM render.
 */
export function easingButtonStyle(
  selected: boolean,
  disabled: boolean,
): React.CSSProperties {
  if (selected) {
    return {
      background: 'var(--color-active)',
      color: 'var(--color-bg)',
      borderColor: 'var(--color-active)',
      opacity: disabled ? 0.45 : 1,
      cursor: disabled ? 'not-allowed' : 'pointer',
    }
  }
  return {
    background: 'transparent',
    color: 'var(--color-fg-dim)',
    borderColor: 'var(--color-line-strong)',
    opacity: disabled ? 0.45 : 1,
    cursor: disabled ? 'not-allowed' : 'pointer',
  }
}

interface InspectorProps {
  vm: InspectorVM
  engine: MixerEngine
  isPlaying: boolean
  /** When true: pair / keyframe controls visually dim and refuse interaction.
   *  The header MUTE-ALL toggle in the route still works (it lives in a
   *  different component). this just locks the inspector's per-pair edits. */
  globallyMuted: boolean
  onTogglePairEnabled: (pairIndex: number) => void
  onPairGain: (pairIndex: number, gain: number) => void
  onPairSpread: (pairIndex: number, spread: number) => void
  onClearAutomation: (pairIndex: number) => void
  onKeyframeEdit: (
    pairIndex: number,
    keyframeIndex: number,
    partial: Partial<Keyframe>,
  ) => void
  onKeyframeDelete: (pairIndex: number, keyframeIndex: number) => void
  onSelectKeyframe: (pairIndex: number, keyframeIndex: number) => void
  /** Navigate from a selected keyframe back to its parent pair view. */
  onBackToPair: (pairIndex: number) => void
  /** Multi-keyframe bulk delete: route deletes every selected kf in one batch. */
  onDeleteSelectedKeyframes: () => void
}

export function Inspector({
  vm,
  engine,
  isPlaying,
  globallyMuted,
  onTogglePairEnabled,
  onPairGain,
  onPairSpread,
  onClearAutomation,
  onKeyframeEdit,
  onKeyframeDelete,
  onSelectKeyframe,
  onBackToPair,
  onDeleteSelectedKeyframes,
}: InspectorProps): React.ReactNode {
  return (
    <aside
      aria-label="inspector"
      className="w-[280px] shrink-0 border-l border-[var(--color-line-strong)] bg-[var(--color-bg-1)] overflow-y-auto"
    >
      {vm.kind === 'none' && <InspectorEmpty />}
      {vm.kind === 'pair' && (
        <InspectorPair
          pair={vm.pair}
          engine={engine}
          isPlaying={isPlaying}
          locked={globallyMuted}
          onToggle={() => onTogglePairEnabled(vm.pair.pairIndex)}
          onGain={(g) => onPairGain(vm.pair.pairIndex, g)}
          onSpread={(s) => onPairSpread(vm.pair.pairIndex, s)}
          onClearAutomation={() => onClearAutomation(vm.pair.pairIndex)}
          onSelectKeyframe={(i) => onSelectKeyframe(vm.pair.pairIndex, i)}
        />
      )}
      {vm.kind === 'keyframe' && (
        <InspectorKeyframe
          pair={vm.pair}
          keyframe={vm.keyframe}
          keyframeIndex={vm.keyframeIndex}
          locked={globallyMuted}
          onEdit={(p) => onKeyframeEdit(vm.pair.pairIndex, vm.keyframeIndex, p)}
          onDelete={() => onKeyframeDelete(vm.pair.pairIndex, vm.keyframeIndex)}
          onBack={() => onBackToPair(vm.pair.pairIndex)}
        />
      )}
      {vm.kind === 'keyframes-multi' && (
        <InspectorKeyframesMulti
          count={vm.count}
          pairIndices={vm.pairIndices}
          locked={globallyMuted}
          onDeleteAll={onDeleteSelectedKeyframes}
        />
      )}
    </aside>
  )
}

function InspectorSectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] uppercase tracking-[0.16em] text-[var(--color-fg-mute)] mb-1.5">
      {children}
    </div>
  )
}

function InspectorEmpty(): React.ReactNode {
  const rows: ReadonlyArray<readonly [string, string]> = [
    ['space', 'play / pause'],
    ['esc', 'clear selection / exit preview'],
    ['↑ / ↓', 'select prev / next pair'],
    ['[ / ]', 'prev / next keyframe'],
    ['m', 'toggle pair on / off'],
    ['g', 'global mute'],
    ['ctrl+z', 'undo, ctrl+shift+z redo'],
    ['del', 'remove selected keyframes'],
    ['?', 'shortcuts overlay'],
    ['rclick row', 'place keyframe'],
    ['drag kf', 'move keyframe in time'],
    ['rclick kf', 'context menu'],
    ['ctrl+click', 'toggle kf in multi-select'],
    ['shift+click', 'range-select keyframes'],
    ['dblclick', 'preview a pair'],
    ['ctrl+wheel', 'zoom timeline'],
  ]
  return (
    <div className="p-3">
      <div className="text-xs uppercase tracking-[0.14em] text-[var(--color-fg)]">
        nothing selected
      </div>
      <p className="mt-1.5 text-[10px] text-[var(--color-fg-dim)] leading-snug">
        click a pair to inspect. right-click on a row to drop a keyframe.
      </p>
      <div className="mt-3">
        <InspectorSectionTitle>shortcuts</InspectorSectionTitle>
        <table className="w-full text-[10px]">
          <tbody>
            {rows.map(([k, v]) => (
              <tr key={k} className="border-t border-[var(--color-line)]">
                <td className="py-1 pr-2 text-[var(--color-fg-dim)] uppercase tracking-[0.08em] w-[6.5rem]">
                  {k}
                </td>
                <td className="py-1 text-[var(--color-fg)]">{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function InspectorPair({
  pair,
  engine,
  isPlaying,
  locked,
  onToggle,
  onGain,
  onSpread,
  onClearAutomation,
  onSelectKeyframe,
}: {
  pair: InspectorPairInfo
  engine: MixerEngine
  isPlaying: boolean
  /** True when global mute is engaged. controls dim and refuse input. */
  locked: boolean
  onToggle: () => void
  onGain: (g: number) => void
  onSpread: (s: number) => void
  onClearAutomation: () => void
  onSelectKeyframe: (kfIdx: number) => void
}): React.ReactNode {
  const kfCount = pair.keyframes.length
  const inputDisabled = pair.unavailable || locked
  // slider is the outside-the-keyframe-range control. inside the range,
  // keyframes win. outside, the slider wins. the slider is therefore never
  // locked when keyframes exist. a footnote explains the piecewise behaviour.
  const hasKeyframes = kfCount > 0
  return (
    <div
      className={`p-3 ${locked ? 'opacity-40 pointer-events-none' : ''}`}
      aria-disabled={locked}
    >
      <div className="flex items-center justify-between">
        <div className="text-xs uppercase tracking-[0.16em] text-[var(--color-fg)]">
          pair {String(pair.pairIndex).padStart(2, '0')}
        </div>
        <button
          type="button"
          onClick={onToggle}
          disabled={inputDisabled}
          aria-pressed={pair.enabled}
          className={
            pair.enabled
              ? '!border-[var(--color-active)] !bg-[var(--color-active)] !text-[var(--color-bg)] !px-2 !py-0.5 text-[10px]'
              : 'border-[var(--color-line-strong)] text-[var(--color-fg-dim)] !px-2 !py-0.5 text-[10px]'
          }
        >
          {pair.enabled ? 'on' : 'off'}
        </button>
      </div>

      <div className="mt-4">
        <InspectorSectionTitle>level</InspectorSectionTitle>
        <PairMeter
          engine={engine}
          leftId={pair.leftTrackId}
          rightId={pair.rightTrackId}
          active={isPlaying && pair.enabled}
        />
        <div className="mt-2 flex items-center gap-2">
          <input
            type="range"
            min={0}
            max={GAIN_MAX * 100}
            step={1}
            value={Math.round(pair.gain * 100)}
            onChange={(e) => onGain(parseFloat(e.target.value) / 100)}
            disabled={inputDisabled}
            className="flex-1 min-w-0"
            aria-label={`pair ${pair.pairIndex} gain`}
          />
          <span className="w-12 text-right text-[10px] tabular-nums text-[var(--color-fg-dim)]">
            {gainToDb(pair.gain)} db
          </span>
        </div>
        {hasKeyframes && (
          <p className="mt-1 text-[9px] uppercase tracking-[0.08em] text-[var(--color-fg-mute)] leading-snug">
            outside the keyframe range, gain follows this slider; inside the
            range, keyframes take over
          </p>
        )}
      </div>

      <div className="mt-4">
        <div className="text-[10px] uppercase tracking-[0.16em] text-[var(--color-fg-mute)] mb-1.5">
          <span
            title="controls how wide the L/R split is. 100% = hard left / hard right (default stereo). 0% = both channels collapsed to mono center."
            className="cursor-help underline decoration-dotted decoration-[var(--color-fg-mute)] underline-offset-2"
          >
            stereo spread
          </span>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={Math.round(pair.spread * 100)}
            onChange={(e) => onSpread(parseFloat(e.target.value) / 100)}
            disabled={inputDisabled}
            className="flex-1 min-w-0"
            aria-label={`pair ${pair.pairIndex} spread`}
          />
          <span className="w-12 text-right text-[10px] tabular-nums text-[var(--color-fg-dim)]">
            {Math.round(pair.spread * 100)}%
          </span>
        </div>
      </div>

      <div className="mt-4 border-t border-[var(--color-line)] pt-3">
        <InspectorSectionTitle>stems</InspectorSectionTitle>
        <dl className="text-[10px] space-y-1">
          <StemRow
            channel="L"
            label={pair.leftLabel}
            hashHex={pair.leftHashHex}
          />
          <StemRow
            channel="R"
            label={pair.rightLabel}
            hashHex={pair.rightHashHex}
          />
        </dl>
      </div>

      <div className="mt-4 border-t border-[var(--color-line)] pt-3">
        <div className="flex items-center justify-between mb-1.5">
          <div className="text-[10px] uppercase tracking-[0.16em] text-[var(--color-fg-mute)]">
            keyframes
          </div>
          {kfCount > 0 && (
            <button
              type="button"
              onClick={onClearAutomation}
              className="!border-0 !bg-transparent !px-0.5 !py-0 inline-flex items-center text-[var(--color-fg-mute)] hover:text-[var(--color-danger)] transition-colors"
              title="clear all keyframes"
              aria-label="clear all keyframes"
            >
              <Eraser size={11} />
            </button>
          )}
        </div>
        {kfCount === 0 ? (
          <p className="text-[10px] text-[var(--color-fg-mute)] leading-snug">
            no keyframes. right-click on this pair's timeline row to drop a
            keyframe.
          </p>
        ) : (
          <ul className="space-y-px">
            {pair.keyframes.map((k, i) => (
              <li key={`${k.time}-${i}`}>
                <button
                  type="button"
                  onClick={() => onSelectKeyframe(i)}
                  className="!border-0 !bg-transparent !px-1 !py-0.5 w-full text-left text-[10px] hover:bg-[var(--color-bg-2)] tabular-nums grid grid-cols-[1.5rem_1fr_2.5rem_2.75rem] gap-2 items-baseline"
                  title={`select keyframe ${i + 1}`}
                >
                  <span className="text-[var(--color-fg-dim)]">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <span className="text-[var(--color-fg)]">
                    {fmtTime(k.time)}
                  </span>
                  <span className="text-right text-[var(--color-fg)]">
                    {gainToDb(k.gain)} db
                  </span>
                  <span
                    className={`text-left text-[9px] uppercase tracking-[0.06em] ${
                      k.easing === 'hold'
                        ? 'text-[var(--color-fg)]'
                        : 'text-[var(--color-fg-dim)]'
                    }`}
                  >
                    {k.easing}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function StemRow({
  channel,
  label,
  hashHex,
}: {
  channel: 'L' | 'R'
  label: string | null
  hashHex: string | null
}): React.ReactNode {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="inline-flex items-center justify-center w-4 h-4 border border-[var(--color-line-strong)] text-[9px] uppercase tracking-normal text-[var(--color-fg-dim)] select-none shrink-0">
        {channel}
      </dt>
      <dd className="font-mono tabular-nums text-[var(--color-fg)] truncate flex-1 min-w-0">
        {label ? (
          <span className="select-none">{label}</span>
        ) : (
          (hashHex ?? '-')
        )}
      </dd>
      {label && hashHex && (
        <span className="text-[var(--color-fg-mute)] text-[9px] font-mono tabular-nums truncate max-w-[6.5rem]">
          {hashHex}
        </span>
      )}
    </div>
  )
}

function InspectorKeyframe({
  pair,
  keyframe,
  keyframeIndex,
  locked,
  onEdit,
  onDelete,
  onBack,
}: {
  pair: InspectorPairInfo
  keyframe: Keyframe
  keyframeIndex: number
  locked: boolean
  onEdit: (partial: Partial<Keyframe>) => void
  onDelete: () => void
  onBack: () => void
}): React.ReactNode {
  const dur = Math.max(0.01, pair.durationSeconds)
  // First keyframe by time? See `isLinearEasingDisabled` for the rationale.
  const isFirstKeyframe = isLinearEasingDisabled(keyframeIndex)
  return (
    <div
      className={`p-3 ${locked ? 'opacity-40 pointer-events-none' : ''}`}
      aria-disabled={locked}
    >
      <button
        type="button"
        onClick={onBack}
        className="!border-0 !bg-transparent !px-0 !py-0 inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.10em] text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]"
        title="Back to the parent pair's view"
        aria-label={`back to pair ${pair.pairIndex}`}
      >
        <ArrowLeft size={10} />
        <span>back to pair {String(pair.pairIndex).padStart(2, '0')}</span>
      </button>

      <div className="mt-3 flex items-center justify-between">
        <div className="text-xs uppercase tracking-[0.16em] text-[var(--color-fg)]">
          keyframe {String(keyframeIndex + 1).padStart(2, '0')}
        </div>
        <div className="text-[10px] uppercase tracking-[0.10em] text-[var(--color-fg-dim)] select-none">
          pair {String(pair.pairIndex).padStart(2, '0')}
        </div>
      </div>

      <div className="mt-4">
        <InspectorSectionTitle>time</InspectorSectionTitle>
        <div className="flex items-center gap-2">
          <ScrubInput
            value={keyframe.time}
            onChange={(v) => onEdit({ time: v })}
            min={0}
            max={dur}
            precision={2}
            sensitivity={0.01}
            suffix="s"
            label="keyframe time seconds"
            disabled={locked}
          />
          <span className="ml-auto text-[9px] uppercase tracking-[0.08em] text-[var(--color-fg-mute)]">
            drag, shift = 10×, alt = 0.1×
          </span>
        </div>
      </div>

      <div className="mt-4">
        <InspectorSectionTitle>gain</InspectorSectionTitle>
        <div className="flex items-center gap-2">
          <ScrubInput
            value={keyframe.gain}
            onChange={(v) => onEdit({ gain: v })}
            min={0}
            max={GAIN_MAX}
            precision={2}
            sensitivity={0.005}
            label="keyframe gain value"
            disabled={locked}
          />
          <span className="w-14 text-right text-[10px] tabular-nums text-[var(--color-fg-dim)]">
            {gainToDb(keyframe.gain)} db
          </span>
        </div>
        <p className="mt-1 text-[9px] uppercase tracking-[0.08em] text-[var(--color-fg-mute)] leading-snug">
          absolute gain, slider only applies outside the keyframe range
        </p>
      </div>

      <div className="mt-4">
        <InspectorSectionTitle>easing</InspectorSectionTitle>
        <div role="radiogroup" className="flex gap-1">
          {(['linear', 'hold'] as const).map((e) => {
            const isSelected = keyframe.easing === e
            // `linear` is unavailable on the first keyframe (no prior point
            // to ramp from). We keep the button enabled-for-click but render
            // it visually dim and ignore clicks below. using HTML `disabled`
            // would invoke `button:disabled` from styles.css which overrides
            // Tailwind utility colours and made the selected styling
            // unreadable (round-5 user report). See `easingButtonStyle` for
            // the explicit inline-style overrides that win over both the
            // base button rules and any specificity surprises.
            const linearUnavailable = e === 'linear' && isFirstKeyframe
            const interactive = !locked && !linearUnavailable
            const style = easingButtonStyle(isSelected, !interactive)
            return (
              <button
                key={e}
                type="button"
                role="radio"
                aria-checked={isSelected}
                aria-pressed={isSelected}
                data-active={isSelected}
                data-disabled={!interactive}
                onClick={() => {
                  if (!interactive) return
                  onEdit({ easing: e })
                }}
                // Intentionally not passing `disabled` so the button stays
                // focusable. interaction is suppressed via `data-disabled`
                // and the click guard above. see the note above for why.
                style={style}
                className={`!px-2 !py-0.5 text-[10px] flex-1 transition-colors uppercase tracking-[0.08em]`}
                title={
                  linearUnavailable
                    ? 'first keyframe; ease-from-previous N/A'
                    : e === 'linear'
                      ? 'Linear ramp from previous keyframe'
                      : 'Hold previous value until this keyframe (step)'
                }
              >
                {e}
              </button>
            )
          })}
        </div>
        {isFirstKeyframe && (
          <p className="mt-1 text-[9px] uppercase tracking-[0.08em] text-[var(--color-fg-mute)] leading-snug">
            first keyframe, linear N/A (no prior point to ramp from)
          </p>
        )}
      </div>

      <div className="mt-4 pt-3 border-t border-[var(--color-line)]">
        <button
          type="button"
          onClick={onDelete}
          disabled={locked}
          className="border-[var(--color-danger)] text-[var(--color-danger)] hover:bg-[var(--color-danger)] hover:text-[var(--color-bg)] !px-2 !py-0.5 text-[10px] transition-colors"
        >
          delete keyframe
        </button>
      </div>
    </div>
  )
}

/**
 * Bulk view shown when 2+ keyframes are selected. Only one affordance: a
 * batch delete. Editing many at once is intentionally not offered because
 * the heterogeneous shape of keyframe state (time/gain/easing) makes
 * cross-target editing awkward. the user can either delete or shift+click
 * each one individually.
 */
function InspectorKeyframesMulti({
  count,
  pairIndices,
  locked,
  onDeleteAll,
}: {
  count: number
  pairIndices: ReadonlyArray<number>
  locked: boolean
  onDeleteAll: () => void
}): React.ReactNode {
  return (
    <div
      className={`p-3 ${locked ? 'opacity-40 pointer-events-none' : ''}`}
      aria-disabled={locked}
    >
      <div className="text-xs uppercase tracking-[0.16em] text-[var(--color-fg)]">
        {count} keyframes
      </div>
      <p className="mt-1.5 text-[10px] text-[var(--color-fg-dim)] leading-snug">
        across {pairIndices.length} pair{pairIndices.length === 1 ? '' : 's'}:{' '}
        {pairIndices.map((p) => String(p).padStart(2, '0')).join(', ')}
      </p>
      <p className="mt-3 text-[9px] uppercase tracking-[0.08em] text-[var(--color-fg-mute)] leading-snug">
        ctrl+click toggles, shift+click range, del to remove
      </p>
      <div className="mt-4 pt-3 border-t border-[var(--color-line)]">
        <button
          type="button"
          onClick={onDeleteAll}
          disabled={locked}
          className="border-[var(--color-danger)] text-[var(--color-danger)] hover:bg-[var(--color-danger)] hover:text-[var(--color-bg)] !px-2 !py-0.5 text-[10px] transition-colors"
        >
          delete {count} keyframes
        </button>
      </div>
    </div>
  )
}
