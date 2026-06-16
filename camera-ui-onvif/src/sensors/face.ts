import { FaceSensor } from '@camera.ui/sdk';

import type { CameraDevice } from '@camera.ui/sdk';
import type { DetectionEventData } from '@seydx/onvif';

export class OnvifFaceSensor extends FaceSensor {
  private cameraDevice: CameraDevice;

  constructor(cameraDevice: CameraDevice, name = 'ONVIF Face') {
    super(name);

    this.cameraDevice = cameraDevice;
  }

  handleDetection(data: DetectionEventData): void {
    this.reportDetections(data.isDetected);
  }
}
