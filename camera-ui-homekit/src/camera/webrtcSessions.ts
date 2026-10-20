import { isIPv4 } from 'node:net';

import { MediaStreamTrack, RTCPeerConnection, RTCRtpCodecParameters } from 'werift';

import { audioPayloadType as AUDIO_PAYLOAD_TYPE, secureVideoMaxRemoteSessions, videoPayloadType as VIDEO_PAYLOAD_TYPE } from '../constants.js';
import { filterBindAddresses, getDurationSeconds } from '../utils/utils.js';
import { SecureVideoSFrame } from './sframe.js';
import { HevcAccessUnitAssembler, SFrameRtpPacketizer } from './sframeRtp.js';
import { Talkback } from './talkback.js';

import type { CameraDevice, CameraDeviceSource, LoggerService, RtpSession } from '@camera.ui/sdk';
import type { RTCRtpTransceiver, RtpPacket } from 'werift';
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

interface WebRtcSession {
  sessionIdentifier: string;
  pc: RTCPeerConnection;
  vtrack: MediaStreamTrack;
  atrack: MediaStreamTrack;
  videoTransceiver: RTCRtpTransceiver;
  audioTransceiver: RTCRtpTransceiver;
  sframe: SecureVideoSFrame;
  tier: SecureVideoVideoTier;
  source: CameraDeviceSource;
  stream?: RtpSession;
  talkback?: Talkback;
  answered: boolean;
  closed: boolean;
  starting?: boolean;
  startedAt: number;
  reapTimer?: NodeJS.Timeout;
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
    const { tier, source } = this.selectRemoteTier();
    const pc = new RTCPeerConnection({
      codecs: { video: [hevcCodec], audio: [opusCodec] },
      iceUseIpv6: false,
      ...(iceAddress ? { iceInterfaceAddresses: { udp4: iceAddress } } : {}),
    });
    const vtrack = new MediaStreamTrack({ kind: 'video' });
    const atrack = new MediaStreamTrack({ kind: 'audio' });
    const videoTransceiver = pc.addTransceiver(vtrack, { direction: 'sendonly' });
    const audioTransceiver = pc.addTransceiver(atrack, { direction: 'sendonly' });

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
      vtrack,
      atrack,
      videoTransceiver,
      audioTransceiver,
      sframe: new SecureVideoSFrame(true),
      tier,
      source,
      answered: false,
      closed: false,
      startedAt: Date.now(),
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
    const sdpOffer = addVideoRtpStreamId(pc.localDescription?.sdp ?? offer.sdp, tier);

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
    this.cameraLogger.log('[WebRTC] Stopping stream...');
    await session.stream?.stop().catch(() => undefined);
    await session.pc.close().catch(() => undefined);
  }

  public closeAll(): void {
    for (const id of [...this.sessions.keys()]) {
      this.handleEndSession(id);
    }
  }

  private selectRemoteTier(): { tier: SecureVideoVideoTier; source: CameraDeviceSource } {
    return { tier: this.videoTiers[0], source: this.cameraDevice.streamSource };
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
    if (session.stream || session.starting || session.closed) {
      return;
    }
    session.starting = true;
    this.cameraLogger.debug(`[WebRTC] Activating stream (${getDurationSeconds(session.startedAt)}s)`);

    const tier = session.tier;
    const videoPayloadType = session.videoTransceiver.sender.codec?.payloadType ?? VIDEO_PAYLOAD_TYPE;

    const stream = session.source.createRtpSession({ audio: true, video: true, backchannel: true });
    session.stream = stream;
    session.talkback = new Talkback(stream, session.sframe, this.cameraLogger);

    const videoSsrc: number = session.videoTransceiver.sender.ssrc;
    const audioSsrc: number = session.audioTransceiver.sender.ssrc;
    const audioPayloadType = session.audioTransceiver.sender.codec?.payloadType ?? AUDIO_PAYLOAD_TYPE;
    const videoCryptor = session.sframe.videoStream(videoSsrc);
    const audioCryptor = session.sframe.audioStream(audioSsrc);
    const assembler = new HevcAccessUnitAssembler();
    const packetizer = new SFrameRtpPacketizer({ ssrc: videoSsrc, payloadType: videoPayloadType, maxPayload: 1200 });
    const audioPacketizer = new SFrameRtpPacketizer({ ssrc: audioSsrc, payloadType: audioPayloadType, maxPayload: 1200 });

    let mediaFailed = false;
    stream.onVideoRtp.subscribe((rtp: RtpPacket) => {
      if (session.closed || mediaFailed) {
        return;
      }
      try {
        const frame = assembler.push(rtp);
        if (!frame) {
          return;
        }
        const sealed = videoCryptor.protectFrame(frame.data);
        for (const packet of packetizer.packetize(sealed, frame.timestamp, frame.marker)) {
          session.vtrack.writeRtp(packet);
        }
      } catch (error) {
        mediaFailed = true;
        this.cameraLogger.error('[WebRTC] Failed to send video', error);
        this.handleEndSession(session.sessionIdentifier);
      }
    });

    stream.onAudioRtp.subscribe((rtp: RtpPacket) => {
      if (session.closed || mediaFailed || rtp.payload.length === 0) {
        return;
      }
      try {
        const sealed = audioCryptor.protectFrame(rtp.payload);
        for (const packet of audioPacketizer.packetize(sealed, rtp.header.timestamp, rtp.header.marker)) {
          session.atrack.writeRtp(packet);
        }
      } catch (error) {
        mediaFailed = true;
        this.cameraLogger.error('[WebRTC] Failed to send audio', error);
        this.handleEndSession(session.sessionIdentifier);
      }
    });

    await stream.startStream({
      hardware: this.cameraAccessory.cameraStorage.values.useHardwareAcceleration ? 'auto' : undefined,
      video: { codec: 'hevc', mtu: 1200, payloadType: videoPayloadType, fps: tier.frameRate, bitrate: tier.peakBitrate * 1000 },
      audio: { codec: 'opus', mtu: 1200, payloadType: audioPayloadType, sampleRate: 48000, channels: 1, frameDuration: 20 },
    });

    clearTimeout(session.reapTimer);
    this.cameraLogger.log(`[WebRTC] Streaming activated (${getDurationSeconds(session.startedAt)}s)`);
  }
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
const RTP_STREAM_ID = '1';

function addVideoRtpStreamId(sdp: string, tier: SecureVideoVideoTier): string {
  const lines = sdp.split(/\r?\n/);
  const videoStart = lines.findIndex((line) => line.startsWith('m=video'));
  if (videoStart < 0) {
    return sdp;
  }
  let videoEnd = lines.findIndex((line, index) => index > videoStart && line.startsWith('m='));
  if (videoEnd < 0) {
    videoEnd = lines.length;
  }

  // without a bitrate the viewer reports "no valid streams"
  const bitrate = tier.peakBitrate * 1000;
  const connection = lines.findIndex((line, index) => index > videoStart && index < videoEnd && line.startsWith('c='));
  lines.splice(connection < 0 ? videoStart + 1 : connection + 1, 0, `b=AS:${tier.peakBitrate}`, `b=TIAS:${bitrate}`);
  videoEnd += 2;

  const usedIds = new Set<number>();
  for (const line of lines) {
    const match = /^a=extmap:(\d+)/.exec(line);
    if (match) {
      usedIds.add(Number(match[1]));
    }
  }
  let extId = 1;
  while (usedIds.has(extId) && extId < 15) {
    extId++;
  }

  // iOS 27 rejects a video offer without an rtpStreamId and werift emits no rid for a send transceiver
  const insert = [
    `a=extmap:${extId} ${RTP_STREAM_ID_URI}`,
    `a=rid:${RTP_STREAM_ID} send max-width=${tier.width};max-height=${tier.height};max-fps=${tier.frameRate};max-br=${bitrate}`,
    `a=simulcast:send ${RTP_STREAM_ID}`,
  ];
  lines.splice(videoEnd, 0, ...insert);
  return lines.join('\r\n');
}
