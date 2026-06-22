from __future__ import annotations

import asyncio
import os
from collections.abc import Callable, Sequence
from typing import Any

import aiohttp
import onnxruntime as ort
from camera_ui_sdk import LoggerService, PluginAPI

from defaults import (
    DEFAULT_CLIP_TEXT,
    DEFAULT_CLIP_VISION,
    MODEL_LFS_URL,
    model_version,
)

# A provider entry is either "CPUExecutionProvider" or ("CUDAExecutionProvider", {...}).
ProviderList = Sequence[str | tuple[str, dict[str, Any]]]


class ModelManager:
    def __init__(
        self,
        api: PluginAPI,
        logger: LoggerService,
        get_providers: Callable[[], ProviderList],
    ) -> None:
        self.model_path = os.path.join(f"{api.storagePath}/models/{model_version}")
        self.logger = logger
        self._get_providers = get_providers
        self._load_tasks: dict[str, asyncio.Task[Any]] = {}

    def reset(self) -> None:
        """Drop cached load tasks so models are rebuilt (e.g. after a provider change)."""
        self._load_tasks.clear()

    @staticmethod
    def _rel_path(model_name: str) -> str:
        # CLIP ships as one folder with two files; everything else is <name>/<name>.onnx.
        if model_name == DEFAULT_CLIP_VISION:
            return "clip-vit-base-patch32/vision.onnx"
        if model_name == DEFAULT_CLIP_TEXT:
            return "clip-vit-base-patch32/text.onnx"
        return f"{model_name}/{model_name}.onnx"

    async def ensure_model(self, model_name: str) -> ort.InferenceSession:
        task = self._load_tasks.get(model_name)
        if task is None:
            task = asyncio.create_task(self._load(model_name))
            self._load_tasks[model_name] = task
        return await task

    async def _load(self, model_name: str) -> ort.InferenceSession:
        rel = self._rel_path(model_name)
        await self._download_file(f"{MODEL_LFS_URL}/{rel}", rel)
        path = os.path.join(self.model_path, rel)

        providers = list(self._get_providers())
        session: ort.InferenceSession = await asyncio.to_thread(
            ort.InferenceSession, path, providers=providers
        )
        active = session.get_providers()
        self.logger.success(f"Loaded model: {model_name} ({active[0] if active else 'CPUExecutionProvider'})")
        return session

    async def _download_file(self, url: str, filename: str) -> None:
        fullpath = os.path.join(self.model_path, filename)
        if os.path.isfile(fullpath):
            return

        tmp = fullpath + ".tmp"
        os.makedirs(os.path.dirname(fullpath), exist_ok=True)

        short_name = os.path.basename(filename)
        self.logger.log(f"Downloading {short_name}...")

        async with aiohttp.ClientSession() as session, session.get(url) as response:
            if response.status < 200 or response.status >= 300:
                raise Exception(f"Error downloading {url}: {response.status}")

            total_size = int(response.headers.get("content-length", 0))
            downloaded = 0
            last_percent = 0

            with open(tmp, "wb") as f:
                async for chunk in response.content.iter_chunked(1024 * 1024):
                    if chunk:
                        downloaded += len(chunk)
                        f.write(chunk)

                        if total_size > 1024 * 1024:
                            percent = min(100, (downloaded * 100) // total_size)
                            if percent >= last_percent + 25 and percent <= 100:
                                last_percent = (percent // 25) * 25
                                self.logger.log(f"Downloading {short_name}... {last_percent}%")

            size_mb = downloaded / (1024 * 1024)
            self.logger.log(f"Downloaded {short_name} ({size_mb:.1f} MB)")

        os.rename(tmp, fullpath)
