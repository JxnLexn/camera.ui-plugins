from __future__ import annotations

import io
from typing import Any

import numpy as np
from PIL import Image

from .backend import InputSpec
from .geometry import Box

NDArray = np.ndarray[Any, Any]


def frame_to_rgb(data: bytes | memoryview, width: int, height: int, fmt: str = "rgb") -> NDArray:
    pixels = np.frombuffer(data, dtype=np.uint8)
    if fmt == "rgb":
        return pixels.reshape((height, width, 3))
    if fmt == "rgba":
        return pixels.reshape((height, width, 4))[:, :, :3]
    if fmt == "gray":
        return np.repeat(pixels.reshape((height, width, 1)), 3, axis=2)
    raise ValueError(f"Unsupported frame format for detection: {fmt}")


def decode_image(data: bytes) -> NDArray:
    return np.asarray(Image.open(io.BytesIO(data)).convert("RGB"))


def resize_rgb(rgb: NDArray, width: int, height: int) -> NDArray:
    if rgb.shape[1] == width and rgb.shape[0] == height:
        return rgb
    return np.asarray(Image.fromarray(rgb, mode="RGB").resize((width, height)))


def to_pil(rgb: NDArray, width: int | None = None, height: int | None = None) -> Image.Image:
    image = Image.fromarray(rgb, mode="RGB")
    if width is not None and height is not None and (image.width != width or image.height != height):
        image = image.resize((width, height))
    return image


def to_tensor(rgb: NDArray, spec: InputSpec) -> NDArray:
    resized = resize_rgb(rgb, spec.width, spec.height)

    src: NDArray
    if spec.layout == "nchw":
        src = resized.transpose(2, 0, 1)
        if spec.channels == "bgr":
            src = src[::-1]
    else:
        src = resized[..., ::-1] if spec.channels == "bgr" else resized

    if spec.normalize == "none":
        out = np.empty((1, *src.shape), dtype=np.uint8 if spec.dtype == "uint8" else np.float32)
        np.copyto(out[0], src, casting="unsafe")
        return out

    out = np.empty((1, *src.shape), dtype=np.float32)
    if spec.normalize == "unit":
        np.divide(src, np.float32(255.0), out=out[0], dtype=np.float32)
    else:
        np.subtract(src, np.float32(127.5), out=out[0], dtype=np.float32)
        np.divide(out, np.float32(128.0 if spec.normalize == "facenet" else 127.5), out=out)
    return out


def crop_rgb(rgb: NDArray, box: Box) -> NDArray:
    x1, y1, x2, y2 = (int(round(v)) for v in box)
    return rgb[y1:y2, x1:x2]
