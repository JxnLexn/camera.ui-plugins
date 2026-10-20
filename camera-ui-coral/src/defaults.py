from __future__ import annotations

from camera_ui_sdk import DetectionLabel

model_version = "v1"

_MODELS_HOST = "https://models.cameraui.com"
MODEL_BASE_URL = f"{_MODELS_HOST}/{model_version}/coral"
MODEL_LFS_URL = MODEL_BASE_URL

OBJECT_MODELS: dict[str, int] = {
    "yolo-v9-s-320": 320,
}

DEFAULT_OBJECT_MODEL = "yolo-v9-s-320"

OBJECT_LABELS: dict[int, DetectionLabel] = {0: "person", 1: "vehicle", 2: "animal"}

# falls back to CPU int8 when the Edge TPU delegate or device is missing
DEFAULT_USE_EDGETPU = True

DEFAULT_OPTION = "default"


def resolve_model(name: str | None, fallback: str) -> str:
    return fallback if not name or name == DEFAULT_OPTION else name
