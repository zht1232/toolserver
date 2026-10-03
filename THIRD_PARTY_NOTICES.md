# Third-party notices

## MI-GAN image inpainting model

The optional server-side watermark repair uses the `migan_pipeline_v2.onnx` weights from [Picsart-AI-Research/MI-GAN](https://github.com/Picsart-AI-Research/MI-GAN). The model weights are not included in this repository. The upstream repository distributes the weights under the MIT License; retain its `LICENSE-WEIGHTS` file alongside the model when installing it.

The model is stored outside the web document root and loaded by `watermark_ai.py` through ONNX Runtime. The Python package versions used on the ARM64 server are pinned in `requirements-ai.txt`.
