# Third-party notices

## MI-GAN image inpainting model

The optional server-side watermark repair uses the `migan_pipeline_v2.onnx` weights from [Picsart-AI-Research/MI-GAN](https://github.com/Picsart-AI-Research/MI-GAN). The model weights are not included in this repository. The upstream repository distributes the weights under the MIT License; retain its `LICENSE-WEIGHTS` file alongside the model when installing it.

The model is stored outside the web document root and loaded by `watermark_ai.py` through ONNX Runtime. The Python package versions used on the ARM64 server are pinned in `requirements-ai.txt`.

## YOLO11 visible-watermark detector

Automatic whole-image detection uses `ayan4m1/Watermark-Detection-YOLO11-ONNX`, trained on the `bastienp/visible-watermark-pita` dataset. The model card identifies the model as AGPL-3.0 and the ONNX file is not included in this repository; the self-hosted copy is pinned by SHA-256 `f3638870eedb2ac4ea202d25da35ac2ae520ba33d572479d1d9cfc671aaa253e`. Review the model's [license and model card](https://huggingface.co/ayan4m1/Watermark-Detection-YOLO11-ONNX) before monetizing the hosted service.

## ONNX Runtime Web

The browser-local inference option serves the unmodified ONNX Runtime Web 1.30.0 WebGPU distribution from a runtime directory outside the web root. Its upstream source and [MIT license](https://github.com/microsoft/onnxruntime/blob/main/LICENSE) are available at microsoft/onnxruntime. The runtime files are not included in this repository; installation is documented in `HANDOFF.md`.

MIT License

Copyright (c) Microsoft Corporation

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
