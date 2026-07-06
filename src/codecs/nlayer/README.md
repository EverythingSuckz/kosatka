# nlayer — TS port of the NLayer MP3 decoder

TypeScript port of the C# [NLayer](https://github.com/naudio/NLayer)
(JLayer-lineage) MPEG-1 Layer III decoder. Bit-exact against
upstream NLayer; the only known decoder family that handles
Rockstar's AWC MP3 streams without dropping frames on ch7+. Wired
into the live mixer via `src/codecs/mp3.ts` + `mp3-worker.ts`. See
`docs/decoder.md` for the surrounding pipeline and the cross-decoder
investigation that led here.

Source: <https://github.com/naudio/NLayer> (MIT).

## Files

| File                    | Purpose                                   | Source                                                |
| ----------------------- | ----------------------------------------- | ----------------------------------------------------- |
| `types.ts`              | Enums + `IMpegFrame` interface            | `NLayer/Enums.cs`                                     |
| `bit-reservoir.ts`      | 8192-byte ring buffer + bit cursor        | `Decoder/BitReservoir.cs`                             |
| `stream-reader.ts`      | Random-access byte source                 | (minimal in-memory utility)                           |
| `frame-base.ts`         | Frame offset / length / saved buffer      | `Decoder/FrameBase.cs`                                |
| `mpeg-frame.ts`         | MPEG header parse + bit reader            | `Decoder/MpegFrame.cs`                                |
| `mpeg-stream-reader.ts` | Frame sync walk + linked list             | `Decoder/MpegStreamReader.cs` (streamlined)           |
| `huffman.ts`            | `decodePair` / `decodeQuad` + table cache | `Decoder/Huffman.cs`                                  |
| `huffman-tables.ts`     | 17 raw code tables                        | auto-generated                                        |
| `layer-decoder-base.ts` | Polyphase synthesis filter                | `Decoder/LayerDecoderBase.cs`                         |
| `l3-tables.ts`          | 14 LIII precomputed tables                | auto-generated                                        |
| `hybrid-mdct.ts`        | Long / short / mixed IMDCT + overlap-add  | `Decoder/LayerIIIDecoder.cs` (HybridMDCT inner class) |
| `layer-iii-decoder.ts`  | `DecodeFrame` orchestrator                | `Decoder/LayerIIIDecoder.cs`                          |

## Generators

- `scripts/build-huffman-tables.ts` — parses upstream `Huffman.cs`, emits
  `huffman-tables.ts`.
- `scripts/build-l3-tables.ts` — parses upstream `LayerDecoderBase.cs` +
  `LayerIIIDecoder.cs`, emits `l3-tables.ts`.

Both expect the upstream C# source cloned to `tmp/nlayer-source/`. Re-run
whichever script when upstream changes.

## JS porting gotchas

- **Signed-int32 bitwise**: every sync-bit compare against constants
  > 0x7FFFFFFF needs `>>> 0`.
- **MPEG version arithmetic**: V2.5 (=25) uses
  `Math.min(Math.floor(version/10)-1, 1)` for the bitrate row index.
- **CRC offset**: Rockstar streams have CRC; bit reader starts at byte
  6, not 4.
- **Verbatim variable names**: keep `gr`, `ch`, `sb`, `ss`, `sfBand`
  etc. identical to upstream so future cross-check diffs stay tractable.
- **Float32 precision**: `Math.fround` around intermediate arithmetic in
  tight DSP loops matches C# `float` semantics.
- **Float32Array indexed access**: with `noUncheckedIndexedAccess` TS
  returns `T | undefined`; every read needs `!`.
- **Huffman tree continuation pointers**: `tree[i,j]` is NOT always
  `{skip, 1}` for internal nodes. Read both bytes; `>= 250` means
  continuation. (This was the single bug that hid the port; see
  `docs/decoder.md` §4.)
