# FlashRaw (vendored)

This directory contains a minimal, unmodified browser build of
[FlashRaw](https://github.com/ybouane/flashraw) **v0.1.0**, the WebAssembly camera
RAW decoder used by LOCALTOOLS' RAW developer page (`assets/js/raw.js`).

- Upstream package: `flashraw@0.1.0` (npm), `dist/` files below.
- License: **MIT OR Apache-2.0** — see `LICENSE-MIT` and `LICENSE-APACHE` in this
  directory.
- The files were copied byte-for-byte from the published npm package `dist/`.

## Files used at runtime

| File | Purpose | Size |
| --- | --- | --- |
| `browser.js` | browser entry point; registers fetch-based WASM loading | 3.7 KiB |
| `core.js` | format-agnostic JS API (open / metadata / decode / preview) | 50 KiB |
| `errors.js` | structured error classes (`err.kind`) | 3.0 KiB |
| `threads.js` | imported unconditionally by `core.js`; only the single-threaded code path is used here | 9.2 KiB |
| `flashraw_bindgen.js` | wasm-bindgen glue for the single-threaded binaries | 24 KiB |
| `flashraw_simd.wasm` | single-threaded SIMD128 build (default) | 2.83 MiB |
| `flashraw.wasm` | single-threaded scalar build (fallback when SIMD is unavailable) | 2.78 MiB |

`threads.js` is required at import time even though LOCALTOOLS explicitly calls
`init({ threads: false })` and does not use the threaded WASM build. The threaded
worker/binary, WebGPU and JPEG XL variants are intentionally **not** vendored; the
page also passes `jpegxl: 'never'`, so JPEG XL DNGs report a clear
"unsupported compression" message instead of fetching a missing asset.

## Provenance / integrity

Package tarball: `flashraw-0.1.0.tgz` from npm. The wasm files are served as
`application/wasm` by the static server; `assets/js/raw.js` initialises the decoder
with `baseUrl` pointing at this directory, so all requests stay on the local origin.
No image data is sent anywhere.
