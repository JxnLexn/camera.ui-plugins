import { PluginInterface, PluginRole, SensorType } from '@camera.ui/sdk';

import type { PluginContract } from '@camera.ui/sdk';

export const contract: PluginContract = {
  name: 'Wyze',
  role: PluginRole.CameraController,
  provides: [SensorType.Motion],
  consumes: [],
  interfaces: [PluginInterface.DiscoveryProvider],
};

export default contract;
