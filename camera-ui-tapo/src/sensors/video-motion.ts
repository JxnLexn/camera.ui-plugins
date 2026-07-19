import { MotionDetectorSensor } from '@camera.ui/sdk';

import type { JsonSchema, MotionResult, VideoFrameData } from '@camera.ui/sdk';

interface TapoVideoMotionStorageValues {
  pixelDifference: number;
  changedPixels: number;
  sampleStep: number;
}

export class TapoVideoMotionSensor extends MotionDetectorSensor<TapoVideoMotionStorageValues> {
  private previousFrame?: Uint8Array;
  private previousWidth = 0;
  private previousHeight = 0;
  private previousFormat?: VideoFrameData['format'];

  constructor() {
    super('Tapo-Videobewegung');
  }

  override get storageSchema(): JsonSchema[] {
    return [
      {
        type: 'number',
        key: 'pixelDifference',
        title: 'Pixelunterschied',
        description: 'Minimale Helligkeitsänderung eines Pixels, damit es als verändert zählt.',
        defaultValue: 24,
        minimum: 1,
        maximum: 255,
        step: 1,
        store: true,
        required: true,
        onSet: async () => this.reset(),
      },
      {
        type: 'number',
        key: 'changedPixels',
        title: 'Veränderte Pixel',
        description: 'Mindestanteil veränderter Bildpunkte in Prozent, der eine Bewegung auslöst.',
        defaultValue: 2,
        minimum: 0.1,
        maximum: 100,
        step: 0.1,
        store: true,
        required: true,
        onSet: async () => this.reset(),
      },
      {
        type: 'number',
        key: 'sampleStep',
        title: 'Abtastschritt',
        description: 'Nur jeder n-te Pixel wird geprüft. Höhere Werte reduzieren die Prozessorlast.',
        defaultValue: 4,
        minimum: 1,
        maximum: 16,
        step: 1,
        store: true,
        required: true,
        onSet: async () => this.reset(),
      },
    ];
  }

  async detectMotion(frame: VideoFrameData): Promise<MotionResult> {
    const luminance = this.toLuminance(frame);
    const compatible = this.previousFrame && this.previousWidth === frame.width && this.previousHeight === frame.height && this.previousFormat === frame.format;

    if (!compatible) {
      this.remember(frame, luminance);
      return { detected: false, detections: [] };
    }

    const threshold = this.storage.values.pixelDifference ?? 24;
    const requiredPercentage = this.storage.values.changedPixels ?? 2;
    const step = Math.max(1, Math.round(this.storage.values.sampleStep ?? 4));
    let samples = 0;
    let changed = 0;

    for (let index = 0; index < luminance.length; index += step) {
      samples++;
      if (Math.abs(luminance[index] - this.previousFrame![index]) >= threshold) {
        changed++;
      }
    }

    this.remember(frame, luminance);
    const percentage = samples === 0 ? 0 : (changed / samples) * 100;
    const detected = percentage >= requiredPercentage;

    return {
      detected,
      detections: detected
        ? [
            {
              label: 'motion',
              confidence: Math.min(1, percentage / Math.max(requiredPercentage, 0.1)),
              box: { x: 0, y: 0, width: 1, height: 1 },
            },
          ]
        : [],
    };
  }

  private toLuminance(frame: VideoFrameData): Uint8Array {
    const data = frame.data instanceof Uint8Array ? frame.data : new Uint8Array(frame.data);
    const pixelCount = frame.width * frame.height;

    if (frame.format === 'gray' || frame.format === 'nv12') {
      return Uint8Array.from(data.subarray(0, pixelCount));
    }

    const channels = frame.format === 'rgba' ? 4 : 3;
    const luminance = new Uint8Array(pixelCount);
    for (let pixel = 0, offset = 0; pixel < pixelCount && offset + 2 < data.length; pixel++, offset += channels) {
      luminance[pixel] = Math.round(data[offset] * 0.299 + data[offset + 1] * 0.587 + data[offset + 2] * 0.114);
    }
    return luminance;
  }

  private remember(frame: VideoFrameData, luminance: Uint8Array): void {
    this.previousFrame = luminance;
    this.previousWidth = frame.width;
    this.previousHeight = frame.height;
    this.previousFormat = frame.format;
  }

  private reset(): void {
    this.previousFrame = undefined;
    this.previousWidth = 0;
    this.previousHeight = 0;
    this.previousFormat = undefined;
  }
}
