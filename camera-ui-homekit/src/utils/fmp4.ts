export type TfdtOffsets = Map<number, bigint>;

export function normalizeFragmentTfdt(fragment: Buffer, offsets: TfdtOffsets): Buffer {
  const out = Buffer.from(fragment);

  eachBox(out, 0, out.length, (type, _boxStart, contentStart, boxEnd) => {
    if (type !== 'moof') return;

    eachBox(out, contentStart, boxEnd, (trafType, _trafStart, trafContent, trafEnd) => {
      if (trafType !== 'traf') return;

      let trackId: number | undefined;
      let tfdtStart: number | undefined;

      eachBox(out, trafContent, trafEnd, (childType, childStart, childContent) => {
        if (childType === 'tfhd') {
          trackId = out.readUInt32BE(childContent + 4); // after version(1) + flags(3)
        } else if (childType === 'tfdt') {
          tfdtStart = childStart;
        }
      });

      if (trackId === undefined || tfdtStart === undefined) return;

      const version = out.readUInt8(tfdtStart + 8);
      const valuePos = tfdtStart + 12;
      const current = version === 1 ? out.readBigUInt64BE(valuePos) : BigInt(out.readUInt32BE(valuePos));

      if (!offsets.has(trackId)) {
        offsets.set(trackId, current);
      }

      let rebased = current - offsets.get(trackId)!;
      if (rebased < 0n) {
        rebased = 0n;
      }

      if (version === 1) {
        out.writeBigUInt64BE(rebased, valuePos);
      } else {
        out.writeUInt32BE(Number(rebased), valuePos);
      }
    });
  });

  return out;
}

export interface TrackTiming {
  timescale: number;
  defaultSampleDuration: number;
}

export function trackTimings(init: Buffer): Map<number, TrackTiming> {
  const timescales = new Map<number, number>();
  const defaults = new Map<number, number>();

  eachBox(init, 0, init.length, (type, _boxStart, contentStart, boxEnd) => {
    if (type !== 'moov') return;

    eachBox(init, contentStart, boxEnd, (moovType, _moovStart, moovContent, moovEnd) => {
      if (moovType === 'trak') {
        let trackId: number | undefined;
        let timescale: number | undefined;
        eachBox(init, moovContent, moovEnd, (trakType, _trakStart, trakContent, trakEnd) => {
          if (trakType === 'tkhd') {
            trackId = init.readUInt32BE(trakContent + (init.readUInt8(trakContent) === 1 ? 20 : 12));
          } else if (trakType === 'mdia') {
            eachBox(init, trakContent, trakEnd, (mdiaType, _mdiaStart, mdiaContent) => {
              if (mdiaType === 'mdhd') {
                timescale = init.readUInt32BE(mdiaContent + (init.readUInt8(mdiaContent) === 1 ? 20 : 12));
              }
            });
          }
        });
        if (trackId !== undefined && timescale) {
          timescales.set(trackId, timescale);
        }
      } else if (moovType === 'mvex') {
        eachBox(init, moovContent, moovEnd, (mvexType, _mvexStart, mvexContent) => {
          if (mvexType === 'trex') {
            defaults.set(init.readUInt32BE(mvexContent + 4), init.readUInt32BE(mvexContent + 12));
          }
        });
      }
    });
  });

  return new Map([...timescales].map(([trackId, timescale]) => [trackId, { timescale, defaultSampleDuration: defaults.get(trackId) ?? 0 }]));
}

export function fragmentDuration(fragment: Buffer, timings: Map<number, TrackTiming>): number | undefined {
  let longest: number | undefined;
  let missing = false;

  eachBox(fragment, 0, fragment.length, (type, _boxStart, contentStart, boxEnd) => {
    if (type !== 'moof') return;

    eachBox(fragment, contentStart, boxEnd, (trafType, _trafStart, trafContent, trafEnd) => {
      if (trafType !== 'traf') return;

      let timing: TrackTiming | undefined;
      let defaultDuration = 0;
      let ticks = 0;

      eachBox(fragment, trafContent, trafEnd, (childType, _childStart, childContent) => {
        const flags = fragment.readUInt32BE(childContent) & 0xffffff;
        if (childType === 'tfhd') {
          timing = timings.get(fragment.readUInt32BE(childContent + 4));
          defaultDuration = timing?.defaultSampleDuration ?? 0;
          if (flags & 0x08) {
            defaultDuration = fragment.readUInt32BE(childContent + 8 + (flags & 0x01 ? 8 : 0) + (flags & 0x02 ? 4 : 0));
          }
        } else if (childType === 'trun') {
          const samples = fragment.readUInt32BE(childContent + 4);
          if (!(flags & 0x100)) {
            ticks += samples * defaultDuration;
            return;
          }
          const stride = 4 * (1 + (flags & 0x200 ? 1 : 0) + (flags & 0x400 ? 1 : 0) + (flags & 0x800 ? 1 : 0));
          let position = childContent + 8 + (flags & 0x01 ? 4 : 0) + (flags & 0x04 ? 4 : 0);
          for (let sample = 0; sample < samples; sample++, position += stride) {
            ticks += fragment.readUInt32BE(position);
          }
        }
      });

      if (!timing) {
        missing = true;
        return;
      }
      longest = Math.max(longest ?? 0, (ticks / timing.timescale) * 1000);
    });
  });

  return missing || !longest ? undefined : longest;
}

const NTP_EPOCH_OFFSET_SECONDS = 2_208_988_800n;

export function ntpToMilliseconds(ntp: bigint): number {
  const seconds = Number((ntp >> 32n) - NTP_EPOCH_OFFSET_SECONDS);
  const fraction = Number(ntp & 0xffffffffn) / 0x100000000;
  return (seconds + fraction) * 1000;
}

export function prependProducerReferenceTime(fragment: Buffer, startedAt: number): Buffer {
  // tvOS 27 hubs read the wall clock from prft and crash homed without it
  let trackId: number | undefined;
  let mediaTime: bigint | undefined;

  eachBox(fragment, 0, fragment.length, (type, _boxStart, contentStart, boxEnd) => {
    if (type !== 'moof' || trackId !== undefined) return;

    eachBox(fragment, contentStart, boxEnd, (trafType, _trafStart, trafContent, trafEnd) => {
      if (trafType !== 'traf' || trackId !== undefined) return;

      eachBox(fragment, trafContent, trafEnd, (childType, childStart, childContent) => {
        if (childType === 'tfhd') {
          trackId = fragment.readUInt32BE(childContent + 4);
        } else if (childType === 'tfdt') {
          const version = fragment.readUInt8(childStart + 8);
          mediaTime = version === 1 ? fragment.readBigUInt64BE(childStart + 12) : BigInt(fragment.readUInt32BE(childStart + 12));
        }
      });
    });
  });

  if (trackId === undefined || mediaTime === undefined) {
    return fragment;
  }

  const milliseconds = BigInt(Math.max(0, Math.round(startedAt)));
  const ntpSeconds = milliseconds / 1000n + NTP_EPOCH_OFFSET_SECONDS;
  const ntpFraction = ((milliseconds % 1000n) << 32n) / 1000n;

  const prft = Buffer.alloc(32);
  prft.writeUInt32BE(32, 0);
  prft.write('prft', 4, 'latin1');
  prft.writeUInt8(1, 8);
  prft.writeUInt32BE(trackId, 12);
  prft.writeBigUInt64BE((ntpSeconds << 32n) | ntpFraction, 16);
  prft.writeBigUInt64BE(mediaTime, 24);

  return Buffer.concat([prft, fragment]);
}

function eachBox(buf: Buffer, start: number, end: number, cb: (type: string, boxStart: number, contentStart: number, boxEnd: number) => void): void {
  let pos = start;
  while (pos + 8 <= end) {
    const size = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);

    let contentStart = pos + 8;
    let boxEnd: number;
    if (size === 1) {
      if (pos + 16 > end) break;
      boxEnd = pos + Number(buf.readBigUInt64BE(pos + 8));
      contentStart = pos + 16;
    } else if (size === 0) {
      boxEnd = end;
    } else {
      boxEnd = pos + size;
    }

    if (boxEnd <= pos || boxEnd > end) break;
    cb(type, pos, contentStart, boxEnd);
    pos = boxEnd;
  }
}
