PP-MobileSeg Base (ADE20K) — AI scene segmentation model
=========================================================

Model
-----
PP-MobileSeg Base, trained on ADE20K (150 semantic classes), from the
PaddleSeg project (release 2.8 model zoo). Upstream project:
  https://github.com/PaddlePaddle/PaddleSeg
Model card / config:
  https://github.com/PaddlePaddle/PaddleSeg/tree/release/2.8/configs/pp_mobileseg
Paper:
  https://arxiv.org/abs/2304.05152

The model was exported from the official Paddle inference archive
(internal folder MV3_4stage_AAMSx8_valid_0321: model.pdmodel /
model.pdiparams / deploy.yaml) to ONNX with paddle2onnx 2.1.0 and
PaddlePaddle 3.1.1. The exported graph produces one int32 class map of
shape [1, 512, 512]. Input is NCHW float32, 512x512, normalized with
mean (0.485, 0.456, 0.406) and std (0.229, 0.224, 0.225), matching the
original deploy.yaml.

Classes used by this site
-------------------------
ADE20K class indices: 2 = sky, 12 = person, 126 = animal. The browser
builds binary masks for these classes; no other classes are exposed.

License
-------
PaddleSeg and this model are distributed under the Apache License 2.0.
The full license text is in LICENSE. ADE20K is a research dataset
released by MIT CSAIL; see the ADE20K terms for dataset usage. This site
only ships the converted model weights and does not redistribute the
dataset.

Runtime behavior
----------------
The ONNX file is served by this site and loaded on demand only when the
visitor creates an AI subject or AI sky mask. Inference runs entirely in
the visitor's browser through ONNX Runtime Web (WASM backend). Images
and generated masks are not uploaded. The model is not fine-tuned or
modified beyond the Paddle-to-ONNX export.
