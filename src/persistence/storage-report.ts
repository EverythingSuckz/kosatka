/**
 * Storage breakdown for the settings "data & keys" panel.
 *
 * navigator.storage.estimate() reports the ORIGIN-wide total, IndexedDB plus
 * Cache Storage, service-worker caches, and the HTTP disk cache the browser
 * attributes to this origin. That total can be far larger than what the app
 * itself stores (e.g. a dev server's cached modules, or a browser's quota
 * padding), which is why "clearing sessions" barely moves it.
 *
 * This report separates the two: exactly what THE APP persists (session blobs
 * plus the derived-key record, both of which we can clear) versus the
 * browser's origin total (which we can't fully control).
 */

export interface StorageReport {
  /** Persisted session count + summed File byte size. */
  sessionCount: number
  sessionBytes: number
  /** Whether a derived-key record is stored (it's ~0.3 MB). */
  hasKeys: boolean
  /** Origin-wide estimate (IDB + caches + http cache), or null if unavailable. */
  originBytes: number | null
}

function openByName(
  name: string,
  version: number,
): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null)
  return new Promise((resolve) => {
    let created = false
    const req = indexedDB.open(name, version)
    req.onupgradeneeded = (): void => {
      created = true // DB didn't exist, don't leave an empty one behind.
    }
    req.onsuccess = (): void => {
      if (created) {
        req.result.close()
        indexedDB.deleteDatabase(name)
        resolve(null)
        return
      }
      resolve(req.result)
    }
    req.onerror = (): void => resolve(null)
  })
}

async function sessionUsage(): Promise<{ count: number; bytes: number }> {
  const db = await openByName('awc-stem-mixer', 1)
  if (!db) return { count: 0, bytes: 0 }
  try {
    if (!db.objectStoreNames.contains('sessions')) return { count: 0, bytes: 0 }
    return await new Promise((resolve) => {
      const tx = db.transaction('sessions', 'readonly')
      const req = tx.objectStore('sessions').getAll()
      req.onsuccess = (): void => {
        const recs = req.result as Array<{ file?: { size?: number } }>
        resolve({
          count: recs.length,
          bytes: recs.reduce((a, r) => a + (r.file?.size ?? 0), 0),
        })
      }
      req.onerror = (): void => resolve({ count: 0, bytes: 0 })
    })
  } catch {
    return { count: 0, bytes: 0 }
  }
}

async function keysPresent(): Promise<boolean> {
  const db = await openByName('awc-stem-mixer-keys', 1)
  if (!db) return false
  try {
    if (!db.objectStoreNames.contains('keys')) return false
    return await new Promise((resolve) => {
      const tx = db.transaction('keys', 'readonly')
      const req = tx.objectStore('keys').count()
      req.onsuccess = (): void => resolve(req.result > 0)
      req.onerror = (): void => resolve(false)
    })
  } catch {
    return false
  }
}

async function originUsage(): Promise<number | null> {
  const nav = navigator as unknown as {
    storage?: { estimate?: () => Promise<{ usage?: number }> }
  }
  try {
    const est = await nav.storage?.estimate?.()
    return est ? (est.usage ?? 0) : null
  } catch {
    return null
  }
}

export async function getStorageReport(): Promise<StorageReport> {
  const [sessions, hasKeys, originBytes] = await Promise.all([
    sessionUsage(),
    keysPresent(),
    originUsage(),
  ])
  return {
    sessionCount: sessions.count,
    sessionBytes: sessions.bytes,
    hasKeys,
    originBytes,
  }
}
