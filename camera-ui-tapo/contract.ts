import { PluginInterface, PluginRole, SensorType } from '@camera.ui/sdk';

import type { PluginContract } from '@camera.ui/sdk';

export const contract: PluginContract = {
  name: 'TP-Link Tapo',
  role: PluginRole.CameraAndSensorProvider,
  provides: [SensorType.PTZ, SensorType.Motion, SensorType.Object, SensorType.Audio, SensorType.Face, SensorType.Doorbell],
  consumes: [],
  interfaces: [PluginInterface.DiscoveryProvider],
};

export default contract;
