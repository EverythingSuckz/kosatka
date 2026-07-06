/**
 * Global settings-modal open state. The modal is mounted ONCE at the app root
 * (reachable from every screen) and driven by this module-level store rather
 * than route-local state, so any component can open it via openSettings(tab?).
 */

import { useSyncExternalStore } from 'react'

export type SettingsTab =
  | 'appearance'
  | 'audio'
  | 'data'
  | 'shortcuts'
  | 'about'

interface SettingsUiState {
  open: boolean
  tab: SettingsTab
}

let state: SettingsUiState = { open: false, tab: 'appearance' }
const listeners = new Set<() => void>()

function emit(): void {
  for (const fn of listeners) fn()
}

export function openSettings(tab: SettingsTab = 'appearance'): void {
  state = { open: true, tab }
  emit()
}

export function closeSettings(): void {
  if (!state.open) return
  state = { ...state, open: false }
  emit()
}

export function setSettingsTab(tab: SettingsTab): void {
  state = { ...state, tab }
  emit()
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

function getSnapshot(): SettingsUiState {
  return state
}

export function useSettingsUi(): SettingsUiState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
