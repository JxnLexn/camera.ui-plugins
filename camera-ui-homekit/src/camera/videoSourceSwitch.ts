import { startsH264Keyframe } from './sframeRtp.js';

import type { RtpSession } from '@camera.ui/sdk';
import type { RtpPacket } from 'werift';

interface SourceOffsets {
  sequence: number;
  timestamp: number;
}

export class VideoSourceSwitch {
  private pending?: RtpSession;
  private offsets?: SourceOffsets;
  private lastSequence?: number;
  private lastTimestamp?: number;
  private lastSentAt = 0;
  private pendingSince = 0;

  constructor(
    private active: RtpSession,
    private onSwitch: (session: RtpSession, previous: RtpSession, waitedMs: number) => void,
  ) {}

  public get current(): RtpSession {
    return this.active;
  }

  public switchTo(session: RtpSession): RtpSession | undefined {
    const dropped = this.pending === session ? undefined : this.pending;
    if (session === this.active) {
      this.pending = undefined;
    } else if (session !== this.pending) {
      this.pending = session;
      this.pendingSince = performance.now();
    }
    return dropped;
  }

  public rewrite(session: RtpSession, rtp: RtpPacket): boolean {
    if (session === this.pending && startsH264Keyframe(rtp.payload)) {
      const previous = this.active;
      this.active = session;
      this.pending = undefined;
      this.offsets = this.anchor(rtp);
      this.onSwitch(session, previous, Math.round(performance.now() - this.pendingSince));
    }
    if (session !== this.active) {
      return false;
    }

    this.offsets ??= { sequence: 0, timestamp: 0 };
    rtp.header.sequenceNumber = (rtp.header.sequenceNumber + this.offsets.sequence) & 0xffff;
    rtp.header.timestamp = (rtp.header.timestamp + this.offsets.timestamp) >>> 0;
    this.lastSequence = rtp.header.sequenceNumber;
    this.lastTimestamp = rtp.header.timestamp;
    this.lastSentAt = performance.now();
    return true;
  }

  private anchor(rtp: RtpPacket): SourceOffsets {
    if (this.lastSequence === undefined || this.lastTimestamp === undefined) {
      return { sequence: 0, timestamp: 0 };
    }
    // the new source continues the timeline where the old one stopped
    const elapsed = Math.max(1, Math.round((performance.now() - this.lastSentAt) * 90));
    return {
      sequence: (this.lastSequence + 1 - rtp.header.sequenceNumber) & 0xffff,
      timestamp: (this.lastTimestamp + elapsed - rtp.header.timestamp) >>> 0,
    };
  }
}
