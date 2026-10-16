from __future__ import annotations

import itertools
from typing import Any, cast

import numpy as np
import pytest

from camera_ui_ml.backend import Channels, DType, InputSpec, Layout, Normalize
from camera_ui_ml.preprocess import frame_to_rgb, resize_rgb, to_tensor

NDArray = np.ndarray[Any, Any]

SPECS = list(
    itertools.product(
        ("nchw", "nhwc"), ("rgb", "bgr"), ("unit", "facenet", "arcface", "none"), ("float32", "uint8")
    )
)


def formula(rgb: NDArray, spec: InputSpec) -> NDArray:
    resized = resize_rgb(rgb, spec.width, spec.height)
    if spec.normalize == "unit":
        arr = resized.astype(np.float32) / 255.0
    elif spec.normalize == "facenet":
        arr = (resized.astype(np.float32) - 127.5) / 128.0
    elif spec.normalize == "arcface":
        arr = (resized.astype(np.float32) - 127.5) / 127.5
    else:
        arr = resized.astype(np.uint8 if spec.dtype == "uint8" else np.float32)
    if spec.layout == "nchw":
        arr = arr.transpose(2, 0, 1)
        if spec.channels == "bgr":
            arr = arr[::-1]
    elif spec.channels == "bgr":
        arr = arr[..., ::-1]
    return np.ascontiguousarray(np.expand_dims(arr, axis=0))


def frame(width: int, height: int) -> NDArray:
    pixels = np.random.default_rng(width * height).integers(0, 256, width * height * 3, dtype=np.uint8)
    pixels[:256] = np.arange(256, dtype=np.uint8)
    # read-only, like the memoryview a decoded rpc frame carries
    return frame_to_rgb(memoryview(pixels.tobytes()), width, height)


def sources() -> list[tuple[NDArray, int, int]]:
    big = frame(640, 480)
    return [
        (frame(320, 320), 320, 320),
        (frame(112, 112), 112, 112),
        (frame(128, 256), 128, 256),
        (big, 320, 320),
        (big[40:296, 100:356], 256, 256),
    ]


@pytest.mark.parametrize(("layout", "channels", "normalize", "dtype"), SPECS)
def test_to_tensor_matches_the_formula_bit_for_bit(
    layout: str, channels: str, normalize: str, dtype: str
) -> None:
    for rgb, width, height in sources():
        spec = InputSpec(
            width,
            height,
            layout=cast(Layout, layout),
            normalize=cast(Normalize, normalize),
            channels=cast(Channels, channels),
            dtype=cast(DType, dtype),
        )
        got, want = to_tensor(rgb, spec), formula(rgb, spec)
        assert got.dtype == want.dtype
        assert got.shape == want.shape
        assert got.flags.c_contiguous
        assert got.flags.writeable
        assert got.tobytes() == want.tobytes()
