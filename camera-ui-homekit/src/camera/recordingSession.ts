import { EventEmitter } from 'node:events';

import { PromiseTimeout } from '../utils/utils.js';

import type { CameraDevice, Fmp4Session, LoggerService } from '@camera.ui/sdk';
import type { CameraRecordingConfiguration } from '../hap.js';
import type { CameraAccessory } from './accessory.js';

export class RecordingSession extends EventEmitter {
  private readonly logPrefix = '[HKSV]';

  private session?: Fmp4Session;
  private configuration?: CameraRecordingConfiguration;

  private recordingActive = false;
  private activeRecording = false;

  private abortController?: AbortController;
  private fragmentTimeout = 8000;

  constructor(
    private cameraAccessory: CameraAccessory,
    private cameraDevice: CameraDevice,
    private logger: LoggerService,
  ) {
    super();
  }

  public updateRecordingActive(active: boolean): void {
    this.recordingActive = active;
    this.logger.debug(this.logPrefix, `Recording active: ${active}`);
  }

  public updateRecordingConfiguration(configuration?: CameraRecordingConfiguration): void {
    this.configuration = configuration;
    this.logger.debug(this.logPrefix, 'Recording configuration updated:', configuration ?? 'No configuration');
  }

  public async *getRecordingStream(): AsyncGenerator<Buffer, void> {
    if (!this.configuration) {
      throw new Error('No recording configuration set');
    }

    this.activeRecording = true;
    this.abortController = new AbortController();

    try {
      await this.ensureSessionStarted();

      const session = this.session;
      if (!session) {
        throw new Error('FMP4 session unavailable');
      }

      this.logger.debug(this.logPrefix, 'Yielding init segment');
      const initSegment = await PromiseTimeout(session.initSegment, this.fragmentTimeout, undefined, 'Init segment timeout');
      yield initSegment;

      this.logger.debug(this.logPrefix, 'Yielding live fragments');
      const iterator = session.streamBoxes(this.abortController.signal);

      while (!this.abortController.signal.aborted) {
        const result = await PromiseTimeout(iterator.next(), this.fragmentTimeout, undefined, 'Fragment timeout');
        if (result.done) {
          break;
        }

        yield result.value;
      }
    } catch (error) {
      if (this.abortController.signal.aborted) {
        this.logger.debug(this.logPrefix, 'Recording stream aborted');
        return;
      }

      this.logger.error(this.logPrefix, 'Error in recording stream:', error);
      throw error;
    } finally {
      this.activeRecording = false;
      this.abortController = undefined;
    }
  }

  public stop(): void {
    this.abortController?.abort();
    this.activeRecording = false;

    const session = this.session;
    if (session) {
      this.session = undefined;
      this.logger.debug(this.logPrefix, 'Stopping FMP4 session');
      session.stop().catch((error) => {
        this.logger.error(this.logPrefix, 'Error stopping FMP4 session:', error);
      });
    }
  }

  private async ensureSessionStarted(): Promise<void> {
    if (this.session) {
      return;
    }

    this.logger.debug(this.logPrefix, 'Starting FMP4 session');

    if (!this.cameraDevice.streamSource.prebuffer) {
      this.logger.warn(this.logPrefix, `Prebuffering is not enabled for source "${this.cameraDevice.streamSource.name}", recording may miss moments before the trigger!`);
    }

    this.session = this.cameraDevice.streamSource.createFmp4Session({
      audio: true,
      video: true,
      backchannel: false,
      gop: false,
      prebuffer: this.cameraDevice.streamSource.prebuffer,
    });

    this.session.onEnded.subscribe(() => {
      this.logger.debug(this.logPrefix, 'FMP4 session ended; discarding');
      this.session = undefined;
      this.emit('session-ended');
    });

    await this.session.startStream({
      supportedVideoCodecs: ['h264'],
      supportedAudioCodecs: ['aac'],
      boxMode: true,
      fragDuration: (this.configuration?.mediaContainerConfiguration?.fragmentLength ?? 4000) * 1000, // in microseconds
      hardware: this.cameraAccessory.cameraStorage.values.useHardwareAcceleration ? 'auto' : undefined,
      video: {
        width: this.configuration?.videoCodec.resolution[0],
        height: this.configuration?.videoCodec.resolution[1],
        fps: this.configuration?.videoCodec.resolution[2],
      },
    });

    this.logger.debug(this.logPrefix, 'FMP4 session started');
  }
}
