# NOTICE — LOCALTOOLS「专业修图」工作区

本目录（`editor/`）是 LOCALTOOLS 自托管的专业修图静态应用，基于开源项目 **BitMappery** 构建。

## 上游项目

- 项目名称：BitMappery
- 上游仓库：<https://github.com/igorski/bitmappery>
- 使用版本：**v1.2.0**（`package.json` 版本号 1.2.0）
- 作者 / 版权：Copyright (c) 2020-2021 Igor Zinken — <https://www.igorski.nl>
- 许可证：**MIT**，完整许可原文见同目录 `LICENSE`
- 获取方式：上游源码 v1.2.0，使用其自带 Vite 构建流程编译为静态资源

BitMappery 的 MIT 许可与版权声明已原样保留在 `LICENSE` 中。本目录中的修改同样以 MIT 许可提供。

## 我们做的修改

构建自上游 v1.2.0 源码，仅修改 `/tmp/photo-libs/bitmappery/**` 范围内的源码；未修改 LOCALTOOLS 站点其他任何文件。

### 1. 浅色主题（与站点色板一致）

- `src/styles/_colors.scss` 由深色主题改为站点浅色色板：
  - 背景 `#F2F5F0`，面板/窗口 `#FFFFFF`，次级表面 `#F7FAF5` / `#EDF2EC`
  - 文字 `#16221E`，次级文字 `#536159`，描边 `#E1E7E0` / `#CFD9CE`
  - 强调色 `#0C7A69`，悬停 `#075E51`，浅强调底 `#E2F3ED`
- 移除深色渐变与辉光：`_colors.scss`、`_global.scss`、`_typography.scss`、`component.scss`、`ui.scss`、`form.scss`、`tooltip.scss`、`font-previews.scss`
- 逐组件调整写死的深色：顶部菜单、工具箱、图层面板、模态窗口、通知、对话框、选择框、滑杆、加载器、右键菜单、文档画布工作区、导出窗口、色板预览等
- 画布工作区使用浅中性网格（`#F7FAF5` / `#EDF2EC` / `#E1E7E0`），透明像素仍使用中性灰棋盘格
- 把上游用 `inline-block` 导致在宽屏换行的主布局改为 flex 三栏布局，保证画布与右侧图层面板同时可见

### 2. 界面中文化

- 批量翻译 `src/**/messages.json`（共 47 个文件），覆盖：
  - 顶部菜单：文件 / 编辑 / 文档 / 图层 / 选择 / 首选项 / 视图 / 窗口 / 帮助
  - 文件菜单：新建、打开、关闭、保存、导出图像
  - 工具栏 15 个工具及撤销/重做提示
  - 图层面板：图层、添加图层、添加蒙版、特效与滤镜、混合模式、不透明度、图层操作提示
  - 工具选项：画笔、橡皮、填充、文字、选区、魔棒、仿制图章、缩放/旋转/镜像/拖拽等
  - 新建文档、调整文档/画布尺寸、导出、保存、首选项、选择区扩展/收缩/载入/存储、描边、文档属性、网格切分、动画预览
  - 空状态、通知、确认/错误对话框、按钮（确定/取消/保存/创建/添加/导出等）
- 默认图层名改为「新建图层」「新建文字图层」；导出格式显示为「JPEG（.jpg）」等
- `index.html`：`lang="zh-CN"`、标题「专业修图 · LOCALTOOLS」、中文 noscript 提示
- 未翻译的少量长尾文案保留英文作为后备；云存储相关文案虽已翻译但入口不可达

### 3. 移除云存储入口

- `src/utils/cloud-service-loader.ts`：`supportsDropbox` / `supportsGoogleDrive` / `supportsS3` 恒为 `false`，三个 service getter 不再动态加载任何云 SDK
- 顶部「文件」菜单移除 Dropbox / Google Drive / S3 打开入口
- 空状态导入面板移除 Dropbox / Google Drive / S3 导入入口
- 保存 / 导出窗口移除「存储位置」选择与云保存组件，仅保留本地下载
- 移除云文件选择器的模态分支与 `public/login.html`（OAuth 回调页）
- 构建产物中不再包含 Dropbox SDK、Google Drive API、AWS SDK 代码块

### 4. 字体本地化 / 离线

- `src/services/font-service.ts`：不再创建 `fonts.googleapis.com` 的 `<link>` 请求，`loadGoogleFont()` 直接 resolve；`fontsConsented()` 恒为 `true`，不再弹出 Google Fonts 同意框
- 文本渲染使用系统字体栈，并追加中文回退字体（PingFang SC / 微软雅黑 / 思源黑体 / Noto Sans CJK）
- 文字工具新增 5 个本地字体选项（系统无衬线、系统衬线、系统等宽、微软雅黑、苹方），默认使用「系统无衬线」
- 原有 Google 字体名称保留为选项，但在离线环境下自动回退到系统字体
- 上游自带的本地 Nunito woff 仍作为展示字体随包提供（同源加载，非第三方）

### 5. 路径与部署

- Vite `base: "./"`，全部资源使用相对路径，可部署到任意子目录（如 `/editor/`）
- 修复 `header-menu` 中写死的 `/assets/favicon/favicon-96x96.png` 绝对路径，改为运行时基于 `document.baseURI` 解析
- 图标路径沿用相对 `./assets/...`；PDF worker、wasm、worker、字体、favicon 均由构建输出到 `assets/`
- 该目录为纯静态应用，无需 Node/Python 后端

### 6. 帮助入口

- 顶部「帮助」不再跳转外部站点，改为应用内对话框，说明来源、许可、离线与常用操作

## 保留的上游功能

图层、图层蒙版、画笔/橡皮/仿制图章/填充、矩形与多边形选区、魔棒、文字图层、图层特效与滤镜、混合模式与不透明度、撤销/重做、PSD 导入、PDF 导入、JPEG/PNG/WebP/GIF 导出、项目 `.bpy` 保存。时间轴/动画预览/精灵表导出等非主流程功能保留但不在默认路径中出现。

## 第三方组件

本应用使用的均为开源库，无商业组件。主要依赖及其许可证：

| 组件 | 许可证 |
| --- | --- |
| Vue 3、Vuex、vue-i18n | MIT |
| @popperjs/core | MIT |
| @simonwep/pickr | MIT |
| floating-vue、vue-select、vuedraggable | MIT |
| zcanvas、psd.js、contactjs | MIT |
| pdfjs-dist | Apache-2.0 |
| gifshot、tiny-script-loader、undo-manager、lz-string | MIT |
| martinez-polygon-clipping、buffer、lodash.clonedeep / isequal | MIT |

各依赖的完整许可证随 npm 包提供；上游仓库的第三方声明同样适用。

## 构建方式

```bash
# 在上游源码目录
npm install
npm run build
# 将 dist/ 内容（不含 login.html）复制到本目录
```

仅复制 `index.html`、`assets/`、`favicon.ico`，不包含 `node_modules` 或源码仓库。

### 7. 站点图标

- 将编辑器标题栏与浏览器 favicon 替换为 LOCALTOOLS 的深青绿图标，保持与站点外壳一致；不影响上游代码逻辑。

### 8. 工具按钮禁用态修复

- 样式已内联进 `editor/index.html`：修复禁用工具按钮 hover 时图标被反白、在浅色背景上不可见的问题；禁用态保持中性灰图标。

### 9. 魔棒选区体验

- `src/rendering/actors/interaction-pane.ts`：普通点击魔棒现在**替换**当前选区，Shift 点击**加选**，不再像上游那样每次点击都静默累加多个选区；Alt 减选在复杂像素路径上会安全回退，不再抛错。
- 魔棒默认阈值从 50 调整为 32，更接近 Photoshop 的默认手感，减少一次点击选中大片相近色的情况。
- 工具选项文案补充「普通点击替换选区，Shift 点击加选」提示，并将阈值标注为「越大范围越广」。
