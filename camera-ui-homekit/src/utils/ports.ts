import { pickPort } from 'pick-port';

import type { Socket } from 'node:dgram';

export async function reservePorts({
  count = 1,
  type = 'udp',
  attemptNumber = 0,
}: {
  count?: number;
  type?: 'udp' | 'tcp';
  attemptNumber?: number;
} = {}): Promise<number[]> {
  if (attemptNumber > 100) {
    throw new Error('Failed to reserve ports after 100 tries');
  }

  const pickPortOptions = {
      type,
      reserveTimeout: 15, // seconds, HomeKit stream setup takes at most 15 s
    },
    port = await pickPort(pickPortOptions),
    ports = [port],
    tryAgain = () => {
      return reservePorts({
        count,
        type,
        attemptNumber: attemptNumber + 1,
      });
    };

  // ffmpeg takes the next port up by default, so the ports must be consecutive
  for (let i = 1; i < count; i++) {
    try {
      const targetConsecutivePort = port + i,
        openPort = await pickPort({
          ...pickPortOptions,
          minPort: targetConsecutivePort,
          maxPort: targetConsecutivePort,
        });

      ports.push(openPort);
    } catch {
      return tryAgain();
    }
  }

  return ports;
}

export function bindToPort(socket: Socket, address = '127.0.0.1'): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    socket.on('error', reject);

    socket.bind(0, address, () => {
      const { port } = socket.address();
      resolve(port);
    });
  });
}
