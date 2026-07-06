/**
 * IndexedDB persistence for the derived keys bundle. Stores a single record
 * (`pc-derived-keys`). Once the user supplies their gta5_enhanced.exe and
 * we derive the keys, we persist them so the user never has to do that step
 * again.
 *
 * Schema: a single object store keyed by `id`. Two record shapes coexist:
 *   - `id: 'pc-awc-key'`   → legacy { key: Uint32Array, derivedAt: number }
 *   - `id: 'pc-derived-keys'` → { keys: DerivedKeys, derivedAt: number }
 *
 * Legacy `pc-awc-key` records are cleared via {@link clearPersistedAwcKey}
 * so a re-derive starts clean. The new RPF flow requires the full bundle and
 * ignores any legacy records (the user re-drops the exe once).
 */

import type { DerivedKeys } from './derive'

const DB_NAME = 'awc-stem-mixer-keys'
const DB_VERSION = 1
const STORE = 'keys'
const LEGACY_KEY_ID = 'pc-awc-key'
const DERIVED_KEYS_ID = 'pc-derived-keys'

interface DerivedKeysRecord {
  id: string
  keys: DerivedKeys
  derivedAt: number
}

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB is not available'))
  }
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = (): void => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' })
      }
    }
    req.onsuccess = (): void => resolve(req.result)
    req.onerror = (): void => reject(req.error ?? new Error('IDB open failed'))
  })
  return dbPromise
}

/**
 * Persist the full DerivedKeys bundle. The structured-clone algorithm copies
 * the Uint8Array / Uint32Array fields by reference-into-clone, which is safe.
 */
export async function persistDerivedKeys(keys: DerivedKeys): Promise<void> {
  if (keys.awcKey.length !== 4) {
    throw new Error(
      `PC_AWC_KEY must have 4 u32 elements (got ${keys.awcKey.length})`,
    )
  }
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    // Persist a deep-copy-friendly record. Cloning each typed array up front
    // protects against later mutation of the inputs.
    const rec: DerivedKeysRecord = {
      id: DERIVED_KEYS_ID,
      keys: {
        awcKey: new Uint32Array(keys.awcKey),
        ngKeys: new Uint8Array(keys.ngKeys),
        ngTables: new Uint8Array(keys.ngTables),
        lut: new Uint8Array(keys.lut),
      },
      derivedAt: Date.now(),
    }
    tx.objectStore(STORE).put(rec)
    tx.oncomplete = (): void => resolve()
    tx.onerror = (): void => reject(tx.error ?? new Error('IDB put failed'))
  })
}

export async function loadPersistedDerivedKeys(): Promise<DerivedKeys | null> {
  const db = await openDb()
  return new Promise<DerivedKeys | null>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).get(DERIVED_KEYS_ID)
    req.onsuccess = (): void => {
      const rec = req.result as DerivedKeysRecord | undefined
      if (!rec) {
        resolve(null)
        return
      }
      // Defensive size checks, guards against IDB corruption.
      const k = rec.keys as Partial<DerivedKeys> | undefined
      if (!k) {
        resolve(null)
        return
      }
      if (
        k.awcKey instanceof Uint32Array &&
        k.awcKey.length === 4 &&
        k.ngKeys instanceof Uint8Array &&
        k.ngKeys.length === 27472 &&
        k.ngTables instanceof Uint8Array &&
        k.ngTables.length === 278528 &&
        k.lut instanceof Uint8Array &&
        k.lut.length === 256
      ) {
        resolve({
          awcKey: new Uint32Array(k.awcKey),
          ngKeys: new Uint8Array(k.ngKeys),
          ngTables: new Uint8Array(k.ngTables),
          lut: new Uint8Array(k.lut),
        })
      } else {
        resolve(null)
      }
    }
    req.onerror = (): void => reject(req.error ?? new Error('IDB get failed'))
  })
}

export async function clearPersistedDerivedKeys(): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).delete(DERIVED_KEYS_ID)
    // Also clear the legacy key record so a re-derive starts clean.
    tx.objectStore(STORE).delete(LEGACY_KEY_ID)
    tx.oncomplete = (): void => resolve()
    tx.onerror = (): void => reject(tx.error ?? new Error('IDB delete failed'))
  })
}

// Legacy AWC-key-only persistence. Kept around for any tests / dev tools that
// still rely on it. Production code now goes through the DerivedKeys path.

export async function clearPersistedAwcKey(): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).delete(LEGACY_KEY_ID)
    tx.oncomplete = (): void => resolve()
    tx.onerror = (): void => reject(tx.error ?? new Error('IDB delete failed'))
  })
}
