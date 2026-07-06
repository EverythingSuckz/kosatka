/**
 * scripts/build-l3-tables.ts
 *
 * Reads the C# sources and emits 14 Layer III precomputed tables into
 * `src/codecs/nlayer/l3-tables.ts`. Tables emitted:
 *   - DEWINDOW (512 floats, from LayerDecoderBase.cs)
 *   - SYNTH_COS64 (31 floats, from LayerDecoderBase.cs)
 *   - ICOS72 (35 floats, from LayerIIIDecoder.cs HybridMDCT)
 *   - GAIN_TAB (256 floats)
 *   - PRETAB (22 ints)
 *   - POW2 (64 floats)
 *   - SF_BAND_INDEX_L (9 arrays of 23 ints each)
 *   - SF_BAND_INDEX_S (9 arrays of 14 ints each)
 *   - SLEN (2 arrays of 16 ints)
 *   - SFB_BLOCK_CNT_TAB (6×3×4 ints)
 *   - IS_RATIO (2×7 floats)
 *   - LSF_RATIO (2×2×... floats)
 *   - SCS (8 floats)
 *   - SCA (8 floats)
 *
 * Each table is parsed by locating its declaration and extracting the
 * literal numeric values. The script preserves the source order so
 * indexing in the decoder matches upstream verbatim.
 *
 * Run: bun run scripts/build-l3-tables.ts
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const LAYER_BASE = readFileSync(
  resolve('tmp/nlayer-source/NLayer/Decoder/LayerDecoderBase.cs'),
  'utf-8',
)
const LAYER_III = readFileSync(
  resolve('tmp/nlayer-source/NLayer/Decoder/LayerIIIDecoder.cs'),
  'utf-8',
)

const OUT = resolve('src/codecs/nlayer/l3-tables.ts')

/** Extract a balanced-brace block following the `startMarker`. */
function extractBlock(src: string, startMarker: string): string {
  const idx = src.indexOf(startMarker)
  if (idx === -1) throw new Error(`marker not found: ${startMarker}`)
  let i = src.indexOf('{', idx)
  if (i === -1) throw new Error('no opening brace')
  let depth = 0
  let end = -1
  while (i < src.length) {
    const c = src[i]!
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) {
        end = i
        break
      }
    }
    i++
  }
  if (end === -1) throw new Error('no matching brace')
  return src.slice(idx, end + 1)
}

/**
 * Strip the C# declaration prefix from a block returned by `extractBlock`.
 *
 * `extractBlock(src, marker)` returns the slice starting at the marker
 * (e.g. `"static readonly float[] POW2_TAB = { ... }"`). Naive number
 * parsing then captures digits from the marker name itself (the `2` in
 * `POW2_TAB`, the `64` in `SYNTH_COS64_TABLE`, the `72` in `icos72_table`),
 * shifting the resulting table by one slot. Cut at the first `{` so we
 * only ever parse the array body.
 */
function blockBody(block: string): string {
  const open = block.indexOf('{')
  if (open === -1) return block
  return block.slice(open + 1)
}

/**
 * Parse a flat list of floats out of a code block. Accepts C# float
 * literals (suffix f optional) and scientific notation. Returns the
 * literal sequence in source order.
 */
function parseFloats(block: string): Array<number> {
  const body = blockBody(block)
  const re = /-?\d+\.?\d*(?:[eE][+-]?\d+)?f?/g
  const out: Array<number> = []
  let m: RegExpExecArray | null
  while ((m = re.exec(body)) !== null) {
    const s = m[0].replace(/f$/, '')
    if (s === '' || s === '-') continue
    out.push(parseFloat(s))
  }
  return out
}

function parseInts(block: string): Array<number> {
  const body = blockBody(block)
  const re = /-?\d+/g
  const out: Array<number> = []
  let m: RegExpExecArray | null
  while ((m = re.exec(body)) !== null) {
    out.push(parseInt(m[0], 10))
  }
  return out
}

const DEWINDOW = parseFloats(
  extractBlock(LAYER_BASE, 'static float[] DEWINDOW_TABLE'),
).slice(0, 512)
const SYNTH_COS64 = parseFloats(
  extractBlock(LAYER_BASE, 'static float[] SYNTH_COS64_TABLE'),
).slice(0, 31)
const ICOS72 = parseFloats(
  extractBlock(LAYER_III, 'static float[] icos72_table'),
).slice(0, 36)
const GAIN_TAB = parseFloats(
  extractBlock(LAYER_III, 'static float[] GAIN_TAB'),
).slice(0, 256)
const PRETAB = parseInts(
  extractBlock(LAYER_III, 'static readonly int[] PRETAB'),
).slice(0, 22)
const POW2 = parseFloats(
  extractBlock(LAYER_III, 'static readonly float[] POW2_TAB'),
).slice(0, 64)

// SF_BAND_INDEX_L: 9 inner arrays of 23 ints each
function parseNestedIntArrays(
  block: string,
  innerLen: number,
): Array<Array<number>> {
  // Find inner `new int[] { ... }` blocks
  const re = /new int\[\]\s*\{([^}]+)\}/g
  const out: Array<Array<number>> = []
  let m: RegExpExecArray | null
  while ((m = re.exec(block)) !== null) {
    out.push(parseInts(m[1]!).slice(0, innerLen))
  }
  return out
}

const SF_BAND_INDEX_L = parseNestedIntArrays(
  extractBlock(LAYER_III, 'static readonly int[][] _sfBandIndexLTable'),
  23,
)
const SF_BAND_INDEX_S = parseNestedIntArrays(
  extractBlock(LAYER_III, 'static readonly int[][] _sfBandIndexSTable'),
  14,
)
const SLEN_BLOCK = extractBlock(LAYER_III, 'static readonly int[][] _slen')
const SLEN = parseNestedIntArrays(SLEN_BLOCK, 16)

// _sfbBlockCntTab is 3D: [6][3][4]. We need a brace-matching parser
// because the nested `new int[]` blocks confuse a non-greedy regex.
function extractBracedAt(
  src: string,
  start: number,
): { body: string; end: number } {
  const open = src.indexOf('{', start)
  if (open === -1) throw new Error('no opening brace at ' + start)
  let depth = 0
  let i = open
  while (i < src.length) {
    const c = src[i]!
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return { body: src.slice(open + 1, i), end: i }
    }
    i++
  }
  throw new Error('unbalanced braces')
}

function parse3DIntArrays(block: string): Array<Array<Array<number>>> {
  const out: Array<Array<Array<number>>> = []
  // Find all `new int[][]` occurrences and extract their balanced bodies.
  let pos = 0
  while (true) {
    const idx = block.indexOf('new int[][]', pos)
    if (idx === -1) break
    const { body, end } = extractBracedAt(block, idx)
    out.push(parseNestedIntArrays(body, 4))
    pos = end + 1
  }
  return out
}
const SFB_BLOCK_CNT_TAB = parse3DIntArrays(
  extractBlock(LAYER_III, 'static readonly int[][][] _sfbBlockCntTab'),
)

const IS_RATIO_BLOCK = extractBlock(
  LAYER_III,
  'static readonly float[][] _isRatio',
)
function parseNestedFloatArrays(block: string): Array<Array<number>> {
  const re = /new float\[\]\s*\{([^}]+)\}/g
  const out: Array<Array<number>> = []
  let m: RegExpExecArray | null
  while ((m = re.exec(block)) !== null) {
    out.push(parseFloats(m[1]!))
  }
  return out
}
const IS_RATIO = parseNestedFloatArrays(IS_RATIO_BLOCK)

const LSF_RATIO_BLOCK = extractBlock(
  LAYER_III,
  'static readonly float[][][] _lsfRatio',
)
// LSF_RATIO is [2][2][N]. Parse outer `new float[][]` blocks via the
// brace matcher (same reason as SFB_BLOCK_CNT_TAB).
function parse3DFloatArrays(block: string): Array<Array<Array<number>>> {
  const out: Array<Array<Array<number>>> = []
  let pos = 0
  while (true) {
    const idx = block.indexOf('new float[][]', pos)
    if (idx === -1) break
    const { body, end } = extractBracedAt(block, idx)
    out.push(parseNestedFloatArrays(body))
    pos = end + 1
  }
  return out
}
const LSF_RATIO = parse3DFloatArrays(LSF_RATIO_BLOCK)

const SCS = parseFloats(extractBlock(LAYER_III, 'static readonly float[] _scs'))
const SCA = parseFloats(extractBlock(LAYER_III, 'static readonly float[] _sca'))

// ---- Emit ----

function emitF32(name: string, values: Array<number>): string {
  let s = `export const ${name}: Readonly<Float32Array> = new Float32Array([\n`
  for (let i = 0; i < values.length; i += 6) {
    s += `  ${values.slice(i, i + 6).join(', ')},\n`
  }
  s += `])\n\n`
  return s
}

function emitI32(name: string, values: Array<number>): string {
  let s = `export const ${name}: Readonly<Int32Array> = new Int32Array([\n`
  for (let i = 0; i < values.length; i += 12) {
    s += `  ${values.slice(i, i + 12).join(', ')},\n`
  }
  s += `])\n\n`
  return s
}

function emitNestedI32(name: string, values: Array<Array<number>>): string {
  let s = `export const ${name}: ReadonlyArray<Readonly<Int32Array>> = [\n`
  for (const row of values) {
    s += `  new Int32Array([${row.join(', ')}]),\n`
  }
  s += `]\n\n`
  return s
}

function emitNestedF32(name: string, values: Array<Array<number>>): string {
  let s = `export const ${name}: ReadonlyArray<Readonly<Float32Array>> = [\n`
  for (const row of values) {
    s += `  new Float32Array([${row.join(', ')}]),\n`
  }
  s += `]\n\n`
  return s
}

function emit3DI32(name: string, values: Array<Array<Array<number>>>): string {
  let s = `export const ${name}: ReadonlyArray<ReadonlyArray<Readonly<Int32Array>>> = [\n`
  for (const grp of values) {
    s += `  [\n`
    for (const row of grp) {
      s += `    new Int32Array([${row.join(', ')}]),\n`
    }
    s += `  ],\n`
  }
  s += `]\n\n`
  return s
}

function emit3DF32(name: string, values: Array<Array<Array<number>>>): string {
  let s = `export const ${name}: ReadonlyArray<ReadonlyArray<Readonly<Float32Array>>> = [\n`
  for (const grp of values) {
    s += `  [\n`
    for (const row of grp) {
      s += `    new Float32Array([${row.join(', ')}]),\n`
    }
    s += `  ],\n`
  }
  s += `]\n\n`
  return s
}

let out = `/**
 * NLayer port — Layer III precomputed tables (auto-generated).
 *
 * DO NOT EDIT. Re-run \`scripts/build-l3-tables.ts\` to regenerate from
 * the C# sources in \`tmp/nlayer-source/\`.
 *
 * Source files:
 *   - DEWINDOW, SYNTH_COS64 — LayerDecoderBase.cs
 *   - All others — LayerIIIDecoder.cs
 */

`

out += emitF32('DEWINDOW', DEWINDOW)
out += emitF32('SYNTH_COS64', SYNTH_COS64)
out += emitF32('ICOS72', ICOS72)
out += emitF32('GAIN_TAB', GAIN_TAB)
out += emitI32('PRETAB', PRETAB)
out += emitF32('POW2', POW2)
out += emitNestedI32('SF_BAND_INDEX_L', SF_BAND_INDEX_L)
out += emitNestedI32('SF_BAND_INDEX_S', SF_BAND_INDEX_S)
out += emitNestedI32('SLEN', SLEN)
out += emit3DI32('SFB_BLOCK_CNT_TAB', SFB_BLOCK_CNT_TAB)
out += emitNestedF32('IS_RATIO', IS_RATIO)
out += emit3DF32('LSF_RATIO', LSF_RATIO)
out += emitF32('SCS', SCS)
out += emitF32('SCA', SCA)

writeFileSync(OUT, out)

console.log(`Wrote tables to ${OUT}`)
console.log(`  DEWINDOW: ${DEWINDOW.length}`)
console.log(`  SYNTH_COS64: ${SYNTH_COS64.length}`)
console.log(`  ICOS72: ${ICOS72.length}`)
console.log(`  GAIN_TAB: ${GAIN_TAB.length}`)
console.log(`  PRETAB: ${PRETAB.length}`)
console.log(`  POW2: ${POW2.length}`)
console.log(
  `  SF_BAND_INDEX_L: ${SF_BAND_INDEX_L.length} × ${SF_BAND_INDEX_L[0]?.length ?? 0}`,
)
console.log(
  `  SF_BAND_INDEX_S: ${SF_BAND_INDEX_S.length} × ${SF_BAND_INDEX_S[0]?.length ?? 0}`,
)
console.log(`  SLEN: ${SLEN.length} × ${SLEN[0]?.length ?? 0}`)
console.log(
  `  SFB_BLOCK_CNT_TAB: ${SFB_BLOCK_CNT_TAB.length} × ${SFB_BLOCK_CNT_TAB[0]?.length ?? 0} × ${SFB_BLOCK_CNT_TAB[0]?.[0]?.length ?? 0}`,
)
console.log(`  IS_RATIO: ${IS_RATIO.length} × ${IS_RATIO[0]?.length ?? 0}`)
console.log(
  `  LSF_RATIO: ${LSF_RATIO.length} × ${LSF_RATIO[0]?.length ?? 0} × ${LSF_RATIO[0]?.[0]?.length ?? 0}`,
)
console.log(`  SCS: ${SCS.length}`)
console.log(`  SCA: ${SCA.length}`)
