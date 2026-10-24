# 交接说明（给接手的开发者/AI）

## 现状
前端工具箱 23 个页面，页面 JS 使用原生 JavaScript（IIFE 模块）。音乐解密与歌词匹配合并在同一页，并可分别开关；歌词可自动匹配或由用户上传，MP3 / FLAC 下载时可自动内嵌；图片压缩和 AI 水印检测、修补都在浏览器本地运行。新增「HIF / HEIF 转 JPEG」页：批量上传相机 HDR HIF，做 BT.2020/PQ/HLG → sRGB 色彩管理与高光压缩，输出 sRGB JPEG。新增「多源音乐下载」页，内嵌 go-music-dl 的 Web UI（12 个音源聚合搜索 / 试听 / 下载，FLAC 无损、歌词封面、歌单 / 专辑解析、批量下载）。
`server.py` 是可选的本地托管 + API（酷狗密钥分片、网易云歌词搜索代理、浏览器模型文件、反馈、HIF 转换，以及 `/music/*` 到本机 music-dl 服务的反向代理）。纯静态部署（无 Python 后端）时以上服务器 API、HIF 转换与音乐下载页不可用。AI 权重与 ONNX Runtime Web 文件放在静态目录之外，通过 allowlist API 提供；服务器只下发模型和运行库，不接收待处理图片或遮罩，也不运行水印推理（HIF 转换是唯一接收用户图片的接口，只在内存处理）。旧的 `/api/watermark/inpaint` 接口返回 410。

启动预览：
```
python3 server.py 8000
# 或任意静态服务器 / 直接双击 index.html（部分 fetch 调用需 http(s) 协议，不能用 file://）
```

## 目录结构
- `index.html` — 单页应用外壳，侧边栏导航 + 23 个 `<section class="page">`，hash 路由切页
- `assets/js/main.js` — 路由表、环境探测（`TB` 全局工具：复制/下载/拖拽/格式化/压缩包）
- `assets/js/*.js` — 每个工具一个文件，职责见下表
- `server.py` — 静态托管 + `/api/kgm/*` + `/api/nc/*` + `/api/feedback` + `/api/hif/convert` + 浏览器 AI 模型/运行库下发 + `/music/*` 反向代理
- `hif_convert.py` — HIF/HEIF 10-bit HDR 解码、PQ/HLG → sRGB 映射、JPEG 输出
- `requirements.txt` — 仅 HIF 转换需要的可选依赖（Pillow / pillow-heif / NumPy）
- `assets/js/watermark-local.js` — ONNX Runtime Web 检测和浏览器本地修补，模型缓存到浏览器 Cache Storage
- 浏览器 AI 模型和 ONNX Runtime Web 文件 — 单独安装在站点目录之外，路径配置位于 `server.py`
- `THIRD_PARTY_NOTICES.md` — go-music-dl / music-lib（AGPL-3.0）、MI-GAN / YOLO11 模型与 ONNX Runtime Web 来源、许可说明

## 工具清单与对应 JS
| 分组 | 页面 | JS 文件 |
|---|---|---|
| 音乐 | 音乐解密与歌词匹配 | music.js（框架）+ lyrics.js + ncm.js/qmc.js/kgm.js/kwm.js/xm.js（各格式解密器） |
| 音乐 | 多源音乐下载 | 无本地 JS：`index.html` 内嵌 iframe（`/music/`，src 由 main.js 首次进入路由时懒加载），实际 UI 由服务器上的 go-music-dl 提供 |
| 音乐 | LRC 时间轴 | lyrics.js |
| 音乐 | 歌词打轴器 | syncer.js |
| 格式 | 图片转换压缩 | tools.js |
| 格式 | HIF / HEIF 转 JPEG | hif.js + server.py `/api/hif/convert` + hif_convert.py |
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
检测和修补模型经 `/api/ai/models/*` 与 `/api/ai/runtime/*` 按需下发，并缓存在浏览器。图片和遮罩只在浏览器处理；服务端不执行推理。旧的 `/api/watermark/inpaint` 路由保留为 410 响应，拒绝旧客户端的图片上传。

运行时文件和模型默认位于 `/home/zht/localtools-models/`（可用 `LOCALTOOLS_AI_MODEL_DIR` 覆盖）：`watermark_detector.onnx`、`migan_pipeline_v2.onnx`，以及 `onnxruntime-web-1.30.0/` 下的 `ort.webgpu.min.js`、`ort-wasm-simd-threaded.jsep.mjs`、`ort-wasm-simd-threaded.jsep.wasm`。AI 检测器模型的 AGPL-3.0 条款见 `THIRD_PARTY_NOTICES.md`。

## HIF / HEIF 转 JPEG（服务端）

浏览器侧无法可靠解码相机 10-bit HDR HEIF，所以这一页把文件上传到 `server.py`，由 `hif_convert.py` 转换后直接返回 JPEG。**这是站内唯一接收用户图片的接口**；文件只在内存中处理，不写临时文件、不落盘，响应完成后释放。

- **色彩链路**：nclx 读取 BT.2020/BT.709/P3、PQ/HLG/SDR；PQ 走 ST 2084 EOTF，HLG 走 BT.2100 OETF + OOTF；线性光下转 BT.709，以 203 nit 为 SDR 参考白，0.85 以上做对数高光肩部压缩，最后 sRGB 编码。输出嵌入 sRGB ICC，EXIF ColorSpace 改为 1。
- **接口**：`POST /api/hif/convert?name=文件名&q=96`，请求体是原始文件字节（`Content-Length` 必填），返回 `image/jpeg`，并带 `X-Output-Width/Height`、`X-Source-Color`、`X-Source-HDR` 供前端显示。错误返回 JSON `{"error": "..."}`。
- **限制**：单张 ≤ 80 MB、≤ 6000 万像素；仅 HEIF/HIF 品牌（不接受 AVIF）；JPEG 质量 70–100。服务端全局串行转换（`threading.BoundedSemaphore(1)`），排队 45 秒仍无空位则 503；上传槽位 2 个、单次读取超时 120 秒；按 IP 每分钟 60 次、每小时 240 次（`_HIF_RATE`）。前端批量上限 30 张 / 500 MB，逐张串行上传，避免服务器同时解多张 32 MP 图。
- **依赖与部署**：需要 Python 3.10+；`requirements.txt` 固定 `pillow-heif==1.8.1`，Pillow / NumPy 用兼容范围；Linux aarch64 有 wheel。未安装时 `server.py` 仍能启动，`/api/ping` 的 `hifConvert.ready=false`，前端只显示服务未就绪。安装建议：
  ```
  cd /home/zht/toolserver
  python3 -m venv .venv
  . .venv/bin/activate
  pip install -r requirements.txt
  # 用该 venv 的 python 重启现有服务（或把 systemd ExecStart 指向 .venv/bin/python）
  ```
  若 systemd 直接用系统 Python，需要确认 PEP 668 是否允许 pip；推荐 venv。更新代码后重启服务即可。
- **验证**：用 Canon EOS R7 的 `452A0021.HIF`（BT.2020/PQ/10-bit）做过端到端测试：6960×4640、约 11 MB JPEG、ICC/EXIF 正确，与本地色彩管线逐像素对比 MAE ≈ 0.0001；浏览器批量 2 张与 ZIP 打包通过。HLG 路径按 BT.2100 实现，但没有真实 HLG 样张做端到端验证，上线后应补测索尼/尼康 HLG。
- **隐私文案**：页面顶部有上传警告；`index.html` 的「隐私与部署」、`README.md` 和 `THIRD_PARTY_NOTICES.md` 都记录了该例外，不要删。

## 多源音乐下载（go-music-dl）部署约定

「多源音乐下载」页不是本站代码，而是把开源项目 [go-music-dl](https://github.com/guohuiyuan/go-music-dl)（AGPL-3.0，v1.1.2 起接入）的 Web UI 通过 `/music/*` 反向代理进来。接入方式与运维约定：

- **独立服务**：服务器上另跑 systemd 单元 `music-dl.service`，`ExecStart=/home/zht/music-dl/music-dl web --port 8080 --desktop --no-browser`。`--desktop` 是上游为「内嵌在别的程序后面」提供的模式：只监听 `127.0.0.1:8080`、免管理员登录、挂载在 `/music` 前缀下。二进制从 GitHub Releases 下载 `go-music-dl_linux_arm64.tar.gz`（服务器是 aarch64），不需要 Go 工具链。
- **数据目录**：`WorkingDirectory=/home/zht/music-dl`，下载文件与 SQLite 索引都落在其 `data/` 子目录（`data/downloads`、`data/video_output`）。要改下载位置就在 UI「设置」里改。
- **代理**：`server.py` 的 `proxy_music_dl()` 把 `/music` 与 `/music/*` 流式转发到 `127.0.0.1:8080`。对齐 go-music-dl README 的 Nginx 反代约定：透传原始 `Host`、`X-Forwarded-For/Proto`、`X-Real-IP`（取 `CF-Connecting-IP`）、`X-Requested-With`、`Origin`、`Sec-Fetch-*`、`Range`、`Cookie`、`Referer`——`X-Requested-With` 是上游区分 XHR/JSON 与整页导航的依据，`Host`+`Origin` 是它同源写校验（`allowSameOriginWrite`，收藏到本地歌单等写操作）的依据，缺了会 403。响应头用黑名单过滤 hop-by-hop 头后其余全透传（`Content-Disposition` 下载文件名、多值 `Set-Cookie` 都要），上游未给 `Cache-Control` 时注入 `no-cache`。上游不可达时返回 503 提示页。
- **依赖**：服务器需安装 `ffmpeg`（`apt install ffmpeg`），用于非 MP3 格式的元数据内嵌与视频生成；普通搜索/MP3/FLAC 下载不依赖它。
- **能力探测**：`/api/ping` 的 `musicDl.reachable` 会探测 8080 端口；iframe 的 src 由 `main.js` 在首次进入 `#musicdl` 路由时懒加载。
- **合规**：AGPL-3.0 是强 Copyleft，通过网络提供修改版服务必须公开对应源码；目前运行的是官方未修改二进制，详见 `THIRD_PARTY_NOTICES.md`。音乐版权风险由使用者自行承担。
- **升级**：换版本时替换 `/home/zht/music-dl/music-dl` 二进制后 `systemctl restart music-dl`；`data/` 目录保留即保留歌单与设置。

## 视觉规范（2026-10 视觉打磨版）

`assets/style.css` 是全站唯一样式源，改样式只改这里，不要在页面里写内联样式（既有少量内联是历史遗留，新代码用 class）。

- **基调**：带蓝的深灰底（`--bg #0C0F16`，不是纯黑）+ 单一青绿强调色（`--accent #2DD4BF`，图标/文字用更亮的 `--accent-hi #5EEAD4`）。层级三件套：表面明度（bg < panel < panel-2）、1px 描边（`--line` / `--line-2`）、轻投影（`--shadow-1`）；面板另有一道 1px 顶部内高光（`--sheen`）做出实体感。刻意不要：渐变标题字、辉光 glow、玻璃拟态大面积背景（仅 topbar 用少量 translucency+blur）。
- **两级面板**：`.panel` 是主操作区（实心 + 描边 + 轻投影，用户在这里干活）；`.panel panel-quiet` 是说明/参考区（近透明底 + 细描边、无投影，视觉退后）。新增面板先想清楚是「干活」还是「看说明」，再选层级。
- **页头**：`.page-head` 是 flex 行，`<h1>`（20px/600，前面带 8px 强调色方块，中文不加 letter-spacing）与一行 `.lede`（13px）同行排布。lede 只写一句话，详细说明放面板或 `.note` 里。
- **字号阶梯**：正文 14px；次要 13px；面板说明 12.5px；表格/日志 12.5px；等宽 `--mono` 12.5px；最小不小于 11px。中文标题一律不加 letter-spacing。
- **导航**：侧栏每项都是「16px 线性图标 + 文字」（图标是 `index.html` 顶部的 SVG sprite，`<use href="#i-xxx">`，stroke=currentColor，加新图标就往 sprite 里加 symbol）；激活项 = 强调色底 + 左侧 2px 竖条 + 图标变亮。侧栏底部是 `.side-status` 状态条（绿点 + 版本号）。早期版本的编号角标和 featured 高亮插队已移除——它们制造噪音还打乱分组。
- **移动端（≤900px）**：侧栏默认收起，顶栏左侧出现 `#nav-toggle` 汉堡按钮，点开是 `body.nav-open`；切页时 `main.js` 自动收菜单。新增移动端样式记得写在 `@media (max-width: 900px)` 块里。
- **顶栏**：只放当前页中文标题（`main.js` 的 `TITLES` 映射）+ 右侧按需显示的格式数（胶囊 chip）。不要往回加标语式文案。
- **按钮**：`.btn-primary` 是实心青绿 + 深色字 + 顶部内高光，无渐变无辉光；`.btn` 是 `--panel-2` 描边次要钮。JS 生成的按钮注意用 `btn-primary` 或 `btn primary`（lyrics.js 两种都见过，CSS 已同时支持）。
- **提示条**：`.note` 是信息（青绿左边条），`.note note-warn` 是警告（琥珀色左边条，用于「要下载大文件」「有版权/实验性风险」这类需要用户停下来看一眼的话）。
- **表格**：`.ftable` 是唯一表格样式；格式扩展名一律用 `.fmt-chip` 小胶囊（等宽、描边），不要直接堆一串空格分隔的文本。
- **内嵌页面**：`.embed-frame` 撑满视口剩余高度（`calc(100vh - 220px)`），iframe 背景与站点一致。
- **原生控件**：`:root` 有 `color-scheme: dark`，下拉/日期等原生弹窗才是暗色；checkbox/radio/range 用 `accent-color: var(--accent)`；select 用 `appearance: none` + 内嵌 SVG 箭头，不要用浏览器默认样式。

## 已知缺口 / 未完成事项
**二维码生成与识别功能本次未实现**，已从导航和路由中完全移除（不是隐藏，是彻底删掉了入口），
不存在半成品或占位页面。原因：要求纯本地手写完整 QR 编码标准（ISO/IEC 18004）算法，
复杂度远超其他工具，之前两次尝试（委托给子任务）都未能在合理时间内产出可用结果。

如果要补上，建议：
1. 不要一次性要求"完整支持 40 个版本 + 8 种掩码 + 完整纠错"，先限定在版本 1-10、纠错等级 M，
   跑通之后再逐步扩展，降低单次任务的复杂度和出错概率。
2. 识别（扫码解码）比生成更难，若时间有限，可以优先用浏览器原生 `BarcodeDetector` API
   （Chrome/Edge 支持，无需手写解码算法），不支持的浏览器再考虑是否要兜底方案或直接提示换浏览器。
3. 二维码功能应避免依赖在线生成 API。HIF 转换是站内唯一上传用户图片的功能，仅在服务器内存处理。

## 其它说明
- 音频、常规图片转换和文本在浏览器本地处理；AI 水印修补也在浏览器本地运行。HIF 转换是唯一上传用户图片的功能，服务器仅内存处理、不落盘。
- 代码风格统一为 ES5（`var`、`function`、无箭头函数/class/let/const/模板字符串），
  是为了兼容老旧设备/浏览器，新增代码请保持一致。
- 已做过的验证：`node --check` 全部 JS 文件语法通过；全部 23 个路由无 `Uncaught` JS 运行时错误；
  HIF 转换用 Canon EOS R7 的 BT.2020/PQ HIF 做过 API、浏览器批量 2 张与 ZIP 打包测试。
  未做过的验证：真实移动设备/老旧浏览器的实机测试、真实 HLG 样张、各音乐解密格式的实机端到端测试。
- 2026-10-18 视觉精修的验证方式：`html.parser` 全量标签配对检查（0 错误）+ agent-browser 无头浏览器实测。
