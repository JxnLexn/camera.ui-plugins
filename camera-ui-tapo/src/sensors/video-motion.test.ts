import { beforeEach, describe, expect, it } from 'vitest';

import { TapoVideoMotionSensor } from './video-motion.js';

import type { DeviceStorage, VideoFrameData } from '@camera.ui/sdk';

describe('TapoVideoMotionSensor', () => {
  let sensor: TapoVideoMotionSensor;

  beforeEach(() => {
    sensor = new TapoVideoMotionSensor();
    sensor._setStorage({ values: { pixelDifference: 20, changedPixels: 25, sampleStep: 1 } } as unknown as DeviceStorage);
  });

  it('verwendet das erste Bild nur als Referenz', async () => {
    const result = await sensor.detectMotion(frame([0, 0, 0, 0]));
    expect(result.detected).toBe(false);
  });

  it('meldet eine ausreichend große Bildänderung', async () => {
    await sensor.detectMotion(frame([0, 0, 0, 0]));
    const result = await sensor.detectMotion(frame([255, 255, 0, 0]));
    expect(result.detected).toBe(true);
    expect(result.detections).toHaveLength(1);
  });

  it('ignoriert Änderungen unterhalb des Schwellwerts', async () => {
    await sensor.detectMotion(frame([0, 0, 0, 0]));
    const result = await sensor.detectMotion(frame([10, 10, 10, 10]));
    expect(result.detected).toBe(false);
  });
});

function frame(values: number[]): VideoFrameData {
  return {
    id: crypto.randomUUID(),
    data: Uint8Array.from(values),
    width: 2,
    height: 2,
    format: 'gray',
  };
}
