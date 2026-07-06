import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  clearRpfSessions,
  createRpfSession,
  getRpfSession,
  getRpfSessionName,
  replaceRpfSession,
} from './rpf-session'
import type { RpfArchive } from './rpf'

/** Minimal fake. The registry never inspects the archive. */
function fakeArchive(label: string): RpfArchive {
  return { label } as unknown as RpfArchive
}

/** Map-backed sessionStorage stub for the bun test env (which has none). */
function makeStorageStub(): Storage {
  const store = new Map<string, string>()
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value)
    },
    removeItem: (key: string) => {
      store.delete(key)
    },
    clear: () => {
      store.clear()
    },
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size
    },
  }
}

const globalWithStorage = globalThis as { sessionStorage?: Storage }
const originalStorage = globalWithStorage.sessionStorage

beforeEach(() => {
  clearRpfSessions()
  globalWithStorage.sessionStorage = makeStorageStub()
})

afterEach(() => {
  clearRpfSessions()
  if (originalStorage === undefined) {
    delete globalWithStorage.sessionStorage
  } else {
    globalWithStorage.sessionStorage = originalStorage
  }
})

describe('rpf session registry', () => {
  test('create then get round-trips file, archive, and name', () => {
    const file = new File(['x'], 'x64a.rpf')
    const archive = fakeArchive('a')
    const id = createRpfSession(file, archive)

    const session = getRpfSession(id)
    expect(session).toBeDefined()
    expect(session?.id).toBe(id)
    expect(session?.file).toBe(file)
    expect(session?.archive).toBe(archive)
    expect(session?.name).toBe('x64a.rpf')
  })

  test('unknown id returns undefined', () => {
    expect(getRpfSession('nope')).toBeUndefined()
  })

  test('distinct sessions get distinct ids', () => {
    const a = createRpfSession(new File(['a'], 'a.rpf'), fakeArchive('a'))
    const b = createRpfSession(new File(['b'], 'b.rpf'), fakeArchive('b'))
    expect(a).not.toBe(b)
    expect(getRpfSession(a)?.name).toBe('a.rpf')
    expect(getRpfSession(b)?.name).toBe('b.rpf')
  })

  test('replace keeps the id and swaps file, archive, and name', () => {
    const id = createRpfSession(new File(['a'], 'old.rpf'), fakeArchive('old'))

    const newFile = new File(['b'], 'new.rpf')
    const newArchive = fakeArchive('new')
    replaceRpfSession(id, newFile, newArchive)

    const session = getRpfSession(id)
    expect(session?.id).toBe(id)
    expect(session?.file).toBe(newFile)
    expect(session?.archive).toBe(newArchive)
    expect(session?.name).toBe('new.rpf')
  })
})

describe('getRpfSessionName', () => {
  test('returns the live registry name while the session exists', () => {
    const id = createRpfSession(new File(['x'], 'live.rpf'), fakeArchive('a'))
    expect(getRpfSessionName(id)).toBe('live.rpf')
  })

  test('falls back to the sessionStorage breadcrumb after registry loss', () => {
    const id = createRpfSession(
      new File(['x'], 'survivor.rpf'),
      fakeArchive('a'),
    )
    // Simulate a page refresh: module registry gone, sessionStorage intact.
    clearRpfSessions()
    expect(getRpfSession(id)).toBeUndefined()
    expect(getRpfSessionName(id)).toBe('survivor.rpf')
  })

  test('replace refreshes the breadcrumb too', () => {
    const id = createRpfSession(new File(['a'], 'old.rpf'), fakeArchive('old'))
    replaceRpfSession(id, new File(['b'], 'new.rpf'), fakeArchive('new'))
    clearRpfSessions()
    expect(getRpfSessionName(id)).toBe('new.rpf')
  })

  test('returns null when neither registry nor breadcrumb knows the id', () => {
    expect(getRpfSessionName('ghost')).toBeNull()
  })
})

describe('sessionStorage unavailable', () => {
  test('create, replace, and name lookup never throw without sessionStorage', () => {
    delete globalWithStorage.sessionStorage

    const id = createRpfSession(new File(['x'], 'bare.rpf'), fakeArchive('a'))
    expect(getRpfSession(id)?.name).toBe('bare.rpf')

    replaceRpfSession(id, new File(['y'], 'bare2.rpf'), fakeArchive('b'))
    expect(getRpfSessionName(id)).toBe('bare2.rpf')

    // Registry lost AND no storage: degrades to null, still no throw.
    clearRpfSessions()
    expect(getRpfSessionName(id)).toBeNull()
  })

  test('create still succeeds when sessionStorage.setItem throws', () => {
    const throwing = makeStorageStub()
    throwing.setItem = () => {
      throw new Error('quota exceeded')
    }
    globalWithStorage.sessionStorage = throwing

    const id = createRpfSession(new File(['x'], 'q.rpf'), fakeArchive('a'))
    expect(getRpfSession(id)?.name).toBe('q.rpf')
  })
})
