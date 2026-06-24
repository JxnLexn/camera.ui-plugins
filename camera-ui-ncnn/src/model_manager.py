from __future__ import annotations

import asyncio
from collections.abc import Callable, Mapping
from typing import Any

import ncnn
from camera_ui_ml import BaseModelManager, InferenceBackend
from camera_ui_sdk import LoggerService

from defaults import MODEL_BASE_URL, MODEL_LFS_URL, model_version
from inference import NcnnBackend


class NcnnModelManager(BaseModelManager):
    def __init__(
        self,
        storage_path: str,
        logger: LoggerService,
        get_use_vulkan: Callable[[], bool],
    ) -> None:
        super().__init__(storage_path, logger, model_version)
        self._get_use_vulkan = get_use_vulkan

    def model_files(self, model_name: str) -> Mapping[str, tuple[str, str]]:
        param_rel = f"{model_name}/{model_name}.ncnn.param"
        bin_rel = f"{model_name}/{model_name}.ncnn.bin"
        return {
            "param": (f"{MODEL_BASE_URL}/{param_rel}", param_rel),
            "bin": (f"{MODEL_LFS_URL}/{bin_rel}", bin_rel),
        }

    async def build_backend(self, model_name: str, paths: Mapping[str, str]) -> InferenceBackend:
        use_vulkan = self._get_use_vulkan()
        net = await asyncio.to_thread(self._build, paths["param"], paths["bin"], use_vulkan)
        size = _input_size(paths["param"])
        # ncnn silently runs on CPU if Vulkan was requested but no GPU is present.
        device = "Vulkan (GPU)" if use_vulkan and ncnn.get_gpu_count() > 0 else "CPU"
        self.logger.success(f"Loaded model: {model_name} ({device})")
        return NcnnBackend(net, size, device)

    @staticmethod
    def _build(param_path: str, bin_path: str, use_vulkan: bool) -> Any:
        net = ncnn.Net()
        net.opt.use_vulkan_compute = use_vulkan
        net.load_param(param_path)
        net.load_model(bin_path)
        return net


def _input_size(param_path: str) -> tuple[int, int]:
    # The Input layer encodes dims as `0=W 1=H`; parse them from the .param text.
    with open(param_path) as handle:
        for line in handle:
            if line.startswith("Input"):
                params = dict(p.split("=", 1) for p in line.split() if "=" in p)
                return (int(params.get("0", 0)), int(params.get("1", 0)))
    return (0, 0)
