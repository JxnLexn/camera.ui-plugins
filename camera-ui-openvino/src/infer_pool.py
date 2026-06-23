from __future__ import annotations

import asyncio
import contextlib
import queue
import threading
from collections.abc import Callable
from typing import Any

import numpy as np
import openvino as ov


def _collect_outputs(
    compiled: ov.CompiledModel, request: ov.InferRequest
) -> dict[Any, np.ndarray[Any, Any]]:
    # Copy each output before the request is reused/returned, keyed by both the
    # output port and its index so callers can index like an OpenVINO OVDict.
    results: dict[Any, np.ndarray[Any, Any]] = {}
    for index, port in enumerate(compiled.outputs):
        data = np.array(request.get_output_tensor(index).data)
        results[port] = data
        results[index] = data
    return results


class PooledModel:
    def __init__(self, compiled: ov.CompiledModel, size: int = 4) -> None:
        self._compiled = compiled
        self._size = max(1, size)
        self._pool: queue.Queue[ov.InferRequest] = queue.Queue()
        self._created = 0
        self._lock = threading.Lock()

    @property
    def compiled(self) -> ov.CompiledModel:
        return self._compiled

    def __call__(self, inputs: Any) -> dict[Any, np.ndarray[Any, Any]]:
        request = self._acquire()
        try:
            request.infer(inputs)
            return _collect_outputs(self._compiled, request)
        finally:
            self._pool.put(request)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._compiled, name)

    def _acquire(self) -> ov.InferRequest:
        try:
            return self._pool.get_nowait()
        except queue.Empty:
            pass
        with self._lock:
            if self._created < self._size:
                self._created += 1
                return self._compiled.create_infer_request()
        return self._pool.get()


class AsyncInferPool:
    def __init__(
        self, compiled: ov.CompiledModel, loop: asyncio.AbstractEventLoop
    ) -> None:
        self._compiled = compiled
        self._loop = loop
        self._queue = ov.AsyncInferQueue(compiled)
        self._queue.set_callback(self._on_done)

    async def infer(
        self,
        inputs: Any,
        parse: Callable[[dict[Any, np.ndarray[Any, Any]]], Any] | None = None,
    ) -> Any:
        future: asyncio.Future[Any] = self._loop.create_future()
        # start_async blocks until a request is idle — keep it off the event loop.
        await self._loop.run_in_executor(
            None, self._queue.start_async, inputs, (future, parse)
        )
        return await future

    def close(self) -> None:
        with contextlib.suppress(Exception):  # best-effort drain on shutdown
            self._queue.wait_all()

    def _on_done(self, request: ov.InferRequest, userdata: Any) -> None:
        future, parse = userdata
        try:
            outputs = _collect_outputs(self._compiled, request)
            result = parse(outputs) if parse else outputs
            self._loop.call_soon_threadsafe(self._set_result, future, result)
        except Exception as error:  # noqa: BLE001 - forwarded to the awaiting caller
            self._loop.call_soon_threadsafe(self._set_exception, future, error)

    @staticmethod
    def _set_result(future: asyncio.Future[Any], value: Any) -> None:
        if not future.done():
            future.set_result(value)

    @staticmethod
    def _set_exception(future: asyncio.Future[Any], error: BaseException) -> None:
        if not future.done():
            future.set_exception(error)
