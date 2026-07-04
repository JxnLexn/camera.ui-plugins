from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import numpy as np
from camera_ui_ml import (
    BaseModelManager,
    BoxDetector,
    NormalizedDetection,
    RawDetection,
    decode_image,
    frame_to_rgb,
    normalize_box,
)
from camera_ui_sdk import ImageMetadata, LoggerService, VideoFrameData
from PIL import Image

from decode import decode_hailo_nms

NDArray = np.ndarray[Any, Any]


class HailoDetector(BoxDetector):
    def __init__(
        self,
        manager: BaseModelManager,
        logger: LoggerService,
        coco_map: Mapping[int, int],
        *,
        name: str = "object detector",
        threshold: float = 0.4,
    ) -> None:
        super().__init__(manager, logger, name=name, threshold=threshold)
        self._coco_map = coco_map

    async def detect(self, image: NDArray, threshold: float | None = None) -> list[RawDetection]:
        if not self._ready():
            return []
        assert self.backend is not None

        limit = self.threshold if threshold is None else threshold
        orig_h, orig_w = int(image.shape[0]), int(image.shape[1])
        model_w, model_h = self.input_size
        resized = np.asarray(Image.fromarray(image, mode="RGB").resize((model_w, model_h)), dtype=np.uint8)

        outputs = await self.backend.infer([resized])
        return decode_hailo_nms(outputs, self._coco_map, orig_w, orig_h, limit)

    async def detect_frame(self, frame: VideoFrameData, threshold: float | None = None) -> list[RawDetection]:
        if not self._ready():
            return []
        rgb = frame_to_rgb(frame["data"], frame["width"], frame["height"], frame["format"])
        return await self.detect(rgb, threshold)

    async def detect_single(
        self, image_data: bytes, metadata: ImageMetadata, threshold: float | None = None
    ) -> list[NormalizedDetection]:
        if not self._ready():
            return []
        rgb = decode_image(image_data)
        height, width = int(rgb.shape[0]), int(rgb.shape[1])
        raw = await self.detect(rgb, threshold)
        return [(cid, conf, normalize_box(box, width, height)) for cid, conf, box in raw]
