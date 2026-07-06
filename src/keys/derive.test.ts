/**
 * End-to-end derivation test. Reads gta5_enhanced.exe + public/magic.dat from
 * disk and runs the full pipeline. Asserts the derived key matches the
 * known-good key in samples/.awc_key.json (which we extracted via CodeWalker
 * during Phase 0).
 *
 * Skipped automatically if any of the three input files is missing.
 */

import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, test } from 'bun:test'

import { deriveAwcKeyFromBytes } from './derive'

const EXE_PATH = 'E:/Games/GTAVEnhanced/GTA5_Enhanced.exe'
const MAGIC_PATH = 'public/magic.dat'
const KEY_PATH = 'samples/.awc_key.json'

const HAS_INPUTS =
  existsSync(EXE_PATH) && existsSync(MAGIC_PATH) && existsSync(KEY_PATH)

describe.if(HAS_INPUTS)('deriveAwcKeyFromBytes: full pipeline', () => {
  test('derives the same PC_AWC_KEY as CodeWalker', async () => {
    const exe = HAS_INPUTS
      ? new Uint8Array(readFileSync(EXE_PATH))
      : new Uint8Array(0)
    const magic = HAS_INPUTS
      ? new Uint8Array(readFileSync(MAGIC_PATH))
      : new Uint8Array(0)
    const expectedJson = JSON.parse(readFileSync(KEY_PATH, 'utf-8')) as {
      PC_AWC_KEY: Array<string>
    }
    const expected = new Uint32Array(
      expectedJson.PC_AWC_KEY.map((s) => parseInt(s, 16) >>> 0),
    )

    const derived = await deriveAwcKeyFromBytes(exe, magic)

    expect(derived.length).toBe(4)
    for (let i = 0; i < 4; i++) {
      expect(derived[i]!.toString(16).padStart(8, '0')).toBe(
        expected[i]!.toString(16).padStart(8, '0'),
      )
    }
  }, 120000) // 2 min timeout, exe scan can be slow
})
