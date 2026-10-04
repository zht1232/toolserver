#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
本地工具箱 - 轻量服务器（基础站点仅依赖 Python 标准库）

职责：
1. 托管本站静态文件（HTML / CSS / JS），替代 Nginx
2. 托管大体积解密密钥表，并按需分片下发（浏览器无需下载整个 70 MB 密钥）
3. 中转部分站点接口（网易云歌词搜索），解决浏览器跨域限制

接口：
  GET /api/ping                     健康检查与能力探测，前端据此决定可用功能
  GET /api/kgm/status               酷狗密钥表状态
  GET /api/kgm/key?start=&len=      按字节区间返回酷狗公钥表（分片解密用）
  GET /api/nc/search?s=关键词        网易云音乐搜索中转
  GET /api/nc/lyric?id=歌曲ID        网易云歌词中转（含翻译歌词）
  GET /api/ai/models/{detector|inpainter} 按需下发浏览器 AI 模型
  GET /api/ai/runtime/{文件名}         下发 allowlist 中的 ONNX Runtime Web 文件
  POST /api/feedback                用户主动提交建议反馈

用法：
    python3 server.py                  # 默认 0.0.0.0:8000
    python3 server.py 8080             # 指定端口
    python3 server.py --expand-key     # 仅解压密钥表后退出（预热，避免首次请求等待）

说明：音频解密、图片处理与 AI 水印推理都在用户浏览器本地完成；服务器只按需下发模型和运行库。
"""
import json
import ipaddress
import os
import sys
import time
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
KEY_XZ = os.path.join(BASE_DIR, "assets", "kugou_key.xz")
KEY_BIN = os.path.join(BASE_DIR, "assets", "kugou_key.bin")
KEY_SIZE = 73155904  # 解压后大小（73,155,904 字节 = 1170494464 / 16）
# Keep user feedback outside the static document root so it cannot be fetched as a file.
FEEDBACK_FILE = os.path.join(os.path.dirname(BASE_DIR), "localtools-feedback.jsonl")

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")

_key_state = {"expanding": False}
_feedback_state = {}
AI_MODEL_DIR = os.environ.get(
    "LOCALTOOLS_AI_MODEL_DIR",
    os.path.join(os.path.dirname(BASE_DIR), "localtools-models"),
)
AI_MODEL_FILES = {
    "detector": (os.path.join(AI_MODEL_DIR, "watermark_detector.onnx"), "application/octet-stream"),
    "inpainter": (os.path.join(AI_MODEL_DIR, "migan_pipeline_v2.onnx"), "application/octet-stream"),
}
AI_RUNTIME_DIR = os.path.join(AI_MODEL_DIR, "onnxruntime-web-1.30.0")
AI_RUNTIME_FILES = {
    "ort.webgpu.min.js": (os.path.join(AI_RUNTIME_DIR, "ort.webgpu.min.js"), "application/javascript; charset=utf-8"),
    "ort-wasm-simd-threaded.jsep.mjs": (os.path.join(AI_RUNTIME_DIR, "ort-wasm-simd-threaded.jsep.mjs"), "text/javascript; charset=utf-8"),
    "ort-wasm-simd-threaded.jsep.wasm": (os.path.join(AI_RUNTIME_DIR, "ort-wasm-simd-threaded.jsep.wasm"), "application/wasm"),
}


def expand_key(force=False):
    """把 kugou_key.xz 解压为原始密钥表（惰性，仅一次）"""
    if not force and os.path.exists(KEY_BIN) and os.path.getsize(KEY_BIN) >= KEY_SIZE:
        return True
    if not os.path.exists(KEY_XZ):
        return False
    if _key_state["expanding"]:
        return False
    _key_state["expanding"] = True
    try:
        import lzma
        sys.stderr.write("[key] 正在解压酷狗密钥表（约 70 MB，仅首次需要）...\n")
        data = lzma.open(KEY_XZ, "rb").read()
        tmp = KEY_BIN + ".tmp"
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, KEY_BIN)
        sys.stderr.write("[key] 完成：%d 字节，已缓存到 assets/kugou_key.bin\n" % len(data))
        return True
    except Exception as e:
        sys.stderr.write("[key] 解压失败：%s\n" % e)
        return False
    finally:
        _key_state["expanding"] = False


def http_get(url, timeout=15):
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Referer": "https://music.163.com/",
        "Cookie": "appver=2.0.2",
    })
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    request_queue_size = 128  # 浏览器会并发拉取多个静态资源，放宽监听队列


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=BASE_DIR, **kwargs)

    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))

    def rate_limit_key(self):
        remote = self.client_address[0] if self.client_address else "unknown"
        try:
            if not ipaddress.ip_address(remote).is_loopback:
                return remote
            forwarded = ipaddress.ip_address(self.headers.get("CF-Connecting-IP", ""))
            return str(forwarded)
        except ValueError:
            return remote

    # ---------- 缓存策略 ----------
    # 边缘（Cloudflare）与浏览器都会遵循这里的 Cache-Control：
    #   /api/*    → 不缓存（密钥分片、歌词检索都要实时）
    #   /assets/* → 长缓存（文件名带 ?v= 版本号，更新时改版本即可）
    #   HTML      → 短缓存 2 分钟：静态站点，重复访问直接命中边缘，更新也能很快生效
    def cache_policy(self):
        path = urllib.parse.urlparse(self.path).path
        if path.startswith("/api/"):
            return "no-store"
        if path.startswith("/assets/"):
            return "public, max-age=604800"
        if path in ("", "/") or path.endswith(".html"):
            return "public, max-age=120"
        return "public, max-age=3600"

    def end_headers(self):
        if not getattr(self, "_cache_set", False):
            self.send_header("Cache-Control", self.cache_policy())
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    # ---------- 响应工具 ----------
    def send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self._cache_set = True
        self.end_headers()
        self.wfile.write(body)

    def send_binary(self, data, status=200):
        self.send_response(status)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "public, max-age=604800")
        self._cache_set = True
        self.end_headers()
        self.wfile.write(data)

    def send_ai_asset(self, path, content_type):
        try:
            size = os.path.getsize(path)
            stream = open(path, "rb")
        except OSError:
            self.send_json({"error": "浏览器 AI 文件尚未安装"}, 404)
            return
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(size))
        self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        self.send_header("X-Content-Type-Options", "nosniff")
        self._cache_set = True
        self.end_headers()
        try:
            with stream:
                while True:
                    chunk = stream.read(1024 * 1024)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass

    # ---------- 路由 ----------
    def do_HEAD(self):
        # 接口路径用 GET 处理，HEAD 也要给出正确响应（供探针 / CDN 校验使用）
        if urllib.parse.urlparse(self.path).path.startswith("/api/"):
            self._cache_set = True
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            return
        self._cache_set = False
        super().do_HEAD()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/watermark/inpaint":
            self.close_connection = True
            self.send_json({"error": "服务器端图片修补已停用，请在浏览器本地处理"}, 410)
            return
        if parsed.path != "/api/feedback":
            self.send_json({"error": "接口不存在"}, 404)
            return
        now = time.time()
        client = self.rate_limit_key()
        recent = [t for t in _feedback_state.get(client, []) if now - t < 3600]
        if len(recent) >= 10:
            self.send_json({"error": "提交过于频繁，请稍后再试"}, 429)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > 65536:
            self.send_json({"error": "反馈内容大小无效"}, 413)
            return
        try:
            raw = self.rfile.read(length)
            data = json.loads(raw.decode("utf-8"))
        except Exception:
            self.send_json({"error": "反馈内容不是有效 JSON"}, 400)
            return
        kind = str(data.get("type", "其他")).strip()[:40]
        message = str(data.get("message", "")).strip()
        contact = str(data.get("contact", "")).strip()[:200]
        if not message:
            self.send_json({"error": "反馈内容不能为空"}, 400)
            return
        if len(message) > 5000:
            self.send_json({"error": "反馈内容不能超过 5000 字"}, 400)
            return
        record = {"type": kind or "其他", "message": message, "contact": contact, "receivedAt": int(now)}
        try:
            with open(FEEDBACK_FILE, "a", encoding="utf-8") as f:
                f.write(json.dumps(record, ensure_ascii=False) + "\n")
            os.chmod(FEEDBACK_FILE, 0o600)
        except Exception:
            self.send_json({"error": "服务器暂时无法保存反馈"}, 500)
            return
        recent.append(now)
        _feedback_state[client] = recent
        self.send_json({"ok": True})

    def do_GET(self):
        self._cache_set = False
        parsed = urllib.parse.urlparse(self.path)
        path, qs = parsed.path, urllib.parse.parse_qs(parsed.query)

        if path.startswith("/api/ai/models/"):
            name = path.rsplit("/", 1)[-1]
            entry = AI_MODEL_FILES.get(name)
            if not entry:
                self.send_json({"error": "模型不存在"}, 404)
                return
            self.send_ai_asset(entry[0], entry[1])
            return

        if path.startswith("/api/ai/runtime/"):
            name = path.rsplit("/", 1)[-1]
            entry = AI_RUNTIME_FILES.get(name)
            if not entry:
                self.send_json({"error": "运行库文件不存在"}, 404)
                return
            self.send_ai_asset(entry[0], entry[1])
            return

        if path == "/api/ping":
            browser_ai = {
                "ready": all(os.path.isfile(path) for path, content_type in AI_MODEL_FILES.values()) and
                         all(os.path.isfile(path) for path, content_type in AI_RUNTIME_FILES.values()),
                "models": {
                    name: (os.path.getsize(path) if os.path.isfile(path) else 0)
                    for name, (path, content_type) in AI_MODEL_FILES.items()
                },
                "runtime": all(os.path.isfile(path) for path, content_type in AI_RUNTIME_FILES.values()),
            }
            self.send_json({
                "ok": True,
                "server": "toolbox",
                "kgmKey": os.path.exists(KEY_BIN) or os.path.exists(KEY_XZ),
                "kgmKeyExpanded": os.path.exists(KEY_BIN),
                "kgmKeySize": KEY_SIZE,
                "lyricsProxy": True,
                "feedback": True,
                "browserWatermarkAi": browser_ai,
            })
            return

        if path == "/api/kgm/status":
            self.send_json({
                "hasXz": os.path.exists(KEY_XZ),
                "expanded": os.path.exists(KEY_BIN),
                "expanding": _key_state["expanding"],
                "size": KEY_SIZE,
            })
            return

        if path == "/api/kgm/key":
            if not os.path.exists(KEY_XZ):
                self.send_json({"error": "服务器未提供酷狗密钥表（assets/kugou_key.xz 缺失）"}, 404)
                return
            if not os.path.exists(KEY_BIN) and not expand_key():
                self.send_json({"error": "密钥表解压失败或正在进行中，请稍后重试"}, 503)
                return
            try:
                start = int((qs.get("start") or ["0"])[0])
                length = int((qs.get("len") or ["1048576"])[0])
            except ValueError:
                self.send_json({"error": "参数错误"}, 400)
                return
            total = os.path.getsize(KEY_BIN)
            if start < 0 or start >= total:
                self.send_json({"error": "区间越界"}, 416)
                return
            length = max(1, min(length, total - start, 8 * 1024 * 1024))
            with open(KEY_BIN, "rb") as f:
                f.seek(start)
                self.send_binary(f.read(length))
            return

        if path == "/api/nc/search":
            keyword = (qs.get("s") or [""])[0].strip()
            if not keyword:
                self.send_json({"error": "缺少关键词"}, 400)
                return
            url = ("https://music.163.com/api/search/get/web?csrf_token="
                   "&s=%s&type=1&offset=0&limit=15" % urllib.parse.quote(keyword))
            self.proxy_json(url)
            return

        if path == "/api/nc/lyric":
            song_id = (qs.get("id") or [""])[0].strip()
            if not song_id.isdigit():
                self.send_json({"error": "歌曲 ID 无效"}, 400)
                return
            url = "https://music.163.com/api/song/lyric?id=%s&lv=1&kv=1&tlyric=1&tv=-1" % song_id
            self.proxy_json(url)
            return

        super().do_GET()

    def proxy_json(self, url):
        try:
            data = http_get(url)
        except Exception as e:
            self.send_json({"error": "上游请求失败：%s" % e}, 502)
            return
        try:
            obj = json.loads(data.decode("utf-8"))
            upstream_code = obj.get("code") if isinstance(obj, dict) else None
            status = 429 if upstream_code in (405, 429) else 200
            self.send_json(obj, status)
        except Exception:
            self.send_json({"error": "上游返回内容异常"}, 502)


def main():
    if "--expand-key" in sys.argv:
        ok = expand_key(force=True)
        print("密钥表就绪：%s" % KEY_BIN if ok else "密钥表处理失败（请确认 assets/kugou_key.xz 存在）")
        return

    port = 8000
    for a in sys.argv[1:]:
        if a.isdigit():
            port = int(a)
    expand_key()  # 启动时预热，避免首个用户等待
    server = Server(("0.0.0.0", port), Handler)
    print("本地工具箱已启动: http://0.0.0.0:%d" % port)
    print("静态目录: %s" % BASE_DIR)
    print("密钥表: %s" % ("已就绪" if os.path.exists(KEY_BIN) else "缺失（酷狗新版格式将不可用）"))
    print("按 Ctrl+C 停止")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")


if __name__ == "__main__":
    main()
