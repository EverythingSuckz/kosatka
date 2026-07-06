/**
 * RPF session registry. In-memory only, lifetime = page.
 *
 * Why no IndexedDB mirror (unlike `session.ts`): an open {@link RpfArchive}
 * fronts a File that can be multi-GB, and the archive object itself holds
 * decrypted TOC state tied to that File. Copying either into IDB would be
 * slow, storage-hostile, and pointless. The archive is cheap to re-open
 * from a re-dropped File with the persisted keys. So the registry is a plain
 * module Map: a page refresh loses it by design, and the `/rpf/$rpfId` route
 * degrades to a "re-drop to reopen" prompt.
 *
 * The one thing we DO persist is the archive's *name*, as a sessionStorage
 * breadcrumb (`rpf-name:<id>` → name). After a refresh the registry is gone,
 * but the breadcrumb lets the re-drop prompt say WHICH rpf to drop
 * ("re-drop `x64a.rpf` to reopen") instead of a generic "re-drop the rpf
 * archive". Breadcrumb writes are best-effort: sessionStorage can be
 * unavailable (tests, storage-disabled browsers), and a missing breadcrumb
 * only costs the prompt its filename.
 *
 * `replaceRpfSession` exists for exactly that re-drop flow: the route keeps
 * its id (and URL) and swaps the fresh File + archive in place.
 */

import type { RpfArchive } from './rpf'

export interface RpfSession {
  id: string
  file: File
  archive: RpfArchive
  name: string
}

const sessions = new Map<string, RpfSession>()

const BREADCRUMB_PREFIX = 'rpf-name:'

function writeBreadcrumb(id: string, name: string): void {
  try {
    sessionStorage.setItem(`${BREADCRUMB_PREFIX}${id}`, name)
  } catch {
    // sessionStorage unavailable (or quota). The breadcrumb is a nicety,
    // the re-drop prompt just loses the filename.
  }
}

export function createRpfSession(file: File, archive: RpfArchive): string {
  const id = crypto.randomUUID()
  const name = file.name
  sessions.set(id, { id, file, archive, name })
  writeBreadcrumb(id, name)
  return id
}

export function getRpfSession(id: string): RpfSession | undefined {
  return sessions.get(id)
}

/**
 * Swap-in-place after a page-refresh re-drop: same id (so the `/rpf/$rpfId`
 * URL stays valid), fresh File + archive. Refreshes the name breadcrumb in
 * case the user re-dropped a renamed copy.
 */
export function replaceRpfSession(
  id: string,
  file: File,
  archive: RpfArchive,
): void {
  const name = file.name
  sessions.set(id, { id, file, archive, name })
  writeBreadcrumb(id, name)
}

/**
 * Display name for the re-drop prompt: live registry entry first, then the
 * sessionStorage breadcrumb (registry lost to a refresh), else null (prompt
 * falls back to generic copy).
 */
export function getRpfSessionName(id: string): string | null {
  const live = sessions.get(id)
  if (live) return live.name
  try {
    return sessionStorage.getItem(`${BREADCRUMB_PREFIX}${id}`)
  } catch {
    return null
  }
}

/**
 * Test helper: wipes the in-memory registry (breadcrumbs untouched) so tests
 * can simulate a page refresh, where sessionStorage survives but module
 * state does not.
 */
export function clearRpfSessions(): void {
  sessions.clear()
}
