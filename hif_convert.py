#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""HEIF/HIF -> sRGB JPEG conversion with HDR colour management.

Only the standard sRGB JPEG is produced. HDR PQ / HLG images are decoded to
linear light, converted from BT.2020 (or P3) to BT.709 primaries, and tone
mapped to an SDR 203-nit reference white with a soft highlight shoulder.
"""
import io
import math

import numpy as np
from PIL import Image, ImageCms, ImageOps
from pillow_heif import open_heif

MAX_PIXELS = 60000000
MAX_UPLOAD_BYTES = 80 * 1024 * 1024
REF_WHITE_NITS = 203.0
KNEE = 0.85
SHOULDER = 8.0
JPEG_QUALITY = 96

_HEIF_BRANDS = frozenset(
    b"heic heix heim heis hevc hevx hevm hevs mif1 msf1".split()
)

# Linear-light RGB -> RGB matrices, D65.
_BT2020_TO_709 = np.array([
    [1.660491, -0.587641, -0.072850],
    [-0.124550, 1.132900, -0.008350],
    [-0.018151, -0.100579, 1.118730],
], dtype=np.float32)
_P3_TO_709 = np.array([
    [1.224940, -0.224940, 0.0],
    [-0.042057, 1.042057, 0.0],
    [-0.019638, -0.078636, 1.098274],
], dtype=np.float32)

_SRGB_ICC = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()


def _heif_has_container_transform(data):
    """True if the HEIF container carries irot (nonzero) or imir.

    libheif/pillow-heif applies these transforms while decoding, so applying
    EXIF orientation on top would rotate 90/270-degree shots twice.
    """
    containers = {b"meta": 4, b"iprp": 0, b"ipco": 0}

    def walk(start, end, depth):
        p = start
        while p + 8 <= end:
            size = int.from_bytes(data[p:p + 4], "big")
            typ = data[p + 4:p + 8]
            header = 8
            if size == 1:
                size = int.from_bytes(data[p + 8:p + 16], "big")
                header = 16
            elif size == 0:
                size = end - p
            if size < header or p + size > end:
                break
            if typ == b"irot":
                if data[p + header] & 0x03:
                    return True
            elif typ == b"imir":
                return True
            elif typ in containers and depth < 6:
                if walk(p + header + containers[typ], p + size, depth + 1):
                    return True
            p += size
        return False

    return walk(0, len(data), 0)


class HifError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def _pq_eotf(value):
    m1 = 2610.0 / 16384.0
    m2 = 2523.0 / 4096.0 * 128.0
    c1 = 3424.0 / 4096.0
    c2 = 2413.0 / 4096.0 * 32.0
    c3 = 2392.0 / 4096.0 * 32.0
    value = np.clip(value, 0.0, 1.0)
    p = np.power(value, 1.0 / m2)
    return 10000.0 * np.power(np.maximum(p - c1, 0.0) / (c2 - c3 * p), 1.0 / m1)


def _hlg_inverse_oetf(value):
    a = 0.17883277
    b = 1.0 - 4.0 * a
    c = 0.5 - a * math.log(4.0 * a)
    value = np.clip(value, 0.0, 1.0)
    low = value * value / 3.0
    high = (np.exp((value - c) / a) + b) / 12.0
    return np.where(value <= 0.5, low, high)


def _hlg_to_nits(value):
    scene = _hlg_inverse_oetf(value)
    y = (0.2627 * scene[..., 0] + 0.6780 * scene[..., 1] + 0.0593 * scene[..., 2])
    return scene * (1000.0 * np.power(np.maximum(y, 0.0), 0.2))[..., None]


def _srgb_eotf(value):
    value = np.clip(value, 0.0, 1.0)
    return np.where(value <= 0.04045, value / 12.92,
                    np.power((value + 0.055) / 1.055, 2.4))


def _bt709_eotf(value):
    value = np.clip(value, 0.0, 1.0)
    return np.where(value < 0.081, value / 4.5,
                    np.power((value + 0.099) / 1.099, 1.0 / 0.45))


def _srgb_oetf(value):
    value = np.clip(value, 0.0, 1.0)
    return np.where(value <= 0.0031308, 12.92 * value,
                    1.055 * np.power(value, 1.0 / 2.4) - 0.055)


def _luminance(rgb):
    return rgb[..., 0] * 0.2126 + rgb[..., 1] * 0.7152 + rgb[..., 2] * 0.0722


def _to_709(linear, primaries):
    if primaries == 1:
        return linear
    if primaries == 9:
        matrix = _BT2020_TO_709
    elif primaries == 12:
        matrix = _P3_TO_709
    else:
        raise HifError("不支持的色彩原色（%s）" % primaries, 415)
    return np.einsum("ij,hwj->hwi", matrix, linear, optimize=True)


def _tone_luminance(y, peak):
    x = y / REF_WHITE_NITS
    white = max(peak / REF_WHITE_NITS, KNEE + 0.001)
    denominator = math.log1p(SHOULDER * (white - KNEE))
    mapped = KNEE + (1.0 - KNEE) * np.log1p(
        SHOULDER * np.maximum(x - KNEE, 0.0)
    ) / denominator
    return np.where(x <= KNEE, x, mapped)


def _source_label(primaries, transfer, bit_depth):
    primaries_name = {1: "BT.709", 9: "BT.2020", 12: "P3"}.get(primaries, "unknown")
    transfer_name = {1: "BT.709", 8: "linear", 13: "sRGB", 16: "PQ", 18: "HLG"}.get(
        transfer, "unknown"
    )
    return "%s/%s/%s-bit" % (primaries_name, transfer_name, bit_depth)


def convert_heif_to_jpeg(data, quality=JPEG_QUALITY, exposure_ev=0.0):
    """Return (jpeg_bytes, metadata). Raises HifError on invalid input."""
    if not isinstance(data, (bytes, bytearray)):
        raise HifError("上传内容无效")
    data = bytes(data)
    if len(data) < 16 or data[4:8] != b"ftyp":
        raise HifError("不是有效的 HEIF/HIF 文件", 415)
    if data[8:12] not in _HEIF_BRANDS:
        raise HifError("当前只支持 HEIF/HIF（不支持 AVIF 等其它容器）", 415)
    if len(data) > MAX_UPLOAD_BYTES:
        raise HifError("文件超过 %d MB 上限" % (MAX_UPLOAD_BYTES // 1048576), 413)
    quality = max(70, min(100, int(quality)))
    gain = 2.0 ** max(-4.0, min(4.0, float(exposure_ev)))

    try:
        heif = open_heif(data, convert_hdr_to_8bit=False)
    except Exception as exc:
        raise HifError("HEIF 解码失败：%s" % exc, 422)

    width, height = heif.size
    if width <= 0 or height <= 0:
        raise HifError("HEIF 尺寸无效", 422)
    if width * height > MAX_PIXELS:
        raise HifError("图片超过 %d 万像素上限" % (MAX_PIXELS // 10000), 413)

    info = heif.info or {}
    nclx = info.get("nclx_profile") or {}
    primaries = int(nclx.get("color_primaries", 0))
    transfer = int(nclx.get("transfer_characteristics", 0))
    bit_depth = int(info.get("bit_depth", 8) or 8)
    if primaries == 0 or transfer == 0:
        raise HifError("HEIF 缺少色彩描述（nclx），无法做可靠的颜色转换", 415)

    try:
        array = np.asarray(heif)
    except Exception as exc:
        raise HifError("HEIF 像素解码失败：%s" % exc, 422)
    if array.ndim != 3 or array.shape[2] < 3:
        raise HifError("HEIF 不是 RGB 图像", 415)
    array = array[:height, :width, :3]

    scale = 255.0 if array.dtype == np.uint8 else 65535.0
    if array.dtype not in (np.uint8, np.uint16):
        raise HifError("不支持的 HEIF 位深（%s）" % array.dtype, 415)

    hdr = transfer in (16, 18)
    peak = 0.0
    if hdr:
        sample = array[::8, ::8].astype(np.float32) / scale
        sample_linear = _pq_eotf(sample) if transfer == 16 else _hlg_to_nits(sample)
        sample_709 = _to_709(sample_linear, primaries)
        peak = float(_luminance(sample_709).max()) * gain
        if not np.isfinite(peak) or peak <= 0:
            raise HifError("HDR 亮度解析失败", 422)

    out = np.empty((height, width, 3), dtype=np.uint8)
    step = 256
    for y0 in range(0, height, step):
        y1 = min(y0 + step, height)
        value = array[y0:y1].astype(np.float32) / scale
        if hdr:
            if transfer == 16:
                linear = _pq_eotf(value)
            else:
                linear = _hlg_to_nits(value)
            linear = _to_709(linear, primaries) * gain
            y = _luminance(linear)
            target = _tone_luminance(y, peak)
            ratio = np.where(y > 1e-6, target / np.maximum(y, 1e-6), 0.0)
            linear = linear * ratio[..., None]
        else:
            if transfer == 13:
                linear = _srgb_eotf(value)
            elif transfer == 1:
                linear = _bt709_eotf(value)
            elif transfer == 8:
                linear = value
            else:
                raise HifError("不支持的 SDR 传输曲线（%s）" % transfer, 415)
            linear = _to_709(linear, primaries) * gain
        out[y0:y1] = (np.clip(_srgb_oetf(linear), 0.0, 1.0) * 255.0 + 0.5).astype(
            np.uint8
        )

    exif_bytes = info.get("exif")
    image = Image.fromarray(out, "RGB")
    if exif_bytes:
        image.info["exif"] = exif_bytes
        if not _heif_has_container_transform(data):
            image = ImageOps.exif_transpose(image)
            exif_bytes = image.info.get("exif")
    exif = Image.Exif()
    if exif_bytes:
        try:
            exif.load(exif_bytes)
        except Exception:
            exif = Image.Exif()
    exif[274] = 1
    try:
        sub_ifd = exif.get_ifd(34665)
        sub_ifd[40961] = 1  # EXIF ColorSpace = sRGB
        sub_ifd[40962] = image.width
        sub_ifd[40963] = image.height
    except Exception:
        pass

    output = io.BytesIO()
    image.save(
        output,
        format="JPEG",
        quality=quality,
        subsampling=0,
        optimize=True,
        icc_profile=_SRGB_ICC,
        exif=exif.tobytes(),
    )
    meta = {
        "width": image.width,
        "height": image.height,
        "primaries": primaries,
        "transfer": transfer,
        "bit_depth": bit_depth,
        "source": _source_label(primaries, transfer, bit_depth),
        "hdr": hdr,
        "peak": round(peak, 1) if hdr else None,
        "quality": quality,
        "exposureEv": round(float(exposure_ev), 2),
    }
    return output.getvalue(), meta
