import { createSocket } from 'node:dgram';
import { afterEach, describe, expect, it } from 'vitest';

import { TapoDoorbellMonitor } from './doorbell-monitor.js';

import type { LoggerService } from '@camera.ui/sdk';
import type { TapoDoorbellSensor } from './sensors/doorbell.js';

const logger = {
  log: () => undefined,
  debug: () => undefined,
  error: () => undefined,
} as unknown as LoggerService;

const monitors: TapoDoorbellMonitor[] = [];

afterEach(() => {
  for (const monitor of monitors) monitor.stop();
  monitors.length = 0;
});

describe('TapoDoorbellMonitor', () => {
  it('löst nur den Sensor mit passender Ereignisquellenadresse aus', async () => {
    const port = 30_000 + Math.floor(Math.random() * 10_000);
    const monitor = new TapoDoorbellMonitor(logger, () => port);
    monitors.push(monitor);

    let matchingTriggers = 0;
    let foreignTriggers = 0;
    monitor.add({ eventSourceAddress: '127.0.0.1', trigger: () => matchingTriggers++ } as unknown as TapoDoorbellSensor);
    monitor.add({ eventSourceAddress: '192.0.2.1', trigger: () => foreignTriggers++ } as unknown as TapoDoorbellSensor);
    await monitor.start();

    const sender = createSocket('udp4');
    await new Promise<void>((resolve, reject) => {
      sender.send(Buffer.from('ring'), port, '127.0.0.1', (error) => {
        sender.close();
        if (error) reject(error);
        else resolve();
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(matchingTriggers).toBe(1);
    expect(foreignTriggers).toBe(0);
  });
});
