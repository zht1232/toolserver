# LOCALTOOLS

一个以浏览器本地处理为主的工具箱，包含音乐、格式转换、开发辅助和文本处理等功能。音乐解密与歌词匹配已合并到同一页面，可分别开关；支持自动匹配或上传歌词、MP3 / FLAC 内嵌、图片压缩、可选浏览器/服务器推理的自动水印检测与 AI 修补，以及建议反馈。

## 本地预览

需要 Python 3；静态托管、歌词代理和反馈接口使用 Python 标准库。服务器修补需要 `requirements-ai.txt`、MI-GAN 权重和许可证。浏览器本地 AI 需要 MI-GAN / YOLO11 模型及 ONNX Runtime Web 1.30.0 WebGPU 文件。将这些大文件放在站点静态目录之外的 `/home/zht/localtools-models/`（或设置 `LOCALTOOLS_AI_MODEL_DIR`）；API 会按 allowlist 提供给浏览器，不将权重提交进 Git。参考 [第三方声明](THIRD_PARTY_NOTICES.md)。

```sh
python3 server.py 8000
```

然后打开 <http://localhost:8000>。Windows 也可以运行 `py server.py 8000`。没有 AI 依赖或模型时，其余站点功能仍可用，AI 修补会显示服务未就绪。

也可以将 `index.html` 和 `assets/` 部署到任意静态 Web 服务器。使用 `file://` 直接打开时，依赖 `fetch` 的功能可能无法工作；静态部署下，依赖本地 API 的增强功能不可用。

## 隐私与联网

音乐解密、图片转换压缩和文本处理在浏览器中完成。AI 水印可选择浏览器本地推理（模型只下载并缓存在当前浏览器，图片不上传），或服务器推理（用户主动开始后才经 HTTPS 上传图片和遮罩，服务器只在内存推理）。歌词搜索会向歌词服务发送歌名和歌手名；建议反馈会把用户主动填写的文字与可选联系方式保存到站点目录之外的本地文件 `localtools-feedback.jsonl`。

## 项目文件

- `index.html`：单页应用和工具页面
- `assets/style.css`：页面样式
- `assets/js/`：路由及各工具的 JavaScript 模块
- `server.py`：本地静态服务器和可选 API 代理
- `watermark_ai.py`：可选的服务器端 MI-GAN / ONNX Runtime 推理
- `requirements-ai.txt`：服务器 AI 推理依赖
- `HANDOFF.md`：完整工具清单、实现约定、已知缺口及交接记录

更多开发背景和当前已知限制见 [HANDOFF.md](HANDOFF.md)。
