import { createSocket } from 'node:dgram';

import type { LoggerService } from '@camera.ui/sdk';
import type { RemoteInfo, Socket } from 'node:dgram';
import type { TapoDoorbellSensor } from './sensors/doorbell.js';

export class TapoDoorbellMonitor {
  private socket?: Socket;
  private sensors = new Set<TapoDoorbellSensor>();

  constructor(
    private readonly logger: LoggerService,
    private readonly getPort: () => number,
  ) {}

  async start(): Promise<void> {
    if (this.socket) return;

    const socket = createSocket({ type: 'udp4', reuseAddr: true });
    this.socket = socket;

    socket.on('message', (_message, remote) => this.handleMessage(remote));
    socket.on('error', (error) => {
      this.logger.error(`Tapo-Türklingel-Listener auf UDP ${this.getPort()} meldet einen Fehler:`, error);
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        socket.off('listening', onListening);
        this.socket = undefined;
        socket.close();
        reject(error);
      };
      const onListening = (): void => {
        socket.off('error', onError);
        resolve();
      };

      socket.once('error', onError);
      socket.once('listening', onListening);
      socket.bind({ address: '0.0.0.0', port: this.getPort(), exclusive: false });
    });

    this.logger.log(`Tapo-Türklingel-Listener hört auf UDP ${this.getPort()}`);
  }

  stop(): void {
    if (!this.socket) return;
    this.socket.close();
    this.socket = undefined;
  }

  async restart(): Promise<void> {
    this.stop();
    if (this.sensors.size > 0) {
      await this.start();
    }
  }

  add(sensor: TapoDoorbellSensor): void {
    this.sensors.add(sensor);
  }

  remove(sensor: TapoDoorbellSensor): void {
    this.sensors.delete(sensor);
  }

  get sensorCount(): number {
    return this.sensors.size;
  }

  private handleMessage(remote: RemoteInfo): void {
    let matched = 0;
    for (const sensor of this.sensors) {
      if (sensor.eventSourceAddress === remote.address) {
        sensor.trigger();
        matched++;
      }
    }

    if (matched > 0) {
      this.logger.debug(`Tapo-Klingelereignis von ${remote.address} ausgelöst (${matched} Sensoren)`);
    }
  }
}
