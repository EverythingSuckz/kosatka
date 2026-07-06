/**
 * Tests for the keys cache. We can't easily test the IDB persistence path
 * under bun (no indexedDB shim), but the in-memory cache + get/set surfaces
 * are exercisable directly.
 *
 * The {@link __resetKeyCacheForTests} hook resets module-level state between
 * cases so each test starts from a clean slate.
 */

import { beforeEach, describe, expect, test } from 'bun:test'

import {
  __resetKeyCacheForTests,
  getAwcKey,
  getDerivedKeys,
  setAwcKey,
  setDerivedKeys,
} from './index'
import type { DerivedKeys } from './derive'

function makeFakeBundle(): DerivedKeys {
  return {
    awcKey: new Uint32Array([1, 2, 3, 4]),
    ngKeys: new Uint8Array(27472),
    ngTables: new Uint8Array(278528),
    lut: new Uint8Array(256),
  }
}

describe('keys cache', () => {
  beforeEach(() => {
    __resetKeyCacheForTests()
  })

  test('getDerivedKeys returns null when nothing is cached and no IDB', async () => {
    // bun test env has no indexedDB, the IDB read rejects, getDerivedKeys
    // logs a warn and returns null.
    const got = await getDerivedKeys()
    expect(got).toBeNull()
  })

  test('setDerivedKeys populates the cache for getDerivedKeys + getAwcKey', async () => {
    const bundle = makeFakeBundle()
    await setDerivedKeys(bundle)
    const got = await getDerivedKeys()
    expect(got).not.toBeNull()
    expect(got!.awcKey[0]).toBe(1)
    expect(got!.ngKeys.length).toBe(27472)
    const awc = await getAwcKey()
    expect(awc).not.toBeNull()
    expect(Array.from(awc!)).toEqual([1, 2, 3, 4])
  })

  test('setAwcKey populates only the AWC-key cache, not the bundle', async () => {
    await setAwcKey(new Uint32Array([9, 8, 7, 6]))
    const awc = await getAwcKey()
    expect(Array.from(awc!)).toEqual([9, 8, 7, 6])
    const bundle = await getDerivedKeys()
    expect(bundle).toBeNull()
  })

  test('setDerivedKeys validates the awcKey shape', async () => {
    const bad = { ...makeFakeBundle(), awcKey: new Uint32Array([1, 2, 3]) }
    await expect(setDerivedKeys(bad)).rejects.toThrow(/PC_AWC_KEY/)
  })

  test('setAwcKey validates the key shape', async () => {
    await expect(setAwcKey(new Uint32Array([1, 2]))).rejects.toThrow(
      /PC_AWC_KEY/,
    )
  })
})
