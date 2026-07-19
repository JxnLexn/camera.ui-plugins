import { DoorbellTrigger } from '@camera.ui/sdk';

import type { JsonSchema } from '@camera.ui/sdk';

export interface TapoDoorbellStorageValues {
  eventSourceAddress: string;
}

export class TapoDoorbellSensor extends DoorbellTrigger<TapoDoorbellStorageValues> {
  constructor(
    private readonly onAddressChanged: () => void,
    private readonly getDefaultAddress: () => string | undefined,
  ) {
    super('Tapo-Türklingel');
  }

  override get storageSchema(): JsonSchema[] {
    return [
      {
        type: 'string',
        format: 'ipv4',
        key: 'eventSourceAddress',
        title: 'H200-/Türklingel-Adresse',
        description: 'IPv4-Adresse des H200 oder einer eigenständigen Tapo-Türklingel, die Klingelereignisse über UDP sendet.',
        store: true,
        required: false,
        onSet: async () => {
          this.onAddressChanged();
        },
      },
    ];
  }

  get eventSourceAddress(): string | undefined {
    const address = this.storage.values.eventSourceAddress?.trim();
    return address || this.getDefaultAddress();
  }
}
