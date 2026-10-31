#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
本地工具箱 - 轻量服务器（基础站点仅依赖 Python 标准库）

职责：
1. 托管本站静态文件（HTML / CSS / JS），替代 Nginx
2. 托管大体积解密密钥表，并按需分片下发（浏览器无需下载整个 70 MB 密钥）
3. 中转部分站点接口（网易云歌词搜索），解决浏览器跨域限制
4. 多源音乐解析：把本机 go-music-dl 当作元数据 / 直链解析器（不代理其 UI，
   不转发音频）；音频字节由浏览器直接向音源 CDN 请求并保存

接口：
  GET /api/ping                     健康检查与能力探测，前端据此决定可用功能
  GET /api/kgm/status               酷狗密钥表状态
  GET /api/kgm/key?start=&len=      按字节区间返回酷狗公钥表（分片解密用）
  GET /api/nc/search?s=关键词        网易云音乐搜索中转
  GET /api/nc/lyric?id=歌曲ID        网易云歌词中转（含翻译歌词）
  GET /api/music/search?s=&source=  多源音乐搜索（解析上游 HTML，返回 JSON 元数据；
                                    source=all 并行检索全部音源并交错合并，附带每源命中数）
  GET /api/music/url?id=&source=&duration=&extra=  解析音源 CDN 直链（只回 URL，不转发字节）
  GET /api/ai/models/{detector|inpainter} 按需下发浏览器 AI 模型
  GET /api/ai/runtime/{文件名}         下发 allowlist 中的 ONNX Runtime Web 文件
  POST /api/feedback                用户主动提交建议反馈
  POST /api/hif/convert?name=&q=&ev=  HIF/HEIF -> sRGB JPEG（HDR 色彩管理，仅内存处理；ev 为曝光补偿）

用法：
    python3 server.py                  # 默认 0.0.0.0:8000
    python3 server.py 8080             # 指定端口
    python3 server.py --expand-key     # 仅解压密钥表后退出（预热，避免首次请求等待）

说明：音频解密、常规图片处理与 AI 水印推理在用户浏览器本地完成；服务器只按需下发模型和运行库。
多源音乐由本机 go-music-dl（127.0.0.1:8080）解析，服务器只回元数据与 CDN URL，不接触音频字节；
旧 /music/* UI 代理已删除，上游 UI 与下载接口不对外暴露。
HIF/HEIF 的 HDR 解码是例外：文件上传后仅在服务器内存中转换、不落盘（见 hif_convert.py）。
"""
import html.parser
import ipaddress
import json
import os
import re
import socket
import sys
import threading
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
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

# 多源音乐解析：本机 go-music-dl（systemd: music-dl.service，仅监听 127.0.0.1:8080）。
# 只调用它的 /music/search（HTML）与 /music/inspect（JSON），把它当作元数据 / 直链解析器；
# 不代理上游 UI、不代理 /music/download，服务器不转发也不保存音频字节。
MUSIC_DL_HOST = "127.0.0.1"
MUSIC_DL_PORT = 8080
MUSIC_DL_ORIGIN = "http://%s:%d" % (MUSIC_DL_HOST, MUSIC_DL_PORT)
# 仅列出 CDN 允许浏览器跨域读取的音源：网易云 / 酷狗 / QQ / 千千（原有四源），
# 以及 2026-10-31 实测 inspect 直链带 Access-Control-Allow-Origin: * 的汽水（soda）与 5sing（fivesing）。
# 酷我、咪咕无 CORS，B 站需 Referer，Jamendo 返回 text/html，浏览器无法直连，因此不对外提供。
MUSIC_SOURCES = ("netease", "kugou", "qq", "qianqian", "soda", "fivesing")
MUSIC_ALL = "all"
MUSIC_MAX_RESULTS = 20
# source=all 交错合并后的总量上限；单源仍取 MUSIC_MAX_RESULTS。
MUSIC_AGG_MAX_RESULTS = 30
# 聚合搜索的并发上限（≤6，等于音源数）：上游是单机解析器，避免一次搜索打满它。
MUSIC_AGG_WORKERS = 6
# 聚合搜索给单源更短的超时：个别源挂起时不要拖住整页搜索。
MUSIC_AGG_TIMEOUT = 12
MUSIC_MAX_QUERY = 80
MUSIC_MAX_ID = 200
MUSIC_MAX_EXTRA = 4000
MUSIC_TIMEOUT = 25
MUSIC_MAX_HTML = 2 * 1024 * 1024
MUSIC_MAX_JSON = 256 * 1024
# 上游是单机解析器，按客户端 IP 做滑动窗口限流，避免被当成公开搜索代理刷爆。
# source=all 的聚合请求只在入口计 1 次（不会因为内部并发 6 个上游请求而多计）。
MUSIC_RATE_LIMITS = {"search": (30, 120), "inspect": (60, 240)}
# 短 TTL 内存缓存：搜索 120s、直链 90s；键 = 实际参数，线程安全、容量有上限。
# inspect 的 TTL 刻意不超过 90s：直链会过期，前端重试时最多在 90s 内仍命中旧 URL。
MUSIC_CACHE_TTL = {"search": 120, "inspect": 90}
MUSIC_CACHE_MAX = 512

_key_state = {"expanding": False}
_feedback_state = {}
_MUSIC_RATE = {kind: {} for kind in MUSIC_RATE_LIMITS}
_MUSIC_RATE_LOCK = threading.Lock()
_MUSIC_RATE_MAX_CLIENTS = 4096
_MUSIC_CACHE = {}
_MUSIC_CACHE_LOCK = threading.Lock()

# HIF conversion is CPU/RAM heavy, so requests are serialised and rate limited.
_HIF_MAX_UPLOAD = getattr(hif_convert, "MAX_UPLOAD_BYTES", 80 * 1024 * 1024)
_HIF_MAX_PIXELS = getattr(hif_convert, "MAX_PIXELS", 60000000)
_HIF_SEMAPHORE = threading.BoundedSemaphore(1)
_HIF_UPLOAD_SEMAPHORE = threading.BoundedSemaphore(2)
_HIF_RATE_LOCK = threading.Lock()
_HIF_RATE = {}
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


def music_dl_reachable(timeout=0.5):
    """探测本机 music-dl 是否在 8080 监听（/api/ping 能力上报用，不发 HTTP 请求）。"""
    try:
        with socket.create_connection((MUSIC_DL_HOST, MUSIC_DL_PORT), timeout=timeout):
            return True
    except OSError:
        return False


def music_resolver_get(path, params, timeout=MUSIC_TIMEOUT, max_bytes=MUSIC_MAX_HTML):
    """调用本机解析器的只读接口：带浏览器 UA，响应超过上限直接报错。"""
    url = MUSIC_DL_ORIGIN + path + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept": "application/json, text/html;q=0.9, */*;q=0.8",
    })
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = resp.read(max_bytes + 1)
    if len(data) > max_bytes:
        raise ValueError("上游响应超过 %d 字节" % max_bytes)
    return data


def https_url(value):
    """CDN 直链常是 http，页面是 https，必须升级，否则浏览器按混合内容拦截。"""
    value = (value or "").strip()
    if value[:7].lower() == "http://":
        return "https://" + value[7:]
    return value


def is_web_url(value):
    try:
        parts = urllib.parse.urlsplit(value)
    except ValueError:
        return False
    return parts.scheme.lower() in ("http", "https") and bool(parts.netloc)


def as_int(value):
    """把上游 JSON / HTML 属性转成非负整数，无法解析时返回 0。"""
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        return 0


def is_digits(value):
    return bool(value) and value.isascii() and value.isdigit()


def as_bytes(value):
    """上游 size 可能是字节数或 '10.0 MB' 之类的可读文本，统一换算成字节。"""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return max(0, int(value))
    match = re.match(r"^\s*([0-9]+(?:\.[0-9]+)?)\s*([KMGT]?)I?B?\s*$",
                     str(value or "").upper())
    if not match:
        return 0
    scale = {"": 0, "K": 1, "M": 2, "G": 3, "T": 4}[match.group(2)]
    return int(round(float(match.group(1)) * (1024 ** scale)))


def as_kbps(value):
    """上游 bitrate 可能是数字或 '320 kbps'，统一成 kbps 整数。"""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return max(0, int(value))
    text = str(value or "").strip().lower()
    match = re.search(r"([0-9]+(?:\.[0-9]+)?)", text)
    if not match:
        return 0
    number = float(match.group(1))
    if "mbps" in text:
        number *= 1000
    return max(0, int(round(number)))


def music_error_text(exc):
    """把上游异常压成一行可读文本（不含堆栈）。"""
    code = getattr(exc, "code", None)
    reason = getattr(exc, "reason", None)
    if code:
        text = "HTTP %s %s" % (code, reason or "")
    else:
        text = str(reason) if reason is not None else str(exc)
    return (text.strip() or type(exc).__name__)[:200]


def music_rate_allow(kind, client):
    """按客户端 IP 的滑动窗口限流；kind 为 search / inspect。"""
    per_minute, per_hour = MUSIC_RATE_LIMITS[kind]
    now = time.time()
    with _MUSIC_RATE_LOCK:
        bucket = _MUSIC_RATE[kind]
        history = [t for t in bucket.get(client, ()) if now - t < 3600]
        if len(history) >= per_hour or sum(1 for t in history if now - t < 60) >= per_minute:
            bucket[client] = history
            return False
        history.append(now)
        bucket[client] = history
        if len(bucket) > _MUSIC_RATE_MAX_CLIENTS:
            # 偶尔清理已经过期的客户端，避免长期运行时字典无限增长
            for key in [k for k, stamps in bucket.items() if not stamps or now - stamps[-1] >= 3600]:
                bucket.pop(key, None)
    return True


def music_cache_get(kind, key):
    """读短 TTL 缓存；过期条目顺手删除并返回 None。key 为参数元组。"""
    full = (kind,) + tuple(key)
    now = time.time()
    with _MUSIC_CACHE_LOCK:
        entry = _MUSIC_CACHE.get(full)
        if entry is None:
            return None
        if entry[0] <= now:
            _MUSIC_CACHE.pop(full, None)
            return None
        return entry[1]


def music_cache_put(kind, key, value):
    """写缓存；只在成功时调用，错误/异常绝不缓存。容量超限时丢弃最早写入项。"""
    full = (kind,) + tuple(key)
    now = time.time()
    ttl = MUSIC_CACHE_TTL.get(kind, 60)
    with _MUSIC_CACHE_LOCK:
        _MUSIC_CACHE[full] = (now + ttl, value)
        if len(_MUSIC_CACHE) > MUSIC_CACHE_MAX:
            for stale in [k for k, item in _MUSIC_CACHE.items() if item[0] <= now]:
                _MUSIC_CACHE.pop(stale, None)
        while len(_MUSIC_CACHE) > MUSIC_CACHE_MAX:
            # dict 保持插入顺序：容量仍超限时淘汰最早写入的条目
            _MUSIC_CACHE.pop(next(iter(_MUSIC_CACHE)))


class MusicSourceError(Exception):
    """单源搜索失败；kind 区分上游请求失败（upstream）与返回内容异常（parse）。"""

    def __init__(self, kind, message):
        super().__init__(message)
        self.kind = kind
        self.message = message


def music_search_source(source, keyword, timeout=MUSIC_TIMEOUT):
    """检索单个音源（带缓存）；失败抛 MusicSourceError，不写缓存。"""
    cache_key = (source, keyword)
    cached = music_cache_get("search", cache_key)
    if cached is not None:
        return list(cached)

    params = {
        "q": keyword,
        "type": "song",
        "page": "1",
        "page_size": str(MUSIC_MAX_RESULTS),
        "sources": source,
    }
    try:
        raw = music_resolver_get("/music/search", params, timeout=timeout)
    except Exception as exc:
        raise MusicSourceError("upstream", music_error_text(exc))
    try:
        songs = parse_music_results(raw.decode("utf-8", "replace"), source)
    except Exception as exc:
        raise MusicSourceError("parse", str(exc)[:200] or type(exc).__name__)
    # 空结果不缓存：上游偶尔会抖动返回空页，缓存会让用户很长时间内重试也拿不到结果。
    if songs:
        music_cache_put("search", cache_key, songs)
    return list(songs)


def music_dedupe_key(song):
    """同源 + 同名 + 同歌手 + 同长度视为重复；跨源重复保留，作为可换源选项。"""
    return (
        song.get("source") or "",
        (song.get("name") or "").strip().lower(),
        (song.get("artist") or "").strip().lower(),
        as_int(song.get("duration")),
    )


def music_search_all(keyword):
    """并行检索全部音源，交错合并去重。

    返回 (songs, counts, failures)：counts 为每个源的命中数（失败源为 0），
    failures 为失败源数量；单个源失败（请求异常 / 解析异常）不影响整体。
    """
    counts = dict((source, 0) for source in MUSIC_SOURCES)
    per_source = {}
    failures = 0
    workers = max(1, min(len(MUSIC_SOURCES), MUSIC_AGG_WORKERS))
    pool = ThreadPoolExecutor(max_workers=workers)
    try:
        futures = dict(
            (pool.submit(music_search_source, source, keyword, MUSIC_AGG_TIMEOUT), source)
            for source in MUSIC_SOURCES
        )
        for future in as_completed(futures):
            source = futures[future]
            try:
                songs = future.result()
            except Exception as exc:
                failures += 1
                # 只记录单行原因，响应里不泄露堆栈
                detail = getattr(exc, "message", None) or str(exc) or type(exc).__name__
                sys.stderr.write("[music] search %s failed: %s\n" % (source, detail[:200]))
                continue
            if songs:
                counts[source] = len(songs)
                per_source[source] = songs
    finally:
        pool.shutdown(wait=True)

    merged = []
    seen = set()
    index = 0
    while len(merged) < MUSIC_AGG_MAX_RESULTS:
        added = False
        for source in MUSIC_SOURCES:
            songs = per_source.get(source) or ()
            if index >= len(songs):
                continue
            added = True
            song = songs[index]
            marker = music_dedupe_key(song)
            if marker in seen:
                continue
            seen.add(marker)
            merged.append(song)
            if len(merged) >= MUSIC_AGG_MAX_RESULTS:
                break
        if not added:
            break
        index += 1
    return merged, counts, failures


class MusicCardParser(html.parser.HTMLParser):
    """收集 go-music-dl 搜索页里的 <li class="song-card" data-*="..."> 属性。

    html.parser 会反转义属性值中的 HTML 实体（&quot; / &#34; / &amp; 等），
    因此 data-extra 拿到的就是上游原始 JSON 字符串，引号与 | 都不会丢。
    """

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.cards = []

    def handle_starttag(self, tag, attrs):
        if tag != "li":
            return
        data = {}
        classes = ()
        for name, value in attrs:
            if name == "class":
                classes = (value or "").split()
            elif name.startswith("data-"):
                data[name] = value or ""
        if "song-card" in classes:
            self.cards.append(data)


def parse_music_results(html_text, source):
    """把搜索结果页 HTML 规范化为前端 JSON 条目（最多 20 首）。"""
    parser = MusicCardParser()
    parser.feed(html_text)
    parser.close()
    songs = []
    for card in parser.cards:
        song_id = (card.get("data-id") or "").strip()
        if not song_id or len(song_id) > MUSIC_MAX_ID:
            continue
        card_source = (card.get("data-source") or "").strip().lower()
        if card_source and card_source not in MUSIC_SOURCES:
            # 只暴露 CDN 允许浏览器直连的音源，其余来源即使上游混入也不下发
            continue
        if not card_source:
            card_source = source
        songs.append({
            "id": song_id,
            "source": card_source,
            "name": (card.get("data-name") or "").strip(),
            "artist": (card.get("data-artist") or "").strip(),
            "album": (card.get("data-album") or "").strip(),
            "duration": as_int(card.get("data-duration")),
            "extra": card.get("data-extra") or "",
            "cover": https_url(card.get("data-cover")),
        })
        if len(songs) >= MUSIC_MAX_RESULTS:
            break
    return songs


def sanitize_music_inspect(info):
    """只回传前端需要的字段；http 直链升级为 https，非 http(s) 一律视为无效。"""
    song = info.get("song") if isinstance(info.get("song"), dict) else {}
    url = https_url(info.get("url") or song.get("url"))
    if bool(info.get("valid")) and is_web_url(url):
        return {
            "valid": True,
            "url": url,
            "size": as_bytes(info.get("size") or song.get("size")),
            "bitrate": as_kbps(info.get("bitrate") or song.get("bitrate")),
            "status": "valid",
            "reason": "",
        }
    status = str(info.get("status") or "").strip()[:40] or "invalid"
    reason = str(info.get("reason") or "").strip()[:200]
    if info.get("valid"):
        status, reason = "no_url", "上游未返回可用直链"
    return {"valid": False, "status": status, "reason": reason, "url": "", "size": 0, "bitrate": 0}


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

    # ---------- 多源音乐解析（go-music-dl 只做解析，音频由浏览器直连 CDN） ----------
    def handle_music_search(self, qs):
        keyword = (qs.get("s") or [""])[0].strip()
        source = (qs.get("source") or [""])[0].strip().lower()
        if not keyword:
            self.send_json({"error": "缺少搜索关键词"}, 400)
            return
        if len(keyword) > MUSIC_MAX_QUERY:
            self.send_json({"error": "搜索关键词过长（最多 %d 个字符）" % MUSIC_MAX_QUERY}, 400)
            return
        if source != MUSIC_ALL and source not in MUSIC_SOURCES:
            self.send_json({
                "error": "不支持的音源（仅支持 all 与 %s）" % "、".join(MUSIC_SOURCES),
            }, 400)
            return
        # 聚合搜索同样只计 1 次，内部并发 6 个上游请求不再额外计数
        if not music_rate_allow("search", self.rate_limit_key()):
            self.send_json({"error": "搜索请求过于频繁，请稍后再试"}, 429)
            return

        if source == MUSIC_ALL:
            try:
                songs, counts, failures = music_search_all(keyword)
            except Exception as exc:
                sys.stderr.write("[music] aggregate failed: %s\n" % exc)
                self.send_json({"error": "解析服务临时异常，请稍后重试"}, 502)
                return
            if failures >= len(MUSIC_SOURCES):
                self.send_json({"error": "解析服务请求失败：全部音源均未响应，请稍后重试"}, 502)
                return
            self.send_json({
                "ok": True,
                "source": MUSIC_ALL,
                "songs": songs,
                "counts": counts,
            })
            return

        try:
            songs = music_search_source(source, keyword)
        except MusicSourceError as exc:
            sys.stderr.write("[music] search %s failed: %s\n" % (source, exc.message))
            if exc.kind == "parse":
                self.send_json({"error": "解析服务返回内容异常，无法解析搜索结果"}, 502)
            else:
                self.send_json({"error": "解析服务请求失败：%s" % exc.message}, 502)
            return
        except Exception as exc:
            sys.stderr.write("[music] search upstream failed: %s\n" % exc)
            self.send_json({"error": "解析服务请求失败：%s" % music_error_text(exc)}, 502)
            return
        self.send_json({"ok": True, "source": source, "songs": songs})

    def handle_music_inspect(self, qs):
        source = (qs.get("source") or [""])[0].strip().lower()
        song_id = (qs.get("id") or [""])[0].strip()
        duration = (qs.get("duration") or [""])[0].strip()
        extra = (qs.get("extra") or [""])[0]
        if source not in MUSIC_SOURCES:
            self.send_json({"error": "不支持的音源（仅支持 %s）" % "、".join(MUSIC_SOURCES)}, 400)
            return
        if not song_id:
            self.send_json({"error": "缺少歌曲 ID"}, 400)
            return
        if len(song_id) > MUSIC_MAX_ID:
            self.send_json({"error": "歌曲 ID 过长"}, 400)
            return
        if duration and not is_digits(duration):
            self.send_json({"error": "时长参数无效"}, 400)
            return
        if len(extra) > MUSIC_MAX_EXTRA:
            self.send_json({"error": "附加参数过长"}, 400)
            return
        if not music_rate_allow("inspect", self.rate_limit_key()):
            self.send_json({"error": "解析请求过于频繁，请稍后再试"}, 429)
            return

        cache_key = (source, song_id, duration, extra)
        cached = music_cache_get("inspect", cache_key)
        if cached is not None:
            self.send_json(cached)
            return

        params = {"id": song_id, "source": source, "duration": duration}
        if extra:
            params["extra"] = extra
        try:
            # 只解析直链，绝不在此请求音频字节
            raw = music_resolver_get("/music/inspect", params, max_bytes=MUSIC_MAX_JSON)
        except Exception as exc:
            sys.stderr.write("[music] inspect upstream failed: %s\n" % exc)
            self.send_json({"error": "解析服务请求失败：%s" % music_error_text(exc)}, 502)
            return
        try:
            info = json.loads(raw.decode("utf-8", "replace"))
        except Exception:
            info = None
        if not isinstance(info, dict):
            self.send_json({"error": "解析服务返回内容异常"}, 502)
            return
        result = sanitize_music_inspect(info)
        # 只缓存成功拿到的直链；失效 / 异常结果不缓存，避免重试被旧结论卡住
        if result.get("valid"):
            music_cache_put("inspect", cache_key, result)
        self.send_json(result)

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
        self._cache_set = False
        super().do_HEAD()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)
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
                "musicResolver": {
                    "reachable": music_dl_reachable(),
                    "sources": list(MUSIC_SOURCES),
                },
                "browserWatermarkAi": browser_ai,
                "hifConvert": {
                    "ready": hif_convert is not None,
                    "maxUploadMB": _HIF_MAX_UPLOAD // 1048576,
                    "maxPixels": _HIF_MAX_PIXELS,
                    "error": _HIF_IMPORT_ERROR[:300],
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

        if path == "/api/music/search":
            self.handle_music_search(qs)
            return

        if path == "/api/music/url":
            self.handle_music_inspect(qs)
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
