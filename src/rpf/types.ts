/**
 * Public types for the read-only RPF7 archive parser. The byte-level format
 * is documented in docs/rpf-feasibility.md §"Format". This module ports the
 * minimum surface area needed to find and extract `.awc` payloads from a
 * GTA V (Legacy or Enhanced) RPF archive, including nested sub-RPFs.
 *
 * What is intentionally _not_ modelled here:
 *   - Resource (`*.yft`, `*.ytd`, `*.ysc`, …) parsing. Resource entries are
 *     exposed as opaque encrypted+compressed blobs. The parser returns their
 *     raw bytes (already decrypted/deflated) but does not decode the RSC7
 *     page-flag layout. AWC is a binary file, not a resource.
 *   - Any write/repack path. Read-only.
 *   - RPF0/2/3/4/6/8. We only accept `Version == 0x52504637`.
 */

/** Magic / version u32 at offset 0 of every RPF7 archive. ASCII "7FPR". */
export const RPF7_VERSION = 0x52504637

/** Encryption mode at header offset 0x0C. See docs/rpf-feasibility.md. */
export const RPF_ENC_NONE = 0x00000000
export const RPF_ENC_OPEN = 0x4e45504f // "OPEN"
export const RPF_ENC_AES = 0x0ffffff9
export const RPF_ENC_NG = 0x0fefffff
/** CodeWalker treats this as NG too. Observed but undocumented. */
export const RPF_ENC_NG_ALT = 0x0fffffff

export type RpfEncryption = 'NONE' | 'OPEN' | 'AES' | 'NG'

/** Directory entry sentinel: x = 0x7FFFFF00 in the second u32 of the 16-byte slot. */
export const RPF_DIRECTORY_SENTINEL = 0x7fffff00

/** Filename hint. Anything ending in `.rpf` (case-insensitive) is a nested archive. */
export const NESTED_RPF_SUFFIX = '.rpf'

/**
 * Single parsed entry in an RPF archive. Directories don't carry payload.
 * File entries (binary or resource) carry an absolute byte offset/size into
 * the outermost physical RPF file, plus encryption + compression hints.
 *
 * The `read()` callback is bound to the source `Blob | File | ArrayBuffer`
 * passed to {@link openRpf}. Calling it on a directory throws.
 */
export interface RpfEntry {
  /**
   * Full path through nested RPFs, slash-separated, lower-cased. The first
   * segment is empty (root), subsequent segments are directory and file
   * names. Sub-RPFs appear in the path verbatim (e.g.
   * `x64/audio/sfx/dlc_hei4_music.rpf/foo.awc`).
   */
  readonly path: string
  /** Basename (the segment after the last `/`). Lower-cased. */
  readonly name: string
  /** Uncompressed size in bytes. */
  readonly size: number
  /** True for directory entries. {@link read} throws on directories. */
  readonly isDirectory: boolean
  /** True for resource entries (system/graphics flag layout). */
  readonly isResource: boolean
  /** Encrypted at the per-entry level (in addition to archive-level encryption). */
  readonly isEncrypted: boolean
  /** Compressed (deflate) flag, derived from `compressed_size > 0`. */
  readonly isCompressed: boolean

  /**
   * Read this entry's bytes from the underlying source, decrypting and
   * decompressing as needed. Returns the final plain bytes.
   *
   * For resource entries: the RSC7 header (if present) is NOT stripped. We
   * hand back the full decrypted+deflated payload as CodeWalker's
   * `ExtractFileResource` would, minus the 16-byte RSC7 trim. (We don't need
   * resource decoding for AWC flows.)
   */
  readonly read: () => Promise<Uint8Array>
}

/**
 * Parsed RPF archive. A flat list of every entry across every nested level,
 * in tree-traversal order. The first entry is the root directory (always).
 *
 * To list only AWC payloads, use {@link RpfArchive.awcEntries}.
 */
export interface RpfArchive {
  /** Filename of the outer archive (lower-cased, defaulted if not provided). */
  readonly name: string
  /** Total size of the outermost source in bytes. */
  readonly size: number
  /** Every entry (directories and files) in every (nested) RPF. */
  readonly entries: ReadonlyArray<RpfEntry>
  /** Convenience: filter entries to `.awc` files anywhere in the tree. */
  readonly awcEntries: () => ReadonlyArray<RpfEntry>
}

/**
 * Source for an open RPF. We accept any of the three browser/Bun-friendly
 * payload shapes: a `File` (drop zone), a `Blob`, or a raw `ArrayBuffer`.
 * Internally everything routes through `Blob#slice` so we never load the
 * full archive into memory.
 */
export type RpfSource = File | Blob | ArrayBuffer | Uint8Array

/** Structured error type. `offset` is the byte position in the source. */
export class RpfParseError extends Error {
  readonly offset: number
  constructor(offset: number, message: string) {
    super(
      `RpfParseError @ 0x${offset.toString(16).padStart(8, '0')}: ${message}`,
    )
    this.name = 'RpfParseError'
    this.offset = offset
  }
}
