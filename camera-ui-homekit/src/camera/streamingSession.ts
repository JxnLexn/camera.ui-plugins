import { Disposable, Subject } from '@camera.ui/sdk';
import { spawn } from 'node:child_process';
import { isIPv6 } from 'node:net';
import { networkInterfaces } from 'node:os';
import {
  isRtcp,
  PictureLossIndication,
  RtcpPacketConverter,
  RtcpPayloadSpecificFeedback,
  RtcpRrPacket,
  RtcpSenderInfo,
  RtcpSrPacket,
  SrtcpSession,
  SrtpSession,
} from 'werift';
import { AudioStreamingCodecType, SRTPCryptoSuites } from '../hap.js';

import { placeholderImageFor } from '../utils/placeholder.js';
import { RtpSplitter } from '../utils/rtp-splitter.js';
import {
  createReceiverStats,
  cumulativePacketsLost,
  ntpTimestamp,
  recordReceiverReport,
  recordRtcpPackets,
  recordRtpPacket,
  summarizeReceiverStats,
} from '../utils/rtp-stats.js';
import { generateSrtpOptions, generateSsrc, getSessionConfig } from '../utils/srtp.js';
import { forcesTranscode, getDurationSeconds, heightForAspectRatio } from '../utils/utils.js';
import { VideoSourceSwitch } from './videoSourceSwitch.js';

import type { CameraDevice, CameraDeviceSource, LoggerService, RtpSession, RtpSessionOptions } from '@camera.ui/sdk';
import type { ChildProcess } from 'node:child_process';
import type { RtpPacket } from 'werift';
import type { PrepareStreamRequest, ReconfiguredVideoInfo, StartStreamRequest } from '../hap.js';
import type { RtpSenderState } from '../utils/rtp-stats.js';
import type { CameraAccessory } from './accessory.js';

const SRTP_AUTH_TAG_LENGTH = 10;
// HomeKit starts remote view at 640x360 and asks for 1280x720 once the connection holds
const SMALL_PICTURE_MAX_WIDTH = 640;
// HomeKit repeats a PLI for every lost frame until the keyframe arrives
const KEYFRAME_REQUEST_INTERVAL = 1000;

export class StreamingSession {
  public start: number;

  public audioSsrc = generateSsrc();
  public videoSsrc = generateSsrc();
  public audioSrtp = generateSrtpOptions();
  public videoSrtp = generateSrtpOptions();

  public audioSplitter = new RtpSplitter();
  public videoSplitter = new RtpSplitter();

  public sourceAddress?: string;

  private videoSrtpSession: SrtpSession;
  private videoSrtcpSession: SrtcpSession;
  private audioSrtcpSession: SrtcpSession;
  private homekitSrtcpSession: SrtcpSession;
  private homekitAudioSrtcpSession: SrtcpSession;

  private cameraAccessory: CameraAccessory;
  private cameraDevice: CameraDevice;
  private audioSession?: RtpSession;
  private startStreamRequest?: StartStreamRequest;
  private videoSwitch?: VideoSourceSwitch;
  private videoSessions = new Map<RtpSession, CameraDeviceSource>();
  private videoChange = Promise.resolve();
  private requestedVideo?: ReconfiguredVideoInfo;
  private keyframeRequestedAt = 0;
  private requestedBitrateSample?: { at: number; octets: number };
  private placeholderProcess?: ChildProcess;
  private disposables: Disposable[] = [];
  private prepareStreamRequest: PrepareStreamRequest;
  private cameraLogger: LoggerService;
  private stopPromise?: Promise<void>;

  private lastPacketLoss = 0;
  private packetReceivedSubject = new Subject<void>();

  private videoSenderState?: RtpSenderState;
  private audioSenderState?: RtpSenderState;
  private videoReceiverStats = createReceiverStats();
  private audioReceiverStats = createReceiverStats();
  private audioClockRate = 48000;
  private audioNegotiated = '';
  private audioPacketsPerSecond = 50;

  constructor(
    cameraAccessory: CameraAccessory,
    cameraDevice: CameraDevice,
    prepareStreamRequest: PrepareStreamRequest,
    start: number,
    private videoCodec: 'h264' | 'hevc' = 'h264',
    private opusClock: 'negotiated' | 'fixed' = 'negotiated',
  ) {
    this.cameraAccessory = cameraAccessory;
    this.cameraDevice = cameraDevice;
    this.prepareStreamRequest = prepareStreamRequest;
    this.start = start;
    this.cameraLogger = cameraDevice.logger;

    this.videoSrtpSession = new SrtpSession(getSessionConfig(this.videoSrtp));
    this.videoSrtcpSession = new SrtcpSession(getSessionConfig(this.videoSrtp));
    this.audioSrtcpSession = new SrtcpSession(getSessionConfig(this.audioSrtp));
    this.homekitSrtcpSession = new SrtcpSession(getSessionConfig(prepareStreamRequest.video));
    this.homekitAudioSrtcpSession = new SrtcpSession(getSessionConfig(prepareStreamRequest.audio));
  }

  public async prepare(): Promise<void> {
    const { socketType, sourceAddress } = await this.setupAddress();
    this.sourceAddress = sourceAddress;

    await Promise.all([this.audioSplitter.prepare(socketType, sourceAddress), this.videoSplitter.prepare(socketType, sourceAddress)]);

    if (!this.videoSplitter.port || !this.audioSplitter.port) {
      throw new Error('Failed to prepare stream splitters');
    }

    let firstRtcp = false;

    const logFirstRtcp = () => {
      this.cameraLogger.debug('Received RTCP packet from HomeKit');
    };

    this.videoSplitter.addMessageHandler(({ message, isRtpMessage }) => {
      if (!firstRtcp) {
        firstRtcp = true;
        logFirstRtcp();
      }

      this.packetReceivedSubject.next();

      if (!isRtpMessage) {
        this.analyzeRtcpPacket(message, 'video');
      }

      return null;
    });

    this.audioSplitter.addMessageHandler(({ message, isRtpMessage }) => {
      if (!firstRtcp) {
        firstRtcp = true;
        logFirstRtcp();
      }

      this.packetReceivedSubject.next();

      if (!isRtpMessage) {
        this.analyzeRtcpPacket(message, 'audio');
      }

      return null;
    });
  }

  private setupInactivityDetection(): void {
    let debounceTimer: NodeJS.Timeout | undefined;
    const resetDebounce = () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        this.cameraLogger.log(`Live stream appears to be inactive. (${getDurationSeconds(this.start)}s)`);
        this.stop();
      }, 5000);
    };
    const initialTimer = setTimeout(resetDebounce, 15000);
    const packetSub = this.packetReceivedSubject.subscribe(resetDebounce);
    this.disposables.push(
      new Disposable(() => {
        clearTimeout(initialTimer);
        clearTimeout(debounceTimer);
        packetSub.dispose();
      }),
    );
  }

  private setupRtcpSenderReports(startStreamRequest: StartStreamRequest): void {
    const sendSenderReport = async (state: RtpSenderState | undefined, ssrc: number, srtcp: SrtcpSession, splitter: RtpSplitter, port: number): Promise<void> => {
      if (!state) return;

      const senderReport = new RtcpSrPacket({
        ssrc,
        senderInfo: new RtcpSenderInfo({
          ntpTimestamp: ntpTimestamp(state.wallclock),
          rtpTimestamp: state.timestamp,
          packetCount: state.packets >>> 0,
          octetCount: state.octets >>> 0,
        }),
      });

      try {
        await splitter.send(srtcp.encrypt(senderReport.serialize()), {
          port,
          address: this.prepareStreamRequest.targetAddress,
        });
      } catch {
        // ignore
      }
    };

    const videoInterval = setInterval(
      () => sendSenderReport(this.videoSenderState, this.videoSsrc, this.videoSrtcpSession, this.videoSplitter, this.prepareStreamRequest.video.port),
      Math.max(500, (startStreamRequest.video.rtcp_interval || 0.5) * 1000),
    );
    const audioInterval = setInterval(
      () => sendSenderReport(this.audioSenderState, this.audioSsrc, this.audioSrtcpSession, this.audioSplitter, this.prepareStreamRequest.audio.port),
      Math.max(500, (startStreamRequest.audio.rtcp_interval || 5) * 1000),
    );
    this.disposables.push(
      new Disposable(() => {
        clearInterval(videoInterval);
        clearInterval(audioInterval);
      }),
    );
  }

  public async activate(startStreamRequest: StartStreamRequest, matchRequestedWidth = false): Promise<void> {
    this.cameraLogger.debug('Starting stream:', startStreamRequest);
    this.setupInactivityDetection();

    const placeholder = placeholderImageFor(this.cameraDevice);
    if (placeholder) {
      this.cameraLogger.log(`Camera unavailable, streaming placeholder (${this.cameraDevice.disabled ? 'disabled' : 'offline'})`);
      await this.runPlaceholder(placeholder, startStreamRequest);
      return;
    }

    this.startStreamRequest = startStreamRequest;
    this.requestedVideo = startStreamRequest.video;
    const main = this.cameraDevice.streamSource;
    const source = matchRequestedWidth ? this.videoSourceFor(startStreamRequest.video.width) : main;
    if (source._id !== main._id) {
      this.cameraLogger.log(`[RTP] HomeKit asks for a small picture, video starts on ${source.name}`);
    }

    const video = this.createVideoSession(source);
    this.videoSwitch = new VideoSourceSwitch(video, (session, previous, waitedMs) => {
      this.cameraLogger.log(`[RTP] Switched video to ${this.videoSessions.get(session)?.name} at its keyframe after ${waitedMs}ms`);
      this.stopVideoSession(previous);
    });
    this.setupRtcpSenderReports(startStreamRequest);

    const width = matchRequestedWidth ? startStreamRequest.video.width : undefined;
    const videoOptions = this.videoStreamOptions(startStreamRequest, source, startStreamRequest.video, width);
    await Promise.all([video.startStream(videoOptions), this.startAudio(startStreamRequest)]);
  }

  public followRequestedVideo(video: ReconfiguredVideoInfo): Promise<void> {
    this.requestedVideo = video;
    this.videoChange = this.videoChange.then(() => this.followRequestedSource());
    return this.videoChange;
  }

  public stop(): Promise<void> {
    this.stopPromise ??= Promise.resolve().then(() => this.shutdown());
    return this.stopPromise;
  }

  private async shutdown(): Promise<void> {
    this.cameraLogger.debug('Stopping stream');
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables = [];

    const sessions = [...this.videoSessions.keys()];
    if (this.audioSession) {
      sessions.push(this.audioSession);
    }
    this.audioSession = undefined;
    this.videoSessions.clear();

    await Promise.all(sessions.map((session) => session.stop().catch(() => undefined)));
    this.stopPlaceholderProcess();
    this.audioSplitter.close();
    this.videoSplitter.close();
    this.logStreamSummary();
    this.cameraLogger.debug('Stream stopped');
  }

  private async runPlaceholder(imagePath: string, startStreamRequest: StartStreamRequest): Promise<void> {
    const ffmpegPath = await this.cameraAccessory.api.coreManager.getFFmpegPath();
    const { targetAddress, video } = this.prepareStreamRequest;
    const address = isIPv6(targetAddress) ? `[${targetAddress}]` : targetAddress;
    const srtpParams = Buffer.concat([this.videoSrtp.srtp_key, this.videoSrtp.srtp_salt]).toString('base64');

    const request = startStreamRequest.video;
    const fps = request.fps || 15;
    const bitrate = request.max_bit_rate || 300;

    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-loop',
      '1',
      '-framerate',
      String(fps),
      '-i',
      imagePath,
      '-an',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-tune',
      'stillimage',
      '-pix_fmt',
      'yuv420p',
      '-vf',
      `scale=${request.width}:${request.height}:force_original_aspect_ratio=decrease,pad=${request.width}:${request.height}:(ow-iw)/2:(oh-ih)/2`,
      '-b:v',
      `${bitrate}k`,
      '-maxrate',
      `${bitrate}k`,
      '-bufsize',
      `${bitrate * 2}k`,
      '-g',
      String(fps * 2),
      '-payload_type',
      String(request.pt),
      '-ssrc',
      String(this.videoSsrc),
      '-f',
      'rtp',
      '-srtp_out_suite',
      'AES_CM_128_HMAC_SHA1_80',
      '-srtp_out_params',
      srtpParams,
      `srtp://${address}:${video.port}?rtcpport=${video.port}&pkt_size=${request.mtu || 1316}`,
    ];

    const process = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    this.placeholderProcess = process;

    process.stderr?.on('data', (chunk: Buffer) => this.cameraLogger.debug(`Placeholder ffmpeg: ${chunk.toString().trim()}`));
    process.on('exit', (code) => {
      if (this.placeholderProcess === process && code !== 0 && code !== null) {
        this.cameraLogger.warn(`Placeholder stream exited with code ${code}`);
      }
    });
  }

  private stopPlaceholderProcess(): void {
    const process = this.placeholderProcess;
    this.placeholderProcess = undefined;
    if (process && !process.killed) {
      process.kill('SIGKILL');
    }
  }

  private async startAudio(startStreamRequest: StartStreamRequest): Promise<void> {
    const fixedOpusClock = this.opusClock === 'fixed' && startStreamRequest.audio.codec === AudioStreamingCodecType.OPUS;
    this.audioClockRate = fixedOpusClock ? 48000 : startStreamRequest.audio.sample_rate * 1000;
    this.audioNegotiated = `${startStreamRequest.audio.codec.toLowerCase()} ${startStreamRequest.audio.sample_rate}k/${startStreamRequest.audio.packet_time}ms`;
    this.audioPacketsPerSecond = Math.round(1000 / startStreamRequest.audio.packet_time);

    const source = this.cameraDevice.streamSource;
    // probed and neither audio nor talkback, go2rtc would refuse the session
    if (source.videoCodec && !source.audioCodecs?.length && !source.backchannelAudioCodec) {
      return;
    }

    const session = source.createRtpSession({ audio: true, video: false, backchannel: true });
    this.audioSession = session;
    session.onError.subscribe((error) => this.cameraLogger.warn(`Live stream source error: ${error.message}`));
    this.listenForAudioPackets(session, startStreamRequest);

    try {
      await session.startStream({
        audio: {
          codec: startStreamRequest.audio.codec === AudioStreamingCodecType.OPUS ? 'opus' : 'aac',
          mtu: 1200,
          sampleRate: startStreamRequest.audio.sample_rate * 1000,
          channels: startStreamRequest.audio.channel,
          ssrc: this.audioSsrc,
          payloadType: startStreamRequest.audio.pt,
          frameDuration: startStreamRequest.audio.packet_time,
        },
      });

      await session.startBackchannel({
        decoderCodec: startStreamRequest.audio.codec === AudioStreamingCodecType.OPUS ? 'libopus' : 'libfdk_aac',
        payloadType: startStreamRequest.audio.pt,
        clockRate: this.audioClockRate,
        channels: startStreamRequest.audio.channel,
        fmtp:
          startStreamRequest.audio.codec === AudioStreamingCodecType.OPUS
            ? 'minptime=10;useinbandfec=1'
            : 'profile-level-id=1;mode=AAC-hbr;sizelength=13;indexlength=3;indexdeltalength=3; config=F8F0212C00BC00',
        srtp: {
          key: this.prepareStreamRequest.audio.srtp_key,
          salt: this.prepareStreamRequest.audio.srtp_salt,
          suite: this.prepareStreamRequest.audio.srtpCryptoSuite === SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80 ? 'AES_CM_128_HMAC_SHA1_80' : 'AES_CM_256_HMAC_SHA1_80',
        },
      });
    } catch (error) {
      if (!this.stopPromise) {
        this.cameraLogger.warn('[RTP] Failed to start audio, the live stream continues without it', error);
      }
      return;
    }

    if (session.hasBackchannel) {
      this.listenForReturnAudioPackets(session);
    }
  }

  private async followRequestedSource(): Promise<void> {
    const { startStreamRequest, requestedVideo } = this;
    if (!startStreamRequest || !requestedVideo || this.stopPromise) {
      return;
    }

    const source = this.videoSourceFor(requestedVideo.width);
    const running = [...this.videoSessions].find(([, input]) => input._id === source._id)?.[0];
    // a stream sent as requested starts again with the new size, frame rate and bitrate
    if (running && !this.cameraAccessory.cameraStorage.values.streamAsRequested) {
      this.switchVideo(running);
      return;
    }

    // the current stream plays on until this one reaches a live keyframe, a replayed GOP would show as fast-forward
    const session = this.createVideoSession(source, false);
    try {
      await session.startStream(this.videoStreamOptions(startStreamRequest, source, requestedVideo, requestedVideo.width));
    } catch (error) {
      if (!this.stopPromise) {
        this.cameraLogger.warn(`[RTP] Failed to start ${source.name}, video stays on the current stream`, error);
      }
      this.stopVideoSession(session);
      return;
    }
    if (!this.stopPromise) {
      this.switchVideo(session);
    }
  }

  private videoSourceFor(width: number): CameraDeviceSource {
    const main = this.cameraDevice.streamSource;
    if (width > SMALL_PICTURE_MAX_WIDTH) {
      return main;
    }
    const small = this.cameraDevice.lowResolutionSource ?? this.cameraDevice.midResolutionSource;
    if (!small || small._id === main._id) {
      this.cameraLogger.log('[RTP] HomeKit asks for a small picture, the camera has no low or mid resolution source');
      return main;
    }
    return small;
  }

  private createVideoSession(source: CameraDeviceSource, gop = true): RtpSession {
    const session = source.createRtpSession({ audio: false, video: true, backchannel: false, gop });
    this.videoSessions.set(session, source);
    session.onError.subscribe((error) => this.cameraLogger.warn(`Live stream source error: ${error.message}`));
    this.listenForVideoPackets(session);
    return session;
  }

  private switchVideo(session: RtpSession): void {
    const dropped = this.videoSwitch?.switchTo(session);
    if (dropped) {
      this.stopVideoSession(dropped);
    }
  }

  private stopVideoSession(session: RtpSession): void {
    this.videoSessions.delete(session);
    session.stop().catch(() => undefined);
  }

  private requestKeyframe(): void {
    const now = performance.now();
    if (now - this.keyframeRequestedAt < KEYFRAME_REQUEST_INTERVAL) {
      return;
    }
    this.keyframeRequestedAt = now;
    this.videoSwitch?.current.requestKeyframe();
  }

  private videoStreamOptions(startStreamRequest: StartStreamRequest, source: CameraDeviceSource, requested: ReconfiguredVideoInfo, width?: number): RtpSessionOptions {
    const storage = this.cameraAccessory.cameraStorage.values;
    const hardware = storage.useHardwareAcceleration ? 'auto' : undefined;
    const video = {
      codec: this.videoCodec,
      // the muxer sizes clear RTP, SRTP appends its tag afterwards
      mtu: startStreamRequest.video.mtu - SRTP_AUTH_TAG_LENGTH,
      ssrc: this.videoSsrc,
      payloadType: startStreamRequest.video.pt,
      transcode: forcesTranscode(storage),
    };

    if (storage.streamAsRequested) {
      return {
        hardware,
        video: { ...video, width: requested.width, height: requested.height, fps: requested.fps, bitrate: requested.max_bit_rate * 1000 },
      };
    }

    // only a transcode scales, the small picture takes the camera's aspect ratio to match the main stream after the switch
    const small = width && source._id !== this.cameraDevice.streamSource._id;
    const height = small ? heightForAspectRatio(width, this.cameraDevice.interfaceSettings.aspectRatio) : undefined;
    return { hardware, video: { ...video, width, height } };
  }

  private logRequestedBitrate(bitrate: number): void {
    const sender = this.videoSenderState;
    const previous = this.requestedBitrateSample;
    this.requestedBitrateSample = sender && { at: sender.wallclock, octets: sender.octets };

    let sent = '';
    if (sender && previous && sender.wallclock > previous.at) {
      sent = `, video ran at ${Math.round(((sender.octets - previous.octets) * 8) / (sender.wallclock - previous.at))} kbit/s since the last request`;
    }
    this.cameraLogger.debug(`[RTP] HomeKit asks for at most ${Math.round(bitrate / 1000)} kbit/s${sent}`);
  }

  private listenForVideoPackets(session: RtpSession): void {
    let sentVideo = false;

    const {
      targetAddress: address,
      video: { port },
    } = this.prepareStreamRequest;

    session.addSubscriptions(
      session.onVideoRtp.subscribe(async (rtp: RtpPacket) => {
        if (!sentVideo) {
          sentVideo = true;
          this.cameraLogger.debug(`Received video data (${getDurationSeconds(this.start)}s)`);
        }
        if (!this.videoSwitch?.rewrite(session, rtp)) {
          return;
        }

        try {
          const encryptedPacket = this.videoSrtpSession.encrypt(rtp.payload, rtp.header);
          this.videoSenderState = recordRtpPacket(this.videoSenderState, rtp, 90000);
          this.videoSplitter.send(encryptedPacket, { port, address }).catch(() => {});
        } catch {
          // ignore
        }
      }),
    );
  }

  private listenForAudioPackets(session: RtpSession, startStreamRequest: StartStreamRequest): void {
    let sentAudio = false;

    const {
      targetAddress: address,
      audio: { port },
    } = this.prepareStreamRequest;

    const audioSrtpSession = new SrtpSession(getSessionConfig(this.audioSrtp));

    // HAP wants Opus on the negotiated clock, not ffmpeg's 48 kHz, rescaled so source gaps stay gaps
    const rewriteTimestamps = startStreamRequest.audio.codec === AudioStreamingCodecType.OPUS && this.opusClock === 'negotiated';
    const clockScale = (startStreamRequest.audio.sample_rate * 1000) / 48000;
    let sourceBase: number | undefined;
    let targetBase: number | undefined;

    session.addSubscriptions(
      session.onAudioRtp.subscribe(async (rtp: RtpPacket) => {
        if (!sentAudio) {
          sentAudio = true;
          this.cameraLogger.debug(`Received audio data (${getDurationSeconds(this.start)}s)`);
        }

        try {
          if (rewriteTimestamps) {
            sourceBase ??= rtp.header.timestamp;
            targetBase ??= rtp.header.timestamp;
            const elapsed = (rtp.header.timestamp - sourceBase) >>> 0;
            rtp.header.timestamp = (targetBase + Math.round(elapsed * clockScale)) >>> 0;
          }

          const encryptedPacket = audioSrtpSession.encrypt(rtp.payload, rtp.header);
          this.audioSenderState = recordRtpPacket(this.audioSenderState, rtp, this.audioClockRate);
          this.audioSplitter.send(encryptedPacket, { port, address }).catch(() => {});
        } catch {
          // ignore
        }
      }),
    );
  }

  private listenForReturnAudioPackets(session: RtpSession): void {
    this.audioSplitter.addMessageHandler(({ message, isRtpMessage }) => {
      if (isRtpMessage) {
        try {
          // still SRTP, node-av decrypts it
          session.sendAudioPacket(message).catch(() => {});
        } catch {
          // ignore
        }
      }

      return null;
    });
  }

  private async setupAddress(): Promise<{
    socketType: 'udp4' | 'udp6';
    sessionID: string;
    sourceAddress: string;
    targetAddress: string;
    addressVersion: 'ipv4' | 'ipv6';
  }> {
    const { sessionID, targetAddress, addressVersion } = this.prepareStreamRequest;
    let { sourceAddress } = this.prepareStreamRequest;

    const socketType = addressVersion === 'ipv6' ? 'udp6' : 'udp4';
    if (socketType === 'udp4' && sourceAddress.startsWith('::ffff:')) {
      sourceAddress = sourceAddress.replace('::ffff:', '');
    }

    const serverAddresses = await this.cameraAccessory.api.coreManager.getServerAddresses();
    const found = serverAddresses.find((address) => address.includes(sourceAddress));

    if (!found && serverAddresses.length) {
      this.cameraLogger.debug(`Source address ${sourceAddress} not found in server addresses`);

      const infos = Object.values(networkInterfaces())
        .flat()
        .map((i) => i?.address) as string[];

      const targetAddresses = serverAddresses.filter((address) => {
        if (socketType === 'udp4') {
          return !isIPv6(address);
        } else {
          return isIPv6(address);
        }
      });

      const targetAddressFound = infos.find((address) => targetAddresses.includes(address));
      if (targetAddressFound) {
        this.cameraLogger.debug(`Using target address ${targetAddressFound}`);
        sourceAddress = targetAddressFound;
      }
    } else if (found) {
      this.cameraLogger.debug(`Using source address ${sourceAddress}`);
    }

    if (isIPv6(sourceAddress)) {
      sourceAddress = sourceAddress.split('%')[0];
    }

    this.cameraLogger.debug('Session setup:', { sessionID, sourceAddress, targetAddress, addressVersion });

    return { socketType, sessionID, sourceAddress, targetAddress, addressVersion };
  }

  private logStreamSummary(): void {
    if (!this.videoSenderState && !this.audioSenderState) return;

    if (this.videoReceiverStats.rrCount === 0 && this.audioReceiverStats.rrCount === 0) {
      this.cameraLogger.debug(`Live stream summary (${getDurationSeconds(this.start)}s): no RTCP received from the device, return path may be blocked`);
      return;
    }

    const video = summarizeReceiverStats('video', this.videoReceiverStats, this.videoSenderState, 90000, { fps: true });
    const audio = summarizeReceiverStats(`audio (${this.audioNegotiated})`, this.audioReceiverStats, this.audioSenderState, this.audioClockRate, {
      expectedPacketsPerSecond: this.audioPacketsPerSecond,
    });
    this.cameraLogger.debug(`Live stream summary (${getDurationSeconds(this.start)}s): ${video}; ${audio}`);
  }

  private analyzeRtcpPacket(message: Buffer, kind: 'video' | 'audio'): void {
    if (!isRtcp(message)) return;

    const stats = kind === 'video' ? this.videoReceiverStats : this.audioReceiverStats;
    const clockRate = kind === 'video' ? 90000 : this.audioClockRate;

    try {
      const srtcp = kind === 'video' ? this.homekitSrtcpSession : this.homekitAudioSrtcpSession;
      const rtcp = srtcp.decrypt(message);
      const requestedBitrate = stats.requestedBitrate;
      recordRtcpPackets(stats, rtcp);
      if (kind === 'video' && stats.requestedBitrate !== requestedBitrate) {
        this.logRequestedBitrate(stats.requestedBitrate);
      }
      const packets = RtcpPacketConverter.deSerialize(rtcp);

      for (const packet of packets) {
        if (packet instanceof RtcpRrPacket) {
          for (const report of packet.reports) {
            // HomeKit reports one lost packet before the first one arrives
            if (report.highestSequence === 0) {
              continue;
            }
            recordReceiverReport(stats, report);

            const packetsLost = cumulativePacketsLost(report);
            if (kind === 'video' && packetsLost > this.lastPacketLoss) {
              this.lastPacketLoss = packetsLost;
              const jitterMs = Math.round((report.jitter / clockRate) * 1000);
              this.cameraLogger.debug(`Increased packet loss detected: Total Lost=${packetsLost}, Highest Seq=${report.highestSequence}, Jitter=${jitterMs}ms`);
            }
          }
        } else if (packet instanceof RtcpPayloadSpecificFeedback) {
          if (packet.feedback instanceof PictureLossIndication || 'fir' in packet.feedback) {
            stats.pliCount++;
            if (kind === 'video') {
              this.requestKeyframe();
            }
          }
        }
      }
    } catch {
      // ignore
    }
  }
}
