from __future__ import annotations

from collections.abc import Sequence
from typing import Any, cast

import numpy as np

NDArray = np.ndarray[Any, Any]

REG_MAX = 16  # DFL bins per box side (64 regression channels = 4 * REG_MAX)


def _softmax(x: NDArray, axis: int) -> NDArray:
    e = np.exp(x - np.max(x, axis=axis, keepdims=True))
    return cast(NDArray, e / np.sum(e, axis=axis, keepdims=True))


def _dfl(x: NDArray) -> NDArray:
    b, _, a = x.shape
    x = x.reshape(b, 4, REG_MAX, a).transpose(0, 2, 1, 3)
    x = _softmax(x, axis=1)
    weights = np.arange(REG_MAX, dtype=np.float32).reshape(1, REG_MAX, 1, 1)
    return cast(NDArray, np.sum(weights * x, axis=1).reshape(b, 4, a))


def _make_anchors(
    feats_hw: list[tuple[int, int]], strides: list[int], offset: float = 0.5
) -> tuple[NDArray, NDArray]:
    points: list[NDArray] = []
    strd: list[NDArray] = []
    for (h, w), stride in zip(feats_hw, strides, strict=False):
        sx = np.arange(w, dtype=np.float32) + offset
        sy = np.arange(h, dtype=np.float32) + offset
        gy, gx = np.meshgrid(sy, sx, indexing="ij")
        points.append(np.stack((gx, gy), axis=-1).reshape(-1, 2))
        strd.append(np.full((h * w, 1), stride, dtype=np.float32))
    return np.concatenate(points), np.concatenate(strd)


def _dist2bbox(distance: NDArray, anchor_points: NDArray) -> NDArray:
    lt, rb = np.split(distance, 2, axis=1)
    anchor_points = anchor_points.transpose(0, 2, 1)
    x1y1 = anchor_points - lt
    x2y2 = anchor_points + rb
    cxy = (x1y1 + x2y2) / 2
    wh = x2y2 - x1y1
    return np.concatenate((cxy, wh), axis=1)


def decode_yolov9_sep(outputs: Sequence[NDArray], input_size: int) -> NDArray:
    preds = [np.asarray(o, dtype=np.float32) for o in outputs]
    reg_channels = 4 * REG_MAX
    num_classes = next(o.shape[2] for o in preds if o.shape[2] != reg_channels)

    # regression tensors first, then class tensors (both anchors-descending) to match make_anchors
    order = sorted(range(len(preds)), key=lambda i: (-preds[i].shape[2], -preds[i].shape[1]))
    half = len(order) // 2
    reg = np.concatenate([preds[i] for i in order[:half]], axis=1)
    cls = np.concatenate([preds[i] for i in order[half:]], axis=1)
    x = np.transpose(np.concatenate([reg, cls], axis=2), (0, 2, 1))

    anchor_counts = [preds[i].shape[1] for i in order[:half]]
    strides = [int(round((input_size * input_size / count) ** 0.5)) for count in anchor_counts]
    dims = [(input_size // s, input_size // s) for s in strides]
    anchors, strd = _make_anchors(dims, strides, 0.5)

    boxes = _dist2bbox(_dfl(x[:, :-num_classes, :]), anchors[None, ...]) * strd.transpose(1, 0)[None, ...]
    scores = 1.0 / (1.0 + np.exp(-x[:, -num_classes:, :]))
    return cast(NDArray, np.concatenate((boxes, scores), axis=1)[0])
