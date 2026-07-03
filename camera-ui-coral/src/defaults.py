from __future__ import annotations

from camera_ui_sdk import DetectionLabel

MODEL_BASE_URL = "https://raw.githubusercontent.com/cameraui/models/main/models/coral"
MODEL_LFS_URL = "https://media.githubusercontent.com/media/cameraui/models/main/models/coral"

model_version = "v1"

OBJECT_MODELS: dict[str, int] = {
    "yolo-v9-s-320": 320,
}

DEFAULT_OBJECT_MODEL = "yolo-v9-s-320"

# TFLite / Edge TPU models carry no embedded class names, so object labels are hardcoded.
OBJECT_LABELS: dict[int, DetectionLabel] = {0: "person", 1: "vehicle", 2: "animal"}

# Prefer the Edge TPU (Coral) when the delegate + device are present; falls back to CPU int8.
DEFAULT_USE_EDGETPU = True
