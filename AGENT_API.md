# Agent 接口

让脚本 / LLM Agent 不打开浏览器，就能用 HTTP 驱动本站的多源音乐下载与修图。站点页面本身的功能不受影响，Agent 接口只是服务端的一层封装。

线上地址：`https://tool.crystalkingdom.top`。能力清单 `GET /api/agent` **免鉴权**，机器可读、含全部参数与示例，Agent 可以先用它自举。

## 1. 鉴权

除清单外所有 `/api/agent/*` 都需要令牌：

```
Authorization: Bearer <token>
```

兼容 `X-Agent-Token: <token>` 和查询参数 `?token=<token>`（查询参数会进访问日志，优先用请求头）。

令牌由服务器首次启动时随机生成，存放在**站点目录之外**的 `../localtools-agent-token`（线上是 `/home/zht/localtools-agent-token`，权限 0600），在服务器上读取：

```sh
cat ~/localtools-agent-token
```

也可以用环境变量 `LOCALTOOLS_AGENT_TOKEN` 直接指定（容器化部署推荐）。**不按回环地址放行**：公网请求经隧道抵达服务时同样是 127.0.0.1，一律校验令牌。

无令牌返回 `401` 并附带取令牌说明；令牌错误返回 `401 {"error":"访问令牌无效"}`。

## 2. 约定与限制

| 项目 | 值 |
| --- | --- |
| JSON 编码 | UTF-8；失败统一 `{"error":"..."}` + 4xx/5xx |
| 下载类响应 | 直接返回文件字节，文件名在 `Content-Disposition`（含 RFC 5987 `filename*`） |
| 限流（按客户端 IP） | read 60/min · 600/h；download 30/min · 300/h；edit 30/min · 240/h |
| 关键词长度 | ≤ 80 字符 |
| 图片上传 | ≤ 40 MB、≤ 4000 万像素；批量 zip ≤ 24 张 |
| 单曲转发 | ≤ 120 MB，一次性流式转发，不落盘、不缓存 |
| 整包下载 | ≤ 40 首、≤ 600 MB，打包时间预算 70 秒 |

## 3. 多源音乐

音源：`netease`、`kugou`、`qq`、`qianqian`、`soda`、`fivesing`（与页面「多源音乐下载」一致），`source=all` 为默认，并行检索后合并。

底层是本机 `go-music-dl`（`music-dl.service`）：服务器只做**搜索与直链解析**，转发字节只在 Agent 明确请求下载时发生，且不落盘、不绕过会员 / DRM 限制。

### 3.1 按歌手 / 专辑检索

上游解析器**只有关键词检索，没有专辑详情接口**，因此本站把六个音源的歌曲结果做归一化匹配（忽略大小写、空格、全半角、标点）后**分组**：

```
GET /api/agent/music/search?q=范特西&type=album&artist=周杰伦
GET /api/agent/music/search?q=周杰伦&type=artist
GET /api/agent/music/search?q=七里香&type=song&source=all&limit=20
```

| type | 返回 |
| --- | --- |
| `song` | `songs[]` 平铺结果，可用 `artist` / `album` 过滤 |
| `album` | `albums[]`：每张含 `album` / `artist` / `cover` / `sources` / `trackCount` / `tracks[]` |
| `artist` | `artists[]`：每位含 `artist` / `albumCount` / `albums[]` / `tracks[]` |

响应还带 `counts`（每源命中数）与 `failures`（失败源数量）。上游各源适配器并不稳定：偶发返回空页，Agent 侧会重试用更小页长（`page_size=10`，实测页长 20 时网易云只回 1 条）并做请求间隔限速。**看 `counts` 判断是不是上游没给数据，而不是逻辑判断成「搜索无结果」。**

### 3.2 取整张专辑 / 某位歌手的作品

```
GET /api/agent/music/album?album=范特西&artist=周杰伦&format=list
GET /api/agent/music/album?album=范特西&artist=周杰伦&format=zip&limit=12
GET /api/agent/music/artist?artist=周杰伦&limit=20
```

`format=zip` 直接把成功下载的曲目打成 ZIP 返回；文件名 `歌手 - 专辑.zip`，响应头 `X-Agent-Tracks` / `X-Agent-Failed` / `X-Agent-Sources` 给出统计，包内 `_errors.txt` 列出失败原因，单曲失败不影响整包。

每条曲目带 `alternates[]`（同名歌曲在其它音源的候选）。解析时先试自身音源，失败自动换源；酷狗当前对大部分曲目返回 `privilege:5`（会员曲）而拿不到直链，这种跨源回退能显著提高成功率。`source` 参数可指定单源，`limit` 控制曲目数（zip 默认 12，最多 40）。

### 3.3 解析直链与下载单曲

```
GET /api/agent/music/resolve?id=<id>&source=netease&duration=269&extra=<extra>
GET /api/agent/music/download?id=<id>&source=netease&duration=269&extra=<extra>
GET /api/agent/music/download?q=七里香&artist=周杰伦
GET /api/agent/music/download?q=七里香&mode=url
```

`id` / `source` / `duration` / `extra` 直接来自搜索结果的 `tracks[]`。也可以只给 `q`，服务端取首条能解析的命中（可加 `artist` / `album` 收窄），首条解析失败会在后续命中里自动换源换版本。`mode=url` 只返回直链 JSON，不转发字节，适合 Agent 自己下载。

**会员 / 版权限制导致的 `not_found` 属于上游正常结果**，不是接口故障：换关键词、换音源，或改用 `mode=url` 把失败原因反馈给用户。

## 4. 修图与格式转换

```
POST /api/agent/image/edit?ops=auto,exposure=0.3,shadows=12,resize=2000x&format=jpeg&quality=88
Content-Type: image/jpeg
<body: 图片原始字节>
```

请求体是 jpg / png / webp / heic / hif / avif 字节，返回处理后的图片字节。`GET /api/agent/image/ops` 给出全部算子与范围；算子也可用同名 query 参数逐项传。`info=1` 只返回尺寸 / 体积 JSON，不回图片。批量时把多张图片打成 zip 上传（或加 `?zip=1`），返回处理后的 zip。

| 算子 | 作用 |
| --- | --- |
| `auto` | 灰世界白平衡 + 自动影调 |
| `exposure` / `contrast` / `saturation` / `sharpness` | EV (-4..4) 与 -100..100 的调整 |
| `shadows` / `highlights` | 阴影提亮 / 高光恢复 (-100..100) |
| `temperature` / `tint` | 色温（正为暖）/ 色调 (-100..100) |
| `vignette` | 正数为去暗角、负数为加暗角 (-120..120) |
| `rotate` / `flip` / `crop` / `resize` / `max_side` | 几何：角度、h/v、x,y,w,h（支持百分比）、1600x / x900 / 50% |
| `format` / `quality` / `target_kb` / `strip` | jpeg/png/webp、质量、自动降质到目标体积、清空元数据 |
| `grayscale` | 黑白 |

图片只在内存中处理，不落盘。10-bit HDR HIF/HEIF 若需要完整色彩管理，可继续用站点原有的 `POST /api/hif/convert?name=&q=&ev=`（独立限流、不共用这把令牌）。

## 5. 最小示例（Python）

```python
import json, os, urllib.parse, urllib.request

BASE = "https://tool.crystalkingdom.top"
TOKEN = open(os.path.expanduser("~/localtools-agent-token")).read().strip()

def agent(path, method="GET", body=None):
    req = urllib.request.Request(BASE + path, data=body, method=method)
    req.add_header("Authorization", "Bearer " + TOKEN)
    with urllib.request.urlopen(req, timeout=120) as resp:
        raw = resp.read()
        if resp.headers.get("Content-Type", "").startswith("application/json"):
            return json.loads(raw)
        return raw

manifest = agent("/api/agent")                       # 免鉴权也行
albums = agent("/api/agent/music/search?" + urllib.parse.urlencode({
    "q": "范特西", "type": "album", "artist": "周杰伦"}))
print(albums["albums"][0]["trackCount"])

blob = agent("/api/agent/music/download?q=" + urllib.parse.quote("七里香"))
open("song.mp3", "wb").write(blob)                   # 二进制时直接落盘

with open("in.jpg", "rb") as f:
    out = agent("/api/agent/image/edit?ops=auto,resize=2000x&format=jpeg", "POST", f.read())
open("out.jpg", "wb").write(out)
```

## 6. 与页面功能的关系

- 页面「多源音乐下载」「专业修图」「Camera Raw」仍走浏览器本地链路，图片 / 音频不经服务器。
- Agent 接口是**额外**能力：服务端替 Agent 完成检索分组、打包、修图，需要令牌。
- 站点另有 `/api/ping`，其 `agent` 字段上报接口是否就绪与版本号。
