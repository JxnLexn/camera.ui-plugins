import { PluginInterface, PluginRole, SensorType } from '@camera.ui/sdk';

import type { PluginContract } from '@camera.ui/sdk';

export const contract: PluginContract = {
  name: 'OpenCL Motion',
  role: PluginRole.SensorProvider,
  provides: [SensorType.Motion],
  consumes: [],
  pythonVersion: '3.11',
  interfaces: [PluginInterface.MotionDetection],
};

export default contract;
