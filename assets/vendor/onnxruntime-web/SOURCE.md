# ONNX Runtime Web (local vendor)

- Package: `onnxruntime-web` 1.22.0 (npm).
- Upstream: https://github.com/microsoft/onnxruntime
- Files:
  - `ort.wasm.min.mjs` — browser ES module bundle (WASM backend).
  - `ort-wasm-simd-threaded.mjs` — WASM loader.
  - `ort-wasm-simd-threaded.wasm` — SIMD WASM runtime.
- License: MIT. Copyright (c) Microsoft Corporation. Full text in `LICENSE`.

Only these three files are vendored; no CDN is contacted at runtime. The
site loads them on demand for local AI segmentation. Inference stays in
the visitor's browser; images and masks are not uploaded. The files are
unmodified upstream binaries.
