# MediaPipe Selfie Segmenter (local vendor)

- Runtime: `vision_bundle.js` from `@mediapipe/tasks-vision` 0.10.21
  (originally `vision_bundle.mjs`, only the file extension was changed so that
  simple static hosts serve it as JavaScript).
- WASM runtime: `wasm/vision_wasm_internal.js` and
  `wasm/vision_wasm_internal.wasm` (SIMD build) from the same package.
- Model: `selfie_segmenter.tflite`, MediaPipe Selfie Segmenter float16 v1,
  downloaded from the official MediaPipe model storage.
- Licenses: Apache License 2.0. Upstream project:
  https://github.com/google-ai-edge/mediapipe
- Model card / model repository:
  https://github.com/google-ai-edge/mediapipe/tree/master/mediapipe/modules/selfie_segmentation
- Attribution: see `NOTICE`; the full Apache License 2.0 text is in `LICENSE`.

The files are served by the site and loaded on demand only when the visitor
creates an AI person mask. Inference runs entirely in the browser; no image or
mask is uploaded. The site does not modify the upstream binaries or model.
