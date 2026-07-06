from __future__ import annotations

import asyncio
from collections.abc import Callable, Mapping, Sequence
from typing import Any

import numpy as np
import onnxruntime as ort
from camera_ui_ml import BaseModelManager, InferenceBackend
from camera_ui_sdk import LoggerService

from defaults import (
    DEFAULT_CLIP_TEXT,
    DEFAULT_CLIP_VISION,
    MODEL_BASE_URL,
    MODEL_LFS_URL,
    model_version,
)
from inference import OnnxBackend

# onnxruntime provider list, e.g. ["CUDAExecutionProvider", "CPUExecutionProvider"]
ProviderList = Sequence[Any]

_ORT_TO_NP: dict[str, Any] = {
    "tensor(float)": np.float32,
    "tensor(float16)": np.float16,
    "tensor(double)": np.float64,
    "tensor(int64)": np.int64,
    "tensor(int32)": np.int32,
    "tensor(uint8)": np.uint8,
    "tensor(bool)": np.bool_,
}


class OnnxModelManager(BaseModelManager):
    def __init__(
        self,
        storage_path: str,
        logger: LoggerService,
        get_provider_lists: Callable[[], list[ProviderList]],
    ) -> None:
        super().__init__(storage_path, logger, model_version)
        self._get_provider_lists = get_provider_lists

    def model_files(self, model_name: str) -> Mapping[str, tuple[str, str]]:
        rel = self._rel_path(model_name)
        return {"model": (f"{MODEL_LFS_URL}/{rel}", rel)}

    def clip_processor_files(self) -> Mapping[str, tuple[str, str]]:
        return {
            name: (
                f"{MODEL_BASE_URL}/clip-vit-base-patch32/{name}",
                f"clip-vit-base-patch32/{name}",
            )
            for name in self.CLIP_PROCESSOR_FILENAMES
        }

    async def build_backend(self, model_name: str, paths: Mapping[str, str]) -> InferenceBackend:
        sessions = await asyncio.to_thread(self._build_sessions, paths["model"])
        active = sessions[0].get_providers()
        self.logger.success(f"Loaded model: {model_name} ({active[0] if active else 'CPUExecutionProvider'})")
        return OnnxBackend(sessions)

    def _build_sessions(self, path: str) -> list[Any]:
        provider_lists = self._get_provider_lists() or [["CPUExecutionProvider"]]
        return [self._create_session(path, list(providers)) for providers in provider_lists]

    def _create_session(self, path: str, providers: list[Any]) -> Any:
        try:
            session = ort.InferenceSession(path, providers=providers)
            if providers != ["CPUExecutionProvider"]:
                self._warmup(session)
            return session
        except Exception as error:
            if providers == ["CPUExecutionProvider"]:
                raise
            self.logger.warn(f"Accelerated provider unavailable ({error}); falling back to CPU")
            return ort.InferenceSession(path, providers=["CPUExecutionProvider"])

    @staticmethod
    def _warmup(session: Any) -> None:
        feeds: dict[str, Any] = {}
        for inp in session.get_inputs():
            shape = [dim if isinstance(dim, int) and dim > 0 else 1 for dim in inp.shape]
            feeds[inp.name] = np.zeros(shape, dtype=_ORT_TO_NP.get(inp.type, np.float32))
        session.run(None, feeds)

    @staticmethod
    def _rel_path(model_name: str) -> str:
        if model_name == DEFAULT_CLIP_VISION:
            return "clip-vit-base-patch32/vision.onnx"
        if model_name == DEFAULT_CLIP_TEXT:
            return "clip-vit-base-patch32/text.onnx"
        return f"{model_name}/{model_name}.onnx"
