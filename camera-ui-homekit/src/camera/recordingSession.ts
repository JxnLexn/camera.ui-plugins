import { EventEmitter } from 'node:events';

import { fragmentDuration, normalizeFragmentTfdt, ntpToMilliseconds, prependProducerReferenceTime, trackTimings } from '../utils/fmp4.js';

import type { CameraDevice, Fmp4Session, Fmp4VideoInfo, LoggerService } from '@camera.ui/sdk';
import type { CameraRecordingConfiguration } from '../hap.js';
import type { TrackTiming } from '../utils/fmp4.js';
import type { CameraAccessory } from './accessory.js';

interface LiveConsumer {
  queue: Buffer[];
  resolve: ((box: Buffer | null) => void) | null;
  error?: Error;
  closed?: boolean;
}

export interface RecordingAudio {
  codec: 'aac' | 'opus';
  bitrate?: number;
}

export interface RecordingSessionOptions {
  logPrefix: string;
  audio: RecordingAudio;
  minPrebuffer?: number;
}

export interface ClipStreamOptions {
  start?: bigint;
  stop?: bigint;
  signal?: AbortSignal;
}

export type ClipPart = { type: 'init'; data: Buffer; videoInfo: Fmp4VideoInfo | undefined } | { type: 'fragment'; data: Buffer; duration: number; last: boolean };

class FragmentTimeoutError extends Error {}

export class RecordingSession extends EventEmitter {
  private static readonly maxLiveQueueFragments = 8;

  private readonly logPrefix: string;
  private readonly fragmentTimeout = 8000;
  private readonly sessionStallTimeout = 24_000; // healthy sources go quiet for up to about 22 s
  private readonly sessionRestartDelay = 3000;
  private readonly maxSessionRestartDelay = 60_000;

  private session?: Fmp4Session;
  private sessionSubscriptions: { unsubscribe(): void }[] = [];
  private lastDeliveryAt = 0;
  private restartAttempts = 0;
  private configuration?: CameraRecordingConfiguration;

  private recordingActive = false;
  private stopped = false;
  private deferred = false;
  private lifecycle = Promise.resolve();
  private lifecycleRevision = 0;

  private prebuffer: Buffer[] = [];
  private fragmentTimes = new WeakMap<Buffer, { end: number; duration: number }>();
  private trackTimings?: Map<number, TrackTiming>;
  private collectAbort?: AbortController;
  private restartTimeout?: NodeJS.Timeout;

  private consumers = new Set<LiveConsumer>();
  private hdsConsumer?: LiveConsumer;
  private demandConsumers = 0;

  constructor(
    private cameraAccessory: CameraAccessory,
    private cameraDevice: CameraDevice,
    private logger: LoggerService,
    private options: RecordingSessionOptions,
  ) {
    super();
    this.logPrefix = options.logPrefix;
  }

  public updateRecordingActive(active: boolean): void {
    this.logger.debug(this.logPrefix, `Recording active: ${active}`);
    if (this.recordingActive === active) {
      return;
    }
    this.recordingActive = active;

    if (active) {
      this.restartPrebuffer();
    } else {
      this.stopPrebuffer();
    }
  }

  public refreshPrebuffer(): void {
    if (this.recordingActive && !this.stopped) {
      this.restartPrebuffer();
    }
  }

  public resumePrebuffer(): void {
    if (this.recordingActive && !this.stopped && this.deferred) {
      this.restartPrebuffer();
    }
  }

  public updateRecordingConfiguration(configuration?: CameraRecordingConfiguration): void {
    this.configuration = configuration;
    this.logger.debug(this.logPrefix, 'Recording configuration updated:', configuration ?? 'No configuration');

    if (this.recordingActive) {
      this.restartPrebuffer();
    }
  }

  public async *getRecordingStream(signal?: AbortSignal): AsyncGenerator<Buffer, void> {
    if (!this.configuration) {
      throw new Error('No recording configuration set');
    }

    const session = await this.acquireSession();
    const tfdtOffsets = new Map<number, bigint>();
    const buffered = this.hubPrebuffer();
    const consumer = this.addConsumer();
    this.hdsConsumer = consumer;

    try {
      this.logger.debug(this.logPrefix, 'Yielding init segment');
      const initSegment = await this.waitForRecording(session.initSegment, signal, () => new Error('Init segment timeout'));
      const sampleEntry = ['hvc1', 'hev1', 'avc1', 'avc3'].find((tag) => initSegment.includes(tag)) ?? 'unknown';
      this.logger.debug(this.logPrefix, `Init segment ${initSegment.length} bytes, sample entry ${sampleEntry}`);
      yield initSegment;

      if (buffered.length > 0) {
        this.logger.debug(this.logPrefix, `Yielding ${buffered.length} prebuffered fragments`);
        for (const fragment of buffered) {
          if (signal?.aborted) {
            return;
          }
          yield this.prepareFragment(fragment, tfdtOffsets);
        }
      }

      this.logger.debug(this.logPrefix, 'Yielding live fragments');
      for await (const box of this.liveFragments(consumer, signal)) {
        yield this.prepareFragment(box, tfdtOffsets);
      }
    } catch (error) {
      if (signal?.aborted) {
        this.logger.debug(this.logPrefix, 'Recording stream aborted');
        return;
      }

      this.checkFragmentTimeout(session, error);
      this.logger.error(this.logPrefix, 'Error in recording stream:', error);
      throw error;
    } finally {
      this.removeConsumer(consumer);
      if (this.hdsConsumer === consumer) {
        this.hdsConsumer = undefined;
      }
      await this.releaseSession(session);
    }
  }

  public async *getClipStream(options: ClipStreamOptions): AsyncGenerator<ClipPart, void> {
    const session = await this.acquireSession();
    const { signal } = options;
    const startMs = options.start === undefined ? 0 : ntpToMilliseconds(options.start);
    const stopMs = options.stop === undefined ? Infinity : ntpToMilliseconds(options.stop);
    const tfdtOffsets = new Map<number, bigint>();
    const buffered = this.prebuffer.filter((fragment) => this.fragmentEnd(fragment) > startMs);
    const consumer = this.addConsumer();

    if (options.start !== undefined) {
      const reach = this.prebuffer.length > 0 ? `${((Date.now() - this.fragmentStart(this.prebuffer[0])) / 1000).toFixed(1)}s` : 'nothing';
      this.logger.debug(this.logPrefix, `Clip starts ${((Date.now() - startMs) / 1000).toFixed(1)}s back, prebuffer reaches back ${reach}`);
    }

    try {
      const initSegment = await this.waitForRecording(session.initSegment, signal, () => new Error('Init segment timeout'));
      yield { type: 'init', data: initSegment, videoInfo: session.videoInfo };

      for (const fragment of buffered) {
        if (signal?.aborted) {
          return;
        }
        const last = this.fragmentEnd(fragment) >= stopMs;
        yield { type: 'fragment', data: this.clipFragment(fragment, tfdtOffsets), duration: this.durationOf(fragment) / 1000, last };
        if (last) {
          return;
        }
      }

      for await (const box of this.liveFragments(consumer, signal)) {
        if (this.fragmentStart(box) >= stopMs) {
          return;
        }
        const last = this.fragmentEnd(box) >= stopMs;
        yield { type: 'fragment', data: this.clipFragment(box, tfdtOffsets), duration: this.durationOf(box) / 1000, last };
        if (last) {
          return;
        }
      }
    } catch (error) {
      this.checkFragmentTimeout(session, error);
      throw error;
    } finally {
      this.removeConsumer(consumer);
      await this.releaseSession(session);
    }
  }

  public closeCurrentRecording(): void {
    const consumer = this.hdsConsumer;
    this.hdsConsumer = undefined;
    if (consumer) {
      this.closeConsumer(consumer);
    }
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    this.recordingActive = false;
    await this.stopPrebuffer();
  }

  private stopPrebuffer(): Promise<void> {
    ++this.lifecycleRevision;
    this.deferred = false;
    this.restartAttempts = 0;
    this.clearRestart();
    this.closeConsumers();
    this.collectAbort?.abort();
    this.prebuffer = [];

    return this.enqueueLifecycle(() => this.stopSession());
  }

  private restartPrebuffer(): void {
    const revision = ++this.lifecycleRevision;
    this.clearRestart();
    this.closeConsumers();
    this.collectAbort?.abort();
    this.prebuffer = [];

    this.enqueueLifecycle(async () => {
      await this.stopSession();

      if (revision !== this.lifecycleRevision || this.stopped || !this.recordingActive || !this.configuration) {
        return;
      }

      if (!this.keepsConnection()) {
        this.logger.debug(this.logPrefix, 'Hot mode is off, recordings open the stream on demand');
        this.deferred = false;
        return;
      }

      if (this.cameraDevice.disabled || !this.cameraDevice.connected) {
        this.logger.debug(this.logPrefix, 'Camera unavailable, prebuffer deferred');
        this.deferred = true;
        return;
      }

      try {
        const session = await this.startSession();
        if (revision !== this.lifecycleRevision || this.stopped || !this.recordingActive) {
          await this.stopSession(session);
          return;
        }
        this.startCollector(session);
        this.deferred = false;
      } catch (error) {
        this.logger.error(this.logPrefix, 'Failed to start prebuffer session:', error);
        this.deferred = true;
        await this.stopSession();
        this.scheduleRestart();
      }
    });
  }

  private enqueueLifecycle(task: () => Promise<void>): Promise<void> {
    const next = this.lifecycle.then(task, task);
    this.lifecycle = next.catch((error) => {
      this.logger.error(this.logPrefix, 'Session lifecycle error:', error);
    });
    return next;
  }

  private keepsConnection(): boolean {
    return this.cameraDevice.streamSource.hotMode !== false;
  }

  private async acquireSession(): Promise<Fmp4Session> {
    if (this.keepsConnection()) {
      if (!this.session) {
        throw new Error('FMP4 session unavailable');
      }
      return this.session;
    }

    let session: Fmp4Session | undefined;
    await this.enqueueLifecycle(async () => {
      if (!this.session) {
        try {
          this.startCollector(await this.startSession());
        } catch (error) {
          await this.stopSession();
          throw error;
        }
      }
      this.demandConsumers++;
      session = this.session;
    });

    if (!session) {
      throw new Error('FMP4 session unavailable');
    }
    return session;
  }

  private async releaseSession(session: Fmp4Session): Promise<void> {
    if (this.keepsConnection() || this.session !== session) {
      return;
    }

    this.demandConsumers = Math.max(0, this.demandConsumers - 1);
    await this.enqueueLifecycle(async () => {
      if (this.demandConsumers === 0) {
        await this.stopSession(session);
      }
    });
  }

  private async startSession(): Promise<Fmp4Session> {
    this.logger.debug(this.logPrefix, 'Starting FMP4 session');

    const session = this.cameraDevice.streamSource.createFmp4Session({
      audio: true,
      video: true,
      backchannel: false,
      gop: false,
    });

    this.session = session;
    this.lastDeliveryAt = Date.now();
    this.sessionSubscriptions = [
      session.onStarted.subscribe(() => {
        this.lastDeliveryAt = Date.now();
      }),
      session.onError.subscribe((error) => {
        this.logger.warn(this.logPrefix, 'FMP4 session error:', error.message);
        this.handleSessionLost(session);
      }),
      session.onEnded.subscribe(() => {
        this.logger.debug(this.logPrefix, 'FMP4 session ended');
        this.emit('session-ended');
        this.handleSessionLost(session);
      }),
    ];

    await session.startStream({
      supportedVideoCodecs: this.cameraAccessory.secureVideoCodec === 'hevc' ? ['h264', 'hevc'] : ['h264'],
      supportedAudioCodecs: [this.options.audio.codec],
      boxMode: true,
      fragDuration: this.fragmentLength() * 1000,
      hardware: this.cameraAccessory.cameraStorage.values.useHardwareAccelerationForRecording ? 'auto' : undefined,
      video: {
        width: this.configuration?.videoCodec.resolution[0],
        height: this.configuration?.videoCodec.resolution[1],
        fps: this.configuration?.videoCodec.resolution[2],
        bitrate: this.configuration?.videoCodec.parameters.bitRate ? this.configuration.videoCodec.parameters.bitRate * 1000 : undefined,
        transcode: this.cameraAccessory.cameraStorage.values.alwaysTranscodeForRecording,
      },
      audio: this.options.audio.bitrate ? { encoderOptions: { b: this.options.audio.bitrate } } : undefined,
    });

    this.logger.debug(this.logPrefix, 'FMP4 session started');
    return session;
  }

  private startCollector(session: Fmp4Session): void {
    const abort = new AbortController();
    this.collectAbort = abort;
    this.trackTimings = undefined;
    session.initSegment
      .then((init) => {
        if (this.session === session) {
          this.trackTimings = trackTimings(init);
        }
      })
      .catch(() => undefined);

    this.collectBoxes(session, abort);
  }

  private async collectBoxes(session: Fmp4Session, abort: AbortController): Promise<void> {
    try {
      for await (const box of session.streamBoxes(abort.signal)) {
        this.pushBox(box);
      }
    } catch (error) {
      if (!abort.signal.aborted) {
        this.logger.error(this.logPrefix, 'Prebuffer collection error:', error);
      }
    } finally {
      if (this.collectAbort === abort) {
        this.collectAbort = undefined;
        await this.handleSessionLost(session);
      }
    }
  }

  private handleSessionLost(session: Fmp4Session): Promise<void> {
    // a restart or stop since the loss replaced the session, do not kill the successor
    const revision = this.lifecycleRevision;
    return this.enqueueLifecycle(async () => {
      if (revision !== this.lifecycleRevision || this.session !== session) {
        return;
      }

      await this.stopSession(session);
      if (this.recordingActive && !this.stopped && this.keepsConnection()) {
        this.deferred = true;
      }
      this.scheduleRestart();
    });
  }

  private checkFragmentTimeout(session: Fmp4Session, error: unknown): void {
    if (!(error instanceof FragmentTimeoutError) || this.session !== session) {
      return;
    }

    // one short gap times out all concurrent recordings, so judge the session's silence
    const silentMs = Date.now() - this.lastDeliveryAt;
    if (silentMs < this.sessionStallTimeout) {
      return;
    }

    this.logger.warn(this.logPrefix, `FMP4 session delivered no fragments for ${Math.round(silentMs / 1000)}s, restarting it`);
    this.handleSessionLost(session);
  }

  private async stopSession(expectedSession?: Fmp4Session): Promise<void> {
    const session = this.session;
    if (!session || (expectedSession && session !== expectedSession)) {
      return;
    }

    this.session = undefined;
    this.demandConsumers = 0;
    this.prebuffer = [];
    this.collectAbort?.abort();
    this.collectAbort = undefined;
    this.sessionSubscriptions.forEach((subscription) => subscription.unsubscribe());
    this.sessionSubscriptions = [];

    this.logger.debug(this.logPrefix, 'Stopping FMP4 session');
    try {
      await session.stop();
    } catch (error) {
      this.logger.error(this.logPrefix, 'Error stopping FMP4 session:', error);
    }
  }

  private scheduleRestart(): void {
    if (this.stopped || !this.recordingActive || this.restartTimeout || !this.keepsConnection()) {
      return;
    }

    const delay = Math.min(this.sessionRestartDelay * 2 ** this.restartAttempts, this.maxSessionRestartDelay);
    this.restartAttempts++;
    this.logger.debug(this.logPrefix, `Restarting the FMP4 session in ${delay / 1000}s`);
    this.restartTimeout = setTimeout(() => {
      this.restartTimeout = undefined;
      if (this.recordingActive && !this.stopped) {
        this.restartPrebuffer();
      }
    }, delay);
  }

  private clearRestart(): void {
    if (this.restartTimeout) {
      clearTimeout(this.restartTimeout);
      this.restartTimeout = undefined;
    }
  }

  private prepareFragment(fragment: Buffer, tfdtOffsets: Map<number, bigint>): Buffer {
    const normalized = normalizeFragmentTfdt(fragment, tfdtOffsets);
    if (this.cameraAccessory.secureVideoCodec !== 'hevc') {
      return normalized;
    }

    return prependProducerReferenceTime(normalized, this.fragmentStart(fragment));
  }

  private clipFragment(fragment: Buffer, tfdtOffsets: Map<number, bigint>): Buffer {
    return prependProducerReferenceTime(normalizeFragmentTfdt(fragment, tfdtOffsets), this.fragmentStart(fragment));
  }

  private fragmentLength(): number {
    return this.configuration?.mediaContainerConfiguration?.fragmentLength ?? 4000;
  }

  private durationOf(fragment: Buffer): number {
    return this.fragmentTimes.get(fragment)?.duration ?? this.fragmentLength();
  }

  private fragmentEnd(fragment: Buffer): number {
    return this.fragmentTimes.get(fragment)?.end ?? Date.now();
  }

  private fragmentStart(fragment: Buffer): number {
    return this.fragmentEnd(fragment) - this.durationOf(fragment);
  }

  private prebufferLength(): number {
    return this.configuration?.prebufferLength ?? 4000;
  }

  private prebufferWindow(): number {
    return Math.max(this.prebufferLength(), this.options.minPrebuffer ?? 0);
  }

  private hubPrebuffer(): Buffer[] {
    return this.prebuffer.slice(this.firstFragmentCovering(Date.now() - this.prebufferLength()));
  }

  private firstFragmentCovering(since: number): number {
    let first = 0;
    while (first < this.prebuffer.length - 1 && this.fragmentStart(this.prebuffer[first + 1]) <= since) {
      first++;
    }
    return first;
  }

  private async *liveFragments(consumer: LiveConsumer, signal?: AbortSignal): AsyncGenerator<Buffer, void> {
    while (!signal?.aborted && !consumer.closed) {
      if (consumer.error) {
        throw new Error(consumer.error.message, { cause: consumer.error });
      }

      let box: Buffer | null;
      if (consumer.queue.length > 0) {
        box = consumer.queue.shift()!;
      } else {
        box = await this.waitForRecording(
          new Promise<Buffer | null>((resolve) => {
            consumer.resolve = resolve;
          }),
          signal,
          () => new FragmentTimeoutError('Fragment timeout'),
        );
      }

      if (box === null) {
        return;
      }
      yield box;
    }
  }

  private addConsumer(): LiveConsumer {
    const consumer: LiveConsumer = { queue: [], resolve: null };
    this.consumers.add(consumer);
    return consumer;
  }

  private removeConsumer(consumer: LiveConsumer): void {
    this.consumers.delete(consumer);
  }

  private closeConsumer(consumer: LiveConsumer): void {
    this.consumers.delete(consumer);
    consumer.closed = true;
    const resolve = consumer.resolve;
    consumer.resolve = null;
    resolve?.(null);
  }

  private closeConsumers(): void {
    this.hdsConsumer = undefined;
    for (const consumer of [...this.consumers]) {
      this.closeConsumer(consumer);
    }
  }

  private pushBox(box: Buffer): void {
    this.lastDeliveryAt = Date.now();
    this.restartAttempts = 0;
    let duration: number | undefined;
    try {
      duration = this.trackTimings && fragmentDuration(box, this.trackTimings);
    } catch {
      // malformed fragment
    }
    this.fragmentTimes.set(box, { end: this.lastDeliveryAt, duration: duration ?? this.fragmentLength() });

    this.prebuffer.push(box);
    this.prebuffer.splice(0, this.firstFragmentCovering(this.lastDeliveryAt - this.prebufferWindow()));

    for (const consumer of this.consumers) {
      if (consumer.resolve) {
        const resolve = consumer.resolve;
        consumer.resolve = null;
        resolve(box);
      } else if (consumer.queue.length >= RecordingSession.maxLiveQueueFragments) {
        consumer.error = new Error(`HKSV consumer too slow: recording ended after ${RecordingSession.maxLiveQueueFragments} queued fragments`);
        consumer.queue.length = 0;
      } else {
        consumer.queue.push(box);
      }
    }
  }

  private async waitForRecording<T>(promise: Promise<T>, signal: AbortSignal | undefined, timeoutError: () => Error): Promise<T> {
    if (signal?.aborted) {
      throw new Error('Recording stream aborted');
    }

    let timeoutId: NodeJS.Timeout | undefined;
    let abortHandler: (() => void) | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(timeoutError()), this.fragmentTimeout);
    });
    const aborted = new Promise<never>((_, reject) => {
      if (signal) {
        abortHandler = () => reject(new Error('Recording stream aborted'));
        signal.addEventListener('abort', abortHandler, { once: true });
      }
    });

    try {
      return await Promise.race([promise, timeout, aborted]);
    } finally {
      clearTimeout(timeoutId);
      if (signal && abortHandler) {
        signal.removeEventListener('abort', abortHandler);
      }
    }
  }
}
