from typing import Any

import cv2
import numpy as np


def get_contour_detections(
    mask: np.ndarray[Any, Any], area_threshold: int
) -> list[tuple[float, float, float, float]]:
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    return [
        (float(x), float(y), float(x + w), float(y + h))
        for contour in contours
        if (_ := cv2.contourArea(contour)) > area_threshold
        for x, y, w, h in [cv2.boundingRect(contour)]
    ]
