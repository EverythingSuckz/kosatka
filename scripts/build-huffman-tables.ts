/**
 * scripts/build-huffman-tables.ts
 *
 * Reads `tmp/nlayer-source/NLayer/Decoder/Huffman.cs` and emits the 17
 * Huffman code-tables verbatim into `src/codecs/nlayer/huffman-tables.ts`.
 *
 * Each table in the C# source is a `byte[,]` literal of two-byte rows.
 * Row 0 of a row indicates a leaf (and the second byte is the value);
 * non-zero indicates a "next pointer" plus the bit value at element [,1].
 * This script doesn't interpret that semantics, it just copies the raw
 * (skip, value) pairs as JS-side flat Uint8Array entries. The decoder
 * uses those bytes exactly the way upstream's `InitTable` does.
 *
 * The C# source labels each table with a `// N` comment (1, 2, 3, 5,
 * 6, 7, ..., 24, 32, 33). We preserve those table numbers as-is.
 *
 * Run with: bun run scripts/build-huffman-tables.ts
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SOURCE = resolve('tmp/nlayer-source/NLayer/Decoder/Huffman.cs')
const OUT = resolve('src/codecs/nlayer/huffman-tables.ts')

const src = readFileSync(SOURCE, 'utf-8')

// Find the start of the `_codeTables` initializer and the matching `};`.
const startMarker = 'static readonly byte[][,] _codeTables ='
const startIdx = src.indexOf(startMarker)
if (startIdx === -1) throw new Error('Could not find _codeTables in Huffman.cs')

// Find the end (matching `};` two braces deep). We bracket-match `{` and `}`.
let i = src.indexOf('{', startIdx)
if (i === -1) throw new Error('No opening brace')
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
if (end === -1) throw new Error('Could not match closing brace')

const block = src.slice(startIdx, end + 1)

// Parse each table: split on `new byte[,]` and look at the body between
// the corresponding `{` and `}`. Each table is preceded by a `// N`
// comment giving its number.
const tables: Array<{ number: number; rows: Array<[number, number]> }> = []
const tableRegex = /\/\/\s*(\d+)\s*\n\s*\{([\s\S]*?)\n\s*\}/g
let m: RegExpExecArray | null
while ((m = tableRegex.exec(block)) !== null) {
  const num = parseInt(m[1]!, 10)
  const body = m[2]!
  const rows: Array<[number, number]> = []
  const rowRegex = /\{\s*0x([0-9a-fA-F]+)\s*,\s*0x([0-9a-fA-F]+)\s*\}/g
  let r: RegExpExecArray | null
  while ((r = rowRegex.exec(body)) !== null) {
    rows.push([parseInt(r[1]!, 16), parseInt(r[2]!, 16)])
  }
  if (rows.length > 0) tables.push({ number: num, rows })
}

if (tables.length !== 17) {
  throw new Error(`Expected 17 tables, parsed ${tables.length}`)
}

// Emit.
let out = `/**
 * NLayer port — Huffman code tables (auto-generated).
 *
 * DO NOT EDIT. Re-run \`scripts/build-huffman-tables.ts\` to regenerate
 * from \`tmp/nlayer-source/NLayer/Decoder/Huffman.cs\`.
 *
 * Each table is a flat \`Uint8Array\` of (skip, value) byte pairs — i.e.
 * row count is \`.length / 2\`. The interpretation mirrors upstream
 * \`InitTable\`: if skip === 0 the row is a leaf and \`value\` is the
 * code's payload; otherwise the row is an internal node and \`skip\` is
 * the distance to its right child (the left child is at \`idx + 1\`).
 *
 * The outer \`HUFFMAN_TABLES\` array is indexed 0..16. The 17→33-index
 * mapping the decoder uses lives in \`huffman.ts\` (see \`getNode\`).
 */

export const HUFFMAN_TABLES: ReadonlyArray<Readonly<Uint8Array>> = [
`

for (const { number, rows } of tables) {
  out += `  // table ${number} (${rows.length} rows)\n`
  out += `  new Uint8Array([\n`
  for (let k = 0; k < rows.length; k += 8) {
    const slice = rows.slice(k, k + 8)
    out += `    ${slice.map((p) => `0x${p[0].toString(16).padStart(2, '0')}, 0x${p[1].toString(16).padStart(2, '0')}`).join(', ')},\n`
  }
  out += `  ]),\n`
}

out += `]\n\n// Table numbers in upstream order (parallels HUFFMAN_TABLES indices)\n`
out += `export const HUFFMAN_TABLE_NUMBERS: ReadonlyArray<number> = [${tables.map((t) => t.number).join(', ')}]\n`

writeFileSync(OUT, out)
console.log(`Wrote ${tables.length} tables to ${OUT}`)
console.log(`Table sizes: ${tables.map((t) => t.rows.length).join(', ')}`)
