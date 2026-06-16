from __future__ import annotations

import asyncio
import io
import os
import tempfile
import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import cv2
import numpy as np
from camera_ui_sdk import (
    API_EVENT,
    BasePlugin,
    CameraDevice,
    Detection,
    DeviceStorage,
    JsonSchema,
    LoggerService,
    MotionDetectionInterface,
    MotionDetectionPluginResponse,
    PluginAPI,
    VideoFrameData,
)

from detector_defaults import (
    DEFAULT_AREA,
    DEFAULT_AREA_BS,
    DEFAULT_AREA_FD,
    DEFAULT_BLUR,
    DEFAULT_DILT,
    DEFAULT_LEARNING_RATE,
    DEFAULT_MODEL,
    DEFAULT_THRESHOLD,
    DEFAULT_THRESHOLD_BS,
)
from opencv_utils import get_detections, get_detections_bs, get_detections_fd
from sensor import OpenCVMotionSensor


class OpenCV(BasePlugin, MotionDetectionInterface):
    def __init__(self, logger: LoggerService, api: PluginAPI, storage: DeviceStorage) -> None:
        super().__init__(logger, api, storage)

        self.sensors: dict[str, OpenCVMotionSensor] = {}
        self.motion_detection_running = False

        # self.api.on(API_EVENT.FINISH_LAUNCHING, self.on_finish_launching)
        self.api.on(API_EVENT.SHUTDOWN, self.on_shutdown)

    async def on_shutdown(self) -> None:
        # Reset all sensor states
        for sensor in self.sensors.values():
            sensor.resetState()

        self.sensors.clear()

    async def configureCameras(self, cameras: list[CameraDevice]) -> None:
        for camera in cameras:
            await self.add_sensor_to_camera(camera)

    async def onCameraAdded(self, camera: CameraDevice) -> None:
        await self.add_sensor_to_camera(camera)

    async def onCameraReleased(self, cameraId: str) -> None:
        sensor = self.sensors.get(cameraId)
        if sensor:
            sensor.resetState()
            del self.sensors[cameraId]

    async def on_camera_selected(self, camera: CameraDevice) -> None:
        await self.add_sensor_to_camera(camera)

    async def add_sensor_to_camera(self, camera: CameraDevice) -> None:
        sensor = OpenCVMotionSensor()

        await camera.addSensor(sensor)

        self.sensors[camera.id] = sensor

    async def motionDetectionSettings(self) -> list[JsonSchema] | None:
        schemas: list[JsonSchema] = [
            {
                "type": "string",
                "key": "motion_detector",
                "title": "Motion Detector",
                "description": "Select the motion detection model to use",
                "enum": ["Frame Difference", "Background Substraction", "Default"],
                "store": False,
                "defaultValue": DEFAULT_MODEL,
                "required": True,
                "group": "Manage",
            },
            {
                "type": "number",
                "key": "default_area",
                "title": "Area",
                "description": "Minimum size of detected motion (pixels)",
                "store": False,
                "defaultValue": DEFAULT_AREA,
                "minimum": 10,
                "maximum": 1000,
                "step": 1,
                "required": True,
                "group": "Default",
            },
            {
                "type": "number",
                "key": "default_threshold",
                "title": "Threshold",
                "description": "Sensitivity of motion detection (higher = less sensitive)",
                "store": False,
                "defaultValue": DEFAULT_THRESHOLD,
                "minimum": 1,
                "maximum": 255,
                "step": 1,
                "required": True,
                "group": "Default",
            },
            {
                "type": "number",
                "key": "default_blur",
                "title": "Blur",
                "description": "Gaussian blur radius to reduce noise",
                "store": False,
                "defaultValue": DEFAULT_BLUR,
                "minimum": 1,
                "maximum": 21,
                "step": 1,
                "required": True,
                "group": "Default",
            },
            {
                "type": "number",
                "key": "default_dilation",
                "title": "Dilation",
                "description": "Expansion of detected motion areas",
                "store": False,
                "defaultValue": DEFAULT_DILT,
                "minimum": 1,
                "maximum": 21,
                "step": 1,
                "required": True,
                "group": "Default",
            },
            {
                "type": "number",
                "key": "background_substraction_area",
                "title": "Area",
                "description": "Minimum size of detected motion (pixels)",
                "store": False,
                "defaultValue": DEFAULT_AREA_BS,
                "minimum": 10,
                "maximum": 1000,
                "step": 1,
                "required": True,
                "group": "Background Substraction",
            },
            {
                "type": "number",
                "key": "background_substraction_threshold",
                "title": "Threshold",
                "description": "Sensitivity of motion detection (higher = less sensitive)",
                "store": False,
                "defaultValue": DEFAULT_THRESHOLD_BS,
                "minimum": 1,
                "maximum": 255,
                "step": 1,
                "required": True,
                "group": "Background Substraction",
            },
            {
                "type": "number",
                "key": "background_substraction_learning_rate",
                "title": "Learning Rate",
                "description": "Speed of background model adaptation (0-1, -1 for auto)",
                "store": False,
                "defaultValue": DEFAULT_LEARNING_RATE,
                "minimum": -1,
                "maximum": 1,
                "step": 0.01,
                "required": True,
                "group": "Background Substraction",
            },
            {
                "type": "number",
                "key": "frame_difference_area",
                "title": "Area",
                "description": "Minimum size of detected motion (pixels)",
                "store": False,
                "defaultValue": DEFAULT_AREA_FD,
                "minimum": 10,
                "maximum": 1000,
                "step": 1,
                "required": True,
                "group": "Frame Difference",
            },
        ]

        return schemas

    async def testMotionDetection(
        self, video_data: bytes, config: dict[str, Any]
    ) -> MotionDetectionPluginResponse:
        if self.motion_detection_running:
            raise Exception("Motion detection already running")

        self.motion_detection_running = True

        # Create a temporary file in memory using BytesIO
        input_buffer = io.BytesIO(video_data)

        # Generate a unique temporary filename in the system's temp directory
        temp_input = os.path.join(tempfile.gettempdir(), f"input_{uuid.uuid4()}.mp4")
        temp_output = os.path.join(tempfile.gettempdir(), f"output_{uuid.uuid4()}.mp4")

        try:
            # Write to temp file efficiently using a single write operation
            with open(temp_input, "wb") as f:
                f.write(input_buffer.getvalue())

            # Release memory of input buffer
            input_buffer.close()
            del input_buffer

            # Open video capture from temporary file
            cap = cv2.VideoCapture(temp_input)

            width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
            height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
            fps = int(cap.get(cv2.CAP_PROP_FPS))

            # Use H.264 codec for better compression and quality
            fourcc = cv2.VideoWriter.fourcc("a", "v", "c", "1")
            out = cv2.VideoWriter(temp_output, fourcc, fps, (width, height), True)

            # Pre-allocate numpy arrays for better performance
            previous_frame: np.ndarray[Any, Any] | None = None
            backSub = None

            # Use a smaller thread pool since we're mostly I/O bound
            executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="OpenCV")
            detector_model = config.get("motion_detector", "Default")
            self.logger.log(f"Using detector model: {detector_model}")

            detections: list[Detection] = []

            try:
                while cap.isOpened():
                    ret, frame = cap.read()
                    if not ret:
                        break

                    # Convert to grayscale efficiently
                    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)

                    if detector_model == "Frame Difference":
                        area = config.get("frame_difference_area", DEFAULT_AREA_FD)

                        if previous_frame is None:
                            previous_frame = gray
                            continue

                        dets = await asyncio.get_event_loop().run_in_executor(
                            executor,
                            get_detections_fd,
                            previous_frame,
                            gray,
                            area,
                        )

                        for x1, y1, x2, y2 in dets:
                            detections.append(
                                {
                                    "label": "motion",
                                    "confidence": 1.0,
                                    "box": {
                                        "x": x1 / width,
                                        "y": y1 / height,
                                        "width": (x2 - x1) / width,
                                        "height": (y2 - y1) / height,
                                    },
                                }
                            )

                        previous_frame = gray

                    elif detector_model == "Background Substraction":
                        if backSub is None:
                            backSub = cv2.createBackgroundSubtractorMOG2(varThreshold=18, detectShadows=False)

                        threshold = config.get("background_substraction_threshold", DEFAULT_THRESHOLD_BS)
                        area = config.get("background_substraction_area", DEFAULT_AREA_BS)

                        dets = await asyncio.get_event_loop().run_in_executor(
                            executor,
                            get_detections_bs,
                            gray,
                            backSub,
                            threshold,
                            area,
                        )

                    else:  # default
                        blur = config.get("default_blur", DEFAULT_BLUR)
                        threshold = config.get("default_threshold", DEFAULT_THRESHOLD)
                        area = config.get("default_area", DEFAULT_AREA)

                        # Use stackBlur for better performance
                        gray = cv2.stackBlur(gray, (blur, blur))

                        if previous_frame is None:
                            previous_frame = gray
                            continue

                        dets = await asyncio.get_event_loop().run_in_executor(
                            executor,
                            get_detections,
                            previous_frame,
                            gray,
                            threshold,
                            area,
                        )

                        previous_frame = gray

                    # Draw rectangles directly on frame
                    for x1, y1, x2, y2 in dets:
                        pt1: cv2.typing.Point = (int(x1), int(y1))
                        pt2: cv2.typing.Point = (int(x2), int(y2))
                        cv2.rectangle(frame, pt1, pt2, (0, 255, 0), 2)

                    out.write(frame)

                    # Explicitly delete frame to help garbage collection
                    del frame

            finally:
                cap.release()
                out.release()
                executor.shutdown()

            # Read output file efficiently in chunks
            with open(temp_output, "rb") as f:
                result_bytes = f.read()

            print(f"Motion detection completed, output size: {len(result_bytes)} bytes")

            return {
                "detected": len(detections) > 0,
                "detections": detections,
                "videoData": result_bytes,
            }

        finally:
            self.motion_detection_running = False

            # Clean up temporary files
            for temp_file in (temp_input, temp_output):
                try:
                    if os.path.exists(temp_file):
                        os.unlink(temp_file)
                except Exception as e:
                    self.logger.error(f"Error cleaning up {temp_file}: {e}")

    async def detectMotion(
        self, frames: list[VideoFrameData], config: dict[str, Any] | None = None
    ) -> MotionDetectionPluginResponse | None:
        if not frames:
            return {"detected": False, "detections": []}

        cfg = config or {}
        detector_model = cfg.get("motion_detector", DEFAULT_MODEL)
        executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="OpenCV")

        previous_frame: np.ndarray[Any, Any] | None = None
        backSub = None
        all_detections: list[Detection] = []

        try:
            for frame in frames:
                width, height = frame["width"], frame["height"]
                gray: np.ndarray[Any, Any] = np.frombuffer(frame["data"], dtype=np.uint8).reshape(
                    (height, width)
                )

                dets: list[tuple[float, float, float, float]] = []

                if detector_model == "Frame Difference":
                    if previous_frame is None:
                        previous_frame = gray
                        continue
                    area = cfg.get("frame_difference_area", DEFAULT_AREA_FD)
                    dets = await asyncio.get_event_loop().run_in_executor(
                        executor, get_detections_fd, previous_frame, gray, area
                    )
                    previous_frame = gray

                elif detector_model == "Background Substraction":
                    if backSub is None:
                        backSub = cv2.createBackgroundSubtractorMOG2(varThreshold=18, detectShadows=False)
                    threshold = cfg.get("background_substraction_threshold", DEFAULT_THRESHOLD_BS)
                    area = cfg.get("background_substraction_area", DEFAULT_AREA_BS)
                    dets = await asyncio.get_event_loop().run_in_executor(
                        executor, get_detections_bs, gray, backSub, threshold, area
                    )

                else:
                    blur = cfg.get("default_blur", DEFAULT_BLUR)
                    if blur % 2 == 0:
                        blur += 1
                    gray = cv2.stackBlur(gray, (blur, blur))
                    if previous_frame is None:
                        previous_frame = gray
                        continue
                    threshold = cfg.get("default_threshold", DEFAULT_THRESHOLD)
                    area = cfg.get("default_area", DEFAULT_AREA)
                    dets = await asyncio.get_event_loop().run_in_executor(
                        executor, get_detections, previous_frame, gray, threshold, area
                    )
                    previous_frame = gray

                for x1, y1, x2, y2 in dets:
                    all_detections.append(
                        {
                            "label": "motion",
                            "confidence": 1.0,
                            "box": {
                                "x": x1 / width,
                                "y": y1 / height,
                                "width": (x2 - x1) / width,
                                "height": (y2 - y1) / height,
                            },
                        }
                    )
        finally:
            executor.shutdown(wait=False)

        return {"detected": len(all_detections) > 0, "detections": all_detections}


def __main__() -> type[OpenCV]:
    return OpenCV
