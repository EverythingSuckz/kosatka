/**
 * Barrel for the RPF7 archive reader. See `./parser.ts` for the main API
 * surface, `./types.ts` for the shapes, `./feistel.ts` for the NG cipher,
 * and `./crypto.ts` for the AES helper.
 */

export { openRpf } from './parser'
export type { NgKeys } from './parser'
export {
  RpfParseError,
  RPF7_VERSION,
  RPF_ENC_AES,
  RPF_ENC_NG,
  RPF_ENC_NONE,
  RPF_ENC_OPEN,
} from './types'
export type { RpfArchive, RpfEntry, RpfEncryption, RpfSource } from './types'
export { setRpfAesKey, clearRpfAesKey, decryptAesWithKey } from './crypto'
export {
  buildNgContext,
  buildNgSubKeys,
  buildNgTables,
  decryptNg,
} from './feistel'
export type { NgContext } from './feistel'
export { gta5Hash, ngKeyIndex } from './gta5-hash'
