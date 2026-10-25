import { randomInt } from 'node:crypto';
import { isIPv4 } from 'node:net';

import {
  GenericNack,
  MediaStreamTrack,
  ReceiverEstimatedMaxBitrate,
  RTCPeerConnection,
  RTCRtpCodecParameters,
  RtcpPayloadSpecificFeedback,
  RtcpRrPacket,
  RtcpSrPacket,
  RtcpTransportLayerFeedback,
} from 'werift';

import { audioPayloadType as AUDIO_PAYLOAD_TYPE, secureVideoMaxRemoteSessions, videoPayloadType as VIDEO_PAYLOAD_TYPE } from '../constants.js';
import { createReceiverStats, recordReceiverReport, recordRtpPacket, summarizeReceiverStats } from '../utils/rtp-stats.js';
import { filterBindAddresses, forcesTranscode, getDurationSeconds, heightForAspectRatio } from '../utils/utils.js';
import { SecureVideoSFrame } from './sframe.js';
import { HevcAccessUnitAssembler, isHevcKeyframe, SFrameRtpPacketizer } from './sframeRtp.js';
import { Talkback } from './talkback.js';

import type { CameraDevice, CameraDeviceSource, LoggerService, RtpSession } from '@camera.ui/sdk';
import type { RtcpPacket, RTCRtpTransceiver, RtpPacket } from 'werift';
import type { RtcpReceiverStats, RtpSenderState } from '../utils/rtp-stats.js';
import type {
  SecureVideoVideoTier,
  WebRTCOffer,
  WebRTCProvideAnswerRequest,
  WebRTCReofferAnswer,
  WebRTCReofferRequest,
  WebRTCSolicitOfferRequest,
  WebRTCStreamingDelegate,
  WebRTCUpdateSessionRequest,
} from '../hap.js';
import type { CameraAccessory } from './accessory.js';

const UNANSWERED_TIMEOUT = 60000;
// kbit/s, the viewer only takes a layer below its network's limit (LTE 600, 5G 2000), the high layer stays the native copy
const REMOTE_HIGH_MAX_BITRATE = 2000;
const REMOTE_LOW_MAX_BITRATE = 600;

const videoRtcpFeedback = [{ type: 'nack' }, { type: 'nack', parameter: 'pli' }, { type: 'ccm', parameter: 'fir' }];

const hevcCodec = new RTCRtpCodecParameters({
  mimeType: 'video/H265',
  clockRate: 90000,
  payloadType: VIDEO_PAYLOAD_TYPE,
  parameters: 'profile-id=1;tier-flag=0;level-id=153;tx-mode=SRST',
  rtcpFeedback: videoRtcpFeedback,
});

const opusCodec = new RTCRtpCodecParameters({
  mimeType: 'audio/opus',
  clockRate: 48000,
  channels: 2,
  payloadType: AUDIO_PAYLOAD_TYPE,
  parameters: 'minptime=20;useinbandfec=1;stereo=0;sprop-stereo=0',
});

interface VideoLayerSpec {
  rid: string;
  tier: SecureVideoVideoTier;
  source: CameraDeviceSource;
}

interface VideoLayer extends VideoLayerSpec {
  track: MediaStreamTrack;
  transceiver: RTCRtpTransceiver;
  ssrc: number;
  stream?: RtpSession;
  sent?: RtpSenderState;
  reports: RtcpReceiverStats;
  firstFrameMs?: number;
  firstKeyframeMs?: number;
  timestampOffset?: number;
  lastTimestamp?: number;
}

interface WebRtcSession {
  sessionIdentifier: string;
  pc: RTCPeerConnection;
  atrack: MediaStreamTrack;
  audioTransceiver: RTCRtpTransceiver;
  sframe: SecureVideoSFrame;
  layers: VideoLayer[];
  talkback?: Talkback;
  answered: boolean;
  closed: boolean;
  starting?: boolean;
  startedAt: number;
  videoClock: { origin: number; base: number };
  reapTimer?: NodeJS.Timeout;
  activatedAt?: number;
  audioSent?: RtpSenderState;
  audioReports: RtcpReceiverStats;
  nackedPackets: number;
  remb?: { min: number; max: number };
}

export class WebRtcSessions implements WebRTCStreamingDelegate {
  private readonly sessions = new Map<string, WebRtcSession>();
  private cameraLogger: LoggerService;

  constructor(
    private cameraAccessory: CameraAccessory,
    private cameraDevice: CameraDevice,
    private videoTiers: SecureVideoVideoTier[],
    private isActive: () => boolean,
  ) {
    this.cameraLogger = cameraDevice.logger;
  }

  public async handleSolicitOffer(request: WebRTCSolicitOfferRequest): Promise<WebRTCOffer> {
    if (this.sessions.size >= secureVideoMaxRemoteSessions || !this.isActive()) {
      throw new Error('WebRTC solicit rejected (session limit or inactive)');
    }

    this.cameraLogger.debug('[WebRTC] Preparing stream...');

    const iceAddress = await this.resolveIceAddress();
    const pc = new RTCPeerConnection({
      codecs: { video: [hevcCodec], audio: [opusCodec] },
      iceUseIpv6: false,
      ...(iceAddress ? { iceInterfaceAddresses: { udp4: iceAddress } } : {}),
    });
    const [mainSpec, ...lowSpecs] = this.selectRemoteLayers();
    const mainLayer = addVideoLayer(pc, mainSpec);
    const atrack = new MediaStreamTrack({ kind: 'audio' });
    const audioTransceiver = pc.addTransceiver(atrack, { direction: 'sendonly' });
    // one m-line per layer, the relay knows a stream only by the ssrc of its media section
    const layers = [mainLayer, ...lowSpecs.map((spec) => addVideoLayer(pc, spec))];

    const candidates: WebRTCOffer['candidates'] = [];
    pc.onIceCandidate.subscribe((candidate: any) => {
      const json = candidate?.toJSON ? candidate.toJSON() : candidate;
      if (json?.candidate) {
        candidates.push({ candidate: json.candidate, sdpMid: json.sdpMid ?? undefined, sdpMLineIndex: json.sdpMLineIndex ?? undefined });
      }
    });

    const session: WebRtcSession = {
      sessionIdentifier: request.sessionIdentifier,
      pc,
      atrack,
      audioTransceiver,
      sframe: new SecureVideoSFrame(true),
      layers,
      answered: false,
      closed: false,
      startedAt: Date.now(),
      videoClock: { origin: performance.now(), base: randomInt(2 ** 32) },
      audioReports: createReceiverStats(),
      nackedPackets: 0,
    };
    this.sessions.set(request.sessionIdentifier, session);
    session.reapTimer = setTimeout(() => this.handleEndSession(request.sessionIdentifier), UNANSWERED_TIMEOUT);

    // the relay's mic packets use ssrcs and payload types no SDP announces, werift's router would drop them
    const router = (pc as any).router;
    const routeRtp = router.routeRtp;
    router.routeRtp = (packet: RtpPacket) => {
      if (packet.header.payloadType !== VIDEO_PAYLOAD_TYPE && !router.ssrcTable[packet.header.ssrc]) {
        if (!session.closed) {
          session.talkback?.push(packet);
        }
        return;
      }
      routeRtp(packet);
    };

    const tag = request.sessionIdentifier.slice(0, 8);
    pc.iceConnectionStateChange.subscribe((state: string) => {
      this.cameraLogger.debug(`[WebRTC] ${tag} ice ${state}`);
    });
    pc.connectionStateChange.subscribe((state: string) => {
      this.cameraLogger.debug(`[WebRTC] ${tag} connection ${state}`);
      if (state === 'connected') {
        this.startMedia(session).catch((error) => {
          this.cameraLogger.error('[WebRTC] Failed to start media', error);
          this.handleEndSession(request.sessionIdentifier);
        });
      } else if (state === 'failed' || state === 'closed' || state === 'disconnected') {
        this.handleEndSession(request.sessionIdentifier);
      }
    });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    replayEarlyDtls(pc, (count) => {
      this.cameraLogger.debug(`[WebRTC] ${tag} replayed ${count} early DTLS packets`);
    });
    this.watchRtcp(session);
    const localSdp = pc.localDescription?.sdp ?? offer.sdp;
    const sdpOffer = addVideoLayers(localSdp, layers, freeExtensionId(localSdp));

    const described = layers.map((layer) => `${layer.rid}: ${layer.tier.width}x${layer.tier.height} from ${layer.source.name}, ssrc ${layer.ssrc}`);
    this.cameraLogger.debug(`[WebRTC] ${tag} layers ${described.join('; ')}`);
    this.cameraLogger.debug(`[WebRTC] Stream prepared (${getDurationSeconds(session.startedAt)}s)`);

    return {
      sdpOffer,
      candidates,
      sframe: session.sframe.senderKey,
    };
  }

  public async handleProvideAnswer(request: WebRTCProvideAnswerRequest): Promise<void> {
    const session = this.sessions.get(request.sessionIdentifier);
    if (!session || session.answered) {
      throw new Error('Unknown or already-answered WebRTC session');
    }

    await session.pc.setRemoteDescription({ type: 'answer', sdp: request.sdpAnswer } as any);
    session.answered = true;
    this.cameraLogger.debug(`[WebRTC] ${request.sessionIdentifier.slice(0, 8)} answer applied`);

    for (const candidate of request.candidates) {
      try {
        await session.pc.addIceCandidate({ candidate: candidate.candidate, sdpMid: candidate.sdpMid, sdpMLineIndex: candidate.sdpMLineIndex });
      } catch (error) {
        this.cameraLogger.warn('[WebRTC] Failed to add ICE candidate', error);
      }
    }
  }

  public async handleReoffer(request: WebRTCReofferRequest): Promise<WebRTCReofferAnswer> {
    const session = this.sessions.get(request.sessionIdentifier);
    if (!session) {
      throw new Error('Unknown WebRTC session');
    }
    // the relay reoffers when the viewer's mic comes and goes, nothing to configure here
    this.cameraLogger.debug(`[WebRTC] ${request.sessionIdentifier.slice(0, 8)} reoffer applied`);
    await session.pc.setRemoteDescription({ type: 'offer', sdp: request.sdpOffer } as any);
    const answer = await session.pc.createAnswer();
    await session.pc.setLocalDescription(answer);
    return { sdpAnswer: (session.pc.localDescription as any)?.sdp ?? (answer as any).sdp };
  }

  public async handleUpdateSession(request: WebRTCUpdateSessionRequest): Promise<void> {
    const session = this.sessions.get(request.sessionIdentifier);
    if (!session) {
      throw new Error('Unknown WebRTC session');
    }
    session.sframe.addReceiveKeys(request.receiveKeysToAdd);
    session.sframe.removeReceiveKeys(request.receiveKIDsToRemove);

    // prettier-ignore
    this.cameraLogger.debug(
      `[WebRTC] ${request.sessionIdentifier.slice(0, 8)} receive keys: added ${request.receiveKeysToAdd.map((key) => key.kid).join(',') || '-'}, ` +
      `removed ${request.receiveKIDsToRemove.join(',') || '-'}`,
    );
  }

  public async handleEndSession(sessionIdentifier: string): Promise<void> {
    const session = this.sessions.get(sessionIdentifier);
    if (!session) {
      return;
    }
    this.sessions.delete(sessionIdentifier);
    session.closed = true;
    clearTimeout(session.reapTimer);
    this.logSummary(session);
    this.cameraLogger.log('[WebRTC] Stopping stream...');
    await Promise.all(session.layers.flatMap(({ stream }) => (stream ? [stream.stop().catch(() => undefined)] : [])));
    await session.pc.close().catch(() => undefined);
  }

  public closeAll(): void {
    for (const id of [...this.sessions.keys()]) {
      this.handleEndSession(id);
    }
  }

  private selectRemoteLayers(): VideoLayerSpec[] {
    const mainSource = this.cameraDevice.streamSource;
    const highTier = this.videoTiers.find((tier) => tier.peakBitrate <= REMOTE_HIGH_MAX_BITRATE) ?? this.videoTiers[0];
    const layers = [{ rid: '1', tier: highTier, source: mainSource }];

    const lowSource = this.cameraDevice.lowResolutionSource ?? this.cameraDevice.midResolutionSource;
    const lowTier = this.videoTiers.find((tier) => tier.peakBitrate <= REMOTE_LOW_MAX_BITRATE);
    if (!lowSource || !lowTier || lowSource._id === mainSource._id) {
      this.cameraLogger.log('[WebRTC] No small stream for slow connections, the camera has no low or mid resolution source');
      return layers;
    }
    const codec = lowSource.videoCodec ?? 'an unknown codec';
    const storage = this.cameraAccessory.cameraStorage.values;
    if (lowSource.videoCodec === 'H265' && !forcesTranscode(storage)) {
      this.cameraLogger.log(`[WebRTC] Sending ${lowSource.name} as it is (HEVC) for remote view on slow connections such as LTE`);
    } else if (lowSource.videoCodec === 'H265' || storage.allowTranscodingForMobileData) {
      this.cameraLogger.log(`[WebRTC] Transcoding ${lowSource.name} from ${codec} to HEVC, remote view on slow connections such as LTE needs a small HEVC stream`);
    } else {
      this.cameraLogger.log(`[WebRTC] No small stream for slow connections, ${lowSource.name} sends ${codec} and Allow transcoding for mobile data is off`);
      return layers;
    }
    layers.push({ rid: '2', tier: lowTier, source: lowSource });
    return layers;
  }

  private async resolveIceAddress(): Promise<string | undefined> {
    try {
      const configured = await this.cameraAccessory.api.coreManager.getServerAddresses();
      return filterBindAddresses(configured, this.cameraLogger).find((address) => isIPv4(address));
    } catch {
      return undefined;
    }
  }

  private async startMedia(session: WebRtcSession): Promise<void> {
    if (session.starting || session.closed) {
      return;
    }
    session.starting = true;
    session.activatedAt = Date.now();
    this.cameraLogger.debug(`[WebRTC] Activating stream (${getDurationSeconds(session.startedAt)}s)`);

    const [mainLayer, ...lowLayers] = session.layers;
    const storage = this.cameraAccessory.cameraStorage.values;
    const hardware = storage.useHardwareAcceleration ? 'auto' : undefined;
    const transcode = forcesTranscode(storage);
    const audioPayloadType = session.audioTransceiver.sender.codec?.payloadType ?? AUDIO_PAYLOAD_TYPE;

    const stream = mainLayer.source.createRtpSession({ audio: true, video: true, backchannel: true });
    mainLayer.stream = stream;
    session.talkback = new Talkback(stream, session.sframe, this.cameraLogger);
    this.forwardVideo(session, mainLayer, stream);

    const audioSsrc: number = session.audioTransceiver.sender.ssrc;
    const audioCryptor = session.sframe.audioStream(audioSsrc);
    const audioPacketizer = new SFrameRtpPacketizer({ ssrc: audioSsrc, payloadType: audioPayloadType, maxPayload: 1200 });
    stream.onAudioRtp.subscribe((rtp: RtpPacket) => {
      if (session.closed || rtp.payload.length === 0) {
        return;
      }
      try {
        const sealed = audioCryptor.protectFrame(rtp.payload);
        for (const packet of audioPacketizer.packetize(sealed, rtp.header.timestamp, rtp.header.marker)) {
          session.atrack.writeRtp(packet);
          session.audioSent = recordRtpPacket(session.audioSent, packet, 48000);
        }
      } catch (error) {
        this.cameraLogger.error('[WebRTC] Failed to send audio', error);
        this.handleEndSession(session.sessionIdentifier);
      }
    });

    const lowStarts = lowLayers.map((layer) => {
      const lowStream = layer.source.createRtpSession({ audio: false, video: true, backchannel: false });
      layer.stream = lowStream;
      this.forwardVideo(session, layer, lowStream);
      const { width, height, frameRate, peakBitrate } = layer.tier;
      return lowStream
        .startStream({
          hardware,
          video: {
            codec: 'hevc',
            mtu: 1200,
            payloadType: videoPayloadType(layer),
            fps: frameRate,
            width,
            // the viewer keeps the aspect ratio of the first layer it shows, also after switching to the main layer
            height: storage.streamAsRequested ? height : heightForAspectRatio(width, this.cameraDevice.interfaceSettings.aspectRatio),
            bitrate: peakBitrate * 1000,
            transcode,
            encoderOptions: { g: frameRate },
          },
        })
        .catch((error) => this.cameraLogger.warn(`[WebRTC] Failed to start layer ${layer.rid} from ${layer.source.name}`, error));
    });

    const mainTier = mainLayer.tier;
    const requestedSize = storage.streamAsRequested ? { width: mainTier.width, height: mainTier.height, fps: mainTier.frameRate } : {};
    await Promise.all([
      stream.startStream({
        hardware,
        video: { codec: 'hevc', mtu: 1200, payloadType: videoPayloadType(mainLayer), bitrate: mainTier.peakBitrate * 1000, transcode, ...requestedSize },
        audio: { codec: 'opus', mtu: 1200, payloadType: audioPayloadType, sampleRate: 48000, channels: 1, frameDuration: 20 },
      }),
      ...lowStarts,
    ]);

    clearTimeout(session.reapTimer);
    this.cameraLogger.log(`[WebRTC] Streaming activated (${getDurationSeconds(session.startedAt)}s)`);
  }

  private forwardVideo(session: WebRtcSession, layer: VideoLayer, stream: RtpSession): void {
    const assembler = new HevcAccessUnitAssembler();
    const cryptor = session.sframe.videoStream(layer.ssrc);
    const packetizer = new SFrameRtpPacketizer({ ssrc: layer.ssrc, payloadType: videoPayloadType(layer), maxPayload: 1200 });

    stream.onVideoRtp.subscribe((rtp: RtpPacket) => {
      if (session.closed) {
        return;
      }
      try {
        const frame = assembler.push(rtp);
        if (!frame) {
          return;
        }
        layer.firstFrameMs ??= sinceActivation(session);
        if (layer.firstKeyframeMs === undefined && isHevcKeyframe(frame.data)) {
          layer.firstKeyframeMs = sinceActivation(session);
        }
        const sealed = cryptor.protectFrame(frame.data);
        for (const packet of packetizer.packetize(sealed, sessionClockTimestamp(session, layer, frame.timestamp), frame.marker)) {
          layer.track.writeRtp(packet);
          layer.sent = recordRtpPacket(layer.sent, packet, 90000);
        }
      } catch (error) {
        this.cameraLogger.error(`[WebRTC] Failed to send video layer ${layer.rid}`, error);
        this.handleEndSession(session.sessionIdentifier);
      }
    });
  }

  private watchRtcp(session: WebRtcSession): void {
    for (const dtlsTransport of session.pc.dtlsTransports) {
      dtlsTransport.onRtcp.subscribe((packet: RtcpPacket) => this.recordRtcp(session, packet));
    }
  }

  private recordRtcp(session: WebRtcSession, packet: RtcpPacket): void {
    if (packet instanceof RtcpRrPacket || packet instanceof RtcpSrPacket) {
      for (const report of packet.reports) {
        const layer = session.layers.find((candidate) => candidate.ssrc === report.ssrc);
        if (layer) {
          recordReceiverReport(layer.reports, report);
        } else if (report.ssrc === session.audioTransceiver.sender.ssrc) {
          recordReceiverReport(session.audioReports, report);
        }
      }
    } else if (packet instanceof RtcpTransportLayerFeedback && packet.feedback instanceof GenericNack) {
      session.nackedPackets += packet.feedback.lost.length;
    } else if (packet instanceof RtcpPayloadSpecificFeedback && packet.feedback instanceof ReceiverEstimatedMaxBitrate) {
      const kbps = Number(packet.feedback.bitrate) / 1000;
      session.remb = { min: Math.min(session.remb?.min ?? kbps, kbps), max: Math.max(session.remb?.max ?? kbps, kbps) };
    } else if (packet instanceof RtcpPayloadSpecificFeedback) {
      const { feedback } = packet;
      // a FIR names its targets in its entries and leaves the media ssrc at 0
      const targets = 'fir' in feedback ? feedback.fir.map((entry) => entry.ssrc) : [feedback.mediaSsrc];
      for (const layer of session.layers) {
        if (targets.includes(layer.ssrc)) {
          layer.reports.pliCount++;
        }
      }
    }
  }

  private logSummary(session: WebRtcSession): void {
    if (session.activatedAt === undefined) {
      return;
    }
    const video = session.layers.map((layer) => {
      const first =
        layer.firstFrameMs === undefined
          ? 'no frame sent'
          : `first frame after ${layer.firstFrameMs}ms, first keyframe ${layer.firstKeyframeMs === undefined ? 'never' : `after ${layer.firstKeyframeMs}ms`}`;
      return `${summarizeReceiverStats(`video ${layer.rid}`, layer.reports, layer.sent, 90000, { fps: true })}, ${first}`;
    });
    const audio = summarizeReceiverStats('audio', session.audioReports, session.audioSent, 48000);
    const nacks = session.nackedPackets > 0 ? `; ${session.nackedPackets} packets nacked` : '';
    const remb = session.remb ? `; remb ${Math.round(session.remb.min)}-${Math.round(session.remb.max)} kbit/s` : '';
    this.cameraLogger.debug(
      `[WebRTC] ${session.sessionIdentifier.slice(0, 8)} summary (${getDurationSeconds(session.activatedAt)}s): ${video.join('; ')}; ${audio}${nacks}${remb}`,
    );
  }
}

function addVideoLayer(pc: RTCPeerConnection, spec: VideoLayerSpec): VideoLayer {
  const track = new MediaStreamTrack({ kind: 'video' });
  const transceiver = pc.addTransceiver(track, { direction: 'sendonly' });
  return { ...spec, track, transceiver, ssrc: transceiver.sender.ssrc, reports: createReceiverStats() };
}

function videoPayloadType(layer: VideoLayer): number {
  return layer.transceiver.sender.codec?.payloadType ?? VIDEO_PAYLOAD_TYPE;
}

function sinceActivation(session: WebRtcSession): number {
  return Date.now() - (session.activatedAt ?? session.startedAt);
}

function sessionClockTimestamp(session: WebRtcSession, layer: VideoLayer, sourceTimestamp: number): number {
  const { origin, base } = session.videoClock;
  const now = (base + Math.round((performance.now() - origin) * 90)) >>> 0;
  const last = layer.lastTimestamp;
  let timestamp = (sourceTimestamp + (layer.timestampOffset ?? 0)) >>> 0;
  // the iPhone plays all layers on one clock and drops a layer on its own timestamps as too old
  if (last === undefined || isAfter(timestamp, now) || !isAfter(timestamp, last)) {
    timestamp = last === undefined || isAfter(now, last) ? now : (last + 1) >>> 0;
    layer.timestampOffset = (timestamp - sourceTimestamp) >>> 0;
  }
  layer.lastTimestamp = timestamp;
  return timestamp;
}

function isAfter(timestamp: number, other: number): boolean {
  return ((timestamp - other) | 0) > 0;
}

function replayEarlyDtls(pc: RTCPeerConnection, onReplay: (count: number) => void): void {
  // werift starts DTLS only after ICE connects, Apple's relay sends the ClientHello earlier and waits 1 s to resend
  for (const dtlsTransport of pc.dtlsTransports) {
    const early: Buffer[] = [];
    const dataSubscription = dtlsTransport.iceTransport.connection.onData.subscribe((data) => {
      if (dtlsTransport.state === 'new' && isDtlsRecord(data)) {
        early.push(data);
      }
    });
    const stateSubscription = dtlsTransport.onStateChange.subscribe((state) => {
      if (state === 'new') {
        return;
      }
      dataSubscription.unSubscribe();
      stateSubscription.unSubscribe();
      if (state !== 'connecting' || early.length === 0) {
        return;
      }
      setImmediate(() => {
        const socket = dtlsTransport.dtls?.transport.socket;
        if (!socket) {
          return;
        }
        const receive = socket.onData as (data: Buffer) => void;
        for (const data of early) {
          receive(data);
        }
        onReplay(early.length);
      });
    });
  }
}

function isDtlsRecord(data: Buffer): boolean {
  return data.length > 0 && data[0] > 19 && data[0] < 64;
}

const RTP_STREAM_ID_URI = 'urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id';

function freeExtensionId(sdp: string): number {
  const usedIds = new Set<number>();
  for (const match of sdp.matchAll(/^a=extmap:(\d+)/gm)) {
    usedIds.add(Number(match[1]));
  }
  let extId = 1;
  while (usedIds.has(extId) && extId < 14) {
    extId++;
  }
  return extId;
}

function splitSdpSections(sdp: string): string[][] {
  const sections: string[][] = [[]];
  for (const line of sdp.trimEnd().split(/\r?\n/)) {
    if (line.startsWith('m=')) {
      sections.push([]);
    }
    sections[sections.length - 1].push(line);
  }
  return sections;
}

function addVideoLayers(sdp: string, layers: VideoLayer[], extensionId: number): string {
  const sections = splitSdpSections(sdp).map((section) => {
    const layer = layers.find(({ transceiver }) => section.includes(`a=mid:${transceiver.mid}`));
    if (!layer) {
      return section;
    }
    const { rid, tier } = layer;
    const lines = [...section];
    // without a bitrate the viewer reports "no valid streams"
    const connection = lines.findIndex((line) => line.startsWith('c='));
    lines.splice(connection < 0 ? 1 : connection + 1, 0, `b=AS:${tier.peakBitrate}`, `b=TIAS:${tier.peakBitrate * 1000}`);
    // iOS 27 rejects a video offer without an rtpStreamId and werift emits no rid for a send transceiver
    lines.push(
      `a=extmap:${extensionId} ${RTP_STREAM_ID_URI}`,
      `a=rid:${rid} send max-width=${tier.width};max-height=${tier.height};max-fps=${tier.frameRate};max-br=${tier.peakBitrate * 1000}`,
      `a=simulcast:send ${rid}`,
    );
    return lines;
  });
  return `${sections.flat().join('\r\n')}\r\n`;
}
