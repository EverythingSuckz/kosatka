# Kosatka

A browser-based stem mixer for Grand Theft Auto V audio. Drop in an `.awc`
(or a `.rpf` archive to browse for one), and Kosatka decodes the individual
music stems and lays them out on a timeline you can mute, balance, automate,
and export. Everything runs in your browser. Nothing is uploaded.

It is named after the Kosatka, the submarine you run the Cayo Perico heist
from, whose soundtrack was the reason this project started.

## What it does

- Opens GTA V `.awc` audio containers and `.rpf` game archives entirely in the browser.
- Decodes the MP3 stems (the Cayo Perico heist tracks are 16-stem, per-block encrypted).
- Presents each stereo pair as a channel on a timeline: toggle on/off, set level, adjust stereo spread, and draw gain automation with keyframes.
- Exports the current mix as a WAV, or the individual stems as a ZIP.
- Works fully offline and installs as a PWA.

### Screenshots

<img width="2314" height="1328" alt="image" src="https://github.com/user-attachments/assets/397ccd9e-7a28-442c-835c-7e99c75cf120" />
<img width="2300" height="1320" alt="image" src="https://github.com/user-attachments/assets/c74e3f2b-30e9-4346-b1d7-a32d8b50c6ef" />

## Ownership and keys

Kosatka does not ship any Rockstar audio, and it cannot decrypt anything on
its own. To derive the decryption key it asks you, once, for your own
`gta5_enhanced.exe` (or `gta5.exe` on legacy editions). The key is computed
locally in your browser and stored only on your device. It is never
transmitted anywhere.

The repository does include `public/magic.dat`, the same obfuscated
key-derivation blob CodeWalker uses. It is inert on its own: without the bytes
from your own game executable it yields nothing usable.

You need a legitimate copy of the game to use this tool.

## How it works

The pipeline mirrors CodeWalker and OpenIV, reimplemented for the browser:

1. **Keys** are derived from your game exe combined with `magic.dat` (`src/keys`).
2. **RPF7** archives are parsed and NG-decrypted to reach the `.awc` inside (`src/rpf`).
3. **AWC** containers are parsed into per-stream metadata and byte ranges (`src/awc`).
4. **MP3** stems are decoded by a from-scratch MPEG-1 Layer III decoder, ported and verified bit-exact against the reference (`src/codecs/nlayer`).
5. **Mixing** happens on the Web Audio graph, with the timeline, automation, and export built on top (`src/mixer`).

## Quick start

Requires [Bun](https://bun.sh).

```sh
bun install
bun run dev      # http://localhost:3000
```

Other scripts:

```sh
bun test         # run the test suite (bun:test)
bun run lint     # eslint
bun run build    # production build + service worker
```

## Build and deploy

```sh
bun run build
```

The build runs Vite, then `scripts/build-sw.ts`, which generates the service
worker and writes the SPA shell. The output is fully static: there is no server
runtime. `wrangler.jsonc` deploys it to Cloudflare as static assets with an
SPA fallback (`bun run deploy`).

## Tech stack

TanStack Start (SPA mode) and TanStack Router, React 19, Tailwind CSS v4, Vite,
and Bun. Audio runs on the Web Audio API with stem decoding offloaded to
workers.

## Project layout

```
src/awc          AWC container parser
src/rpf          RPF7 archive parser + NG decryption
src/keys         key derivation from the game exe + magic.dat
src/codecs       MPEG-1 Layer III decoder (nlayer port) + worker
src/mixer        Web Audio engine, timeline, automation, export
src/routes       drop page, mix editor, rpf explorer
src/settings     preferences + settings modal
src/persistence  IndexedDB session and key storage
```

## Limitations

- Whole-file XXTEA-encrypted AWCs are not supported yet; the encrypted
  per-block and NG paths are.
- Best experienced in Chromium browsers, which have the most complete Web Audio
  and worker support.

## Credits

Format and cryptography research stands on the shoulders of
[CodeWalker](https://github.com/dexyfex/CodeWalker) and OpenIV.

## License

MIT. See [LICENSE](LICENSE).

The MIT license covers Kosatka's own source. It grants no rights to Grand Theft
Auto V or any Rockstar Games assets. See "Ownership and keys" above.
