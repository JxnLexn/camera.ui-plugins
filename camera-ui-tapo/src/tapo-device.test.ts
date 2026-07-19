import { describe, expect, it } from 'vitest';

import { isTapoDiscoveryIdentity, isTapoDoorbellModel } from './tapo-device.js';

describe('Tapo-Geräteerkennung', () => {
  it.each(['D235', 'Tapo D235', 'TP-Link Tapo D235'])('erkennt %s als Türklingel', (model) => {
    expect(isTapoDoorbellModel(model)).toBe(true);
  });

  it.each(['Tapo C320WS', 'TP-Link C520WS', 'Kamera Tapo'])('akzeptiert %s bei der ONVIF-Erkennung', (identity) => {
    expect(isTapoDiscoveryIdentity(identity, identity)).toBe(true);
  });

  it('lehnt ein fremdes ONVIF-Gerät ab', () => {
    expect(isTapoDiscoveryIdentity('Garage', 'Reolink RLC-810A')).toBe(false);
  });
});
