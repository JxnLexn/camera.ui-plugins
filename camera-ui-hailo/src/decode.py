from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

import numpy as np
from camera_ui_ml import Box

NDArray = np.ndarray[Any, Any]


def decode_hailo_nms(
    outputs: Sequence[NDArray],
    coco_map: Mapping[int, int],
    orig_w: int,
    orig_h: int,
    threshold: float,
) -> list[tuple[int, float, Box]]:
    detections: list[tuple[int, float, Box]] = []
    for coco_id, class_dets in enumerate(outputs):
        mapped = coco_map.get(coco_id)
        if mapped is None:
            continue
        arr = np.asarray(class_dets)
        if arr.size == 0:
            continue
        for det in arr:
            if det.shape[0] < 5:
                continue
            score = float(det[4])
            if score < threshold:
                continue
            ymin, xmin, ymax, xmax = (
                float(det[0]),
                float(det[1]),
                float(det[2]),
                float(det[3]),
            )
            detections.append(
                (
                    mapped,
                    score,
                    (xmin * orig_w, ymin * orig_h, xmax * orig_w, ymax * orig_h),
                )
            )
    return detections
