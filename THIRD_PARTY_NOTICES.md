# Third-party notices

## BitMappery (professional editor)

The "专业修图" workspace is a self-hosted build of [BitMappery](https://github.com/igorski/bitmappery) 1.2.0, licensed under the MIT License. It provides layers, layer masks, brushes, selections, text, non-destructive effects, history, PSD import and image export. Our build changes the theme, adds Chinese labels, removes/hides cloud-storage entry points and disables Google Fonts loading; the upstream copyright and MIT license are included in `editor/LICENSE`. All editing happens in the browser; the editor does not upload images to our server.

## FlashRaw (RAW decoder)

The "Camera Raw" page uses [FlashRaw](https://github.com/ybouane/flashraw) 0.1.0, licensed under MIT OR Apache-2.0, as a WebAssembly RAW decoder. The browser-served WASM assets are unmodified; both license texts are included in `assets/vendor/flashraw/`. Raw files are decoded and developed locally in the browser and are never uploaded.

## PP-MobileSeg Base and ONNX Runtime Web (AI subject / sky masks)

The Camera Raw page's "AI 主体" and "AI 天空" masks use the following unmodified assets, vendored under `assets/vendor/ai-segmentation/` and `assets/vendor/onnxruntime-web/` and loaded on demand:

- [PP-MobileSeg Base (ADE20K)](https://github.com/PaddlePaddle/PaddleSeg/tree/release/2.8/configs/pp_mobileseg) from PaddleSeg — Apache License 2.0. The official Paddle inference model (`MV3_4stage_AAMSx8_valid_0321`) was exported to ONNX with paddle2onnx 2.1.0; input 1×3×512×512, output int32 512×512 class map. ADE20K classes 2 (sky), 12 (person) and 126 (animal) are used.
- [ONNX Runtime Web 1.22.0](https://github.com/microsoft/onnxruntime) — MIT License. The browser module `ort.wasm.min.mjs`, loader `ort-wasm-simd-threaded.mjs` and SIMD WASM runtime are served from this site.

The Apache License 2.0 text and model provenance are included at `assets/vendor/ai-segmentation/LICENSE`, `NOTICE` and `SOURCE.md`; the MIT text and runtime provenance are at `assets/vendor/onnxruntime-web/LICENSE` and `SOURCE.md`. Nothing is fetched from a third-party CDN. Inference runs in the visitor's browser (single-threaded WASM when cross-origin isolation is unavailable); images and generated masks are not uploaded. The site does not fine-tune or otherwise modify the upstream model or runtime.

## go-music-dl (internal metadata/URL resolver)

The "多源音乐下载" page uses the unmodified [go-music-dl](https://github.com/guohuiyuan/go-music-dl) v1.1.3 binary on the self-hosted server (systemd `music-dl.service`, listening only on 127.0.0.1:8080). The site calls only its `/music/search` HTML and `/music/inspect` JSON endpoints to resolve metadata and CDN URLs; it does not embed or proxy the upstream UI and does not use the upstream download endpoint. Audio bytes are fetched by the visitor's browser directly from the source CDN and are never relayed or stored by the server. go-music-dl and its [music-lib](https://github.com/guohuiyuan/music-lib) are licensed under AGPL-3.0; the binary is unmodified. Downloading copyrighted music may violate platform terms and local law; personal, non-commercial use only.

## HIF / HEIF conversion libraries

### Browser-local decoder (default path)

The default HIF/HEIF conversion runs entirely in the browser using the **libheif-js 1.19.8** Emscripten/WASM bundle vendored at `assets/vendor/libheif/libheif-bundle.js`:

- [libheif-js](https://github.com/catdad-experiments/libheif-js) — npm wrapper/bundle; the bundle embeds [libheif](https://github.com/strukturag/libheif) 1.23.5 and [libde265](https://github.com/strukturag/libde265) for HEVC decoding. Both libraries are licensed under **LGPL-3.0**.
- The bundle is served unmodified from this site and executed in the visitor's browser. HIF files decoded by this path never leave the device and are not sent to the server.
- The full LGPL-3.0 text and attribution are included in [`assets/vendor/libheif/LICENSE.txt`](assets/vendor/libheif/LICENSE.txt) and [`assets/vendor/libheif/NOTICE.txt`](assets/vendor/libheif/NOTICE.txt). To exercise the LGPL relinking right, rebuild libheif-js from the upstream sources above and replace `libheif-bundle.js`; the rest of the site has no compiled linkage to the WASM.

### Optional server-side fallback

The optional server-side HIF/HEIF converter uses the following Python packages, installed from PyPI and not vendored into this repository:

- [Pillow](https://python-pillow.org/) — MIT-CMU / HPND license ([source](https://github.com/python-pillow/Pillow)).
- [pillow-heif](https://github.com/bigcat88/pillow_heif) — BSD-3-Clause license; its wheels include [libheif](https://github.com/strukturag/libheif) (LGPL-3.0) and may include libde265 (LGPL-3.0) for HEVC decoding.
- [NumPy](https://numpy.org/) — BSD-3-Clause license.

These libraries run only on the self-hosted server when the visitor explicitly enables the fallback and local decoding fails. Uploaded HIF files are decoded in memory, not written to disk, and are not redistributed. If you redistribute a server image containing these libraries, comply with the LGPL-3.0 terms for libheif/libde265, including providing the corresponding source or a written offer as required.

## MI-GAN image inpainting model

Browser-local watermark repair uses the `migan_pipeline_v2.onnx` weights from [Picsart-AI-Research/MI-GAN](https://github.com/Picsart-AI-Research/MI-GAN). The model weights are not included in this repository. The upstream repository distributes the weights under the MIT License; retain its `LICENSE-WEIGHTS` file alongside the model when installing it.

The model is stored outside the web document root and downloaded by the browser through the allowlisted `/api/ai/models/inpainter` endpoint. Inference runs in the browser with ONNX Runtime Web; the image and mask remain on the user's device.

## YOLO11 visible-watermark detector

Automatic whole-image detection uses `ayan4m1/Watermark-Detection-YOLO11-ONNX`, trained on the `bastienp/visible-watermark-pita` dataset. The model card identifies the model as AGPL-3.0 and the ONNX file is not included in this repository; the self-hosted copy is pinned by SHA-256 `f3638870eedb2ac4ea202d25da35ac2ae520ba33d572479d1d9cfc671aaa253e`. Review the model's [license and model card](https://huggingface.co/ayan4m1/Watermark-Detection-YOLO11-ONNX) before monetizing the hosted service.

## ONNX Runtime Web

The browser-local inference option serves the unmodified ONNX Runtime Web 1.30.0 WebGPU distribution from a runtime directory outside the web root. Its upstream source and [MIT license](https://github.com/microsoft/onnxruntime/blob/main/LICENSE) are available at microsoft/onnxruntime. The runtime files are not included in this repository; installation is documented in `HANDOFF.md`.

MIT License

Copyright (c) Microsoft Corporation

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
