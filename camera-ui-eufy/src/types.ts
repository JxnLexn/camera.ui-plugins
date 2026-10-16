import type { EufyMega, PersistedSession } from '@mega-yfue/eufy-sdk';

export type StreamMode = 'p2p' | 'rtsp';

export interface EufyCameraStorage {
  streamMode?: StreamMode;
}

export interface StorageValues {
  debug?: boolean;
  username?: string;
  password?: string;
  country?: string;
  maxLiveStreamDuration?: number;
  ignoreDevices?: string[];
  captcha?: string;
  captchaCode?: string;
  twoFactorCode?: string;
  session?: StoredSession;
}

export interface StoredSession {
  account: string;
  session: PersistedSession;
}

export interface EufyContext {
  readonly client: EufyMega;
  readonly debug: boolean;
  readonly maxLiveStreamDuration: number;
}
