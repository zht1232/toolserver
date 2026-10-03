# 交接说明（给接手的开发者/AI）

## 现状
前端工具箱 21 个页面，页面 JS 使用原生 JavaScript（IIFE 模块）。音乐解密与歌词匹配合并在同一页，并可分别开关；歌词可自动匹配或由用户上传，MP3 / FLAC 下载时可自动内嵌；图片压缩在浏览器本地运行，AI 水印可自动检测与选择浏览器/服务器修补。
`server.py` 是可选的本地托管 + API（酷狗密钥分片、网易云歌词搜索代理、AI 水印修补、浏览器模型文件和反馈）。纯静态部署（无 Python 后端）时以上服务器 API 不可用。AI 权重与 ONNX Runtime Web 文件放在静态目录之外，通过 allowlist API 提供，路径配置位于 `server.py`；见 `THIRD_PARTY_NOTICES.md`。

启动预览：
```
python3 server.py 8000
# 或任意静态服务器 / 直接双击 index.html（部分 fetch 调用需 http(s) 协议，不能用 file://）
```

## 目录结构
- `index.html` — 单页应用外壳，侧边栏导航 + 21 个 `<section class="page">`，hash 路由切页
- `assets/js/main.js` — 路由表、环境探测（`TB` 全局工具：复制/下载/拖拽/格式化/压缩包）
- `assets/js/*.js` — 每个工具一个文件，职责见下表
- `server.py` — 静态托管 + `/api/kgm/*` + `/api/nc/*` + `/api/feedback` + `/api/watermark/inpaint` + 浏览器 AI 模型/运行库下发
- `watermark_ai.py` — MI-GAN ONNX Runtime CPU 推理，图片只在服务器内存中处理
- `assets/js/watermark-local.js` — ONNX Runtime Web 检测和浏览器本地修补，模型缓存到浏览器 Cache Storage
- `requirements-ai.txt` — 可选 AI 推理依赖；模型文件单独安装在站点目录之外
- `THIRD_PARTY_NOTICES.md` — MI-GAN / YOLO11 模型与 ONNX Runtime Web 来源、许可说明

## 工具清单与对应 JS
| 分组 | 页面 | JS 文件 |
|---|---|---|
| 音乐 | 音乐解密与歌词匹配 | music.js（框架）+ lyrics.js + ncm.js/qmc.js/kgm.js/kwm.js/xm.js（各格式解密器） |
| 音乐 | LRC 时间轴 | lyrics.js |
| 音乐 | 歌词打轴器 | syncer.js |
| 格式 | 图片转换压缩 | tools.js |
| 格式 | JSON 格式化 / 编解码 | tools.js |
| 格式 | CSV / JSON / Markdown 表格互转 | csvjson.js |
| 格式 | Markdown 实时预览 | markdown.js（内置手写 Markdown 解析器） |
| 开发 | 正则表达式测试 | regex.js |
| 开发 | JWT 解析器 | jwt.js |
| 开发 | Cron 表达式 | cron.js |
| 开发 | 进制转换 / 位运算 | radix.js |
| 开发 | UUID / 密码生成 | generator.js |
| 开发 | 文本 Diff 对比 | diff.js（LCS 算法） |
| 开发 | 速查表 | reference.js（HTTP 状态码 / ASCII / 常用正则，纯静态数据） |
| 文本 | 文本处理 / 哈希校验 / 时间戳 | text.js |
| 文本 | 颜色转换 | color.js（HEX/RGB/HSL 三向联动 + 色轮 + 滑块 + 预设色 + 明暗梯度） |
| 工具库 | zip.js | 纯 JS 打包下载用的 ZIP 封装 |
| 信息 | 建议与反馈 | feedback.js + server.py `/api/feedback` |

在线反馈写入 `BASE_DIR` 的父目录 `localtools-feedback.jsonl`，不对静态资源开放；提交内容包含用户填写的文字和可选联系方式。
浏览器模式下载的模型经 `/api/ai/models/*` 和 `/api/ai/runtime/*` 提供，并缓存在该浏览器。此模式不上传图片。服务器模式只在用户点击修补后上传原图与遮罩，在服务器内存处理，不保存到磁盘。单张图片限制 20 MiB / 1200 万像素；服务端每个来源每分钟最多运行 3 次且全局一次只运行一个推理任务。

运行时文件和模型默认位于 `/home/zht/localtools-models/`（可用 `LOCALTOOLS_AI_MODEL_DIR` 覆盖）：`watermark_detector.onnx`、`migan_pipeline_v2.onnx`，以及 `onnxruntime-web-1.30.0/` 下的 `ort.webgpu.min.js`、`ort-wasm-simd-threaded.jsep.mjs`、`ort-wasm-simd-threaded.jsep.wasm`。AI 检测器模型的 AGPL-3.0 条款见 `THIRD_PARTY_NOTICES.md`。

## 已知缺口 / 未完成事项
**二维码生成与识别功能本次未实现**，已从导航和路由中完全移除（不是隐藏，是彻底删掉了入口），
不存在半成品或占位页面。原因：要求纯本地手写完整 QR 编码标准（ISO/IEC 18004）算法，
复杂度远超其他工具，之前两次尝试（委托给子任务）都未能在合理时间内产出可用结果。

如果要补上，建议：
1. 不要一次性要求"完整支持 40 个版本 + 8 种掩码 + 完整纠错"，先限定在版本 1-10、纠错等级 M，
   跑通之后再逐步扩展，降低单次任务的复杂度和出错概率。
2. 识别（扫码解码）比生成更难，若时间有限，可以优先用浏览器原生 `BarcodeDetector` API
   （Chrome/Edge 支持，无需手写解码算法），不支持的浏览器再考虑是否要兜底方案或直接提示换浏览器。
3. 二维码功能应避免依赖在线生成 API。本站 AI 水印修补是单独的用户主动选择，会把图片和遮罩临时上传到自有服务器。

## 其它说明
- 音频、常规图片转换和文本仍在浏览器本地处理；服务器 AI 水印修补会接收用户主动选中的图片与遮罩，仅内存推理，不落盘。
- 代码风格统一为 ES5（`var`、`function`、无箭头函数/class/let/const/模板字符串），
  是为了兼容老旧设备/浏览器，新增代码请保持一致。
- 已做过的验证：`node --check` 全部 JS 文件语法通过；用 headless 浏览器扫描过全部 21 个路由，
  确认无 `Uncaught` JS 运行时错误。未做过的验证：真实移动设备/老旧浏览器的实机测试、
  各音乐解密格式用真实加密文件的端到端测试（之前版本已有基础，这次新增工具不涉及这部分）。
