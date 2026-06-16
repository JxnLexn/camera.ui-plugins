import { MotionSensor } from '@camera.ui/sdk';

import type { CameraDevice } from '@camera.ui/sdk';
import type { MotionEventData } from '@seydx/onvif';

export class OnvifMotionSensor extends MotionSensor {
  private cameraDevice: CameraDevice;

  constructor(cameraDevice: CameraDevice, name = 'ONVIF Motion') {
    super(name);

    this.cameraDevice = cameraDevice;
  }

  handleMotion(data: MotionEventData): void {
    this.reportDetections(data.isMotion);
  }
}
