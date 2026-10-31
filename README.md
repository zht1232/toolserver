# LOCALTOOLS

一个以浏览器本地处理为主的工具箱，包含音乐、格式转换、开发辅助和文本处理等功能。音乐解密与歌词匹配已合并到同一页面，可分别开关；支持自动匹配或上传歌词、MP3 / FLAC 内嵌、图片压缩、浏览器本地自动水印检测与 AI 修补，以及建议反馈。另有「HIF / HEIF 转 JPEG」页：批量把相机 HDR HIF 转成 sRGB JPEG，默认在浏览器本地用 WebAssembly 解码并做 BT.2020/PQ/HLG 到 sRGB 的色彩管理与高光压缩，图片不上传；仅当用户开启服务器兜底且本地解码失败时，才由 `server.py` 在内存中兜底转换、不落盘。另有「多源音乐下载」页：默认并行检索网易云、QQ音乐、酷狗、汽水音乐、千千、5sing 六个音源，服务器上的 go-music-dl 只做搜索与直链解析，浏览器直连各平台 CDN 下载，音频不经服务器、不存服务器；会员曲、版权下架曲或平台限制曲可能没有可下载直链，可用「换源搜索」在全部音源中找替代版本。另有「专业修图」页：基于 MIT 开源的 BitMappery，提供图层、图层蒙版、画笔、选区、文字、特效、撤销重做、PSD 导入与图片导出；以及「Camera Raw」页：基于 MIT/Apache-2.0 的 FlashRaw WASM 解码 RAW，提供曝光、高光/阴影、色温、带动态直方图的 RGB/红/绿/蓝点曲线与参数曲线、裁剪/旋转/拉直、手动镜头畸变/暗角/色差校正、亮度/色彩降噪、最多 8 个可独立叠加且随裁剪/旋转保持贴合的线性/径向/画笔/AI 主体/AI 天空蒙版，以及可点击回到任意步骤的完整历史记录。AI 主体与 AI 天空使用本地 PP-MobileSeg Base（ADE20K）语义分割模型，可识别人物、动物与天空（首次按需加载约 35 MB，之后由浏览器缓存）；模型不可用时回退到构图或颜色识别。两个工作区都在浏览器本地运行，不上传图片。界面为亮色主题（暖纸张底 + 深青绿强调色），支持顶栏工具搜索与移动端导航。

## 本地预览

需要 Python 3；静态托管、歌词代理、反馈接口和浏览器 AI 文件下发使用 Python 标准库。HIF 页默认在浏览器本地转换，无需服务器依赖；可选的服务器兜底需要 Python 3.10+ 和 `requirements.txt`（Pillow / pillow-heif / NumPy）。浏览器本地 AI 需要 MI-GAN / YOLO11 模型及 ONNX Runtime Web 1.30.0 WebGPU 文件。将这些大文件放在站点静态目录之外的 `/home/zht/localtools-models/`（或设置 `LOCALTOOLS_AI_MODEL_DIR`）；API 会按 allowlist 提供给浏览器，不将权重提交进 Git。图片与遮罩不会上传，服务器不执行 AI 推理。Camera Raw 的 AI 蒙版使用随站点部署的 PP-MobileSeg Base ONNX 模型与 ONNX Runtime Web 1.22.0 WASM（`assets/vendor/ai-segmentation/`、`assets/vendor/onnxruntime-web/`，合计约 35 MB），首次使用时按需加载并缓存在浏览器。HIF 浏览器解码器（libheif-js WASM，约 1.4 MB）随站点放在 `assets/vendor/libheif/`，首次转换时按需加载并缓存。参考 [第三方声明](THIRD_PARTY_NOTICES.md)。

```sh
python3 -m pip install -r requirements.txt   # 仅 HIF 服务器兜底需要；不装则浏览器本地转换仍可用
python3 server.py 8000
```

然后打开 <http://localhost:8000>。Windows 也可以运行 `py server.py 8000`。没有 AI 依赖或模型时，其余站点功能仍可用，AI 修补会显示服务未就绪；没有 HIF 依赖时，浏览器本地转换仍然可用，只是服务器兜底会提示不可用。多源音乐解析依赖服务器上运行中的 go-music-dl（`music-dl.service`，仅本机搜索/解析、不转发音频）；未运行时该页会提示解析服务不可用，纯静态托管下多源音乐页不可用。

也可以将 `index.html` 和 `assets/` 部署到任意静态 Web 服务器。使用 `file://` 直接打开时，依赖 `fetch` 的功能可能无法工作；静态部署下，浏览器本地 HIF 转换仍可用，依赖本地 API 的增强功能（服务器兜底等）不可用。

## 隐私与联网

音乐解密、常规图片转换压缩和文本处理在浏览器中完成。AI 水印检测与修补也在浏览器本地运行；模型只在需要时下载并缓存在当前浏览器，图片与遮罩不会上传。HIF/HEIF 的 10-bit HDR 解码默认在浏览器本地用 WebAssembly 完成，图片不上传；只有用户勾选服务器兜底且本地解码失败时，所选文件才会临时上传到运行 `server.py` 的服务器，仅在内存中转换、不落盘；普通静态托管下该兜底不可用。多源音乐下载页只向 `server.py` 请求搜索与直链元数据，音频字节由浏览器直接从各音源 CDN 取走并保存到本机；服务器不转发、不保存歌曲，也不绕过会员或 DRM 限制。专业修图与 Camera Raw 页的图片、图层、蒙版、智能识别和 RAW 数据只在浏览器内存/Canvas/WASM 中处理，不上传服务器；AI 主体与 AI 天空使用站点自托管的 PP-MobileSeg Base 模型和 ONNX Runtime Web 在浏览器内推理，识别失败时分别回退到构图识别与颜色/连通域识别，两种蒙版都可再用画笔修整。歌词搜索会向歌词服务发送歌名和歌手名；建议反馈会把用户主动填写的文字与可选联系方式保存到站点目录之外的本地文件 `localtools-feedback.jsonl`。

## 项目文件

- `index.html`：单页应用和工具页面
- `assets/style.css`：页面样式
- `assets/js/`：路由及各工具的 JavaScript 模块
- `assets/js/musicfast.js`：多源音乐下载（全部音源聚合 + 换源搜索；服务端只做搜索/直链解析，浏览器直连 CDN 保存）
- `assets/js/hif-worker.js`：HIF/HEIF 浏览器本地解码与色调映射 Worker
- `assets/vendor/libheif/`：libheif-js WASM 解码器与 LGPL-3.0 许可证/来源说明
- `editor/`：BitMappery（MIT）专业修图工作区构建产物与许可证/修改说明
- `assets/js/raw.js` + `assets/raw.css`：Camera Raw 风格 RAW 显影界面与 WebGL2 处理管线
- `assets/vendor/flashraw/`：FlashRaw WASM RAW 解码器（MIT OR Apache-2.0）
- `assets/vendor/ai-segmentation/`：PP-MobileSeg Base（ADE20K）ONNX 语义分割模型，用于 AI 主体（人物/动物）与 AI 天空（Apache-2.0，按需加载）
- `assets/vendor/onnxruntime-web/`：ONNX Runtime Web 1.22.0 WASM 运行时（MIT，按需加载）
- `server.py`：本地静态服务器和可选 API 代理（含 HIF 服务器兜底）
- `hif_convert.py`：HIF/HEIF HDR → sRGB JPEG 色彩管理与转换（服务器兜底）
- `requirements.txt`：HIF 转换的可选 Python 依赖（Pillow / pillow-heif / NumPy）
- `assets/js/watermark-local.js`：ONNX Runtime Web 水印检测与浏览器本地修补
- `HANDOFF.md`：完整工具清单、实现约定、已知缺口及交接记录

更多开发背景和当前已知限制见 [HANDOFF.md](HANDOFF.md)。
