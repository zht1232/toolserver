# 交接说明（给接手的开发者/AI）

## 现状
前端工具箱 25 个页面，页面 JS 使用原生 JavaScript（IIFE 模块）。音乐解密与歌词匹配合并在同一页，并可分别开关；歌词可自动匹配或由用户上传，MP3 / FLAC 下载时可自动内嵌；图片压缩和 AI 水印检测、修补都在浏览器本地运行。新增「HIF / HEIF 转 JPEG」页：批量上传相机 HDR HIF，做 BT.2020/PQ/HLG → sRGB 色彩管理与高光压缩，输出 sRGB JPEG。**该页默认在浏览器本地用 WebAssembly（libheif/libde265）解码，图片不上传**；只有用户勾选服务器兜底且本地解码失败时，才会把单张文件临时上传到 `server.py` 内存转换。新增「多源音乐下载」页：默认并行检索网易云 / QQ音乐 / 酷狗 / 汽水音乐 / 千千 / 5sing，服务器用本机 go-music-dl 只做搜索与直链解析，音频字节由浏览器直连各平台 CDN，服务器不转发、不保存歌曲；会员/版权曲可换源搜索。另新增「专业修图」（BitMappery）与「Camera Raw」（FlashRaw）两个本地图像工作区。
`server.py` 是可选的本地托管 + API（酷狗密钥分片、网易云歌词搜索代理、浏览器模型文件、反馈、HIF 兜底转换、多源音乐搜索/直链解析）。纯静态部署（无 Python 后端）时，浏览器本地 HIF 转换仍可用，服务器兜底、AI 模型下发与多源音乐解析不可用。AI 权重与 ONNX Runtime Web 文件放在静态目录之外，通过 allowlist API 提供；服务器只下发模型和运行库，不接收待处理图片或遮罩，也不运行水印推理（HIF 兜底转换是唯一可能接收用户图片的接口，只在内存处理）。旧的 `/api/watermark/inpaint` 接口返回 410。

启动预览：
```
python3 server.py 8000
# 或任意静态服务器 / 直接双击 index.html（部分 fetch 调用需 http(s) 协议，不能用 file://）
```

## 目录结构
- `index.html` — 单页应用外壳，侧边栏导航 + 25 个路由页面（`retouch`/`raw` 为新建的修图工作区），hash 路由切页
- `assets/js/main.js` — 路由表、环境探测（`TB` 全局工具：复制/下载/拖拽/格式化/压缩包）
- `assets/js/*.js` — 每个工具一个文件，职责见下表
- `assets/js/hif-worker.js` — HIF 浏览器本地转换 Worker：nclx/pixi 解析、libheif 16-bit 解码、PQ/HLG/SDR → sRGB 色调映射
- `assets/vendor/libheif/` — libheif-js 1.19.8 WASM bundle（未修改）与 LGPL-3.0 许可证/来源说明；仅在 HIF 页首次转换时按需加载
- `server.py` — 静态托管 + `/api/kgm/*` + `/api/nc/search|lyric` + `/api/music/search|url` + `/api/feedback` + `/api/hif/convert`（兜底）+ 浏览器 AI 模型/运行库下发
- `hif_convert.py` — HIF/HEIF 10-bit HDR 解码、PQ/HLG → sRGB 映射、JPEG 输出（服务器兜底用）
- `requirements.txt` — 仅 HIF 转换需要的可选依赖（Pillow / pillow-heif / NumPy）
- `assets/js/watermark-local.js` — ONNX Runtime Web 检测和浏览器本地修补，模型缓存到浏览器 Cache Storage
- 浏览器 AI 模型和 ONNX Runtime Web 文件 — 单独安装在站点目录之外，路径配置位于 `server.py`
- `THIRD_PARTY_NOTICES.md` — MI-GAN / YOLO11 模型与 ONNX Runtime Web 来源、许可说明

## 工具清单与对应 JS
| 分组 | 页面 | JS 文件 |
|---|---|---|
| 音乐 | 音乐解密与歌词匹配 | music.js（框架）+ lyrics.js + ncm.js/qmc.js/kgm.js/kwm.js/xm.js（各格式解密器） |
| 音乐 | 多源音乐下载 | musicfast.js + server.py `/api/music/search|url`（go-music-dl 仅解析元数据/直链；浏览器直连 CDN） |
| 音乐 | LRC 时间轴 | lyrics.js |
| 音乐 | 歌词打轴器 | syncer.js |
| 格式 | 图片转换压缩 | tools.js |
| 格式 | HIF / HEIF 转 JPEG | hif.js + hif-worker.js + assets/vendor/libheif/（浏览器本地）；server.py `/api/hif/convert` + hif_convert.py（兜底） |
| 修图 | 专业修图 | editor/（BitMappery 构建，按需 iframe）+ retouch.js |
| 修图 | Camera Raw | raw.js + raw.css + assets/vendor/flashraw（FlashRaw WASM + WebGL2） |
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

## HIF / HEIF 转 JPEG（浏览器本地 + 服务端兜底）

HIF 页默认在浏览器里用 libheif-js（WASM，内含 libheif 1.23.5 + libde265）解码 10-bit HEIF，再由 `hif-worker.js` 做与服务端一致的色彩管线。图片不上传；首次转换按需加载约 1.4 MB 解码器（`assets/vendor/libheif/libheif-bundle.js`，长缓存）。纯静态部署也能使用这一页。

- **浏览器链路**：Worker 解析 HEIF `meta/iprp/ipco` 中的 `nclx`（原色/传输曲线）与 `pixi`（位深），用 `heif_js_decode_image2(..., RGB, RRGGBB_LE)` 拿到 10-bit RGB；PQ 走 ST 2084 EOTF，HLG 走 BT.2100 OETF + OOTF；线性光下转 BT.709，以 203 nit 为 SDR 参考白，0.85 以上做对数高光肩部压缩，最后 sRGB 编码。色调映射后的 RGBA 与服务端 JPEG 逐像素对比 MAE ≈ 0.96/255（99 分位 4），肉眼无差异。
- **Worker 与内存**：每次转换创建一个 Worker，解码后把 16-bit 平面复制出 WASM 堆并释放 HEIF image，输出 RGBA 后 transfer 回主线程；主线程用 canvas 编码 JPEG，随后 `worker.terminate()` 释放 WASM 内存。32 MP 图像实测（Windows/Node WASM）：解码 ~4.7 s、色调映射 ~1.1 s；浏览器总耗时取决于设备，移动端可能更慢或内存不足。
- **编码差异**：浏览器用 canvas `toBlob('image/jpeg', q/100)` 输出 sRGB JPEG，**不保留 EXIF/ICC**，且通常为 4:2:0 子采样，文件比服务端 4:4:4 输出略小；需要保留相机 EXIF/ICC 时应走服务器兜底。
- **服务器兜底**：页面复选框「浏览器无法解码时自动改用本站服务器」默认开启；仅当本地解码失败或内存不足时才调用 `POST /api/hif/convert?name=&q=`（请求体是原始文件字节，`Content-Length` 必填）。服务器只在内存处理、不落盘，返回 `image/jpeg` 与 `X-Output-*`/`X-Source-*` 头，输出嵌入 sRGB ICC，EXIF ColorSpace 改为 1。
- **服务端限制**：单张 ≤ 80 MB、≤ 6000 万像素；仅 HEIF/HIF 品牌（不接受 AVIF）；JPEG 质量 70–100。服务端全局串行转换（`threading.BoundedSemaphore(1)`），排队 45 秒仍无空位则 503；上传槽位 2 个、单次读取超时 120 秒；按 IP 每分钟 60 次、每小时 240 次（`_HIF_RATE`）。前端批量上限 30 张 / 500 MB，逐张串行。
- **曝光补偿**：浏览器 Worker 与服务端 `hif_convert.convert_heif_to_jpeg(..., exposure_ev=)` 都支持 `-4..+4 EV`；页面下拉提供 0 / +0.5 / +1.0 / +1.5 EV，服务端接口为 `/api/hif/convert?...&ev=1`。用于暗图提亮；改变的是线性光增益，203 nit 参考白肩部仍生效。
- **服务器依赖**：需要 Python 3.10+；`requirements.txt` 固定 `pillow-heif==1.8.1`，Pillow / NumPy 用兼容范围；Linux aarch64 有 wheel。未安装时 `server.py` 仍能启动，`/api/ping` 的 `hifConvert.ready=false`，浏览器本地转换不受影响。安装建议：
  ```
  cd /home/zht/toolserver
  python3 -m venv .venv
  . .venv/bin/activate
  pip install -r requirements.txt
  # 用该 venv 的 python 重启现有服务（或把 systemd ExecStart 指向 .venv/bin/python）
  ```
  若 systemd 直接用系统 Python，需要确认 PEP 668 是否允许 pip；推荐 venv。更新代码后重启服务即可。
- **验证**：用 Canon EOS R7 的 `452A0021.HIF`（BT.2020/PQ/10-bit，6960×4640）验证：浏览器 WASM 解码 + JS 色调映射输出与服务端结果 MAE ≈ 0.96/255；浏览器批量、ZIP、服务器兜底均需在真实浏览器里复测。HLG 路径按 BT.2100 实现，但没有真实 HLG 样张做端到端验证，上线后应补测索尼/尼康 HLG。
- **隐私文案**：页面顶部说明默认本地、兜底会上传；`index.html` 的「隐私与部署」、`README.md` 和 `THIRD_PARTY_NOTICES.md` 都记录了该例外，不要删。浏览器解码器为未修改的 libheif-js 1.19.8，许可证与来源见 `assets/vendor/libheif/`。

## 多源音乐下载（解析器 + 浏览器直连）

「多源音乐下载」页（`#musicfast`，`musicfast.js`）是本站原生 UI，不内嵌 go-music-dl 的页面或 CSS。服务器上的 go-music-dl（systemd `music-dl.service`，仅监听 127.0.0.1:8080）只作为**搜索/直链解析器**：

- `/api/music/search?s=&source=` 调上游 `/music/search`（HTML）并解析 `.song-card`，返回歌曲元数据（id/source/name/artist/album/duration/extra）。
- `/api/music/url?id=&source=&duration=&extra=` 调上游 `/music/inspect`（JSON），返回 CDN URL / size / bitrate；http→https。
- 浏览器 `fetch(mode:'cors')` 直连 CDN 流式下载到本机；服务器不转发、不缓存、不落盘音频，也没有服务器下载兜底。
- 可浏览器直连的源：网易云 / QQ音乐 / 酷狗 / 汽水音乐 / 千千 / 5sing（CDN 实测返回 `Access-Control-Allow-Origin: *`）。酷我 / 咪咕无 CORS、B 站需 Referer、Jamendo 返回 HTML，故不列出。
- `/api/music/search` 支持 `source=all`：并行检索六源、交错合并、每源计数；搜索缓存 120s、直链缓存 90s（只缓存非空搜索结果和有效直链），单源聚合超时 12s。
- 直连失败 / 会员曲 / 版权下架 / CORS 拦截时前端明确区分原因，并提供「换源搜索」在全部音源中找替代版本；解析服务不可用时 `/api/ping.musicResolver.reachable=false`。
- 旧 `/music/*` UI 代理已删除，上游 UI 与 `/music/download` 不对外暴露；`music-dl.service` 只供本站 API 在本机调用。服务为未修改的 AGPL-3.0 二进制，详见 `THIRD_PARTY_NOTICES.md`。
- **部署**：`music-dl.service` 需 `active` 且 `enabled`（只监听 127.0.0.1:8080）；`server.py` 的 `/api/music/*` 只调用它的 `/music/search` 与 `/music/inspect`，不调用 `/download`，不落盘音频。

## 专业修图与 Camera Raw（浏览器本地）

- **专业修图**（`#retouch`）：`assets/js/retouch.js` 只负责按需加载 `editor/` 里的 BitMappery 构建（MIT），避免首屏拉取 4.4 MB 编辑器；iframe 由站点浅色页面框住，可全屏打开。BitMappery 提供图层、图层蒙版、画笔、选区、文字、非破坏滤镜、历史、PSD 导入和图片导出；已移除云端存储入口、禁用 Google Fonts 外部请求并做中文化。禁用工具按钮 hover 修复已内联在 `editor/index.html`，编辑器本身不向服务器上传文件。
- **Camera Raw**（`#raw`）：`assets/js/raw.js` 动态导入 `assets/vendor/flashraw/browser.js` 与单线程 SIMD WASM（FlashRaw 0.1.0，MIT OR Apache-2.0），在浏览器解码 CR2/CR3/NEF/ARW/DNG/RAF/ORF 等 RAW；WebGL2 负责曝光/高光/阴影/白平衡/带动态 RGB 直方图的 RGB/红/绿/蓝分通道曲线，以及最多 8 个可独立叠加的线性/径向/画笔蒙版与局部调整；蒙版支持新建类型选择、添加/擦除画笔、撤销笔画、启用/停用、复制和删除；调整/曲线/蒙版支持撤销重做（Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y）。导出 JPEG/PNG。桌面端预览区使用 sticky 布局，长控制栏滚动时预览仍保持可见。需要 WebGL2；无 COOP/COEP 时使用单线程 WASM，不影响其他站点资源。
- **许可证**：BitMappery 的 LICENSE 与修改说明在 `editor/`；FlashRaw 的 MIT/APACHE 许可证在 `assets/vendor/flashraw/`；整体来源见 `THIRD_PARTY_NOTICES.md`。
- **集成**：两个页面都通过 `main.js` 的 `route-editor` 类隐藏右栏并使用更宽的工作区；`retouch.js`/`raw.js` 不改动服务器 API，也没有上传接口。

## 视觉规范（2026-10-25 亮色主题版）

`assets/style.css` 是全站唯一样式源，改样式只改这里，不要在页面里写内联样式（既有少量内联是历史遗留，新代码用 class）。

- **基调**：暖纸张底 + 白色工作面板 + 单一深青绿强调色。`--bg #F2F5F0`、`--bg-side #F7FAF4`、`--panel #FFFFFF`、`--ink #16221E`、`--ink-2 #536159`、`--ink-3 #6C7A72`、`--accent #0C7A69`、`--accent-bg #E2F3ED`、`--line #E1E7E0`。层级用表面明度、1px 描边和极轻投影；不要深色渐变、辉光、玻璃拟态大面积背景。
- **两级面板**：`.panel` 是主操作区（白底 + 描边 + 轻投影）；`.panel panel-quiet` 是说明/参考区（近白底、细描边、无投影，视觉退后）。新增面板先想清楚是「干活」还是「看说明」。
- **页头**：`.page-head` 是 flex 行，`<h1>`（21px/500，前面带 7–8px 深青绿方块，中文不加 letter-spacing）与一行 `.lede`（13px）同行排布。lede 只写一句话，详细说明放面板或 `.note`。
- **字号阶梯**：正文 13.5px；次要 12px；面板说明 12px；表格/日志 12px；等宽 `--mono` 12.5px；最小不小于 11px。中文标题一律不加 letter-spacing；标题与按钮用 500，不用 600/700。
- **导航**：侧栏每项是「16px 线性图标 + 文字」（图标是 `index.html` 顶部 SVG sprite）；激活项 = 浅薄荷底 + 左侧 2px 深青绿竖条 + 图标变深。顶部 `#nav-all-tools`（全部工具 / 23）聚焦顶栏搜索；底部是 `.local-first` 卡、`.side-status` 状态与 `.side-meta` 版本/断网可用。`#nav-empty` 用于顶栏搜索无结果提示。
- **顶栏**：白色 sticky 56px；左侧「工具 / 分组 / 当前页」三级面包屑（分组由 `main.js` 的 `GROUPS` 映射，≤900px 隐藏分组）；右侧 `.tool-search` 全局工具搜索（`Ctrl/Cmd+K` 聚焦、回车跳到第一个匹配）、`#top-tool-count` 工具数胶囊、`#top-format-count` 格式数胶囊、`.top-status` 本地运行状态、`.top-help` 帮助入口。搜索逻辑在 `main.js`：过滤 `.nav-item`，搜索时隐藏 `.nav-cap`，切页自动清空。
- **移动端（≤900px）**：侧栏收起，`#nav-toggle` 汉堡按钮；顶栏换行，`.tool-search` 占满一行；分组、工具数/格式数、帮助按钮隐藏；切页自动收菜单。新增移动端样式写在 `@media (max-width: 900px)` 块里。
- **按钮**：`.btn-primary` 是深青绿底 + 白字；`.btn` 是白底描边次要钮；focus 用 2px 青绿 ring。JS 生成的按钮注意用 `btn-primary` 或 `btn primary`（CSS 同时支持）。
- **提示条**：`.note` 是浅薄荷信息条，`.note note-warn` 是浅琥珀警告条（用于「会上传文件」「有版权/实验性风险」这类需要停一下看的话）。
- **表格**：`.ftable` 是唯一表格样式；格式扩展名用 `.fmt-chip` 小胶囊（等宽、描边），不要堆空格分隔文本。
- **HIF 页**：`.hif-converter-panel` 把「转换队列」标题/统计/清空/本地标识、拖放区、控制条、每文件进度、文件列表和面板脚注收进同一张白卡；控制条 `.hif-controls` 单行时「开始转换」靠右，≤600px 堆叠并让主按钮占满。右栏 `.rail-hif` 只在 `body.route-hif` 显示，包含解码器状态、本次会话统计、最近使用和 EXIF 提示；统计/最近使用由 `hif.js` 与 `main.js` 实时更新，页面切换通过 `showPage()` 挂 `body.route-hif`。
- **右信息栏与页脚**：≥1400px 显示右侧 rail，非 HIF 页用 `.rail-generic`，HIF 页用 `.rail-hif`；rail 区块用白卡。`main` 底部有 `.site-foot` 一行「LOCALTOOLS · 25 个工具 / 浏览器本地处理」。
- **原生控件**：`:root` 用 `color-scheme: light`；checkbox/radio/range 用 `accent-color: var(--accent)`；select 用 `appearance: none` + 深色内嵌 SVG 箭头，不要用浏览器默认样式。

## 已知缺口 / 未完成事项
**修图页的限制**：专业修图是 BitMappery 的独立 iframe 构建（约 4.4 MB，首次启动加载），移动端空间较紧，建议桌面横屏；图层蒙版、PSD 导入和大部分上游功能保留，但上游本身没有 Camera Raw 级显影参数，RAW 显影请用 `#raw`。Camera Raw 页需要 WebGL2；大尺寸 RAW 首次解码需要数百毫秒到数秒，预览会按 1600px 限制，导出全分辨率可能较慢；不支持 WebGL2 的浏览器无法使用实时显影。当前曲线是 RGB 复合 + R/G/B 单通道点曲线，尚无参数曲线/分通道直方图独立缩放；多蒙版单次最多 8 个，尚无 AI 主体/天空蒙版、裁剪/旋转、镜头校正和降噪；画笔蒙版支持撤销单笔但尚无完整历史画笔橡皮擦；导出为 8-bit sRGB，不含 EXIF/ICC。

**HIF 浏览器本地路径的限制**：浏览器 canvas 编码不保留 EXIF/ICC，且常见为 4:2:0 子采样；需要这些信息时走服务器兜底。32 MP 图像的 WASM 解码 + 色调映射在桌面浏览器约 5–10 秒，移动端可能更慢或因内存不足失败；失败时按页面复选框回退服务器。EXIF 方向（Orientation ≠ 1）目前未在浏览器路径处理，依赖 libheif 对 HEIF `irot/imir` 的处理；Python 兜底路径已避免 irot 与 EXIF 重复旋转，上线后应用竖拍 HIF 补测。

**二维码生成与识别功能本次未实现**，已从导航和路由中完全移除（不是隐藏，是彻底删掉了入口），
不存在半成品或占位页面。原因：要求纯本地手写完整 QR 编码标准（ISO/IEC 18004）算法，
复杂度远超其他工具，之前两次尝试（委托给子任务）都未能在合理时间内产出可用结果。

如果要补上，建议：
1. 不要一次性要求"完整支持 40 个版本 + 8 种掩码 + 完整纠错"，先限定在版本 1-10、纠错等级 M，
   跑通之后再逐步扩展，降低单次任务的复杂度和出错概率。
2. 识别（扫码解码）比生成更难，若时间有限，可以优先用浏览器原生 `BarcodeDetector` API
   （Chrome/Edge 支持，无需手写解码算法），不支持的浏览器再考虑是否要兜底方案或直接提示换浏览器。
3. 二维码功能应避免依赖在线生成 API。HIF 默认在浏览器本地转换；仅用户开启服务器兜底且本地失败时才会在服务器内存处理。

## 其它说明
- 音频、常规图片转换和文本在浏览器本地处理；AI 水印修补也在浏览器本地运行。HIF 默认在浏览器本地转换；只有用户开启服务器兜底且本地解码失败时才会上传，服务器仅内存处理、不落盘。
- 代码风格统一为 ES5（`var`、`function`、无箭头函数/class/let/const/模板字符串），
  是为了兼容老旧设备/浏览器，新增代码请保持一致。`hif-worker.js` 允许使用 Promise（仅在支持 Worker + WebAssembly 的浏览器里运行）。
- 已做过的验证：`node --check` 全部 JS 文件语法通过；全部 25 个路由无 `Uncaught` JS 运行时错误；
  HIF 转换用 Canon EOS R7 的 BT.2020/PQ HIF 做过 API、浏览器批量 2 张与 ZIP 打包测试。
  2026-10-24 浏览器本地路线：用 Node 的 libheif-js WASM 对 32 MP HIF 实测解码 ~4.7 s、色调映射 ~1.1 s，色彩与服务端输出 MAE ≈ 0.96/255；仍需在真实 Chrome/Edge/Safari 和移动端复测 canvas 编码与内存。
  未做过的验证：真实移动设备/老旧浏览器的实机测试、真实 HLG 样张、竖拍 EXIF 方向、各音乐解密格式的实机端到端测试。
- 2026-10-18 视觉精修的验证方式：`html.parser` 全量标签配对检查（0 错误）+ agent-browser 无头浏览器实测。
