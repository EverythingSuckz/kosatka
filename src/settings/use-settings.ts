/** React binding for the settings store. Re-renders on any settings change. */

import { useSyncExternalStore } from 'react'

import { getSettings, subscribeSettings } from './store'
import type { Settings } from './store'

export function useSettings(): Settings {
  return useSyncExternalStore(subscribeSettings, getSettings, getSettings)
}
