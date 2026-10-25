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
  GET /api/nc/url?id=&br=            网易云直链解析（直连下载页用，服务器只回 URL 不转发字节）
  GET /api/nc/stream?id=&br=&name=   网易云代理流（直连失败兜底，服务器流式转发、不落盘）
  GET /api/ai/models/{detector|inpainter} 按需下发浏览器 AI 模型
  GET /api/ai/runtime/{文件名}         下发 allowlist 中的 ONNX Runtime Web 文件
  POST /api/feedback                用户主动提交建议反馈
  POST /api/hif/convert?name=&q=&ev=  HIF/HEIF -> sRGB JPEG（HDR 色彩管理，仅内存处理；ev 为曝光补偿）
  *    /music  /music/*             反向代理到本机 music-dl（go-music-dl Web 服务，多源音乐下载）

用法：
    python3 server.py                  # 默认 0.0.0.0:8000
    python3 server.py 8080             # 指定端口
    python3 server.py --expand-key     # 仅解压密钥表后退出（预热，避免首次请求等待）

说明：音频解密、常规图片处理与 AI 水印推理在用户浏览器本地完成；服务器只按需下发模型和运行库。
HIF/HEIF 的 HDR 解码是例外：文件上传后仅在服务器内存中转换、不落盘（见 hif_convert.py）。
/music/* 代理到 go-music-dl（12 个音源的搜索 / 试听 / 下载 Web 服务，AGPL-3.0，见 THIRD_PARTY_NOTICES.md）。
"""
import json
import ipaddress
import os
import re
import socket
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

try:
    import hif_convert
    _HIF_IMPORT_ERROR = ""
except Exception as _hif_exc:  # Optional feature: the rest of the site still runs.
    hif_convert = None
    _HIF_IMPORT_ERROR = "%s: %s" % (type(_hif_exc).__name__, _hif_exc)

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

# HIF conversion is CPU/RAM heavy, so requests are serialised and rate limited.
_HIF_MAX_UPLOAD = getattr(hif_convert, "MAX_UPLOAD_BYTES", 80 * 1024 * 1024)
_HIF_MAX_PIXELS = getattr(hif_convert, "MAX_PIXELS", 60000000)
_HIF_SEMAPHORE = threading.BoundedSemaphore(1)
_HIF_UPLOAD_SEMAPHORE = threading.BoundedSemaphore(2)
_HIF_RATE_LOCK = threading.Lock()
_HIF_RATE = {}
# 网易云直连/代理下载：代理流只用于浏览器直连失败时兜底，限制并发与频率。
_NC_BRS = ("128000", "192000", "320000", "999000")
_NC_STREAM_SEMAPHORE = threading.BoundedSemaphore(2)
_NC_STREAM_RATE_LOCK = threading.Lock()
_NC_STREAM_RATE = {}
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

# 多源音乐下载服务（go-music-dl Web 模式，systemd: music-dl.service，仅监听 127.0.0.1:8080）。
# 本站把 /music 与 /music/* 反向代理到它，对外只暴露 8000 一个端口。
MUSIC_DL_ORIGIN = "http://127.0.0.1:8080"
MUSIC_DL_PREFIX = "/music"
# 透传给上游的请求头。X-Requested-With / Origin / Sec-Fetch-* 是 go-music-dl 区分 XHR 与
# 整页导航、做同源写校验的依据，必须原样透传；Accept-Encoding 不透传（上游不做压缩，
# 透传反而会让流式回写复杂化）。
_MUSIC_DL_REQ_HEADERS = ("range", "content-type", "cookie", "accept", "user-agent",
                         "x-requested-with", "origin", "referer",
                         "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest")
# 响应头回写黑名单：hop-by-hop 头与 Server/Date 不回写（后者由 http.server 自己生成）。
# Content-Disposition（下载文件名）等其余头部全部透传。
_MUSIC_DL_SKIP_RESP_HEADERS = frozenset([
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailer", "transfer-encoding", "upgrade", "server", "date",
])


def _http_header_name(h):
    """range -> Range，content-type -> Content-Type"""
    return "-".join(p.capitalize() for p in h.split("-"))


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


def resolve_nc_url(song_id, br="320000"):
    """解析网易云歌曲的签名 CDN 直链；只返回元数据，不转发音频字节。"""
    if br not in _NC_BRS:
        br = "320000"
    ids = urllib.parse.quote("[" + song_id + "]", safe="[]")
    url = ("https://music.163.com/api/song/enhance/player/url"
           "?id=%s&ids=%s&br=%s" % (song_id, ids, br))
    raw = json.loads(http_get(url).decode("utf-8"))
    items = (raw.get("data") or []) if isinstance(raw, dict) else []
    item = items[0] if items and isinstance(items[0], dict) else None
    link = (item or {}).get("url") or ""
    if not link:
        # 版权受限 / 需会员 / 已下架：明确告知前端，由前端回落到代理下载
        return {"code": -1, "error": "该歌曲暂未提供直链（版权或会员限制）"}
    # CDN 返回的常是 http，页面是 https，必须转成 https 否则浏览器按混合内容拦截
    if link.startswith("http://"):
        link = "https://" + link[len("http://"):]
    ext = (item.get("type") or "mp3").lower()
    return {
        "code": 200,
        "url": link,
        "br": item.get("br") or int(br),
        "size": item.get("size") or 0,
        "ext": ext,
        "md5": item.get("md5") or "",
        # 直链有效期（秒），默认 20 分钟，过期需重新解析
        "expi": item.get("expi") or 1200,
    }


def music_dl_reachable(timeout=0.5):
    """探测 music-dl 是否在本机 8080 监听（用于 /api/ping 能力上报）"""
    try:
        with socket.create_connection(("127.0.0.1", 8080), timeout=timeout):
            return True
    except OSError:
        return False


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

    # ---------- HIF / HEIF 转换（HDR -> sRGB，仅内存处理） ----------
    def hif_rate_ok(self):
        now = time.time()
        client = self.rate_limit_key()
        with _HIF_RATE_LOCK:
            history = [t for t in _HIF_RATE.get(client, ()) if now - t < 3600]
            per_minute = sum(1 for t in history if now - t < 60)
            if per_minute >= 60 or len(history) >= 240:
                _HIF_RATE[client] = history
                return False
            history.append(now)
            _HIF_RATE[client] = history
        return True

    def nc_stream_rate_ok(self):
        now = time.time()
        client = self.rate_limit_key()
        with _NC_STREAM_RATE_LOCK:
            history = [t for t in _NC_STREAM_RATE.get(client, ()) if now - t < 3600]
            if len(history) >= 60:
                _NC_STREAM_RATE[client] = history
                return False
            history.append(now)
            _NC_STREAM_RATE[client] = history
        return True

    def handle_hif_convert(self, qs):
        if hif_convert is None:
            self.send_json({
                "error": "HIF 转换依赖未安装，请运行 pip install -r requirements.txt",
                "detail": _HIF_IMPORT_ERROR,
            }, 503)
            return
        if not self.hif_rate_ok():
            self.send_json({"error": "转换请求过于频繁，请稍后再试"}, 429)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0:
            self.send_json({"error": "缺少上传内容"}, 411)
            return
        if length > _HIF_MAX_UPLOAD:
            self.send_json({
                "error": "文件超过 %d MB 上限" % (_HIF_MAX_UPLOAD // 1048576),
            }, 413)
            return

        if not _HIF_UPLOAD_SEMAPHORE.acquire(timeout=5):
            self.send_json({"error": "服务器正在接收其他文件，请稍后再试"}, 503)
            return
        remaining = length
        chunks = []
        try:
            try:
                self.connection.settimeout(120)
            except OSError:
                pass
            while remaining > 0:
                chunk = self.rfile.read(min(remaining, 1024 * 1024))
                if not chunk:
                    break
                chunks.append(chunk)
                remaining -= len(chunk)
        except (ConnectionError, OSError):
            self.close_connection = True
            return
        finally:
            _HIF_UPLOAD_SEMAPHORE.release()
        if remaining:
            self.send_json({"error": "上传中断"}, 400)
            return

        try:
            quality = int((qs.get("q") or ["96"])[0])
        except ValueError:
            quality = 96
        try:
            exposure_ev = float((qs.get("ev") or ["0"])[0])
        except ValueError:
            exposure_ev = 0.0
        exposure_ev = max(-4.0, min(4.0, exposure_ev))
        name = (qs.get("name") or ["converted.hif"])[0]
        name = os.path.basename(name.replace("\\", "/"))[:200]
        base = os.path.splitext(name)[0] or "converted"

        if not _HIF_SEMAPHORE.acquire(timeout=45):
            self.send_json({"error": "服务器正在处理其他图片，请稍后再试"}, 503)
            return
        started = time.time()
        try:
            jpeg, meta = hif_convert.convert_heif_to_jpeg(
                b"".join(chunks), quality, exposure_ev=exposure_ev
            )
        except hif_convert.HifError as exc:
            self.send_json({"error": str(exc)}, exc.status)
            return
        except Exception as exc:
            sys.stderr.write("[hif] conversion failed: %s: %s\n" % (type(exc).__name__, exc))
            self.send_json({"error": "转换失败，请换一张图片重试"}, 500)
            return
        finally:
            _HIF_SEMAPHORE.release()

        out_name = base + "_sdr.jpg"
        self.send_response(200)
        self.send_header("Content-Type", "image/jpeg")
        self.send_header("Content-Length", str(len(jpeg)))
        self.send_header(
            "Content-Disposition",
            "attachment; filename=\"converted.jpg\"; filename*=UTF-8''%s"
            % urllib.parse.quote(out_name, safe=""),
        )
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Output-Width", str(meta["width"]))
        self.send_header("X-Output-Height", str(meta["height"]))
        self.send_header("X-Source-Color", meta["source"])
        self.send_header("X-Source-HDR", "1" if meta["hdr"] else "0")
        self.send_header("X-Output-Quality", str(meta["quality"]))
        self.send_header(
            "Access-Control-Expose-Headers",
            "X-Output-Width, X-Output-Height, X-Source-Color, X-Source-HDR, X-Output-Quality",
        )
        self._cache_set = True
        self.end_headers()
        try:
            self.wfile.write(jpeg)
        except (BrokenPipeError, ConnectionResetError):
            pass
        sys.stderr.write(
            "[hif] %s -> %dx%d, %d -> %d bytes, %.2fs\n"
            % (name, meta["width"], meta["height"], length, len(jpeg), time.time() - started)
        )

    # ---------- 音乐下载反向代理（/music -> 127.0.0.1:8080） ----------
    def send_music_unavailable(self, reason):
        """music-dl 未运行时给浏览器一个可读的提示页（iframe 内直接可见）"""
        body = (
            "<!DOCTYPE html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">"
            "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
            "<title>音乐下载服务未就绪</title></head>"
            "<body style=\"margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;"
            "background:#F2F5F0;color:#16221E;font-family:Inter,'MiSans','HarmonyOS Sans SC','PingFang SC',"
            "'Microsoft YaHei',-apple-system,'Segoe UI',sans-serif;font-size:13.5px;line-height:1.65\">"
            "<div style=\"max-width:420px;padding:32px;text-align:center\">"
            "<div style=\"width:46px;height:46px;margin:0 auto 12px;border-radius:12px;background:#E2F3ED;"
            "display:flex;align-items:center;justify-content:center\">"
            "<svg width=\"22\" height=\"22\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#0C7A69\" "
            "stroke-width=\"1.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\">"
            "<path d=\"M9 18V5l12-2v13\"/><circle cx=\"6\" cy=\"18\" r=\"3\"/><circle cx=\"18\" cy=\"16\" r=\"3\"/>"
            "</svg></div>"
            "<h1 style=\"font-size:18px;font-weight:500;margin:0 0 10px\">音乐下载服务未就绪</h1>"
            "<p style=\"color:#536159;margin:0 0 8px\">本机 127.0.0.1:8080 上的 music-dl 服务没有响应，"
            "可能正在启动或已停止。</p>"
            "<p style=\"color:#6C7A72;margin:0 0 16px;font-size:12px\">%s</p>"
            "<a href=\"/music/\" style=\"display:inline-block;padding:8px 22px;border-radius:8px;"
            "background:#0C7A69;color:#fff;text-decoration:none;font-weight:500\">重试</a>"
            "</div></body></html>"
        ) % (reason or "connection refused")
        body = body.encode("utf-8")
        self.send_response(503)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self._cache_set = True
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def proxy_music_dl(self, method):
        """把 /music 与 /music/* 请求流式代理到本机 go-music-dl Web 服务。

        对齐 go-music-dl README 里的 Nginx 反代约定：转发原始 Host、X-Forwarded-*、
        X-Requested-With / Origin / Sec-Fetch-*，使上游的 XHR 判别与同源写校验正常工作。
        响应按 64 KB 分块流式回写，大文件（FLAC 整专打包）不会堆在内存里。
        """
        parsed = urllib.parse.urlparse(self.path)
        upstream = MUSIC_DL_ORIGIN + parsed.path
        if parsed.query:
            upstream += "?" + parsed.query

        body = None
        if method == "POST":
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                length = 0
            if length > 0:
                body = self.rfile.read(min(length, 32 * 1024 * 1024))

        client_ip = self.client_address[0] if self.client_address else ""

        req = urllib.request.Request(upstream, data=body, method=method)
        # 原始 Host 必须透传：上游用请求 Host 与 Origin 做同源校验
        if self.headers.get("Host"):
            req.add_header("Host", self.headers.get("Host"))
        for h in _MUSIC_DL_REQ_HEADERS:
            v = self.headers.get(h)
            if v:
                req.add_header(_http_header_name(h), v)
        # 反代标准转发头（保留 Cloudflare 已写入的真实客户端信息）
        if self.headers.get("X-Forwarded-For"):
            req.add_header("X-Forwarded-For", self.headers.get("X-Forwarded-For"))
        elif client_ip:
            req.add_header("X-Forwarded-For", client_ip)
        real_ip = self.headers.get("CF-Connecting-IP") or client_ip
        if real_ip:
            req.add_header("X-Real-IP", real_ip)
        proto = self.headers.get("X-Forwarded-Proto") or ("https" if self.headers.get("CF-Visitor") else "http")
        req.add_header("X-Forwarded-Proto", proto)

        try:
            resp = urllib.request.urlopen(req, timeout=300)
        except urllib.error.HTTPError as e:
            resp = e  # 上游的 4xx/5xx 也原样透传
        except Exception as e:
            self.send_music_unavailable(str(e))
            return

        try:
            self.send_response(resp.status)
            has_length, has_cache = False, False
            for name, value in resp.headers.items():
                lname = name.lower()
                if lname in _MUSIC_DL_SKIP_RESP_HEADERS:
                    continue
                if lname == "content-length":
                    has_length = True
                if lname == "cache-control":
                    has_cache = True
                self.send_header(name, value)
            if not has_cache:
                # 上游未指定缓存策略：要求每次重新验证，避免 music-dl 升级后
                # 浏览器拿着启发式缓存的旧 UI / 旧 JSON
                self.send_header("Cache-Control", "no-cache")
            if not has_length:
                # 上游未给出长度（chunked 已被 urllib 解包）：关闭 keep-alive，
                # 依靠连接结束向客户端标识 body 结尾
                self.close_connection = True
            self.end_headers()
            if method == "HEAD":
                return
            while True:
                chunk = resp.read(64 * 1024)
                if not chunk:
                    break
                self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass  # 客户端中途断开（用户切页 / 取消下载），静默结束
        finally:
            try:
                resp.close()
            except Exception:
                pass

    # ---------- 路由 ----------
    def do_HEAD(self):
        # 接口路径用 GET 处理，HEAD 也要给出正确响应（供探针 / CDN 校验使用）
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path.startswith("/api/"):
            self._cache_set = True
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            return
        if parsed.path == MUSIC_DL_PREFIX or parsed.path.startswith(MUSIC_DL_PREFIX + "/"):
            self._cache_set = True
            self.proxy_music_dl("HEAD")
            return
        self._cache_set = False
        super().do_HEAD()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)
        if parsed.path == MUSIC_DL_PREFIX or parsed.path.startswith(MUSIC_DL_PREFIX + "/"):
            self._cache_set = True
            self.proxy_music_dl("POST")
            return
        if parsed.path == "/api/hif/convert":
            self.handle_hif_convert(qs)
            return
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

        if path == MUSIC_DL_PREFIX or path.startswith(MUSIC_DL_PREFIX + "/"):
            self._cache_set = True
            self.proxy_music_dl("GET")
            return

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
                "hifConvert": {
                    "ready": hif_convert is not None,
                    "maxUploadMB": _HIF_MAX_UPLOAD // 1048576,
                    "maxPixels": _HIF_MAX_PIXELS,
                    "error": _HIF_IMPORT_ERROR[:300],
                },
                "musicDl": {
                    "proxied": True,
                    "path": MUSIC_DL_PREFIX,
                    "reachable": music_dl_reachable(),
                },
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

        if path == "/api/nc/url":
            # 解析歌曲直链，用于「网易云直连下载」页：服务器只返回一个 URL，
            # 音频字节由用户浏览器直接从 CDN 取走，不再经本机转发（绕开 Cloudflare 隧道的带宽瓶颈）。
            song_id = (qs.get("id") or [""])[0].strip()
            if not song_id.isdigit():
                self.send_json({"error": "歌曲 ID 无效"}, 400)
                return
            br = (qs.get("br") or ["320000"])[0].strip()
            try:
                info = resolve_nc_url(song_id, br)
            except Exception as e:
                self.send_json({"error": "上游请求失败：%s" % e}, 502)
                return
            self.send_json(info, 200)
            return

        if path == "/api/nc/stream":
            # 浏览器直连 CDN 失败时的服务器兜底：解析直链后由服务器流式转发。
            # 不落盘、不缓存；速度受服务器上行限制，仅作兜底。
            song_id = (qs.get("id") or [""])[0].strip()
            if not song_id.isdigit():
                self.send_json({"error": "歌曲 ID 无效"}, 400)
                return
            if not self.nc_stream_rate_ok():
                self.send_json({"error": "代理下载请求过于频繁，请稍后再试"}, 429)
                return
            br = (qs.get("br") or ["320000"])[0].strip()
            try:
                info = resolve_nc_url(song_id, br)
            except Exception as e:
                self.send_json({"error": "上游直链解析失败：%s" % e}, 502)
                return
            if info.get("code") != 200 or not info.get("url"):
                self.send_json(info, 409)
                return

            name = (qs.get("name") or [""])[0].strip()
            artist = (qs.get("artist") or [""])[0].strip()
            ext = re.sub(r"[^a-z0-9]", "", (info.get("ext") or "mp3").lower()) or "mp3"
            base = name + (" - " + artist if artist else "") or "netease"
            base = re.sub(r"[\\/:*?\"<>|\r\n]", "_", base)[:120] or "netease"
            out_name = base + "." + ext
            ascii_name = "netease." + ext
            if not _NC_STREAM_SEMAPHORE.acquire(timeout=5):
                self.send_json({"error": "代理下载并发已满，请稍后再试"}, 503)
                return

            upstream = None
            started = False
            try:
                req = urllib.request.Request(info["url"], headers={"User-Agent": UA})
                upstream = urllib.request.urlopen(req, timeout=30)
                content_type = upstream.headers.get("Content-Type") or "audio/mpeg"
                try:
                    length = int(upstream.headers.get("Content-Length") or 0)
                except ValueError:
                    length = 0
                if not length:
                    length = int(info.get("size") or 0)
                self.send_response(200)
                self.send_header("Content-Type", content_type)
                if length > 0:
                    self.send_header("Content-Length", str(length))
                else:
                    self.close_connection = True
                self.send_header(
                    "Content-Disposition",
                    "attachment; filename=\"%s\"; filename*=UTF-8''%s"
                    % (ascii_name, urllib.parse.quote(out_name, safe="")),
                )
                self.send_header("Cache-Control", "no-store")
                self.send_header("X-Audio-Ext", ext)
                self.send_header("X-Audio-Source", "netease")
                self._cache_set = True
                self.end_headers()
                started = True
                while True:
                    chunk = upstream.read(64 * 1024)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
            except (BrokenPipeError, ConnectionResetError):
                self.close_connection = True
            except Exception as e:
                sys.stderr.write("[nc-stream] failed: %s: %s\n" % (type(e).__name__, e))
                if not started:
                    self.send_json({"error": "代理下载失败：%s" % e}, 502)
            finally:
                if upstream is not None:
                    try:
                        upstream.close()
                    except Exception:
                        pass
                _NC_STREAM_SEMAPHORE.release()
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
    print("HIF 转换: %s" % ("就绪" if hif_convert else
                            "未安装依赖（pip install -r requirements.txt）"))
    print("按 Ctrl+C 停止")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")


if __name__ == "__main__":
    main()
