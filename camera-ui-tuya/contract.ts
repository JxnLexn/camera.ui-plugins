import { PluginInterface, PluginRole } from '@camera.ui/sdk';

import type { PluginContract } from '@camera.ui/sdk';

export const contract: PluginContract = {
  name: 'Tuya',
  role: PluginRole.CameraController,
  provides: [],
  consumes: [],
  interfaces: [PluginInterface.DiscoveryProvider],
};

export default contract;
