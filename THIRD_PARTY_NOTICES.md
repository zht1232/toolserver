# Third-party notices

## go-music-dl (multi-source music download)

The "多源音乐下载" page embeds the Web UI of [guohuiyuan/go-music-dl](https://github.com/guohuiyuan/go-music-dl) (v1.1.2), reverse-proxied by `server.py` under `/music/*` to a local `music-dl` service (systemd unit `music-dl.service`, listening on `127.0.0.1:8080` only). The platform search/download parsing logic lives in the upstream library [guohuiyuan/music-lib](https://github.com/guohuiyuan/music-lib).

Both projects are licensed under **GNU Affero General Public License v3.0**. The binary is run unmodified on the self-hosted server; no source of go-music-dl or music-lib is vendored into this repository. Because the site offers network access to the software, the AGPL-3.0 copyleft terms apply to any modified version served over the network — keep the service unmodified, or publish the corresponding complete source. Downloading copyrighted music may violate platform terms and local law; the feature is intended for personal, non-commercial use only.

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
