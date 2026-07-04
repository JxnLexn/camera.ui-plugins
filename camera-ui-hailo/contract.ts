import { PluginInterface, PluginRole, SensorType } from '@camera.ui/sdk';

import type { PluginContract } from '@camera.ui/sdk';

export const contract: PluginContract = {
  name: 'Hailo',
  role: PluginRole.SensorProvider,
  provides: [SensorType.Object],
  consumes: [],
  pythonVersion: '3.11',
  interfaces: [
    PluginInterface.ObjectDetection,
  ],
};

export default contract;
