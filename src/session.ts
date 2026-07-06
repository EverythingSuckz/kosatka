/**
 * Session registry. Fast in-memory Map backed by IndexedDB persistence.
 * Drop zone calls `createSession(file)`. Mix route calls `loadSession(id)`
 * (async) which returns the in-memory session when present, or falls
 * through to IDB after a page reload.
 *
 * The drop zone also parses + extracts the AWC before navigating so it can
 * show progress UX inside the drop box. To avoid the mix route re-parsing
 * and flashing a plain `parsing…` screen, the drop zone stashes the parsed
 * payload here via `attachParsed`, and the mix route's first action is
 * `consumeParsed`. Single-shot cache, cleared after pickup so a page
 * reload still re-parses (which is fast).
 */

import { loadSession as idbLoad, persistSession } from './persistence/sessions'
import type { AwcFile } from './awc/types'
import type { ExtractedStream } from './codecs'

const sessions = new Map<string, File>()

export interface ParsedSessionData {
  awc: AwcFile
  buffer: ArrayBuffer
  streamBytes: Array<ExtractedStream>
}

const parsedCache = new Map<string, ParsedSessionData>()

export function createSession(file: File): string {
  const id = crypto.randomUUID()
  sessions.set(id, file)
  // Fire-and-forget: persistence is best-effort. A failure (e.g. private
  // browsing) just means a refresh loses the session, the live mix still works.
  void persistSession(id, file).catch((e) => {
    console.warn('session persist failed:', e)
  })
  return id
}

/**
 * Fallback path for the mix route: hits IndexedDB if the in-memory Map
 * doesn't have it (e.g. after a page reload). On hit, populates the Map.
 */
export async function loadSession(id: string): Promise<File | null> {
  const cached = sessions.get(id)
  if (cached) return cached
  const file = await idbLoad(id)
  if (file) sessions.set(id, file)
  return file
}

/**
 * Drop zone hands the mix route the already-parsed AWC + extracted streams
 * here so the mix route can skip its own parse pass and go straight to
 * audio decode. Single-shot: see `consumeParsed`.
 */
export function attachParsed(id: string, data: ParsedSessionData): void {
  parsedCache.set(id, data)
}

/**
 * Mix route pulls the parsed payload (if any) and clears the cache so
 * subsequent reloads re-parse via the normal path. Returns `null` when no
 * parsed payload was attached (e.g. direct navigation, page refresh).
 */
export function consumeParsed(id: string): ParsedSessionData | null {
  const data = parsedCache.get(id)
  if (data) parsedCache.delete(id)
  return data ?? null
}
