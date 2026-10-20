import { ntpToMilliseconds } from '../utils/fmp4.js';

import type { CameraDevice, LoggerService } from '@camera.ui/sdk';
import type {
  BufferActivityCommandRequest,
  BufferUploadCommandRequest,
  CameraRecordingPublishingPointValue,
  CMAFClipRequest,
  CMAFError,
  CMAFRecordingDelegate,
  CMAFSegment,
} from '../hap.js';
import type { RecordingDelegate } from './recordingDelegate.js';

export class CmafRecordingDelegate implements CMAFRecordingDelegate {
  private readonly logPrefix = '[CMAF]';
  private logger: LoggerService;

  constructor(
    cameraDevice: CameraDevice,
    private recordingDelegate: RecordingDelegate,
  ) {
    this.logger = cameraDevice.logger;
  }

  public async *streamClip(request: CMAFClipRequest): AsyncGenerator<CMAFSegment> {
    const { command } = request;
    this.logger.log(this.logPrefix, `Clip upload ${command.sessionId} started`);
    this.logger.debug(this.logPrefix, `Upload command ${command.command}, start ${secondsAgo(command.start)}, stop ${secondsAgo(command.stop)}`);

    for await (const part of this.recordingDelegate.getClipStream({ start: command.start, stop: command.stop, signal: request.signal })) {
      if (part.type === 'init') {
        yield { type: 'init', data: part.data };
      } else {
        yield { type: 'media', data: part.data, duration: part.duration, last: part.last };
      }
    }
  }

  public handleUploadStop(request: BufferUploadCommandRequest): void {
    this.logger.debug(this.logPrefix, `Upload stop ${request.sessionId}, stop ${secondsAgo(request.stop)}, action ${request.stopAction ?? '-'}`);
  }

  public handleBufferActivity(request: BufferActivityCommandRequest): void {
    this.logger.debug(this.logPrefix, `Buffer activity ${request.activity}, start ${request.start}, duration ${request.duration}ms`);
  }

  public updateRecordingActive(active: boolean, audioActive: boolean): void {
    this.logger.debug(this.logPrefix, `Recording active: ${active}, audio: ${audioActive}`);
  }

  public updatePublishingPoint(publishingPoint: CameraRecordingPublishingPointValue | undefined): void {
    if (!publishingPoint) {
      this.logger.log(this.logPrefix, 'Publishing point cleared');
      return;
    }
    this.logger.log(this.logPrefix, `Publishing point set: ${new URL(publishingPoint.url).host}`);
  }

  public updateClientCertificate(installed: boolean): void {
    this.logger.log(this.logPrefix, installed ? 'Client certificate installed' : 'Client certificate cleared');
  }

  public handleUploadResult(cmafSessionId: bigint, error?: CMAFError, detail?: string): void {
    if (error === undefined) {
      this.logger.log(this.logPrefix, `CMAF session ${cmafSessionId} uploaded`);
    } else {
      this.logger.warn(this.logPrefix, `CMAF session ${cmafSessionId} failed: cmafError=${error}${detail ? ` ${detail}` : ''}`);
    }
  }
}

function secondsAgo(ntp?: bigint): string {
  return ntp === undefined ? '-' : `${((Date.now() - ntpToMilliseconds(ntp)) / 1000).toFixed(1)}s ago`;
}
