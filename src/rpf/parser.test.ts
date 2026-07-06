/**
 * Synthetic-fixture tests for the RPF7 parser. We hand-build OPEN-mode
 * (unencrypted) archives, validate header parsing, entry decode, nested
 * RPF traversal, and the lazy `read()` path.
 *
 * End-to-end tests against a real NG-encrypted Cayo Perico RPF live in the
 * gated section at the bottom of this file (skipped if no fixture is found).
 */

import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, test } from 'bun:test'

import { buildNgContext } from './feistel'
import { openRpf } from './parser'
import {
  RPF7_VERSION,
  RPF_DIRECTORY_SENTINEL,
  RPF_ENC_NG,
  RPF_ENC_OPEN,
  RpfParseError,
} from './types'

// Synthetic OPEN-mode RPF builder. Each test crafts a minimal but spec-
// compliant byte sequence by hand to exercise one piece of the parser.

interface FixtureEntry {
  /** Entry kind. */
  kind: 'directory' | 'binary'
  /** Friendly name (lower-cased, written into the names blob). */
  name: string
  /** For directories: indices of children in the entries array (after the root). */
  children?: Array<number>
  /** For binary: raw uncompressed payload bytes. */
  payload?: Uint8Array
  /** For binary: if true, mark with fileSize > 0 so the parser tries to deflate. */
  compressed?: boolean
}

interface BuildResult {
  bytes: Uint8Array
  /** Map name → offset into the source for hand-verification. */
  layout: {
    headerStart: number
    entriesStart: number
    namesStart: number
    payloadStart: number
  }
}

function buildOpenRpf(entries: Array<FixtureEntry>): BuildResult {
  // Step 1: build the names blob (null-terminated ASCII concatenation).
  const names: Array<number> = []
  const nameOffsets = new Map<number, number>()
  for (let i = 0; i < entries.length; i++) {
    nameOffsets.set(i, names.length)
    const e = entries[i]!
    for (let j = 0; j < e.name.length; j++)
      names.push(e.name.charCodeAt(j) & 0xff)
    names.push(0)
  }
  // Pad names blob to multiple of 16, not required by the spec but
  // matches what real archives do (entry header is always 16-aligned).
  while (names.length % 16 !== 0) names.push(0)
  const namesData = new Uint8Array(names)

  // Step 2: compute payload offsets in 512-byte sectors. Header (16) + entries
  // (16 each) + names → first sector boundary at next multiple of 512.
  const headerSize = 16
  const entriesSize = entries.length * 16
  const tocEnd = headerSize + entriesSize + namesData.length
  let payloadStart = tocEnd
  if (payloadStart % 512 !== 0) {
    payloadStart += 512 - (payloadStart % 512)
  }

  const entryOffsets = new Map<
    number,
    { offsetSectors: number; size: number; uncompressed: number }
  >()
  let cursor = payloadStart
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!
    if (e.kind !== 'binary' || !e.payload) continue
    if (cursor % 512 !== 0) {
      cursor += 512 - (cursor % 512)
    }
    entryOffsets.set(i, {
      offsetSectors: cursor / 512,
      size: e.compressed ? e.payload.length : 0, // 0 = stored uncompressed
      uncompressed: e.payload.length,
    })
    cursor += e.payload.length
  }
  const totalSize = cursor

  // Step 3: assemble the full byte stream.
  const bytes = new Uint8Array(totalSize)
  const view = new DataView(bytes.buffer)

  // Header.
  view.setUint32(0, RPF7_VERSION, true)
  view.setUint32(4, entries.length, true)
  view.setUint32(8, namesData.length, true)
  view.setUint32(12, RPF_ENC_OPEN, true)

  // Entries.
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!
    const off = headerSize + i * 16
    const nameOff = nameOffsets.get(i)!
    if (e.kind === 'directory') {
      view.setUint32(off, nameOff, true) // y = nameOffset
      view.setUint32(off + 4, RPF_DIRECTORY_SENTINEL, true)
      // entriesIndex+count point at the first child and span.
      const kids = e.children ?? []
      view.setUint32(off + 8, kids.length === 0 ? 0 : kids[0]!, true)
      view.setUint32(off + 12, kids.length, true)
    } else {
      // Binary file: pack u64 (LE) = nameOffset(16) | fileSize(24) | fileOffset(24).
      const f = entryOffsets.get(i)!
      const y = nameOff | ((f.size & 0xffff) << 16)
      const xLo = (f.size >>> 16) & 0xff
      const xHi = (f.offsetSectors & 0xffffff) << 8
      const x = (xLo | xHi) >>> 0
      view.setUint32(off, y >>> 0, true)
      view.setUint32(off + 4, x, true)
      view.setUint32(off + 8, f.uncompressed, true)
      view.setUint32(off + 12, 0, true) // encryptionType = 0
    }
  }

  // Names.
  bytes.set(namesData, headerSize + entriesSize)

  // Payloads.
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!
    if (e.kind !== 'binary' || !e.payload) continue
    const f = entryOffsets.get(i)!
    bytes.set(e.payload, f.offsetSectors * 512)
  }

  return {
    bytes,
    layout: {
      headerStart: 0,
      entriesStart: headerSize,
      namesStart: headerSize + entriesSize,
      payloadStart,
    },
  }
}

describe('openRpf: OPEN-mode synthetic archives', () => {
  test('rejects non-RPF7 magic', async () => {
    const bytes = new Uint8Array(64)
    const view = new DataView(bytes.buffer)
    view.setUint32(0, 0xdeadbeef, true)
    await expect(openRpf(bytes, null)).rejects.toThrow(RpfParseError)
  })

  test('rejects truncated header', async () => {
    await expect(openRpf(new Uint8Array(8), null)).rejects.toThrow(
      RpfParseError,
    )
  })

  test('parses a single-file flat archive', async () => {
    const payload = new TextEncoder().encode('hello world')
    const { bytes } = buildOpenRpf([
      { kind: 'directory', name: '', children: [1] },
      { kind: 'binary', name: 'hello.bin', payload },
    ])
    const arch = await openRpf(bytes, null)
    expect(arch.entries.length).toBe(2)
    expect(arch.entries[0]!.isDirectory).toBe(true)
    expect(arch.entries[1]!.isDirectory).toBe(false)
    expect(arch.entries[1]!.name).toBe('hello.bin')
    expect(arch.entries[1]!.size).toBe(11)
    const got = await arch.entries[1]!.read()
    expect(new TextDecoder().decode(got)).toBe('hello world')
  })

  test('builds full paths through nested directories', async () => {
    // Layout: / (root) → dirA → fileA.bin, dirB → fileB.bin
    // The entries array must be DFS-laid-out so each directory's children
    // are contiguous. CodeWalker's RpfFile.ReadHeader (line 250) iterates
    // `for (i = item.EntriesIndex; i < item.EntriesIndex + item.EntriesCount; ...)`.
    //   [0] root  (children: dirA, dirB at indices 1, 2)
    //   [1] dirA  (children: fileA at index 3)
    //   [2] dirB  (children: fileB at index 4)
    //   [3] fileA
    //   [4] fileB
    const pa = new TextEncoder().encode('aaa')
    const pb = new TextEncoder().encode('bbbb')
    const { bytes } = buildOpenRpf([
      { kind: 'directory', name: '', children: [1, 2] },
      { kind: 'directory', name: 'dira', children: [3] },
      { kind: 'directory', name: 'dirb', children: [4] },
      { kind: 'binary', name: 'filea.bin', payload: pa },
      { kind: 'binary', name: 'fileb.bin', payload: pb },
    ])
    const arch = await openRpf(bytes, null)
    // Verify paths.
    const byName = new Map(arch.entries.map((e) => [e.name, e.path]))
    expect(byName.get('filea.bin')).toBe('dira/filea.bin')
    expect(byName.get('fileb.bin')).toBe('dirb/fileb.bin')
    // Verify read() at depth.
    const e = arch.entries.find((x) => x.name === 'filea.bin')!
    expect(new TextDecoder().decode(await e.read())).toBe('aaa')
  })

  test('awcEntries() filters to .awc files only', async () => {
    const aa = new TextEncoder().encode('aa')
    const bb = new TextEncoder().encode('bb')
    const cc = new TextEncoder().encode('cc')
    const { bytes } = buildOpenRpf([
      { kind: 'directory', name: '', children: [1, 2, 3] },
      { kind: 'binary', name: 'foo.awc', payload: aa },
      { kind: 'binary', name: 'bar.txt', payload: bb },
      { kind: 'binary', name: 'baz.awc', payload: cc },
    ])
    const arch = await openRpf(bytes, null)
    const awcs = arch.awcEntries()
    expect(awcs.length).toBe(2)
    expect(awcs.map((e) => e.name).sort()).toEqual(['baz.awc', 'foo.awc'])
  })

  test('recurses into nested .rpf binary entries', async () => {
    // Inner RPF: a single AWC file inside it.
    const innerPayload = new TextEncoder().encode('nested-awc-bytes')
    const inner = buildOpenRpf([
      { kind: 'directory', name: '', children: [1] },
      { kind: 'binary', name: 'song.awc', payload: innerPayload },
    ])
    // Outer RPF: one file, which IS the inner RPF. Payload = inner.bytes.
    const outer = buildOpenRpf([
      { kind: 'directory', name: '', children: [1] },
      { kind: 'binary', name: 'inner.rpf', payload: inner.bytes },
    ])
    const arch = await openRpf(outer.bytes, null)
    // Should find both the outer 'inner.rpf' entry AND the nested 'song.awc'.
    const names = arch.entries.map((e) => e.name)
    expect(names).toContain('inner.rpf')
    expect(names).toContain('song.awc')
    const song = arch.entries.find((e) => e.name === 'song.awc')!
    expect(song.path).toBe('inner.rpf/song.awc')
    expect(new TextDecoder().decode(await song.read())).toBe('nested-awc-bytes')
    expect(arch.awcEntries().map((e) => e.name)).toEqual(['song.awc'])
  })

  test('respects fileSize = 0 (uncompressed) vs > 0 (compressed) flag', async () => {
    // We don't actually feed deflate data here, we just check the flag flow.
    // For an uncompressed entry, read() should return the payload verbatim
    // (no inflate attempt).
    const payload = new Uint8Array([1, 2, 3, 4, 5])
    const { bytes } = buildOpenRpf([
      { kind: 'directory', name: '', children: [1] },
      { kind: 'binary', name: 'raw.bin', payload },
    ])
    const arch = await openRpf(bytes, null)
    const e = arch.entries[1]!
    expect(e.isCompressed).toBe(false)
    const got = await e.read()
    expect(got).toEqual(payload)
  })

  test('throws when reading a directory entry', async () => {
    const payload = new TextEncoder().encode('x')
    const { bytes } = buildOpenRpf([
      { kind: 'directory', name: '', children: [1] },
      { kind: 'binary', name: 'x.bin', payload },
    ])
    const arch = await openRpf(bytes, null)
    const dir = arch.entries.find((e) => e.isDirectory)!
    await expect(dir.read()).rejects.toThrow(/directory/)
  })

  test('NG-encrypted archive without ng keys → clear error', async () => {
    // Manually craft an NG header (we won't actually populate valid
    // encrypted data, the parser should fail at the "no keys" check
    // before getting to that.)
    const bytes = new Uint8Array(64)
    const view = new DataView(bytes.buffer)
    view.setUint32(0, RPF7_VERSION, true)
    view.setUint32(4, 1, true) // entryCount=1
    view.setUint32(8, 0, true) // namesLength=0
    view.setUint32(12, RPF_ENC_NG, true)
    await expect(openRpf(bytes, null)).rejects.toThrow(/NG-encrypted/)
  })
})

// Optional: NG-encrypted decode path. Builds an NgContext from magic.dat
// (which is in the project) and verifies the table-size invariants.

const MAGIC_PATH = 'public/magic.dat'
const EXE_PATH = 'E:/Games/GTAVEnhanced/GTA5_Enhanced.exe'
const HAS_E2E = existsSync(MAGIC_PATH) && existsSync(EXE_PATH)

describe.if(HAS_E2E)('openRpf: NG keys derivation smoke test', () => {
  test('derives NG keys/tables/lut at correct sizes', async () => {
    const { deriveKeysFromBytes } = await import('../keys/derive')
    const exe = new Uint8Array(readFileSync(EXE_PATH))
    const magic = new Uint8Array(readFileSync(MAGIC_PATH))
    const keys = await deriveKeysFromBytes(exe, magic)
    expect(keys.ngKeys.length).toBe(27472)
    expect(keys.ngTables.length).toBe(278528)
    expect(keys.lut.length).toBe(256)
    expect(keys.awcKey.length).toBe(4)
    // Building an NG context should be cheap and succeed.
    const ctx = buildNgContext(keys.ngKeys, keys.ngTables, keys.lut)
    expect(ctx.subKeys.length).toBe(101 * 17 * 4)
  }, 120000)
})

// Optional fixture for a real Cayo Perico RPF. Looks at samples/. If a
// `dlc_hei4_music.rpf` (or similar) is present, list its AWC contents.
const CAYO_PATH = 'samples/dlc_hei4_music.rpf'
const HAS_CAYO =
  existsSync(CAYO_PATH) && existsSync(MAGIC_PATH) && existsSync(EXE_PATH)

describe.if(HAS_CAYO)('openRpf: real NG-encrypted Cayo Perico RPF', () => {
  test('lists AWC entries inside the archive', async () => {
    const { deriveKeysFromBytes } = await import('../keys/derive')
    const exe = new Uint8Array(readFileSync(EXE_PATH))
    const magic = new Uint8Array(readFileSync(MAGIC_PATH))
    const keys = await deriveKeysFromBytes(exe, magic)
    const rpfBytes = new Uint8Array(readFileSync(CAYO_PATH))
    const arch = await openRpf(rpfBytes, keys, { name: 'dlc_hei4_music.rpf' })
    const awcs = arch.awcEntries()
    expect(awcs.length).toBeGreaterThan(0)
    // Print for the dev loop, these tests are gated and only run locally.
    console.log(`Cayo Perico RPF: ${awcs.length} AWC entries`)
    for (const a of awcs.slice(0, 10))
      console.log(`  ${a.path} (${a.size} bytes)`)
  }, 120000)
})
