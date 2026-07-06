/**
 * Session persistence. Stores the dropped .awc File in IndexedDB keyed by
 * sessionId so a page reload doesn't lose the user's work. The in-memory Map
 * in src/session.ts stays authoritative during a session. IDB is the fallback
 * we hit when the page first loads with a /mix/:id URL.
 *
 * Storing the actual File blob works because modern browsers accept File/Blob
 * in IDB with no special handling.
 *
 * Pruning: every drop persists the whole .awc (~38 MB) and before pruning the
 * store grew unboundedly, so a long auditioning session could eat hundreds of
 * MB. persistSession prunes after each put, keeping only the newest
 * MAX_PERSISTED_SESSIONS records. Prune failures are swallowed, housekeeping
 * must never fail the persist itself.
 *
 * The pure helpers (selectPruneIds, toSummaries) hold the prune-selection and
 * ordering logic so bun can test them without an IndexedDB shim (bun has none,
 * same trade-off as src/keys).
 */

const DB_NAME = 'awc-stem-mixer'
const DB_VERSION = 1
const STORE = 'sessions'

interface SessionRecord {
  id: string
  file: File
  createdAt: number
}

/** What the drop screen's "recent" strip needs: name, size, age. */
export interface SessionSummary {
  id: string
  name: string
  size: number
  createdAt: number
}

/**
 * How many sessions survive a prune. At ~38 MB per .awc this caps the store
 * near 190 MB, roomy enough for the recent strip, small enough to leave the
 * user's quota alone.
 */
export const MAX_PERSISTED_SESSIONS = 5

/**
 * Pure: project raw records into summaries, newest first. Ties on
 * `createdAt` keep their input order (Array.prototype.sort is stable).
 */
export function toSummaries(
  records: ReadonlyArray<{ id: string; file: File; createdAt: number }>,
): Array<SessionSummary> {
  return [...records]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((r) => ({
      id: r.id,
      name: r.file.name,
      size: r.file.size,
      createdAt: r.createdAt,
    }))
}

/**
 * Pure: which record ids to delete so that only the newest `max` remain.
 * Returns `[]` when the store is already within budget. Ties on `createdAt`
 * are resolved stably, earlier-input records are treated as newer.
 */
export function selectPruneIds(
  records: ReadonlyArray<{ id: string; createdAt: number }>,
  max: number,
): Array<string> {
  const keep = Math.max(0, max)
  if (records.length <= keep) return []
  return [...records]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(keep)
    .map((r) => r.id)
}

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(
      new Error('IndexedDB is not available in this environment'),
    )
  }
  dbPromise = new Promise((resolve, reject) => {
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

function getAllRecords(db: IDBDatabase): Promise<Array<SessionRecord>> {
  return new Promise<Array<SessionRecord>>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).getAll()
    req.onsuccess = (): void => resolve(req.result as Array<SessionRecord>)
    req.onerror = (): void =>
      reject(req.error ?? new Error('IDB getAll failed'))
  })
}

async function pruneOldSessions(db: IDBDatabase): Promise<void> {
  const records = await getAllRecords(db)
  const doomed = selectPruneIds(records, MAX_PERSISTED_SESSIONS)
  if (doomed.length === 0) return
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    for (const doomedId of doomed) store.delete(doomedId)
    tx.oncomplete = (): void => resolve()
    tx.onerror = (): void => reject(tx.error ?? new Error('IDB prune failed'))
    tx.onabort = (): void => reject(tx.error ?? new Error('IDB prune aborted'))
  })
}

export async function persistSession(id: string, file: File): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    const rec: SessionRecord = { id, file, createdAt: Date.now() }
    store.put(rec)
    tx.oncomplete = (): void => resolve()
    tx.onerror = (): void => reject(tx.error ?? new Error('IDB put failed'))
    tx.onabort = (): void => reject(tx.error ?? new Error('IDB put aborted'))
  })
  // Prune AFTER the put so the new record counts toward the budget. The
  // try/catch scopes to the prune only: a prune failure must never turn a
  // successful persist into a rejection.
  try {
    await pruneOldSessions(db)
  } catch {
    // swallowed, pruning is best-effort housekeeping
  }
}

/**
 * Persisted sessions as summaries, newest first, capped at
 * MAX_PERSISTED_SESSIONS. The cap matters for stores that predate pruning
 * (pruning only runs on persist): without it a legacy store would render an
 * unbounded "recent" strip until the user's next drop.
 */
export async function listSessions(): Promise<Array<SessionSummary>> {
  const db = await openDb()
  const records = await getAllRecords(db)
  return toSummaries(records).slice(0, MAX_PERSISTED_SESSIONS)
}

export async function loadSession(id: string): Promise<File | null> {
  const db = await openDb()
  return new Promise<File | null>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const store = tx.objectStore(STORE)
    const req = store.get(id)
    req.onsuccess = (): void => {
      const rec = req.result as SessionRecord | undefined
      resolve(rec ? rec.file : null)
    }
    req.onerror = (): void => reject(req.error ?? new Error('IDB get failed'))
  })
}

export async function deleteSession(id: string): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).delete(id)
    tx.oncomplete = (): void => resolve()
    tx.onerror = (): void => reject(tx.error ?? new Error('IDB delete failed'))
  })
}

/** Delete every persisted session (settings panel "clear recent"). */
export async function clearAllSessions(): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).clear()
    tx.oncomplete = (): void => resolve()
    tx.onerror = (): void => reject(tx.error ?? new Error('IDB clear failed'))
  })
}
