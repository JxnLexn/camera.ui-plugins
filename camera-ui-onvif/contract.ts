import { PluginInterface, PluginRole, SensorType } from '@camera.ui/sdk';

import type { PluginContract } from '@camera.ui/sdk';

export const contract: PluginContract = {
  name: 'Onvif',
  role: PluginRole.CameraAndSensorProvider,
  provides: [SensorType.PTZ, SensorType.Motion, SensorType.Object, SensorType.Audio, SensorType.Face],
  consumes: [],
  interfaces: [PluginInterface.DiscoveryProvider],
};

export default contract;
