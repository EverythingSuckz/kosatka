/**
 * Derived-keys registry. Single entry point for getting either the AWC XXTEA
 * key or the full {@link DerivedKeys} bundle (which also carries the NG
 * tables + LUT required by the RPF7 NG decryption path).
 *
 * Resolution order (Decision: option C′ from docs/scope.md):
 *   1. Module-level cache (already-resolved this session).
 *   2. IndexedDB (production user-derived bundle, persisted once).
 *   3. Dev-only Vite middleware at `/__dev/awc-key.json` (returns the
 *      gitignored `samples/.awc_key.json`). Dev-only and provides only the
 *      AWC key, no NG tables. RPF flows must run the full derivation.
 *   4. null, caller must drive the C′ derivation flow (drop gta5_enhanced.exe).
 *
 * The production derivation lives in {@link ./derive}. Once it produces a
 * bundle, persist it via {@link setDerivedKeys}.
 *
 * Back-compat: {@link getAwcKey} / {@link setAwcKey} continue to work for
 * call-sites that only need the AWC XXTEA key. They delegate to / from the
 * full-bundle cache when possible. Old IDB records that only contain the
 * AWC key are read as `null` for the DerivedKeys path, callers re-derive.
 */

import { loadPersistedDerivedKeys, persistDerivedKeys } from './store'
import type { DerivedKeys } from './derive'

let cachedBundle: DerivedKeys | null = null
let cachedAwcKey: Uint32Array | null = null
let idbLoadAttempted = false

/**
 * Return the full DerivedKeys bundle if available (cache → IDB).
 * Returns `null` when the user hasn't derived yet. Dev-only AWC-key-only
 * sources do NOT satisfy this, they return null so RPF flows fall through
 * to the NeedsKeyPrompt.
 */
export async function getDerivedKeys(): Promise<DerivedKeys | null> {
  if (cachedBundle) return cachedBundle
  if (!idbLoadAttempted) {
    idbLoadAttempted = true
    try {
      const fromIdb = await loadPersistedDerivedKeys()
      if (fromIdb) {
        cachedBundle = fromIdb
        cachedAwcKey = fromIdb.awcKey
        return fromIdb
      }
    } catch (e) {
      console.warn('IDB derived-keys load failed:', e)
    }
  }
  return null
}

/**
 * Populate the cache (memory + IDB) with a freshly-derived bundle.
 */
export async function setDerivedKeys(keys: DerivedKeys): Promise<void> {
  if (keys.awcKey.length !== 4) {
    throw new Error(
      `PC_AWC_KEY must have 4 u32 elements (got ${keys.awcKey.length})`,
    )
  }
  cachedBundle = keys
  cachedAwcKey = new Uint32Array(keys.awcKey)
  idbLoadAttempted = true
  try {
    await persistDerivedKeys(keys)
  } catch (e) {
    console.warn('IDB derived-keys persist failed:', e)
  }
}

/**
 * Back-compat: AWC-key-only fetch.
 *   1. cached bundle's awcKey, or
 *   2. legacy in-memory awcKey, or
 *   3. IDB (full bundle preferred, falls back to legacy key-only record), or
 *   4. dev sample.
 */
export async function getAwcKey(): Promise<Uint32Array | null> {
  if (cachedAwcKey) return cachedAwcKey
  const bundle = await getDerivedKeys()
  if (bundle) return bundle.awcKey
  // Dev: Vite middleware exposes the gitignored sample key.
  if (import.meta.env.DEV) {
    const k = await loadDevKey()
    if (k) {
      cachedAwcKey = k
      return k
    }
  }
  return null
}

/**
 * Back-compat write: persists the AWC key as part of a bundle when possible,
 * otherwise as a stand-alone AWC-key record (legacy callers that don't have
 * the full bundle on hand).
 */
export async function setAwcKey(key: Uint32Array): Promise<void> {
  if (key.length !== 4) {
    throw new Error(`PC_AWC_KEY must have 4 u32 elements (got ${key.length})`)
  }
  cachedAwcKey = new Uint32Array(key)
  // If we already have a bundle, keep them consistent by updating its awcKey.
  // (This is unusual. The typical flow is setDerivedKeys → getAwcKey.)
  if (cachedBundle && cachedBundle.awcKey !== cachedAwcKey) {
    cachedBundle = { ...cachedBundle, awcKey: cachedAwcKey }
    try {
      await persistDerivedKeys(cachedBundle)
    } catch (e) {
      console.warn('IDB derived-keys persist failed:', e)
    }
  }
}

async function loadDevKey(): Promise<Uint32Array | null> {
  try {
    const r = await fetch('/__dev/awc-key.json')
    if (!r.ok) return null
    const json = (await r.json()) as { PC_AWC_KEY?: unknown }
    const arr = json.PC_AWC_KEY
    if (!Array.isArray(arr) || arr.length !== 4) return null
    const out = new Uint32Array(4)
    for (let i = 0; i < 4; i++) {
      const v = arr[i]
      if (typeof v !== 'string') return null
      const n = parseInt(v, 16)
      if (!Number.isFinite(n)) return null
      out[i] = n >>> 0
    }
    return out
  } catch {
    return null
  }
}

/**
 * Test-only escape hatch: reset module-level state so individual tests don't
 * leak cached bundles across the suite. Not exported through any public
 * barrel intentionally, import from `./keys/index` directly in tests.
 */
export function __resetKeyCacheForTests(): void {
  cachedBundle = null
  cachedAwcKey = null
  idbLoadAttempted = false
}
