from __future__ import annotations

import ctypes
import os
import threading
import weakref
from collections.abc import Sequence
from functools import cache
from typing import Any

import numpy as np
from camera_ui_ml import NDArray
from coremltools.proto import FeatureTypes_pb2 as ft

LIBRARY = "libcoremlhelper.dylib"

_ARRAY = 0
_RGB = 1
_ERROR_SIZE = 512

_COMPUTE_UNITS = {"CPU_ONLY": 0, "CPU_AND_GPU": 1, "ALL": 2, "CPU_AND_NE": 3}


class _Input(ctypes.Structure):
    _fields_ = [
        ("name", ctypes.c_char_p),
        ("kind", ctypes.c_int32),
        ("ndim", ctypes.c_int32),
        ("shape", ctypes.POINTER(ctypes.c_int64)),
        ("data", ctypes.c_void_p),
    ]


class _Output(ctypes.Structure):
    _fields_ = [
        ("name", ctypes.c_char_p),
        ("ndim", ctypes.c_int32),
        ("shape", ctypes.POINTER(ctypes.c_int64)),
        ("data", ctypes.c_void_p),
    ]


class NativeModel:
    def __init__(
        self,
        lib: ctypes.CDLL,
        handle: int,
        inputs: list[tuple[bytes, int]],
        outputs: list[tuple[bytes, tuple[int, ...]]],
    ) -> None:
        self._lib = lib
        self._handle = handle
        self._release = weakref.finalize(self, lib.cm_release, handle)
        self._inputs = inputs
        self._outputs = [(name, shape, (ctypes.c_int64 * len(shape))(*shape)) for name, shape in outputs]
        self._state = threading.Lock()
        self._inflight = 0
        self._closed = False

    def predict(self, values: Sequence[Any]) -> list[NDArray]:
        self._enter()
        try:
            return self._predict(values)
        finally:
            self._leave()

    def close(self) -> None:
        with self._state:
            if self._closed:
                return
            self._closed = True
            release = self._inflight == 0
        if release:
            self._release()

    def _enter(self) -> None:
        with self._state:
            if self._closed:
                raise RuntimeError("CoreML model is closed")
            self._inflight += 1

    def _leave(self) -> None:
        with self._state:
            self._inflight -= 1
            release = self._closed and self._inflight == 0
        if release:
            self._release()

    def _predict(self, values: Sequence[Any]) -> list[NDArray]:
        arrays: list[NDArray] = []
        inputs = (_Input * len(self._inputs))()
        for slot, (name, kind), value in zip(inputs, self._inputs, values, strict=True):
            array = np.ascontiguousarray(value, dtype=np.uint8 if kind == _RGB else np.float32)
            arrays.append(array)
            slot.name = name
            slot.kind = kind
            slot.ndim = array.ndim
            slot.shape = (ctypes.c_int64 * array.ndim)(*array.shape)
            slot.data = array.ctypes.data

        results: list[NDArray] = []
        outputs = (_Output * len(self._outputs))()
        for slot, (name, shape, dims) in zip(outputs, self._outputs, strict=True):
            result = np.empty(shape, dtype=np.float32)
            results.append(result)
            slot.name = name
            slot.ndim = len(shape)
            slot.shape = dims
            slot.data = result.ctypes.data

        error = ctypes.create_string_buffer(_ERROR_SIZE)
        status = self._lib.cm_predict(
            self._handle, inputs, len(self._inputs), outputs, len(self._outputs), error, _ERROR_SIZE
        )
        if status != 0:
            raise RuntimeError(f"CoreML prediction failed: {error.value.decode(errors='replace')}")
        return results


def helper_error() -> str | None:
    lib = _library()
    return lib if isinstance(lib, str) else None


def load_native(compiled_path: str, compute_units: str, spec: Any) -> NativeModel | None:
    lib = _library()
    plan = _plan(spec)
    if isinstance(lib, str) or plan is None:
        return None
    error = ctypes.create_string_buffer(_ERROR_SIZE)
    handle = lib.cm_load(compiled_path.encode(), _COMPUTE_UNITS.get(compute_units, 2), error, _ERROR_SIZE)
    if not handle:
        raise RuntimeError(error.value.decode(errors="replace"))
    return NativeModel(lib, handle, *plan)


@cache
def _library() -> ctypes.CDLL | str:
    here = os.path.dirname(os.path.abspath(__file__))
    candidates = [os.path.join(here, LIBRARY), os.path.join(here, "..", "helper", "bin", LIBRARY)]
    path = next((candidate for candidate in candidates if os.path.isfile(candidate)), None)
    if path is None:
        return f"{LIBRARY} not found"
    try:
        lib = ctypes.CDLL(path)
    except OSError as error:
        return str(error)
    lib.cm_load.restype = ctypes.c_void_p
    lib.cm_load.argtypes = [ctypes.c_char_p, ctypes.c_int32, ctypes.c_char_p, ctypes.c_size_t]
    lib.cm_release.restype = None
    lib.cm_release.argtypes = [ctypes.c_void_p]
    lib.cm_predict.restype = ctypes.c_int32
    lib.cm_predict.argtypes = [
        ctypes.c_void_p,
        ctypes.POINTER(_Input),
        ctypes.c_int32,
        ctypes.POINTER(_Output),
        ctypes.c_int32,
        ctypes.c_char_p,
        ctypes.c_size_t,
    ]
    return lib


def _plan(spec: Any) -> tuple[list[tuple[bytes, int]], list[tuple[bytes, tuple[int, ...]]]] | None:
    inputs: list[tuple[bytes, int]] = []
    for feature in spec.description.input:
        kind = feature.type.WhichOneof("Type")
        if kind == "multiArrayType" and feature.type.multiArrayType.dataType == ft.ArrayFeatureType.FLOAT32:
            inputs.append((feature.name.encode(), _ARRAY))
        elif kind == "imageType" and feature.type.imageType.colorSpace == ft.ImageFeatureType.RGB:
            inputs.append((feature.name.encode(), _RGB))
        else:
            return None

    outputs: list[tuple[bytes, tuple[int, ...]]] = []
    for feature in spec.description.output:
        array = feature.type.multiArrayType
        if (
            feature.type.WhichOneof("Type") != "multiArrayType"
            or array.dataType not in (ft.ArrayFeatureType.FLOAT32, ft.ArrayFeatureType.FLOAT16)
            or not array.shape
        ):
            return None
        outputs.append((feature.name.encode(), tuple(int(dim) for dim in array.shape)))
    return inputs, outputs
