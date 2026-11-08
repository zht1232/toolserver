#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Agent 接口层：让脚本 / LLM Agent 用 HTTP 直接驱动站点能力。

设计原则
--------
1. 不改变站点原有行为：本模块只是 server.py 上面的一层薄封装，普通页面走的还是原来的
   /api/music/* 与浏览器本地处理链路。
2. 一切写操作 / 耗时操作都要鉴权：token 由服务首次启动时随机生成，存放在站点目录之外
   （默认 ../localtools-agent-token，0600），可用环境变量 LOCALTOOLS_AGENT_TOKEN 覆盖。
   注意不能按「本机回环地址」放行——公网请求经 Cloudflare 隧道进来也是 127.0.0.1。
3. 音乐仍然只做「检索 + 解析直链」：单曲下载按 Agent 请求转发一次字节流，不落盘、不缓存；
   整专辑下载在内存 / 私有临时目录里打包后立刻删除。
4. 能力清单 /api/agent 免鉴权（只是文档，不含任何密钥），方便 Agent 自举：
   先读清单，再拿 token 调具体接口。

接口
----
  GET  /api/agent                     能力清单（免鉴权）
  GET  /api/agent/ping                健康检查（需鉴权，返回上游解析器与图像处理可用性）
  GET  /api/agent/music/search        多源检索：type=song|artist|album
  GET  /api/agent/music/album         按专辑取曲目，format=list|zip
  GET  /api/agent/music/artist        按歌手取作品，format=list|zip
  GET  /api/agent/music/resolve       只解析直链（JSON，不转发字节）
  GET  /api/agent/music/download      下载单曲（流式字节，或 mode=url 返回直链）
  GET  /api/agent/image/ops           修图算子说明
  POST /api/agent/image/edit          服务端修图 / 格式转换（支持 zip 批量）
"""
import hmac
import io
import json
import os
import re
import secrets
import shutil
import sys
import tempfile
import threading
import time
import unicodedata
import urllib.parse
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed

AGENT_VERSION = "1.0"

# 由 server.py 在启动时注入（见 bind）。
_srv = None


def bind(module):
    """注入 server 模块，用于复用它的音乐检索 / 限流 / 解析工具。"""
    global _srv
    _srv = module


# ---------------------------------------------------------------- 常量与状态
MAX_UPLOAD = 40 * 1024 * 1024          # 单张图片 / 单个 zip 上传上限
MAX_PIXELS = 40_000_000                # 解码后像素上限（防止解压炸弹）
MAX_AUDIO_TRACK = 120 * 1024 * 1024    # 单曲转发上限
MAX_ALBUM_BYTES = 600 * 1024 * 1024    # 整专辑打包上限
MAX_ALBUM_TRACKS = 40
MAX_ZIP_FILES = 24
MAX_KEYWORD = 80
MAX_TRACKS_RETURN = 40

# 音频 CDN 对 Referer 有要求的源：带上各自站点页，避免 403。
SOURCE_REFERERS = {
    "netease": "https://music.163.com/",
    "kugou": "https://www.kugou.com/",
    "qq": "https://y.qq.com/",
    "qianqian": "https://music.taihe.com/",
    "soda": "https://music.douyin.com/",
    "fivesing": "https://5sing.kugou.com/",
}

# 限流：kind -> (每分钟, 每小时)。按客户端 IP 计，公网走 CF-Connecting-IP。
RATE_LIMITS = {"read": (60, 600), "download": (30, 300), "edit": (30, 240)}

_RATE = {kind: {} for kind in RATE_LIMITS}
_RATE_LOCK = threading.Lock()
_RATE_MAX_CLIENTS = 4096

_TOKEN_STATE = {"value": "", "lock": threading.Lock()}

_IMAGE_SEMAPHORE = threading.BoundedSemaphore(2)

try:  # 图像算子只依赖 Pillow；pillow-heif 是可选的 HEIC/HIF 解码器
    from PIL import Image as _PIL_Image  # noqa: F401
    _PIL_READY = True
except Exception:
    _PIL_READY = False


class AgentError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.message = message
        self.status = status


# ---------------------------------------------------------------- 鉴权
def token_file():
    return os.path.join(os.path.dirname(_srv.BASE_DIR), "localtools-agent-token")


def agent_token():
    """读 token；不存在则生成（0600）。环境变量优先，便于容器化部署。"""
    env = os.environ.get("LOCALTOOLS_AGENT_TOKEN", "").strip()
    if env:
        return env
    with _TOKEN_STATE["lock"]:
        if _TOKEN_STATE["value"]:
            return _TOKEN_STATE["value"]
        path = token_file()
        try:
            if os.path.exists(path):
                with open(path, "r", encoding="utf-8") as f:
                    value = f.read().strip()
                if value:
                    _TOKEN_STATE["value"] = value
                    return value
            value = secrets.token_urlsafe(24)
            tmp = path + ".tmp"
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(value + "\n")
            os.replace(tmp, path)
            _TOKEN_STATE["value"] = value
            sys.stderr.write("[agent] 已生成访问令牌：%s\n" % path)
            return value
        except OSError as exc:
            sys.stderr.write("[agent] 无法读写令牌文件 %s: %s\n" % (path, exc))
            return ""


def _presented_token(handler, qs):
    auth = handler.headers.get("Authorization") or ""
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    header = (handler.headers.get("X-Agent-Token") or "").strip()
    if header:
        return header
    return ((qs.get("token") or [""])[0] or "").strip()


def require_auth(handler, qs):
    expected = agent_token()
    if not expected:
        raise AgentError("服务器未能初始化 Agent 令牌，请在服务器上检查目录写权限", 503)
    got = _presented_token(handler, qs)
    if not got:
        raise AgentError("缺少访问令牌", 401)
    if not hmac.compare_digest(got, expected):
        raise AgentError("访问令牌无效", 401)
    return True


def unauthorized(handler, message):
    handler.send_json({
        "error": message,
        "auth": {
            "required": True,
            "header": "Authorization: Bearer <token>",
            "alternatives": ["X-Agent-Token: <token>", "?token=<token>"],
            "tokenFile": token_file(),
            "env": "LOCALTOOLS_AGENT_TOKEN",
            "hint": "令牌由服务器首次启动时生成，仅在本机站点目录之外，读取后放进请求头即可。",
        },
    }, 401)


# ---------------------------------------------------------------- 限流
def rate_ok(kind, client):
    per_minute, per_hour = RATE_LIMITS[kind]
    now = time.time()
    with _RATE_LOCK:
        bucket = _RATE[kind]
        history = [t for t in bucket.get(client, ()) if now - t < 3600]
        if len(history) >= per_hour or sum(1 for t in history if now - t < 60) >= per_minute:
            bucket[client] = history
            return False
        history.append(now)
        bucket[client] = history
        if len(bucket) > _RATE_MAX_CLIENTS:
            for key in [k for k, stamps in bucket.items() if not stamps or now - stamps[-1] >= 3600]:
                bucket.pop(key, None)
    return True


def require_rate(handler, kind):
    if not rate_ok(kind, handler.rate_limit_key()):
        raise AgentError("请求过于频繁，请稍后再试（%s 类接口有每分钟上限）" % kind, 429)


# ---------------------------------------------------------------- 通用小工具
def qs1(qs, name, default=""):
    return (qs.get(name) or [default])[0].strip()


def qs_int(qs, name, default, low=None, high=None):
    raw = (qs.get(name) or [""])[0].strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        raise AgentError("参数 %s 需要整数" % name)
    if low is not None and value < low:
        value = low
    if high is not None and value > high:
        value = high
    return value


def norm_text(value):
    """归一化用于匹配：全角转半角、小写、去掉空白与常见分隔符。"""
    text = unicodedata.normalize("NFKC", value or "").lower()
    return re.sub(r"[\s\u3000\-–—_·.,、，。:：;；/&()（）\[\]【】'\"!！?？+~]+", "", text)


ARTIST_SPLIT = re.compile(r"[、,，/&;；]|(?:\bfeat\.?|\bft\.|\bwith\b)", re.I)


def artist_tokens(value):
    return [norm_text(t) for t in ARTIST_SPLIT.split(value or "") if norm_text(t)]


def match_artist(song_artist, query_norm):
    if not query_norm:
        return True
    if query_norm in norm_text(song_artist):
        return True
    return any(query_norm == token for token in artist_tokens(song_artist))


def match_album(song_album, query_norm):
    if not query_norm:
        return True
    album = norm_text(song_album)
    if not album:
        return False
    if query_norm in album:
        return True
    # 反向包含：用户给的是完整专辑名（含版本后缀）而库里是短名
    return len(album) >= 2 and album in query_norm


def safe_filename(value, fallback="audio", limit=120):
    text = re.sub(r"[\\/:*?\"<>|\r\n\t]+", "_", (value or "").strip())
    text = re.sub(r"\s+", " ", text).strip(" ._")
    return (text or fallback)[:limit]


def disposition(name):
    ascii_name = re.sub(r"[^A-Za-z0-9._-]+", "_", name) or "download"
    return "attachment; filename=\"%s\"; filename*=UTF-8''%s" % (
        ascii_name, urllib.parse.quote(name, safe=""))


# ---------------------------------------------------------------- 音乐检索
def _search_one_source(source, keywords, timeout):
    """单源检索多个关键词。上游偶尔会因为并发过多返回空页，空结果重试一次。"""
    songs = []
    for keyword in keywords:
        try:
            songs.extend(_paced_search(source, keyword, timeout))
        except Exception:
            # 单关键词失败不拖累其它关键词；全部失败时由调用方统计
            continue
    if not songs:
        time.sleep(0.5)
        try:
            songs = list(_paced_search(source, keywords[0], timeout))
        except Exception:
            songs = []
    return songs


# 上游是单机解析器：并发过高时会返回空页，给请求之间加一点最小间隔，避免互相打架。
_UPSTREAM_LOCK = threading.Lock()
_UPSTREAM_LAST = [0.0]
_UPSTREAM_MIN_INTERVAL = 0.12


def _paced_search(source, keyword, timeout):
    with _UPSTREAM_LOCK:
        wait = _UPSTREAM_MIN_INTERVAL - (time.time() - _UPSTREAM_LAST[0])
        if wait > 0:
            time.sleep(wait)
        _UPSTREAM_LAST[0] = time.time()
    return _srv.music_search_source(source, keyword, timeout, AGENT_PAGE_SIZE)


def collect_songs(keywords, source):
    """按音源检索多个关键词并合并；返回 (songs, counts, failures)。

    与 /api/music/search 的区别：这里不做「交错截断到 30 条」，而是保留每个音源的全部
    命中，供专辑 / 歌手分组用——截断会把同一张专辑的曲目切掉一半。
    """
    keywords = [k for k in keywords if k][:2]
    if not keywords:
        raise AgentError("缺少检索关键词")
    sources = list(_srv.MUSIC_SOURCES)
    if source != "all":
        if source not in sources:
            raise AgentError("不支持的音源（仅支持 all 与 %s）" % "、".join(sources))
        songs = []
        failure = 0
        for keyword in keywords:
            try:
                songs.extend(_srv.music_search_source(source, keyword, page_size=AGENT_PAGE_SIZE))
            except Exception:
                failure += 1
        if failure == len(keywords):
            raise AgentError("解析服务请求失败，请稍后重试", 502)
        counts = {source: len(songs)}
        return _dedupe(songs), counts, 0

    counts = {s: 0 for s in sources}
    per_source = {}
    failures = 0
    pool = ThreadPoolExecutor(max_workers=max(1, min(len(sources), 6)))
    try:
        futures = {
            pool.submit(_search_one_source, s, keywords, _srv.MUSIC_AGG_TIMEOUT): s
            for s in sources
        }
        for future in as_completed(futures):
            name = futures[future]
            try:
                songs = future.result()
            except Exception:
                failures += 1
                continue
            if songs:
                per_source[name] = songs
                counts[name] = len(songs)
    finally:
        pool.shutdown(wait=True)
    if failures >= len(sources):
        raise AgentError("解析服务请求失败：全部音源均未响应，请稍后重试", 502)
    merged = []
    for name in sources:
        merged.extend(per_source.get(name, ()))
    return _dedupe(merged), counts, failures


def _dedupe(songs):
    seen = set()
    out = []
    for song in songs:
        marker = (song.get("source"), song.get("id"))
        if not marker[1] or marker in seen:
            continue
        seen.add(marker)
        out.append(song)
    return out


def enrich_pool(keyword, songs, sources=("netease", "qq")):
    """整包下载前用单源补检索一次：主音源解析不出来时，备选池里得先有同一首歌。"""
    existing = {(s.get("source"), s.get("id")) for s in songs}
    for source in sources:
        if source not in _srv.MUSIC_SOURCES:
            continue
        try:
            extra = _paced_search(source, keyword, _srv.MUSIC_AGG_TIMEOUT)
        except Exception:
            continue
        for song in extra:
            key = (song.get("source"), song.get("id"))
            if key in existing:
                continue
            existing.add(key)
            songs.append(song)
    return songs


def public_song(song):
    return {
        "id": song.get("id", ""),
        "source": song.get("source", ""),
        "name": song.get("name", ""),
        "artist": song.get("artist", ""),
        "album": song.get("album", ""),
        "duration": int(song.get("duration") or 0),
        "cover": song.get("cover", ""),
        "extra": song.get("extra", ""),
    }


def group_albums(songs, album_query, artist_query, max_tracks):
    """按 (专辑, 歌手) 分组，返回带曲目的专辑列表。"""
    album_q = norm_text(album_query)
    artist_q = norm_text(artist_query)
    groups = {}
    for song in songs:
        if not match_album(song.get("album", ""), album_q):
            continue
        if not match_artist(song.get("artist", ""), artist_q):
            continue
        key = (norm_text(song.get("album")), norm_text(song.get("artist")))
        group = groups.get(key)
        if group is None:
            group = {
                "album": song.get("album", ""),
                "artist": song.get("artist", ""),
                "cover": song.get("cover", ""),
                "sources": [],
                "tracks": [],
                "_seen": set(),
            }
            groups[key] = group
        source = song.get("source", "")
        if source not in group["sources"]:
            group["sources"].append(source)
        if not group["cover"] and song.get("cover"):
            group["cover"] = song.get("cover")
        # 同一首歌在不同音源重复出现时只留第一条（音源顺序即优选顺序），
        # 但记录其余可用音源，便于解析失败时换源。
        track_key = (norm_text(song.get("name")), int(song.get("duration") or 0) // 3)
        if track_key in group["_seen"]:
            continue
        group["_seen"].add(track_key)
        group["tracks"].append(public_song(song))

    albums = []
    for group in groups.values():
        tracks = group["tracks"][:max_tracks]
        group.pop("_seen", None)
        if not tracks:
            continue
        albums.append({
            "album": group["album"],
            "artist": group["artist"],
            "cover": group["cover"],
            "sources": group["sources"],
            "trackCount": len(tracks),
            "duration": sum(t["duration"] for t in tracks),
            "tracks": tracks,
        })
    albums.sort(key=lambda item: (-item["trackCount"], item["album"]))
    return albums


def group_artists(songs, artist_query, max_tracks):
    artist_q = norm_text(artist_query)
    groups = {}
    for song in songs:
        if artist_q and not match_artist(song.get("artist", ""), artist_q):
            continue
        token = None
        if artist_q:
            for candidate in artist_tokens(song.get("artist", "")):
                if candidate == artist_q:
                    token = candidate
                    break
        key = token or norm_text(song.get("artist"))
        group = groups.get(key)
        if group is None:
            group = {
                "artist": song.get("artist", "") if not token else _display_artist(song, token),
                "cover": song.get("cover", ""),
                "sources": [],
                "albums": {},
                "tracks": [],
                "_seen": set(),
            }
            groups[key] = group
        source = song.get("source", "")
        if source not in group["sources"]:
            group["sources"].append(source)
        if not group["cover"] and song.get("cover"):
            group["cover"] = song["cover"]
        album_name = song.get("album") or "未知专辑"
        album_entry = group["albums"].setdefault(album_name, {"album": album_name, "trackCount": 0})
        album_entry["trackCount"] += 1
        track_key = (norm_text(song.get("name")), int(song.get("duration") or 0) // 3)
        if track_key in group["_seen"] or len(group["tracks"]) >= max_tracks:
            continue
        group["_seen"].add(track_key)
        group["tracks"].append(public_song(song))

    artists = []
    for group in groups.values():
        group.pop("_seen", None)
        albums = sorted(group["albums"].values(), key=lambda a: -a["trackCount"])
        artists.append({
            "artist": group["artist"],
            "cover": group["cover"],
            "sources": group["sources"],
            "albumCount": len(albums),
            "albums": albums,
            "trackCount": len(group["tracks"]),
            "tracks": group["tracks"],
        })
    artists.sort(key=lambda item: -item["trackCount"])
    return artists


def _display_artist(song, token):
    """把完整歌手串收敛到命中的那位（如「周杰伦、杨瑞代」→「周杰伦」）。"""
    for part in ARTIST_SPLIT.split(song.get("artist", "")):
        if norm_text(part) == token:
            return part.strip()
    return song.get("artist", "")


# ---------------------------------------------------------------- 直链解析与下载
# 音源可用性并不稳定：实测酷狗当前对所有 hash 都返回 not_found，网易云 / 汽水正常。
# 因此每首歌都带一组「同曲其它音源」备选，解析失败自动换源，而不是让整张专辑失败。
SOURCE_PRIORITY = ["netease", "qq", "kugou", "soda", "qianqian", "fivesing"]
ZIP_BUDGET = 70      # 整包下载时间预算（秒），给打包与回传留出余量
ZIP_WORKERS = 3
# 上游各源适配器在页长偏大时更容易回空页（网易云 page_size=20 只回 1 条），Agent 用 10 更稳
AGENT_PAGE_SIZE = 10


def resolve_song(song):
    """解析单曲直链；返回 sanitize 后的结果（valid/url/size/bitrate...）。"""
    source = (song.get("source") or "").strip().lower()
    song_id = (song.get("id") or "").strip()
    if source not in _srv.MUSIC_SOURCES:
        raise AgentError("不支持的音源（仅支持 %s）" % "、".join(_srv.MUSIC_SOURCES))
    if not song_id:
        raise AgentError("缺少歌曲 id")
    params = {
        "id": song_id,
        "source": source,
        "duration": str(int(song.get("duration") or 0)),
    }
    extra = (song.get("extra") or "").strip()
    if extra:
        params["extra"] = extra[: _srv.MUSIC_MAX_EXTRA]
    try:
        raw = _srv.music_resolver_get("/music/inspect", params, max_bytes=_srv.MUSIC_MAX_JSON)
    except Exception as exc:
        raise AgentError("解析失败：%s" % _srv.music_error_text(exc), 502)
    try:
        info = json.loads(raw.decode("utf-8", "replace"))
    except Exception:
        raise AgentError("解析服务返回内容异常", 502)
    if not isinstance(info, dict):
        raise AgentError("解析服务返回内容异常", 502)
    return _srv.sanitize_music_inspect(info)


def attach_alternates(tracks, pool):
    """给每首曲目挂上「同名同曲、其它音源」的备选，解析失败时可换源。"""
    index = {}
    for song in pool:
        index.setdefault(norm_text(song.get("name")), []).append(song)
    for track in tracks:
        duration = int(track.get("duration") or 0)
        candidates = []
        for song in index.get(norm_text(track.get("name")), ()):
            if song.get("source") == track.get("source") and song.get("id") == track.get("id"):
                continue
            candidates.append(song)
        candidates.sort(key=lambda item: (
            SOURCE_PRIORITY.index(item["source"]) if item.get("source") in SOURCE_PRIORITY else 9,
            abs(int(item.get("duration") or 0) - duration),
        ))
        track["alternates"] = [public_song(item) for item in candidates[:4]]


def resolve_track(track):
    """按曲目自身音源解析，失败则依次尝试备选音源；返回 (info, 实际使用的曲目)。"""
    chain = [track] + list(track.get("alternates") or [])
    last = None
    tried = set()
    for candidate in chain:
        key = (candidate.get("source"), candidate.get("id"))
        if key in tried:
            continue
        tried.add(key)
        try:
            info = resolve_song(candidate)
        except AgentError as exc:
            last = exc
            continue
        if info.get("valid") and info.get("url"):
            return info, candidate
        last = info
    if isinstance(last, AgentError):
        raise last
    return (last or {"valid": False, "status": "invalid", "reason": "解析失败"}), track


def audio_ext(url, content_type):
    path = urllib.parse.urlsplit(url).path.lower()
    for ext in (".flac", ".mp3", ".m4a", ".aac", ".ogg", ".opus", ".wav", ".ape"):
        if path.endswith(ext):
            return ext
    mapping = {
        "audio/mpeg": ".mp3", "audio/mp3": ".mp3", "audio/flac": ".flac",
        "audio/x-flac": ".flac", "audio/mp4": ".m4a", "audio/aac": ".aac",
        "audio/ogg": ".ogg", "audio/opus": ".opus", "audio/wav": ".wav",
    }
    return mapping.get((content_type or "").split(";")[0].strip().lower(), ".mp3")


def open_audio(url, source):
    """打开音频流（带 Referer / UA），返回 urlopen 响应对象。"""
    headers = {
        "User-Agent": _srv.UA,
        "Accept": "*/*",
        "Referer": SOURCE_REFERERS.get(source, "https://music.163.com/"),
    }
    return urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=90)


def handle_download(handler, qs):
    track = _song_from_query(qs)
    info, used = resolve_track(track)
    if qs1(qs, "mode").lower() == "url":
        handler.send_json({
            "ok": bool(info.get("valid")),
            "song": used,
            "url": info.get("url", ""),
            "size": info.get("size", 0),
            "bitrate": info.get("bitrate", 0),
            "status": info.get("status", ""),
            "reason": info.get("reason", ""),
            "note": "直链来自音源 CDN，可能短时失效；重新调用本接口即可换新链。",
        })
        return
    if not info.get("valid") or not info.get("url"):
        raise AgentError("该歌曲当前没有可用直链：%s"
                         % (info.get("reason") or info.get("status") or "unknown"), 502)

    name = safe_filename(qs1(qs, "name") or _track_name(used))
    ext = audio_ext(info["url"], "")
    try:
        response = open_audio(info["url"], used.get("source", ""))
    except Exception as exc:
        raise AgentError("音频下载失败：%s" % _srv.music_error_text(exc), 502)

    with response:
        content_type = response.headers.get("Content-Type", "audio/mpeg")
        length = response.headers.get("Content-Length")
        try:
            size = int(length) if length else 0
        except ValueError:
            size = 0
        if size > MAX_AUDIO_TRACK:
            raise AgentError("音频超过 %d MB 上限" % (MAX_AUDIO_TRACK // 1048576), 413)
        if ext == ".mp3" and "mpeg" not in (content_type or ""):
            ext = audio_ext(info["url"], content_type)

        handler.send_response(200)
        handler.send_header("Content-Type", content_type or "application/octet-stream")
        if size:
            handler.send_header("Content-Length", str(size))
        else:
            handler.close_connection = True
        handler.send_header("Content-Disposition", disposition(name + ext))
        handler.send_header("X-Agent-Source", used.get("source", ""))
        handler.send_header("X-Agent-Bitrate", str(info.get("bitrate", 0)))
        handler.send_header("X-Agent-Size", str(size))
        handler.send_header("Cache-Control", "no-store")
        handler._cache_set = True
        handler.end_headers()
        try:
            while True:
                chunk = response.read(256 * 1024)
                if not chunk:
                    break
                handler.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError):
            handler.close_connection = True


def _track_name(song):
    artist = (song.get("artist") or "").strip()
    name = (song.get("name") or "").strip() or "audio"
    return "%s - %s" % (artist, name) if artist else name


def _song_from_query(qs):
    """支持两种用法：给 id+source 直接解析；或给 q（可带 artist/album）取首条命中。"""
    song_id = qs1(qs, "id")
    source = qs1(qs, "source").lower()
    if song_id:
        return {
            "id": song_id,
            "source": source,
            "name": qs1(qs, "name"),
            "artist": qs1(qs, "artist"),
            "album": qs1(qs, "album"),
            "duration": qs_int(qs, "duration", 0, 0, 24 * 3600),
            "extra": qs1(qs, "extra"),
        }
    keyword = qs1(qs, "q")
    if not keyword:
        raise AgentError("需要 id+source，或用 q 直接检索")
    songs, _counts, _failures = collect_songs([keyword], source or "all")
    artist_q = norm_text(qs1(qs, "artist"))
    album_q = norm_text(qs1(qs, "album"))
    matches = [
        song for song in songs
        if match_artist(song.get("artist", ""), artist_q) and match_album(song.get("album", ""), album_q)
    ]
    if not matches:
        raise AgentError("没有找到匹配的歌曲：%s" % keyword, 404)
    track = public_song(matches[0])
    # 后几条命中作为备选：首条解析不出来（音源失效 / 会员曲）时自动换源换版本
    track["alternates"] = [public_song(item) for item in matches[1:6]]
    return track


def handle_album(handler, qs, kind="album"):
    """按专辑 / 歌手取曲目；format=zip 时打包下载。"""
    album_q = qs1(qs, "album")
    artist_q = qs1(qs, "artist")
    keyword = qs1(qs, "q") or album_q or artist_q
    if not keyword:
        raise AgentError("缺少 album / artist 参数")
    if len(keyword) > MAX_KEYWORD:
        raise AgentError("关键词过长（最多 %d 字符）" % MAX_KEYWORD)
    source = qs1(qs, "source").lower() or "all"
    fmt = qs1(qs, "format").lower() or "list"
    limit = qs_int(qs, "limit", 12 if fmt == "zip" else 30, 1, MAX_ALBUM_TRACKS)

    keywords = [keyword]
    if artist_q and album_q and norm_text(artist_q) not in norm_text(keyword):
        keywords.insert(0, "%s %s" % (artist_q, album_q))
    songs, counts, failures = collect_songs(keywords, source)

    if kind == "album":
        groups = group_albums(songs, album_q or keyword, artist_q, limit)
        if not groups:
            raise AgentError("没有找到匹配的专辑：%s" % keyword, 404)
        target = groups[0]
        title = "%s - %s" % (target["artist"] or "未知歌手", target["album"])
        tracks = target["tracks"][:limit]
    else:
        groups = group_artists(songs, artist_q or keyword, limit)
        if not groups:
            raise AgentError("没有找到匹配的歌手：%s" % keyword, 404)
        target = groups[0]
        title = target["artist"] or keyword
        tracks = target["tracks"][:limit]

    # 整包下载对解析成功率最敏感：先补一次单源检索，让换源备选池更全
    if fmt == "zip" and kind == "album":
        enrich_pool("%s %s" % (artist_q, album_q) if (artist_q and album_q) else keyword, songs)
    attach_alternates(tracks, songs)

    payload = {
        "ok": True,
        "query": keyword,
        "counts": counts,
        "failures": failures,
        "total": len(tracks),
    }
    if kind == "album":
        payload.update({
            "album": target["album"],
            "artist": target["artist"],
            "cover": target["cover"],
            "sources": target["sources"],
            "albums": [{"album": g["album"], "artist": g["artist"], "trackCount": g["trackCount"]} for g in groups[:8]],
            "tracks": tracks,
        })
    else:
        payload.update({
            "artist": target["artist"],
            "cover": target["cover"],
            "sources": target["sources"],
            "albums": target["albums"][:20],
            "tracks": tracks,
            "artists": [{"artist": g["artist"], "trackCount": g["trackCount"]} for g in groups[:6]],
        })

    if fmt != "zip":
        handler.send_json(payload)
        return
    _send_album_zip(handler, title, tracks)


def _fetch_track(workdir, index, track, deadline):
    """下载单曲到临时目录；成功返回条目，失败抛 AgentError。"""
    if time.time() > deadline:
        raise AgentError("超出打包时间预算")
    info, used = resolve_track(track)
    if not (info.get("valid") and info.get("url")):
        raise AgentError("无可用直链（%s）" % (info.get("reason") or info.get("status") or "invalid"))
    ext = audio_ext(info["url"], "")
    path = os.path.join(workdir, "%03d" % index)
    written = 0
    with open_audio(info["url"], used.get("source", "")) as response, open(path, "wb") as out:
        while True:
            chunk = response.read(256 * 1024)
            if not chunk:
                break
            written += len(chunk)
            if written > MAX_AUDIO_TRACK:
                raise AgentError("单曲超过 %d MB 上限" % (MAX_AUDIO_TRACK // 1048576))
            out.write(chunk)
    if not written:
        raise AgentError("音频为空")
    return {"index": index, "path": path, "ext": ext, "bytes": written,
            "source": used.get("source", ""), "name": _track_name(track)}


def _send_album_zip(handler, title, tracks):
    """并行下载曲目并打包；有总时长预算，超时/失败的曲目写进 _errors.txt。"""
    started = time.time()
    deadline = started + ZIP_BUDGET
    workdir = tempfile.mkdtemp(prefix="agent-zip-")
    results = []
    errors = []
    total = 0
    futures = {}
    try:
        pool = ThreadPoolExecutor(max_workers=ZIP_WORKERS)
        try:
            futures = {
                pool.submit(_fetch_track, workdir, index, track, deadline): (index, track)
                for index, track in enumerate(tracks, 1)
            }
            for future in as_completed(futures, timeout=max(5, deadline - time.time())):
                index, track = futures[future]
                try:
                    entry = future.result()
                except Exception as exc:
                    errors.append("%02d %s - %s" % (
                        index, _track_name(track), getattr(exc, "message", None) or str(exc)[:120]))
                    continue
                if total + entry["bytes"] > MAX_ALBUM_BYTES:
                    errors.append("%02d %s - 超出整包上限" % (index, entry["name"]))
                    continue
                total += entry["bytes"]
                results.append(entry)
        except Exception:
            # as_completed 超时：未完成的记为跳过，已完成的照常打包
            for future, (index, track) in futures.items():
                if not future.done():
                    future.cancel()
                    errors.append("%02d %s - 超出打包时间预算" % (index, _track_name(track)))
        finally:
            pool.shutdown(wait=False)

        if not results:
            raise AgentError("没有任何曲目下载成功：%s" % ("；".join(errors[:3]) or "未知原因"), 502)

        results.sort(key=lambda item: item["index"])
        bundle = os.path.join(workdir, "bundle.zip")
        with zipfile.ZipFile(bundle, "w", zipfile.ZIP_STORED) as archive:
            for entry in results:
                name = "%02d %s%s" % (entry["index"], safe_filename(entry["name"]), entry["ext"])
                archive.write(entry["path"], name)
            if errors:
                archive.writestr("_errors.txt", "\n".join(errors) + "\n")

        filename = safe_filename(title) + ".zip"
        size = os.path.getsize(bundle)
        handler.send_response(200)
        handler.send_header("Content-Type", "application/zip")
        handler.send_header("Content-Length", str(size))
        handler.send_header("Content-Disposition", disposition(filename))
        handler.send_header("X-Agent-Tracks", str(len(results)))
        handler.send_header("X-Agent-Failed", str(len(errors)))
        handler.send_header("X-Agent-Sources", ",".join(sorted({e["source"] for e in results})))
        handler.send_header("Cache-Control", "no-store")
        handler._cache_set = True
        handler.end_headers()
        with open(bundle, "rb") as stream:
            while True:
                chunk = stream.read(512 * 1024)
                if not chunk:
                    break
                handler.wfile.write(chunk)
        sys.stderr.write("[agent] zip %s：%d 首 / %.1f MB / %.1fs\n" % (
            filename, len(results), size / 1048576.0, time.time() - started))
    except (BrokenPipeError, ConnectionResetError):
        handler.close_connection = True
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


# ---------------------------------------------------------------- 图像处理
OPS_SPEC = {
    "auto": "自动白平衡 + 自动影调（1 开启，默认 0）",
    "exposure": "曝光补偿，单位 EV，-4..4",
    "contrast": "对比度，-100..100",
    "saturation": "饱和度，-100..100",
    "sharpness": "锐化，-100..100（负值为柔化）",
    "temperature": "色温，-100..100（正数偏暖 / 负数偏冷）",
    "tint": "色调，-100..100（正数偏品红 / 负数偏绿）",
    "shadows": "阴影提亮，-100..100",
    "highlights": "高光恢复，-100..100（正数压高光）",
    "vignette": "暗角校正，0..120（去暗角）；负数 -120..0 为加暗角",
    "grayscale": "黑白，1 开启",
    "rotate": "旋转角度（顺时针为正）",
    "flip": "h 水平镜像 / v 垂直翻转",
    "crop": "裁剪 x,y,w,h，支持百分比写法 0,0,50%,50%",
    "resize": "缩放：1600x / x900 / 1600x900（等比内嵌）/ 50% / 1600（长边）",
    "format": "输出格式 jpeg / png / webp",
    "quality": "输出质量 1..95（jpeg / webp）",
    "target_kb": "目标体积 KB，自动降质量直到满足",
    "strip": "1 表示清空 EXIF / ICC 等元数据",
    "max_side": "长边上限（等比缩小，不放大）",
}


def _num(ops, name, default=0.0, low=None, high=None):
    raw = ops.get(name)
    if raw is None:
        return default
    try:
        value = float(str(raw).replace("%", "").strip())
    except ValueError:
        raise AgentError("参数 %s 需要数字" % name)
    if low is not None and value < low:
        value = low
    if high is not None and value > high:
        value = high
    return value


def parse_ops(qs):
    """解析算子串。逗号既是算子分隔符，也是 crop 的坐标分隔符：
    没有等号且不是独立开关的片段，视为上一个算子的续写（如 crop=0,0,50%,50%）。"""
    ops = {}
    for token in re.split(r"[,\s]+", (qs1(qs, "ops") or "")):
        if not token:
            continue
        if "=" in token:
            key, value = token.split("=", 1)
            ops[key.strip().lower()] = value.strip()
        elif token.lower() in OPS_SPEC:
            ops[token.lower()] = "1"
        elif ops:
            last = list(ops)[-1]
            ops[last] = "%s,%s" % (ops[last], token)
    for key in OPS_SPEC:
        if key in qs and key not in ops:
            ops[key] = qs[key][0].strip()
    return ops


def _open_image(data):
    from PIL import Image, ImageOps
    try:
        import pillow_heif
        pillow_heif.register_heif_opener()
    except Exception:
        pass
    try:
        image = Image.open(io.BytesIO(data))
        image.load()
    except Exception as exc:
        raise AgentError("无法解码这张图片：%s" % type(exc).__name__)
    if image.width * image.height > MAX_PIXELS:
        raise AgentError("图片像素超过 %d 上限" % MAX_PIXELS, 413)
    try:
        orientation = image.getexif().get(274)
    except Exception:
        orientation = None
    if orientation:
        image = ImageOps.exif_transpose(image)
    return image


def _flatten(image):
    from PIL import Image
    if image.mode in ("RGBA", "LA", "P"):
        image = image.convert("RGBA")
        background = Image.new("RGB", image.size, (255, 255, 255))
        background.paste(image, mask=image.split()[-1])
        return background
    if image.mode != "RGB":
        return image.convert("RGB")
    return image


def _auto_tone(image):
    import numpy as np
    from PIL import Image, ImageOps
    rgb = _flatten(image)
    array = np.asarray(rgb, dtype=np.float32)
    means = array.reshape(-1, 3).mean(axis=0)
    if float(means.min()) > 1.0:
        target = float(means.mean())
        scale = np.clip(target / np.maximum(means, 1.0), 0.7, 1.4)
        array = np.clip(array * scale, 0, 255)
        rgb = Image.fromarray(array.astype("uint8"), "RGB")
    return ImageOps.autocontrast(rgb, cutoff=0.4)


def _tone_curve(image, shadows, highlights):
    if not shadows and not highlights:
        return image
    table = []
    for value in range(256):
        x = value / 255.0
        if shadows:
            x = x + shadows * 0.42 * (1 - x) ** 2
        if highlights:
            x = x - highlights * 0.42 * x ** 2
        table.append(max(0, min(255, int(round(x * 255)))))
    return image.point(table * len(image.getbands()))


def _temperature(image, temperature, tint):
    from PIL import Image
    if not temperature and not tint:
        return image
    rgb = image.convert("RGB")
    red_gain = 1 + 0.22 * temperature
    blue_gain = 1 - 0.22 * temperature
    green_gain = 1 + 0.18 * tint
    red_lut = [min(255, int(round(v * red_gain))) for v in range(256)]
    green_lut = [min(255, int(round(v * green_gain))) for v in range(256)]
    blue_lut = [min(255, int(round(v * blue_gain))) for v in range(256)]
    red, green, blue = rgb.split()
    return Image.merge("RGB", (red.point(red_lut), green.point(green_lut), blue.point(blue_lut)))


def _vignette(image, strength):
    if not strength:
        return image
    try:
        import numpy as np
    except Exception:
        return image
    rgb = image.convert("RGB")
    array = np.asarray(rgb, dtype=np.float32)
    height, width = array.shape[:2]
    yy, xx = np.mgrid[0:height, 0:width].astype(np.float32)
    cx, cy = (width - 1) / 2.0, (height - 1) / 2.0
    radius = ((xx - cx) / (width / 2.0)) ** 2 + ((yy - cy) / (height / 2.0)) ** 2
    radius = np.clip(radius / 2.0, 0, 1.5)
    gain = 1.0 + strength * radius
    array = np.clip(array * gain[..., None], 0, 255)
    from PIL import Image
    return Image.fromarray(array.astype("uint8"), "RGB")


def _parse_crop(value, width, height):
    parts = [p.strip() for p in value.split(",")]
    if len(parts) != 4:
        raise AgentError("crop 需要 x,y,w,h 四个数")
    numbers = []
    for index, part in enumerate(parts):
        scale = width if index % 2 == 0 else height
        if part.endswith("%"):
            numbers.append(int(round(float(part[:-1]) / 100.0 * scale)))
        else:
            numbers.append(int(float(part)))
    x, y, w, h = numbers
    if w <= 0 or h <= 0:
        raise AgentError("crop 宽高必须为正")
    return (max(0, x), max(0, y), min(width, x + w), min(height, y + h))


def _parse_resize(value, width, height):
    value = value.strip().lower()
    if value.endswith("%"):
        try:
            ratio = float(value[:-1]) / 100.0
        except ValueError:
            raise AgentError("resize 百分比无效")
        return max(1, int(width * ratio)), max(1, int(height * ratio))
    if "x" in value:
        left, right = value.split("x", 1)
        try:
            target_w = int(left) if left else 0
            target_h = int(right) if right else 0
        except ValueError:
            raise AgentError("resize 写法无效，示例 1600x / x900 / 1600x900")
        if target_w and target_h:
            ratio = min(target_w / width, target_h / height)
        elif target_w:
            ratio = target_w / width
        else:
            ratio = target_h / height
        return max(1, int(round(width * ratio))), max(1, int(round(height * ratio)))
    try:
        longest = int(value)
    except ValueError:
        raise AgentError("resize 写法无效，示例 1600x / x900 / 1600 / 50%")
    if longest <= 0:
        raise AgentError("resize 需要正数")
    ratio = min(1.0, longest / max(width, height))
    return max(1, int(round(width * ratio))), max(1, int(round(height * ratio)))


def edit_image(data, ops):
    """按算子处理一张图片，返回 (PIL.Image, notes)。"""
    from PIL import Image, ImageEnhance
    image = _open_image(data)
    notes = {}

    if "crop" in ops:
        image = image.crop(_parse_crop(ops["crop"], image.width, image.height))
    if "rotate" in ops:
        angle = _num(ops, "rotate", 0, -360, 360)
        if angle:
            image = image.rotate(-angle, expand=True, resample=Image.BICUBIC)
    flip = (ops.get("flip") or "").lower()
    if flip in ("h", "horizontal", "1"):
        image = image.transpose(Image.FLIP_LEFT_RIGHT)
    elif flip in ("v", "vertical"):
        image = image.transpose(Image.FLIP_TOP_BOTTOM)

    if "resize" in ops:
        image = image.resize(_parse_resize(ops["resize"], image.width, image.height), Image.LANCZOS)
    if "max_side" in ops:
        limit = int(_num(ops, "max_side", 0, 1, 20000))
        if limit and max(image.size) > limit:
            ratio = limit / max(image.size)
            image = image.resize((max(1, int(image.width * ratio)), max(1, int(image.height * ratio))), Image.LANCZOS)

    if ops.get("auto") not in (None, "", "0", "false"):
        image = _auto_tone(image)
        notes["auto"] = 1
    if "grayscale" in ops and ops["grayscale"] not in ("0", "false", ""):
        image = image.convert("L").convert("RGB")

    exposure = _num(ops, "exposure", 0, -4, 4)
    if exposure:
        image = ImageEnhance.Brightness(_flatten(image)).enhance(2 ** exposure)
    contrast = _num(ops, "contrast", 0, -100, 100)
    if contrast:
        image = ImageEnhance.Contrast(_flatten(image)).enhance(max(0.0, 1 + contrast / 100.0))
    saturation = _num(ops, "saturation", 0, -100, 100)
    if saturation:
        image = ImageEnhance.Color(_flatten(image)).enhance(max(0.0, 1 + saturation / 100.0))
    shadows = _num(ops, "shadows", 0, -100, 100) / 100.0
    highlights = _num(ops, "highlights", 0, -100, 100) / 100.0
    image = _tone_curve(_flatten(image), shadows, highlights)
    image = _temperature(image, _num(ops, "temperature", 0, -100, 100) / 100.0,
                         _num(ops, "tint", 0, -100, 100) / 100.0)
    sharpness = _num(ops, "sharpness", 0, -100, 100)
    if sharpness:
        image = ImageEnhance.Sharpness(image).enhance(max(0.0, 1 + sharpness / 100.0))
    vignette = _num(ops, "vignette", 0, -120, 120)
    if vignette:
        image = _vignette(image, vignette / 100.0)
    return image, notes


def encode_image(image, fmt, quality, target_bytes):
    fmt = (fmt or "jpeg").lower()
    if fmt in ("jpg", "jpeg"):
        fmt, ext, mime = "JPEG", ".jpg", "image/jpeg"
        image = _flatten(image)
    elif fmt == "png":
        fmt, ext, mime = "PNG", ".png", "image/png"
        image = _flatten(image).convert("RGB")
    elif fmt == "webp":
        fmt, ext, mime = "WEBP", ".webp", "image/webp"
        image = _flatten(image)
    else:
        raise AgentError("不支持的输出格式：%s（jpeg / png / webp）" % fmt)

    def dump(level):
        buffer = io.BytesIO()
        if fmt == "PNG":
            image.save(buffer, "PNG", optimize=True)
        elif fmt == "WEBP":
            image.save(buffer, "WEBP", quality=int(level), method=4)
        else:
            image.save(buffer, "JPEG", quality=int(level), optimize=True, progressive=True)
        return buffer.getvalue()

    quality = int(max(1, min(95, quality or 88)))
    data = dump(quality)
    if target_bytes and len(data) > target_bytes:
        low, high = 20, quality
        best = data
        while low <= high:
            middle = (low + high) // 2
            candidate = dump(middle)
            if len(candidate) <= target_bytes:
                best = candidate
                low = middle + 1
            else:
                high = middle - 1
        data = best
    return data, ext, mime


def handle_image_edit(handler, qs):
    if not _PIL_READY:
        raise AgentError("服务器图像处理依赖缺失（请安装 Pillow）", 503)
    ops = parse_ops(qs)
    try:
        length = int(handler.headers.get("Content-Length", "0"))
    except ValueError:
        length = 0
    if length <= 0:
        raise AgentError("缺少上传内容（请求体应为图片字节，批量时为一个 zip）", 411)
    if length > MAX_UPLOAD:
        raise AgentError("上传超过 %d MB 上限" % (MAX_UPLOAD // 1048576), 413)
    chunks = []
    remaining = length
    handler.connection.settimeout(120)
    while remaining > 0:
        chunk = handler.rfile.read(min(remaining, 1024 * 1024))
        if not chunk:
            break
        chunks.append(chunk)
        remaining -= len(chunk)
    payload = b"".join(chunks)
    if remaining:
        raise AgentError("上传中断", 400)

    fmt = (ops.get("format") or qs1(qs, "format") or "jpeg").lower()
    quality = int(_num(ops, "quality", 88, 1, 95))
    target_kb = _num(ops, "target_kb", 0, 0, 20000)
    target_bytes = int(target_kb * 1024) if target_kb else 0
    strip = ops.get("strip") in ("1", "true", "yes")

    if not _IMAGE_SEMAPHORE.acquire(timeout=20):
        raise AgentError("服务器正在处理其他图片，请稍后再试", 503)
    started = time.time()
    try:
        if (qs1(qs, "zip") in ("1", "true") or payload[:2] == b"PK"):
            result = _edit_zip(payload, ops, fmt, quality, target_bytes)
            _send_bytes(handler, result, "application/zip", "edited.zip")
            return
        image, notes = edit_image(payload, ops)
        data, ext, mime = encode_image(image, fmt, quality, target_bytes)
        if qs1(qs, "info") in ("1", "true"):
            handler.send_json({
                "ok": True,
                "width": image.width,
                "height": image.height,
                "format": fmt,
                "bytes": len(data),
                "ops": ops,
                "notes": notes,
                "elapsed": round(time.time() - started, 3),
            })
            return
        _send_bytes(handler, data, mime, safe_filename(qs1(qs, "name") or "edited", "edited") + ext)
        sys.stderr.write("[agent] image %s %dx%d %d KB %.2fs\n" % (
            fmt, image.width, image.height, len(data) // 1024, time.time() - started))
    finally:
        _IMAGE_SEMAPHORE.release()


def _edit_zip(payload, ops, fmt, quality, target_bytes):
    """批量：请求体是 zip，逐个处理后打成新 zip 返回。"""
    output = io.BytesIO()
    count = 0
    try:
        archive = zipfile.ZipFile(io.BytesIO(payload))
    except zipfile.BadZipFile:
        raise AgentError("请求体既不是图片也不是 zip")
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as out:
        for entry in archive.infolist():
            if entry.is_dir():
                continue
            if count >= MAX_ZIP_FILES:
                break
            if entry.file_size > MAX_UPLOAD:
                continue
            name = os.path.basename(entry.filename)
            try:
                image, _notes = edit_image(archive.read(entry), ops)
                data, ext, _mime = encode_image(image, fmt, quality, target_bytes)
            except AgentError:
                continue
            stem = os.path.splitext(name)[0] or "image"
            out.writestr(safe_filename(stem, "image") + ext, data)
            count += 1
    if not count:
        raise AgentError("zip 里没有可处理的图片")
    return output.getvalue()


def _send_bytes(handler, data, mime, filename):
    handler.send_response(200)
    handler.send_header("Content-Type", mime)
    handler.send_header("Content-Length", str(len(data)))
    handler.send_header("Content-Disposition", disposition(filename))
    handler.send_header("Cache-Control", "no-store")
    handler._cache_set = True
    handler.end_headers()
    handler.wfile.write(data)


# ---------------------------------------------------------------- 能力清单
def manifest():
    sources = list(_srv.MUSIC_SOURCES)
    token = agent_token()
    return {
        "name": "localtools-agent",
        "version": AGENT_VERSION,
        "site": "tool.crystalkingdom.top",
        "auth": {
            "required": True,
            "header": "Authorization: Bearer <token>",
            "alternatives": ["X-Agent-Token: <token>", "?token=<token>"],
            "tokenFile": token_file(),
            "env": "LOCALTOOLS_AGENT_TOKEN",
            "tokenReady": bool(token),
            "manifestIsPublic": True,
        },
        "conventions": {
            "json": "所有 JSON 接口返回 UTF-8，失败时返回 {\"error\": \"...\"} 与 4xx/5xx",
            "binary": "下载类接口成功时直接返回文件字节，文件名在 Content-Disposition",
            "limits": {
                "keyword": MAX_KEYWORD,
                "uploadMB": MAX_UPLOAD // 1048576,
                "pixels": MAX_PIXELS,
                "albumTracks": MAX_ALBUM_TRACKS,
                "albumZipMB": MAX_ALBUM_BYTES // 1048576,
            },
            "rate": {kind: {"perMinute": a, "perHour": b} for kind, (a, b) in RATE_LIMITS.items()},
        },
        "music": {
            "sources": sources,
            "search": {
                "method": "GET", "path": "/api/agent/music/search",
                "params": {
                    "q": "关键词：歌名 / 歌手 / 专辑",
                    "type": "song（默认，平铺结果）| artist（按歌手分组）| album（按专辑分组）",
                    "source": "all（默认）| " + " | ".join(sources),
                    "artist": "可选，进一步按歌手过滤（type=song/album 时最有用）",
                    "limit": "每组返回曲目上限，默认 20，最大 %d" % MAX_TRACKS_RETURN,
                },
                "example": "/api/agent/music/search?q=范特西&type=album&artist=周杰伦",
            },
            "album": {
                "method": "GET", "path": "/api/agent/music/album",
                "params": {"album": "专辑名", "artist": "可选，歌手名", "source": "all|…",
                           "limit": "曲目上限，默认 30，最大 %d" % MAX_ALBUM_TRACKS,
                           "format": "list（默认 JSON）| zip（直接下载整专辑打包）"},
                "example": "/api/agent/music/album?album=范特西&artist=周杰伦&format=zip",
            },
            "artist": {
                "method": "GET", "path": "/api/agent/music/artist",
                "params": {"artist": "歌手名", "limit": "曲目上限，默认 30", "format": "list|zip"},
                "example": "/api/agent/music/artist?artist=周杰伦&limit=20",
            },
            "resolve": {
                "method": "GET", "path": "/api/agent/music/resolve",
                "params": {"id": "歌曲 id", "source": "音源", "duration": "秒", "extra": "搜索返回的 extra 原样带回"},
                "example": "/api/agent/music/resolve?id=347230&source=netease&duration=269",
            },
            "download": {
                "method": "GET", "path": "/api/agent/music/download",
                "params": {
                    "id+source": "已知歌曲 id 时直接指定",
                    "q": "或给关键词，取首条命中（可配 artist / album 过滤）",
                    "mode": "url 时只返回直链 JSON，不转发字节",
                    "name": "可选，自定义文件名（不含扩展名）",
                },
                "example": "/api/agent/music/download?q=七里香&artist=周杰伦",
                "note": "字节只做一次性转发，不落盘、不缓存；单曲上限 %d MB。" % (MAX_AUDIO_TRACK // 1048576),
            },
        },
        "image": {
            "ops": {
                "method": "GET", "path": "/api/agent/image/ops",
                "description": "列出全部修图算子与取值含义",
            },
            "edit": {
                "method": "POST", "path": "/api/agent/image/edit",
                "body": "图片原始字节（jpg/png/webp/heic/hif/avif），或 zip（批量，最多 %d 张）" % MAX_ZIP_FILES,
                "params": {"ops": "逗号分隔算子，如 auto,exposure=0.4,resize=1600x", "info": "1 时只返回处理后的尺寸/大小 JSON"},
                "example": "POST /api/agent/image/edit?ops=auto,exposure=0.3,shadows=12,resize=2000x&format=jpeg&quality=88",
                "note": "任何算子都不写磁盘；返回处理后的图片字节。",
            },
            "hif": {
                "method": "POST", "path": "/api/hif/convert",
                "description": "10-bit HDR HIF/HEIF 专用转换（复用站点原有管线，走同一把 token 之外的独立限流）",
            },
        },
        "ping": {"method": "GET", "path": "/api/agent/ping"},
        "examples": {
            "curl_search_album": "curl -H \"Authorization: Bearer $TOKEN\" \"https://tool.crystalkingdom.top/api/agent/music/search?q=范特西&type=album&artist=周杰伦\"",
            "curl_album_zip": "curl -H \"Authorization: Bearer $TOKEN\" -OJ \"https://tool.crystalkingdom.top/api/agent/music/album?album=范特西&artist=周杰伦&format=zip\"",
            "curl_download": "curl -H \"Authorization: Bearer $TOKEN\" -OJ \"https://tool.crystalkingdom.top/api/agent/music/download?q=七里香&artist=周杰伦\"",
            "curl_edit": "curl -H \"Authorization: Bearer $TOKEN\" --data-binary @in.jpg \"https://tool.crystalkingdom.top/api/agent/image/edit?ops=auto,exposure=0.3&format=jpeg\" -o out.jpg",
        },
    }


# ---------------------------------------------------------------- 路由
def handle(handler, path, qs, method):
    """统一入口：返回 True 表示已处理。"""
    if not path.startswith("/api/agent"):
        return False

    if path in ("/api/agent", "/api/agent/", "/api/agent/manifest"):
        handler.send_json(manifest())
        return True

    if path == "/api/agent/image/ops":
        handler.send_json({"ok": True, "ops": OPS_SPEC,
                           "example": "auto,exposure=0.3,contrast=8,resize=1600x,format=jpeg,quality=88"})
        return True

    try:
        if method == "GET":
            _route_get(handler, path, qs)
        elif method == "POST":
            _route_post(handler, path, qs)
        else:
            raise AgentError("不支持的方法", 405)
    except AgentError as exc:
        if exc.status == 401:
            unauthorized(handler, exc.message)
        else:
            handler.send_json({"error": exc.message}, exc.status)
    except Exception as exc:  # 兜底：不让内部异常变成空响应
        sys.stderr.write("[agent] %s failed: %s: %s\n" % (path, type(exc).__name__, exc))
        handler.send_json({"error": "服务器内部错误：%s" % type(exc).__name__}, 500)
    return True


def _route_get(handler, path, qs):
    require_auth(handler, qs)

    if path == "/api/agent/ping":
        require_rate(handler, "read")
        handler.send_json({
            "ok": True,
            "agent": AGENT_VERSION,
            "musicResolver": _srv.music_dl_reachable(),
            "sources": list(_srv.MUSIC_SOURCES),
            "image": {
                "ready": _PIL_READY,
                "ops": list(OPS_SPEC),
                "formats": ["jpeg", "png", "webp"],
            },
            "limits": {"uploadMB": MAX_UPLOAD // 1048576, "pixels": MAX_PIXELS},
        })
        return

    if path == "/api/agent/music/search":
        require_rate(handler, "read")
        keyword = qs1(qs, "q")
        if not keyword:
            raise AgentError("缺少 q 参数")
        if len(keyword) > MAX_KEYWORD:
            raise AgentError("关键词过长（最多 %d 字符）" % MAX_KEYWORD)
        kind = (qs1(qs, "type") or "song").lower()
        source = (qs1(qs, "source") or "all").lower()
        artist_q = qs1(qs, "artist") or (keyword if kind == "artist" else "")
        album_q = qs1(qs, "album")
        limit = qs_int(qs, "limit", 20, 1, MAX_TRACKS_RETURN)

        keywords = [keyword]
        if kind == "album" and artist_q and norm_text(artist_q) not in norm_text(keyword):
            keywords.insert(0, "%s %s" % (artist_q, keyword))
        songs, counts, failures = collect_songs(keywords, source)

        if kind == "song":
            filtered = [
                public_song(song) for song in songs
                if match_artist(song.get("artist", ""), norm_text(artist_q))
                and match_album(song.get("album", ""), norm_text(album_q))
            ][:limit]
            handler.send_json({"ok": True, "type": "song", "query": keyword,
                               "counts": counts, "failures": failures, "songs": filtered})
            return
        if kind == "artist":
            artists = group_artists(songs, artist_q, limit)
            handler.send_json({"ok": True, "type": "artist", "query": keyword,
                               "counts": counts, "failures": failures,
                               "artists": artists[:10]})
            return
        if kind == "album":
            albums = group_albums(songs, album_q or keyword, artist_q, limit)
            handler.send_json({"ok": True, "type": "album", "query": keyword,
                               "counts": counts, "failures": failures,
                               "albums": albums[:10]})
            return
        raise AgentError("type 仅支持 song / artist / album")

    if path in ("/api/agent/music/album", "/api/agent/music/artist"):
        require_rate(handler, "download" if qs1(qs, "format").lower() == "zip" else "read")
        handle_album(handler, qs, "album" if path.endswith("album") else "artist")
        return

    if path == "/api/agent/music/resolve":
        require_rate(handler, "read")
        song = _song_from_query(qs)
        info = resolve_song(song)
        handler.send_json({"ok": bool(info.get("valid")), "song": song, **info})
        return

    if path == "/api/agent/music/download":
        require_rate(handler, "download")
        handle_download(handler, qs)
        return

    raise AgentError("接口不存在", 404)


def _route_post(handler, path, qs):
    require_auth(handler, qs)

    if path == "/api/agent/image/edit":
        require_rate(handler, "edit")
        handle_image_edit(handler, qs)
        return

    raise AgentError("接口不存在", 404)
