"""Server-side MI-GAN image inpainting. Uploaded pixels are processed in memory only."""
import io
import os
import threading

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_PATH = os.environ.get(
    "LOCALTOOLS_MIGAN_MODEL",
    os.path.join(os.path.dirname(BASE_DIR), "localtools-models", "migan_pipeline_v2.onnx"),
)

_session = None
_session_lock = threading.Lock()
_inference_lock = threading.Lock()


class ModelUnavailable(Exception):
    pass


def status():
    if not os.path.isfile(MODEL_PATH):
        return {"ready": False, "reason": "服务器尚未安装 AI 修补模型"}
    try:
        import importlib.util
        missing = [name for name in ("PIL", "numpy", "onnxruntime") if importlib.util.find_spec(name) is None]
    except Exception:
        missing = ["AI 运行依赖"]
    if missing:
        return {"ready": False, "reason": "缺少服务器依赖：" + ", ".join(missing)}
    return {"ready": True, "model": "MI-GAN"}


def _get_session():
    global _session
    if _session is not None:
        return _session
    with _session_lock:
        if _session is not None:
            return _session
        if not os.path.isfile(MODEL_PATH):
            raise ModelUnavailable("服务器尚未安装 AI 修补模型")
        try:
            import onnxruntime as ort
            opts = ort.SessionOptions()
            opts.intra_op_num_threads = 2
            opts.inter_op_num_threads = 1
            opts.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
            session = ort.InferenceSession(MODEL_PATH, sess_options=opts, providers=["CPUExecutionProvider"])
            names = {item.name for item in session.get_inputs()}
            if not {"image", "mask"}.issubset(names):
                raise ModelUnavailable("模型输入格式不兼容")
            _session = session
            return _session
        except ModelUnavailable:
            raise
        except Exception as exc:
            raise ModelUnavailable("AI 模型加载失败：%s" % exc)


def inpaint(image_bytes, mask_bytes):
    """Return (encoded image bytes, MIME type); neither input is written to disk."""
    try:
        import numpy as np
        from PIL import Image, ImageOps
    except Exception as exc:
        raise ModelUnavailable("服务器缺少图片处理依赖：%s" % exc)

    try:
        with Image.open(io.BytesIO(image_bytes)) as opened:
            width, height = opened.size
            if width < 2 or height < 2 or width * height > 12_000_000:
                raise ValueError("图片尺寸无效或超过 1200 万像素")
            oriented = ImageOps.exif_transpose(opened)
            rgba = oriented.convert("RGBA")
            width, height = rgba.size
            image = np.asarray(rgba.convert("RGB"), dtype=np.uint8)
            alpha = np.asarray(rgba.getchannel("A"), dtype=np.uint8)
        with Image.open(io.BytesIO(mask_bytes)) as opened_mask:
            if opened_mask.size != (width, height):
                raise ValueError("图片与遮罩尺寸不一致，请重新框选修补区域")
            mask = opened_mask.convert("L")
            mask_array = np.asarray(mask, dtype=np.uint8)
    except ValueError:
        raise
    except Exception as exc:
        raise ValueError("无法读取图片或修补遮罩：%s" % exc)

    # MI-GAN's ONNX pipeline uses 255 for known pixels and 0 for pixels to fill.
    mask_array = np.where(mask_array >= 128, 255, 0).astype(np.uint8)
    if not np.any(mask_array == 0):
        raise ValueError("请先用画笔标出需要修补的区域")

    session = _get_session()
    image_tensor = np.transpose(image, (2, 0, 1))[None, ...]
    mask_tensor = mask_array[None, None, ...]
    try:
        with _inference_lock:
            repaired = session.run(None, {"image": image_tensor, "mask": mask_tensor})[0]
    except Exception as exc:
        raise RuntimeError("AI 修补失败：%s" % exc)
    if repaired.ndim != 4 or repaired.shape[0] != 1 or repaired.shape[1] != 3:
        raise RuntimeError("AI 模型返回了无法识别的图像格式")
    generated = np.transpose(repaired[0], (1, 2, 0)).astype(np.uint8, copy=False)
    known_pixels = (mask_array == 255)[..., None]
    rgb = np.where(known_pixels, image, generated).astype(np.uint8, copy=False)
    output = Image.fromarray(rgb, "RGB")

    transparent = bool(np.any(alpha < 255))
    if transparent:
        output.putalpha(Image.fromarray(alpha, "L"))
        fmt, mime = "PNG", "image/png"
    else:
        fmt, mime = "WEBP", "image/webp"
    result = io.BytesIO()
    try:
        if fmt == "WEBP":
            output.save(result, format=fmt, quality=92, method=4)
        else:
            output.save(result, format=fmt, optimize=True)
    except Exception as exc:
        raise RuntimeError("修补结果编码失败：%s" % exc)
    return result.getvalue(), mime
