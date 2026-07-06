/**
 * Read-only browser for an open {@link RpfArchive}. Lists every `.awc` entry
 * inside the (potentially nested) archive, with search, sort, and a lazy
 * on-visibility "peek" that reads each entry's bytes once and decodes the
 * AWC header to surface stem count + duration.
 *
 * Peeks are driven by a SHARED IntersectionObserver. when a row scrolls into
 * view it auto-populates with stems + duration. Concurrent peeks are capped
 * (PEEK_CONCURRENCY) and queued so a fast scroll across many rows doesn't
 * stampede the decryption pipeline. The peek cache lives on a `useRef<Map>`
 * keyed by entry path. re-scrolling past a resolved row is free.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp } from '@phosphor-icons/react'

import { parseAwc } from '../awc/parser'
import type { RpfArchive, RpfEntry } from '../rpf'

export type SortKey = 'name' | 'path' | 'size'
export type SortDir = 'asc' | 'desc'
export type SortMode = `${SortKey}-${SortDir}`

interface PeekResult {
  /** null when the AWC failed to parse, we show "-" in the UI. */
  stems: number | null
  /** null when no stream provided length information. */
  durationSeconds: number | null
  /** Set if parseAwc threw, so we don't retry on every re-hover. */
  failed: boolean
}

interface RpfExplorerProps {
  archive: RpfArchive
  onPickEntry: (entry: RpfEntry) => void
  onReset: () => void
  /** Initial sort (restored from the URL so it survives a round-trip to the mixer). */
  initialSort?: SortMode
  /** Fired when the sort changes so the caller can persist it (e.g. in the URL). */
  onSortChange?: (sort: SortMode) => void
}

export function RpfExplorer({
  archive,
  onPickEntry,
  onReset,
  initialSort,
  onSortChange,
}: RpfExplorerProps): React.ReactNode {
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [initKey, initDir] = (initialSort ?? 'name-asc').split('-') as [
    SortKey,
    SortDir,
  ]
  const [sortKey, setSortKey] = useState<SortKey>(initKey)
  const [sortDir, setSortDir] = useState<SortDir>(initDir)
  const sort: SortMode = `${sortKey}-${sortDir}`

  // Notify the caller (URL persistence) whenever the sort changes, but not
  // on the initial mount, when it already matches what we were given.
  const onSortChangeRef = useRef(onSortChange)
  onSortChangeRef.current = onSortChange
  const firstSort = useRef(true)
  useEffect(() => {
    if (firstSort.current) {
      firstSort.current = false
      return
    }
    onSortChangeRef.current?.(sort)
  }, [sort])

  // 100ms search debounce. fast enough to feel snappy but cheap on the
  // filter pass which iterates the full entry list.
  useEffect(() => {
    const h = setTimeout(() => setDebouncedQuery(query), 100)
    return (): void => {
      clearTimeout(h)
    }
  }, [query])

  const awcs = useMemo(() => archive.awcEntries(), [archive])

  const filteredSorted = useMemo(
    () => filterAndSort(awcs, debouncedQuery, sort),
    [awcs, debouncedQuery, sort],
  )

  // Peek cache (lives across renders). The map is mutated in place via the
  // peekTick state to nudge React when an in-flight peek resolves.
  const peekCache = useRef<Map<string, PeekResult>>(new Map())
  const inFlight = useRef<Map<string, AbortController>>(new Map())
  // Entries waiting for a free in-flight slot. Drained whenever a peek
  // settles. Each queue entry remembers its bound RpfEntry so the runner
  // doesn't need to look it back up.
  const peekQueue = useRef<Array<RpfEntry>>([])
  const [peekTick, setPeekTick] = useState(0)

  // Cap concurrent peeks. Each peek decrypts + parses an AWC header, cheap
  // per call but expensive 178x over. ~6 in flight keeps a fast scroll
  // smooth without saturating the main thread.
  const PEEK_CONCURRENCY = 6

  // Cancel every outstanding peek when the explorer unmounts (i.e. the user
  // drops a new RPF or backs out to idle).
  useEffect(() => {
    const flying = inFlight.current
    const queue = peekQueue.current
    return (): void => {
      for (const ac of flying.values()) ac.abort()
      flying.clear()
      queue.length = 0
    }
  }, [])

  const runPeek = useCallback((entry: RpfEntry): void => {
    const ac = new AbortController()
    inFlight.current.set(entry.path, ac)
    void (async () => {
      try {
        const bytes = await entry.read()
        if (ac.signal.aborted) return
        try {
          const awc = parseAwc(
            bytes.buffer.slice(
              bytes.byteOffset,
              bytes.byteOffset + bytes.byteLength,
            ) as ArrayBuffer,
          )
          const stems = awc.streams.length
          let durationSeconds: number | null = null
          for (const s of awc.streams) {
            if (s.durationSeconds > (durationSeconds ?? 0)) {
              durationSeconds = s.durationSeconds
            }
          }
          peekCache.current.set(entry.path, {
            stems,
            durationSeconds,
            failed: false,
          })
        } catch {
          // parseAwc threw, show "-" rather than blocking on retries.
          peekCache.current.set(entry.path, {
            stems: null,
            durationSeconds: null,
            failed: true,
          })
        }
        // Force re-render so the row reflects the resolved peek.
        setPeekTick((t) => t + 1)
      } catch {
        // entry.read() threw (likely abort or NG decryption failure). Cache
        // a failed marker so we don't retry on subsequent scrolls.
        if (!ac.signal.aborted) {
          peekCache.current.set(entry.path, {
            stems: null,
            durationSeconds: null,
            failed: true,
          })
          setPeekTick((t) => t + 1)
        }
      } finally {
        inFlight.current.delete(entry.path)
        // Drain the queue: kick off the next pending peek (if any) now that
        // a slot has freed up.
        const next = peekQueue.current.shift()
        if (next) runPeek(next)
      }
    })()
  }, [])

  const startPeek = useCallback(
    (entry: RpfEntry): void => {
      if (peekCache.current.has(entry.path)) return
      if (inFlight.current.has(entry.path)) return
      if (peekQueue.current.some((e) => e.path === entry.path)) return
      if (inFlight.current.size >= PEEK_CONCURRENCY) {
        peekQueue.current.push(entry)
        return
      }
      runPeek(entry)
    },
    [runPeek],
  )

  // Shared IntersectionObserver, one instance for the whole list. As rows
  // scroll into view (with a 100px margin so we kick off the peek slightly
  // before they appear), we fire startPeek. We never un-register: once a row
  // has been seen, leaving the viewport doesn't cancel the peek, the result
  // gets cached and benefits a future scroll-back. Offscreen rows that have
  // not yet started simply don't.
  const observerRef = useRef<IntersectionObserver | null>(null)
  // Map row element back to the entry it represents so the observer callback
  // can route by element identity (rows are recycled by key, but the map is
  // refreshed on each render via the ref-callback).
  const rowEntries = useRef(new Map<Element, RpfEntry>())

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return
    const obs = new IntersectionObserver(
      (entries) => {
        for (const ent of entries) {
          if (ent.intersectionRatio <= 0) continue
          const rpf = rowEntries.current.get(ent.target)
          if (rpf) startPeek(rpf)
        }
      },
      { root: null, rootMargin: '100px', threshold: 0 },
    )
    observerRef.current = obs
    // Catch up: row `ref` callbacks fire BEFORE useEffects, so the rows
    // already registered themselves into `rowEntries` while `observerRef`
    // was still null and didn't call `obs.observe()`. Walk every already-
    // registered element and observe it now. Without this, the very first
    // render of the explorer never sees any peeks fire, only rows that
    // mount AFTER this effect (e.g. via search-filter changes) would.
    for (const el of rowEntries.current.keys()) {
      obs.observe(el)
    }
    return (): void => {
      obs.disconnect()
      observerRef.current = null
    }
  }, [startPeek])

  // Register a row element with the shared observer. Called via the row's
  // ref callback. null on unmount unregisters.
  const setRowRef = useCallback(
    (entry: RpfEntry, el: HTMLLIElement | null): void => {
      const obs = observerRef.current
      // Clean up previous mapping for this element (if any).
      for (const [k, v] of rowEntries.current) {
        if (v.path === entry.path && k !== el) {
          rowEntries.current.delete(k)
          obs?.unobserve(k)
        }
      }
      if (el) {
        rowEntries.current.set(el, entry)
        obs?.observe(el)
      }
    },
    [],
  )

  const onPick = useCallback(
    (entry: RpfEntry) => {
      onPickEntry(entry)
    },
    [onPickEntry],
  )

  return (
    <div className="flex flex-col items-stretch gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="flex flex-wrap items-baseline gap-3">
          <span
            title={archive.name}
            className="max-w-[24ch] truncate text-[var(--color-fg)] uppercase tracking-[0.16em]"
          >
            {archive.name}
          </span>
          <span className="text-xs uppercase tracking-[0.16em] text-[var(--color-fg-dim)]">
            {awcs.length} awcs
          </span>
          <span className="text-xs uppercase tracking-[0.16em] text-[var(--color-fg-dim)]">
            {fmtBytes(archive.size)}
          </span>
        </div>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onReset()
          }}
          className="text-xs uppercase tracking-[0.16em] text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]"
        >
          {'← drop another'}
        </button>
      </div>

      <div className="flex flex-wrap items-stretch gap-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          placeholder="search…"
          className="min-w-[16ch] flex-1 border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-1.5 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-mute)] focus:border-[var(--color-line-strong)] focus:outline-none"
        />
        <select
          value={sortKey}
          onChange={(e) => setSortKey(e.target.value as SortKey)}
          onClick={(e) => e.stopPropagation()}
          aria-label="sort by"
          className="border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-1.5 text-sm text-[var(--color-fg)] focus:border-[var(--color-line-strong)] focus:outline-none"
        >
          <option value="name">name</option>
          <option value="path">path</option>
          <option value="size">size</option>
        </select>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
          }}
          aria-label={
            sortDir === 'asc' ? 'sorted ascending' : 'sorted descending'
          }
          title={sortDir === 'asc' ? 'ascending' : 'descending'}
          className="!px-2.5 inline-flex items-center text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]"
        >
          {sortDir === 'asc' ? <ArrowUp size={14} /> : <ArrowDown size={14} />}
        </button>
      </div>

      {filteredSorted.length === 0 ? (
        <p className="px-2 py-6 text-center text-[var(--color-fg-mute)]">
          {awcs.length === 0 ? 'no .awc entries in this archive' : 'no matches'}
        </p>
      ) : (
        <ul
          className="m-0 max-h-[60vh] list-none overflow-y-auto border border-[var(--color-line)] p-0"
          // Force a re-render when the peek cache updates. we read it
          // directly inside the row component so we need a render trigger.
          data-peek-tick={peekTick}
        >
          {filteredSorted.map((entry) => {
            const parentPath = parentOf(entry.path)
            const peek = peekCache.current.get(entry.path)
            return (
              <li
                key={entry.path}
                ref={(el) => setRowRef(entry, el)}
                onClick={(e) => {
                  e.stopPropagation()
                  onPick(entry)
                }}
                className="cursor-pointer border-b border-[var(--color-line)] px-3 py-2 last:border-b-0 hover:bg-[var(--color-bg-1)]"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span
                    className="truncate text-[var(--color-fg)]"
                    title={entry.name}
                  >
                    {entry.name}
                  </span>
                  <span className="shrink-0 text-xs uppercase tracking-[0.12em] text-[var(--color-fg-dim)]">
                    {fmtBytes(entry.size)}
                  </span>
                </div>
                {parentPath ? (
                  <div
                    className="truncate text-xs text-[var(--color-fg-mute)]"
                    title={parentPath}
                  >
                    {parentPath}/
                  </div>
                ) : null}
                <div className="mt-0.5 text-xs uppercase tracking-[0.12em] text-[var(--color-fg-dim)]">
                  {/*
                    Non-breaking space when peek hasn't resolved yet so the
                    line has the same line-height as a populated row.
                    otherwise the row "grows" on hover when peek lands and
                    pushes neighbouring rows around (the bug you saw).
                  */}
                  {peek === undefined
                    ? ' '
                    : peek.failed
                      ? '-'
                      : `${peek.stems ?? '-'} stems, ${fmtDuration(peek.durationSeconds)}`}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

/**
 * Filter+sort the entry list by query and sort mode. Exported so unit tests
 * can verify the search semantics independent of React.
 */
export function filterAndSort(
  entries: ReadonlyArray<RpfEntry>,
  query: string,
  sort: SortMode,
): Array<RpfEntry> {
  const q = query.trim().toLowerCase()
  const filtered = q
    ? entries.filter(
        (e) =>
          e.name.toLowerCase().includes(q) || e.path.toLowerCase().includes(q),
      )
    : [...entries]
  const [key, dir] = sort.split('-') as [SortKey, SortDir]
  const sign = dir === 'asc' ? 1 : -1
  filtered.sort((a, b) => {
    let cmp: number
    if (key === 'size') cmp = a.size - b.size
    else if (key === 'path') cmp = a.path.localeCompare(b.path)
    else cmp = a.name.localeCompare(b.name)
    return cmp * sign
  })
  return filtered
}

function parentOf(path: string): string {
  const i = path.lastIndexOf('/')
  if (i < 0) return ''
  return path.slice(0, i)
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`
}

function fmtDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return '-'
  const total = Math.round(seconds)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}
