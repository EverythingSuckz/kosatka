/**
 * Read-only RPF7 archive parser. Port of CodeWalker's `RpfFile.ReadHeader`
 * (RpfFile.cs:134-274) + `ScanStructure` (lines 296-362) + `ExtractFileBinary`
 * (lines 529-575). Trimmed to the surface area we need:
 *
 *   - Parse the 16-byte header at any offset (root or nested sub-RPF).
 *   - Decrypt the entries+names blob (NONE / OPEN / AES / NG).
 *   - Decode each entry as directory / binary / resource.
 *   - Build the path-prefix tree.
 *   - Recurse into nested `.rpf` binary entries.
 *   - On demand, slice + decrypt + inflate any entry's payload.
 *
 * The parser never holds the full archive in memory. It slices via `Blob#slice`
 * for every read. The decoded entry table is in memory (a few KB to a few MB
 * per archive, fine).
 *
 * See docs/rpf-feasibility.md for the byte-level format.
 */

import { decryptAes, decryptNgCopy } from './crypto'
import { buildNgContext } from './feistel'
import {
  NESTED_RPF_SUFFIX,
  RPF7_VERSION,
  RPF_DIRECTORY_SENTINEL,
  RPF_ENC_AES,
  RPF_ENC_NG,
  RPF_ENC_NG_ALT,
  RPF_ENC_NONE,
  RPF_ENC_OPEN,
  RpfParseError,
} from './types'
import type { NgContext } from './feistel'
import type { RpfArchive, RpfEncryption, RpfEntry, RpfSource } from './types'

/** Header is exactly 16 bytes. */
const HEADER_SIZE = 16
/** Every entry slot is exactly 16 bytes (4 × u32). */
const ENTRY_SIZE = 16
/** File offsets in binary/resource entries are in 512-byte sectors. */
const SECTOR_SIZE = 512

/**
 * Derived-keys subset needed for RPF parsing. Pass {@link DerivedKeys}
 * verbatim, we only read these three fields. Matches the type from
 * `import('../keys/derive').DerivedKeys` field-by-field (TS structural typing).
 */
export interface NgKeys {
  readonly ngKeys: Uint8Array
  readonly ngTables: Uint8Array
  readonly lut: Uint8Array
}

/** Opaque source wrapper. Slicing is the only operation we need. */
interface SourceReader {
  readonly size: number
  /** Slice `[start, start+length)` and return as a Uint8Array. */
  readonly slice: (start: number, length: number) => Promise<Uint8Array>
}

function makeSourceReader(src: RpfSource): SourceReader {
  if (src instanceof ArrayBuffer) {
    const u = new Uint8Array(src)
    return {
      size: u.length,
      slice: (start, length) =>
        Promise.resolve(u.subarray(start, start + length)),
    }
  }
  if (src instanceof Uint8Array) {
    return {
      size: src.length,
      slice: (start, length) =>
        Promise.resolve(src.subarray(start, start + length)),
    }
  }
  // Blob / File. Use slice + arrayBuffer. Browsers and Bun both support this.
  return {
    size: src.size,
    slice: async (start, length) => {
      const ab = await src.slice(start, start + length).arrayBuffer()
      return new Uint8Array(ab)
    },
  }
}

/** Internal decoded entry shape. Mirrors CodeWalker's three entry classes. */
interface RawEntry {
  kind: 'directory' | 'binary' | 'resource'
  nameOffset: number
  // directory:
  entriesIndex: number
  entriesCount: number
  // file:
  fileSize: number // compressed size (0 if uncompressed for binary, flags-derived for resource)
  fileOffset: number // sector offset within parent
  fileUncompressedSize: number // binary only
  encryptionType: number // binary only (0 = unencrypted, 1 = AES per-entry)
  isResourceEncrypted: boolean // resource: derived from name suffix (.ysc)
}

/**
 * Parse the header at `pos` and return the decrypted entries+names blobs
 * plus the raw header fields. Caller continues with `parseEntries`.
 */
async function parseHeader(
  reader: SourceReader,
  pos: number,
  archiveName: string,
  archiveSize: number,
  ng: NgContext | null,
): Promise<{
  version: number
  entryCount: number
  namesLength: number
  encryption: RpfEncryption
  entriesData: Uint8Array
  namesData: Uint8Array
  headerEnd: number
}> {
  const head = await reader.slice(pos, HEADER_SIZE)
  if (head.length < HEADER_SIZE) {
    throw new RpfParseError(
      pos,
      `header truncated (${head.length} < ${HEADER_SIZE})`,
    )
  }
  const headView = new DataView(head.buffer, head.byteOffset, head.byteLength)
  const version = headView.getUint32(0, true)
  const entryCount = headView.getUint32(4, true)
  const namesLength = headView.getUint32(8, true)
  const encRaw = headView.getUint32(12, true)

  if (version !== RPF7_VERSION) {
    throw new RpfParseError(
      pos,
      `not an RPF7 archive: version 0x${version.toString(16)} (expected 0x52504637)`,
    )
  }
  if (entryCount === 0 || entryCount > 0x00ffffff) {
    throw new RpfParseError(pos + 4, `implausible entryCount ${entryCount}`)
  }
  if (namesLength > 0x10000000) {
    throw new RpfParseError(pos + 8, `implausible namesLength ${namesLength}`)
  }

  const encryption: RpfEncryption =
    encRaw === RPF_ENC_NONE
      ? 'NONE'
      : encRaw === RPF_ENC_OPEN
        ? 'OPEN'
        : encRaw === RPF_ENC_AES
          ? 'AES'
          : encRaw === RPF_ENC_NG || encRaw === RPF_ENC_NG_ALT
            ? 'NG'
            : 'NG' // CodeWalker treats unknown as NG (RpfFile.cs:168-171).

  const entriesByteLength = entryCount * ENTRY_SIZE
  const entriesStart = pos + HEADER_SIZE
  const namesStart = entriesStart + entriesByteLength
  const headerEnd = namesStart + namesLength

  // Pull entries and names in two slices. CodeWalker decrypts them as two
  // independent blobs (NOT concatenated).
  const entriesRaw = await reader.slice(entriesStart, entriesByteLength)
  const namesRaw = await reader.slice(namesStart, namesLength)

  let entriesData: Uint8Array
  let namesData: Uint8Array
  switch (encryption) {
    case 'NONE':
    case 'OPEN':
      entriesData = entriesRaw
      namesData = namesRaw
      break
    case 'AES':
      entriesData = await decryptAes(entriesRaw)
      namesData = await decryptAes(namesRaw)
      break
    case 'NG':
      if (!ng) {
        throw new RpfParseError(
          pos + 12,
          'archive is NG-encrypted but no NG keys/tables were provided to openRpf()',
        )
      }
      entriesData = decryptNgCopy(entriesRaw, archiveName, archiveSize, ng)
      namesData = decryptNgCopy(namesRaw, archiveName, archiveSize, ng)
      break
  }

  return {
    version,
    entryCount,
    namesLength,
    encryption,
    entriesData,
    namesData,
    headerEnd,
  }
}

/**
 * Decode `entryCount` × 16-byte entry slots from the (already-decrypted)
 * `entriesData` blob. Returns the flat list in their on-disk order. The
 * tree shape is reconstructed in `buildTree` below.
 */
function parseEntries(
  entriesData: Uint8Array,
  entryCount: number,
): Array<RawEntry> {
  const view = new DataView(
    entriesData.buffer,
    entriesData.byteOffset,
    entriesData.byteLength,
  )
  const out: Array<RawEntry> = []
  for (let i = 0; i < entryCount; i++) {
    const off = i * ENTRY_SIZE
    const y = view.getUint32(off, true)
    const x = view.getUint32(off + 4, true)

    if (x === RPF_DIRECTORY_SENTINEL) {
      // Directory entry.
      const nameOffset = y
      const entriesIndex = view.getUint32(off + 8, true)
      const entriesCount = view.getUint32(off + 12, true)
      out.push({
        kind: 'directory',
        nameOffset,
        entriesIndex,
        entriesCount,
        fileSize: 0,
        fileOffset: 0,
        fileUncompressedSize: 0,
        encryptionType: 0,
        isResourceEncrypted: false,
      })
    } else if ((x & 0x80000000) === 0) {
      // Binary file entry. The first 8 bytes pack u16 nameOffset + u24
      // fileSize + u24 fileOffset. We already have them as y/x.
      //   buf (u64 LE) = y | (x << 32)
      //   nameOffset = buf       & 0xFFFF
      //   fileSize   = (buf>>16) & 0xFFFFFF
      //   fileOffset = (buf>>40) & 0xFFFFFF
      const nameOffset = y & 0xffff
      // bits 16..39 of the u64: take the upper 16 bits of y, plus the low 8 of x.
      const fileSize = ((y >>> 16) | ((x & 0xff) << 16)) >>> 0
      // bits 40..63: bits 8..31 of x.
      const fileOffset = (x >>> 8) & 0xffffff
      const fileUncompressedSize = view.getUint32(off + 8, true)
      const encryptionType = view.getUint32(off + 12, true)
      out.push({
        kind: 'binary',
        nameOffset,
        entriesIndex: 0,
        entriesCount: 0,
        fileSize,
        fileOffset,
        fileUncompressedSize,
        encryptionType,
        isResourceEncrypted: false,
      })
    } else {
      // Resource file entry.
      //   nameOffset    u16
      //   fileSize      u24
      //   fileOffset    u24 (top bit set in the on-disk layout, strip below)
      //   systemFlags   u32
      //   graphicsFlags u32
      // We don't expose the page flags. We DO need fileOffset to read it.
      const nameOffset = y & 0xffff
      const fileSize = ((y >>> 16) | ((x & 0xff) << 16)) >>> 0
      // For resource entries the top bit of fileOffset is the "is resource"
      // marker, mask it off (`& 0x7FFFFF`).
      const fileOffset = ((x >>> 8) & 0x7fffff) >>> 0
      // 0xFFFFFF means "size in RSC7 header", we leave it as-is. Callers
      // that read resource bytes get the full payload back.
      out.push({
        kind: 'resource',
        nameOffset,
        entriesIndex: 0,
        entriesCount: 0,
        fileSize,
        fileOffset,
        fileUncompressedSize: 0,
        encryptionType: 0,
        isResourceEncrypted: false, // patched below from the name (.ysc)
      })
    }
  }
  return out
}

/** Pull a null-terminated ASCII string out of `namesData` at `offset`. */
function readName(namesData: Uint8Array, offset: number): string {
  if (offset < 0 || offset >= namesData.length) return ''
  let end = offset
  while (end < namesData.length && namesData[end] !== 0) end++
  // ASCII-only by spec. If we hit non-ASCII we'd still decode via TextDecoder
  // but RPF entries are always ASCII.
  let len = end - offset
  if (len > 256) len = 256 // CodeWalker's freeze guard.
  return new TextDecoder('ascii').decode(
    namesData.subarray(offset, offset + len),
  )
}

interface BuildResult {
  /** Flat list, parented by directory traversal. */
  entries: Array<ParsedEntry>
  /** The root directory entry (always entries[0]). */
  root: ParsedEntry
}

interface ParsedEntry {
  raw: RawEntry
  name: string
  /** Slash-joined path inside this RPF only, does NOT include nested-RPF prefix. */
  innerPath: string
  /** Children, only populated for directories. */
  children: Array<ParsedEntry>
}

/** Walk the flat entries list directory-first, building parent → children. */
function buildTree(raw: Array<RawEntry>, namesData: Uint8Array): BuildResult {
  const wrapped: Array<ParsedEntry> = raw.map((r) => ({
    raw: r,
    name: readName(namesData, r.nameOffset),
    innerPath: '',
    children: [],
  }))
  if (wrapped.length === 0) {
    throw new RpfParseError(0, 'archive has no entries')
  }
  const root = wrapped[0]!
  if (root.raw.kind !== 'directory') {
    throw new RpfParseError(0, 'first entry is not a directory')
  }
  root.innerPath = ''
  // BFS: every directory entry stores [entriesIndex, entriesCount). Each
  // referenced child gets its parent set and its innerPath built.
  const stack: Array<ParsedEntry> = [root]
  while (stack.length > 0) {
    const dir = stack.pop()!
    const start = dir.raw.entriesIndex
    const end = start + dir.raw.entriesCount
    if (start < 0 || end > wrapped.length) {
      throw new RpfParseError(
        0,
        `directory entry slice [${start}, ${end}) is out of bounds (entries=${wrapped.length})`,
      )
    }
    for (let i = start; i < end; i++) {
      const child = wrapped[i]!
      const childName = child.name.toLowerCase()
      child.innerPath =
        dir.innerPath === '' ? childName : `${dir.innerPath}/${childName}`
      dir.children.push(child)
      // patch resource entry's `isResourceEncrypted` from the name (matches
      // CodeWalker's `.ysc` heuristic at RpfFile.cs:231).
      if (child.raw.kind === 'resource' && childName.endsWith('.ysc')) {
        child.raw.isResourceEncrypted = true
      }
      if (child.raw.kind === 'directory') {
        stack.push(child)
      }
    }
  }
  return { entries: wrapped, root }
}

/**
 * Parse the RPF at `startPos`. Recurses into nested `.rpf` binary entries.
 * Returns a flat list of {@link RpfEntry} with full paths.
 *
 * `archiveName` is used by the NG cipher to pick the per-archive sub-key:
 *   - Outer archive: the user-supplied basename (or `unknown.rpf`).
 *   - Nested archive: the binary entry's name (e.g. `dlc_hei4_music.rpf`).
 *
 * `archiveSize`:
 *   - Outer: the source file's total size in bytes.
 *   - Nested: the binary entry's `fileUncompressedSize` (NOT `fileSize`),
 *     matching CodeWalker's `binentry.GetFileSize()` which returns
 *     `(fileSize == 0) ? fileUncompressedSize : fileSize`. For nested RPFs
 *     `fileSize` is 0 (the sub-RPF is stored uncompressed and unencrypted),
 *     so the value is `fileUncompressedSize`.
 */
async function parseArchive(
  reader: SourceReader,
  startPos: number,
  archiveName: string,
  archiveSize: number,
  ng: NgContext | null,
  pathPrefix: string,
  out: Array<RpfEntry>,
): Promise<void> {
  const { entriesData, namesData, encryption } = await parseHeader(
    reader,
    startPos,
    archiveName,
    archiveSize,
    ng,
  )
  const raw = parseEntries(entriesData, entriesData.length / ENTRY_SIZE)
  const { entries: parsed } = buildTree(raw, namesData)

  // Emit every entry with a full path. Then recurse into nested .rpf
  // binary entries.
  for (const p of parsed) {
    const path =
      pathPrefix === ''
        ? p.innerPath
        : p.innerPath === ''
          ? pathPrefix
          : `${pathPrefix}/${p.innerPath}`
    const isDir = p.raw.kind === 'directory'
    const isRes = p.raw.kind === 'resource'
    const isCompressed = !isDir && p.raw.fileSize > 0
    const size = isDir
      ? 0
      : p.raw.kind === 'binary'
        ? p.raw.fileSize === 0
          ? p.raw.fileUncompressedSize
          : p.raw.fileUncompressedSize > 0
            ? p.raw.fileUncompressedSize
            : p.raw.fileSize
        : p.raw.fileSize
    const encryptedFlag =
      !isDir && (p.raw.encryptionType === 1 || p.raw.isResourceEncrypted)

    out.push(
      makeRpfEntry({
        reader,
        startPos,
        archiveEncryption: encryption,
        archiveName,
        archiveSize,
        ng,
        path,
        name: p.name.toLowerCase(),
        size,
        isDirectory: isDir,
        isResource: isRes,
        isEncrypted: encryptedFlag,
        isCompressed,
        raw: p.raw,
      }),
    )
  }

  // Recurse into nested RPFs.
  for (const p of parsed) {
    if (p.raw.kind !== 'binary') continue
    const lowerName = p.name.toLowerCase()
    if (!lowerName.endsWith(NESTED_RPF_SUFFIX)) continue
    const subStart = startPos + p.raw.fileOffset * SECTOR_SIZE
    // Sub-RPF "size" = GetFileSize().
    const subSize =
      p.raw.fileSize === 0 ? p.raw.fileUncompressedSize : p.raw.fileSize
    const subPath =
      pathPrefix === '' ? p.innerPath : `${pathPrefix}/${p.innerPath}`
    try {
      await parseArchive(reader, subStart, p.name, subSize, ng, subPath, out)
    } catch (e) {
      // CodeWalker swallows per-entry errors during ScanStructure
      // (RpfFile.cs:356-359). We rethrow so callers can surface them.
      if (e instanceof RpfParseError) {
        // header magic mismatch is the most useful diagnostic.
        throw e
      }
      // unexpected, rethrow
      throw e
    }
  }
}

interface MakeEntryArgs {
  reader: SourceReader
  /** Absolute byte offset of the parent archive's header. */
  startPos: number
  archiveEncryption: RpfEncryption
  /** Name used for NG sub-key selection (the parent archive). */
  archiveName: string
  archiveSize: number
  ng: NgContext | null
  path: string
  name: string
  size: number
  isDirectory: boolean
  isResource: boolean
  isEncrypted: boolean
  isCompressed: boolean
  raw: RawEntry
}

function makeRpfEntry(args: MakeEntryArgs): RpfEntry {
  const {
    reader,
    startPos,
    archiveEncryption,
    archiveName,
    ng,
    path,
    name,
    size,
    isDirectory,
    isResource,
    isEncrypted,
    isCompressed,
    raw,
  } = args
  return {
    path,
    name,
    size,
    isDirectory,
    isResource,
    isEncrypted,
    isCompressed,
    read: async () => {
      if (isDirectory) {
        throw new RpfParseError(0, `cannot read() a directory entry: ${path}`)
      }
      const fileStart = startPos + raw.fileOffset * SECTOR_SIZE
      // CodeWalker: l = entry.GetFileSize(), read `l` bytes, decrypt if
      // needed, decompress if fileSize > 0.
      const onDiskLength =
        raw.kind === 'binary'
          ? raw.fileSize === 0
            ? raw.fileUncompressedSize
            : raw.fileSize
          : raw.fileSize
      if (onDiskLength === 0) return new Uint8Array(0)
      let bytes = await reader.slice(fileStart, onDiskLength)
      // Per-entry encryption: only the IsEncrypted flag matters here. The
      // archive-level encryption mode determines which cipher (AES vs NG).
      if (raw.kind === 'binary' && raw.encryptionType === 1) {
        if (archiveEncryption === 'AES') {
          bytes = await decryptAes(bytes)
        } else {
          if (!ng) {
            throw new RpfParseError(
              0,
              `entry "${path}" is per-entry encrypted but no NG keys/tables were provided`,
            )
          }
          // CodeWalker passes `entry.FileUncompressedSize` as the length for
          // binary files (see ExtractFileBinary at RpfFile.cs:555).
          bytes = decryptNgCopy(bytes, name, raw.fileUncompressedSize, ng)
        }
      } else if (raw.kind === 'resource' && raw.isResourceEncrypted) {
        if (archiveEncryption === 'AES') {
          bytes = await decryptAes(bytes)
        } else {
          if (!ng) {
            throw new RpfParseError(
              0,
              `resource entry "${path}" is encrypted but no NG keys/tables were provided`,
            )
          }
          // CodeWalker passes `entry.FileSize` for resources (RpfFile.cs:608).
          bytes = decryptNgCopy(bytes, name, raw.fileSize, ng)
        }
      }
      // Decompress if the entry is flagged compressed (fileSize > 0 means
      // "compressed_size, with uncompressed in fileUncompressedSize").
      if (isCompressed && raw.kind === 'binary') {
        bytes = await rawInflate(bytes)
      }
      // For resources we don't decompress here. AWC pipeline doesn't traverse
      // resource entries, and CodeWalker's resource decompression path is
      // entangled with RSC7-header parsing we explicitly don't model.
      // Use `archiveName` to silence unused-binding warnings if every branch
      // above is dead, a practical no-op.
      void archiveName
      return bytes
    },
  }
}

/**
 * Open an RPF7 archive and return a flat list of every entry across every
 * nested level. Reads only the bytes it needs (headers + entries blobs).
 * The actual file payloads are loaded lazily via `RpfEntry.read()`.
 *
 * @param source  A `File`, `Blob`, `ArrayBuffer`, or `Uint8Array`.
 * @param ngKeys  The {@link import('../keys/derive').DerivedKeys} bundle (or
 *                anything that has its three byte-array fields). Pass `null`
 *                only if you're sure the archive isn't NG-encrypted (e.g.
 *                modded OPEN-mode RPFs).
 * @param options.name  Optional override for the outer archive name. Used by
 *                the NG cipher to select the per-archive sub-key. If your
 *                source is a `File`, we default to `file.name`, otherwise
 *                `"unknown.rpf"` (which works fine for OPEN/AES archives but
 *                will produce gibberish for NG without an explicit name).
 */
export async function openRpf(
  source: RpfSource,
  ngKeys: NgKeys | null = null,
  options: { name?: string } = {},
): Promise<RpfArchive> {
  const reader = makeSourceReader(source)
  const archiveName = (
    options.name ?? (source instanceof File ? source.name : 'unknown.rpf')
  ).toLowerCase()

  const ng: NgContext | null = ngKeys
    ? buildNgContext(ngKeys.ngKeys, ngKeys.ngTables, ngKeys.lut)
    : null

  const entries: Array<RpfEntry> = []
  await parseArchive(reader, 0, archiveName, reader.size, ng, '', entries)

  return {
    name: archiveName,
    size: reader.size,
    entries,
    awcEntries: () =>
      entries.filter((e) => !e.isDirectory && e.name.endsWith('.awc')),
  }
}

// DEFLATE-raw helper (same shape as src/keys/derive.ts's `rawInflate`).
// Pulled inline so this module is self-contained.

async function rawInflate(input: Uint8Array): Promise<Uint8Array> {
  if (input.length === 0) return input
  const ab = new ArrayBuffer(input.byteLength)
  new Uint8Array(ab).set(input)
  const blob = new Blob([ab])
  const ds = new DecompressionStream('deflate-raw')
  const inflated = await new Response(
    blob.stream().pipeThrough(ds),
  ).arrayBuffer()
  return new Uint8Array(inflated)
}
