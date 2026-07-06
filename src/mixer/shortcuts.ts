/**
 * Keyboard-shortcut reference data. Shared by the settings modal's Shortcuts
 * tab (the canonical viewer), kept as plain data so it has no React/DOM
 * dependency and can be rendered anywhere.
 *
 * The actual key HANDLING lives in the mix route, this is documentation only.
 */

export interface Shortcut {
  keys: string
  description: string
}

export const SHORTCUTS: ReadonlyArray<Shortcut> = [
  { keys: 'Space', description: 'play / pause' },
  { keys: 'Esc', description: 'clear selection / exit preview / stop' },
  { keys: '↑ / ↓', description: 'focus prev / next pair' },
  { keys: '[ / ]', description: 'select prev / next keyframe in focused pair' },
  { keys: 'M or X', description: 'toggle focused pair on / off' },
  { keys: 'G', description: 'toggle global mute (panic / restore)' },
  { keys: 'Ctrl+Z', description: 'undo' },
  { keys: 'Ctrl+Shift+Z / Ctrl+Y', description: 'redo' },
  { keys: 'Del / Backspace', description: 'delete selected keyframe(s)' },
  { keys: '?', description: 'open shortcuts' },
  { keys: 'Right-click row', description: 'drop a keyframe at the click time' },
  {
    keys: 'Click keyframe',
    description: 'select keyframe (inspector: time / gain / easing)',
  },
  {
    keys: 'Ctrl+click kf',
    description: 'toggle keyframe in / out of multi-selection',
  },
  {
    keys: 'Shift+click kf',
    description: 'range-select keyframes within the same pair',
  },
  {
    keys: 'Drag keyframe',
    description: 'move keyframe in time (snaps to 0.01s)',
  },
  {
    keys: 'Right-click kf',
    description: 'context menu (delete / duplicate / fade / easing)',
  },
  {
    keys: 'Double-click pair',
    description: 'preview that pair (others go silent)',
  },
  { keys: 'Ctrl+wheel', description: 'zoom timeline (zoom toward cursor)' },
  {
    keys: 'Chevron',
    description: 'expand pair row to show L / R waveforms stacked',
  },
]
