import { AudioSensor } from '@camera.ui/sdk';

import type { CameraDevice } from '@camera.ui/sdk';
import type { AudioEventData } from '@seydx/onvif';

export class OnvifAudioSensor extends AudioSensor {
  private cameraDevice: CameraDevice;

  constructor(cameraDevice: CameraDevice, name = 'ONVIF Audio') {
    super(name);

    this.cameraDevice = cameraDevice;
  }

  handleAudio(data: AudioEventData): void {
    this.reportDetections(data.isAudioDetected);

    // Update decibel level if provided
    if (data.level !== undefined) {
      this.setDecibels(data.level);
    }
  }
}
