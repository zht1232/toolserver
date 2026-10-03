# LOCALTOOLS

一个以浏览器本地处理为主的工具箱，包含音乐、格式转换、开发辅助和文本处理等 21 个工具页面。前端使用原生 JavaScript 编写，无框架依赖。

## 本地预览

需要 Python 3；服务端只使用 Python 标准库，不需要安装第三方包。

```sh
python3 server.py 8000
```

然后打开 <http://localhost:8000>。Windows 也可以运行 `py server.py 8000`。

也可以将 `index.html` 和 `assets/` 部署到任意静态 Web 服务器。使用 `file://` 直接打开时，依赖 `fetch` 的功能可能无法工作；静态部署下，依赖本地 API 的增强功能不可用。

## 隐私与联网

文件转换和文本处理在浏览器中完成，用户文件不会上传到本项目的服务器。歌词搜索等联网功能会向相应的在线服务发送搜索请求；运行 `server.py` 可提供网易云歌词代理接口。

## 项目文件

- `index.html`：单页应用和工具页面
- `assets/style.css`：页面样式
- `assets/js/`：路由及各工具的 JavaScript 模块
- `server.py`：本地静态服务器和可选 API 代理
- `HANDOFF.md`：完整工具清单、实现约定、已知缺口及交接记录

更多开发背景和当前已知限制见 [HANDOFF.md](HANDOFF.md)。
