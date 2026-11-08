# AI 降噪模型来源（DnCNN）

- **模型**：DnCNN（17 层残差去噪卷积网络，预测噪声残差并从输入中减去）。
- **训练权重**：KAIR — https://github.com/cszn/KAIR （Kai Zhang，MIT License，2019）。
  论文：Zhang et al., "Beyond a Gaussian Denoiser: Residual Learning of Deep CNN
  for Image Denoising", IEEE TIP 2017。该权重针对 sigma=25 高斯噪声、灰度图训练。
- **ONNX 导出**：Qualcomm AI Hub Models — https://huggingface.co/qualcomm/DnCNN
  （MIT License），发布资产 `dncnn-onnx-float.zip`（v0.66.0，ONNX Runtime 1.27.1 /
  QAIRT 2.50）。原始包为 `dncnn.onnx`（图）+ `dncnn.data`（外部权重）。
- **本地修改**：用 `onnx` 将外部权重合并进单一自包含 `dncnn.onnx`（约 2.3 MB），
  便于浏览器 ONNX Runtime Web 直接加载；未改动网络结构或权重数值。
- **张量规格**：输入 `image` float32 [1,1,256,256]，灰度，取值 [0,1]；
  输出 `denoised_image` float32 [1,1,256,256]（已去噪结果，非残差）。opset 21。
- **本站用法**：在浏览器本地对显影后图像的亮度（luma）通道做 256×256 重叠分块推理，
  按强度与原图混合；图片不上传服务器。首次使用按需加载并由浏览器缓存。
- **许可**：MIT（见 LICENSE）。运行时 ONNX Runtime Web 的许可见
  `assets/vendor/onnxruntime-web/LICENSE`。