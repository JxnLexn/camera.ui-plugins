import { randomBytes } from 'crypto';
import {
  Accessory,
  AccessoryEventTypes,
  AudioBitrate,
  AudioRecordingCodecType,
  AudioRecordingSamplerate,
  AudioStreamingCodecType,
  AudioStreamingSamplerate,
  CameraController,
  CameraVideoQuality,
  Categories,
  Characteristic,
  ControllerStorage,
  H264Level,
  H264Profile,
  MediaContainerType,
  SecureVideoController,
  Service,
  SRTPCryptoSuites,
  StreamTierAudioBitDepth,
  StreamTierAudioSampleRate,
  StreamTierVideoCodec,
  uuid,
  VideoCodecType,
} from '../hap.js';

import { audioPayloadType, baseAdvertiser, secureVideoMaxRemoteSessions, videoPayloadType } from '../constants.js';
import * as mac from '../utils/mac.js';
import { captureSnapshot } from '../utils/placeholder.js';
import { filterBindAddresses, followInstance, generateValidAccessoryName, Subscribed } from '../utils/utils.js';
import { CmafRecordingDelegate } from './cmafRecordingDelegate.js';
import { MultiTierRtpDelegate } from './multiTierRtpDelegate.js';
import { RecordingDelegate } from './recordingDelegate.js';
import { CameraServices } from './services.js';
import { StreamingDelegate } from './streamingDelegate.js';
import { WebRtcSessions } from './webrtcSessions.js';

import type { CameraDevice, DeviceStorage, LoggerService, PluginAPI, SensorLike, VideoCodec } from '@camera.ui/sdk';
import type { CameraControllerOptions, CameraRecordingOptions, MacAddress, MDNSAdvertiser, PublishInfo, SecureVideoUserAgent } from '../hap.js';
import type HomeKit from '../index.js';
import type { CameraStorageValues } from '../types.js';
import type { RecordingAudio } from './recordingSession.js';
import type { SecureVideoCodec } from './sframeRtp.js';

const PROBE_TIMEOUT = 5000;
const SECURE_VIDEO_CMAF_ENABLED = false as boolean;
const SECURE_VIDEO_AUDIO_TIER = {
  identifier: 1,
  targetAverageBitrate: 24000,
  sampleRate: StreamTierAudioSampleRate.KHZ_48,
  bitDepth: StreamTierAudioBitDepth.BITS_16,
  packetTime: 20,
  channels: 1,
};
const SECURE_VIDEO_CMAF_AUDIO: RecordingAudio = { codec: 'aac' };

export class CameraAccessory extends Subscribed {
  public controller?: CameraController;
  public secureVideoController?: SecureVideoController;
  public cameraStorage: DeviceStorage<CameraStorageValues>;
  public api: PluginAPI;
  public secureVideoCodec: SecureVideoCodec = 'hevc';

  private logger: LoggerService;
  private cameraLogger: LoggerService;
  private cameraDevice: CameraDevice;

  private accessory?: Accessory;
  private cameraServices?: CameraServices;

  private recordingDelegate?: RecordingDelegate;
  private multiTierRtp?: MultiTierRtpDelegate;
  private webrtc?: WebRtcSessions;
  private streamingDelegate?: StreamingDelegate;

  private published = false;
  private publishing?: Promise<void>;
  private cameraSeenOnline = false;
  private instanceId: Promise<string | undefined>;
  private identitySettled = false;

  private sourceCodec: SecureVideoCodec = 'hevc';
  private sourceHotMode: boolean;

  private attachedSensors = new Map<string, SensorLike>();

  private publishedExternalAccessories: Map<MacAddress, Accessory>;
  private accessoryPort: number | undefined;

  private get advertiser(): MDNSAdvertiser {
    return this.cameraStorage.values.advertiser.split(' (')[0] as MDNSAdvertiser;
  }

  constructor(platform: HomeKit, cameraDevice: CameraDevice) {
    super();

    this.api = platform.api;
    this.logger = platform.logger;
    this.cameraLogger = cameraDevice.logger;
    this.cameraDevice = cameraDevice;
    this.publishedExternalAccessories = platform.publishedExternalAccessories;
    this.instanceId = platform.instanceId();
    this.sourceHotMode = this.hotMode();

    this.cameraStorage = this.createCameraStorage();

    this.cameraDevice.onConnected.subscribe(async (connected) => {
      if (connected) {
        await this.publishAccessory(this.cameraSeenOnline);
        this.cameraSeenOnline = true;
        this.recordingDelegate?.resumePrebuffer();
      } else {
        await this.streamingDelegate?.stopAllSessions();
      }
    });

    this.cameraDevice.onPropertyChange('disabled').subscribe(() => {
      this.streamingDelegate?.stopAllSessions();
      this.recordingDelegate?.refreshPrebuffer();
    });

    this.cameraDevice.onPropertyChange('sources').subscribe(() => {
      this.followSourceHotMode();
      this.followSourceCodec();
    });

    this.publishAccessory();
  }

  public get eventActive(): boolean {
    return this.cameraServices?.eventActive ?? false;
  }

  public attachSensor(sensor: SensorLike): void {
    this.attachedSensors.set(sensor.id, sensor);
    this.cameraServices?.addSensor(sensor);
  }

  public detachSensor(sensorId: string): void {
    if (this.attachedSensors.delete(sensorId)) {
      this.cameraServices?.removeSensor(sensorId);
    }
  }

  public async teardown(destroy?: boolean): Promise<void> {
    const wasPublished = this.published;
    this.published = false;

    if (this.accessory) {
      const accessory = this.accessory;
      try {
        if (destroy) {
          this.cameraLogger.log('Removing...');
          await this.accessory.destroy();
        } else if (wasPublished) {
          this.cameraLogger.log('Stopping...');
          await this.accessory.unpublish();
        }
      } finally {
        await this.resetAccessory(destroy);
        const advertiseAddress = await this.cameraStorage.getValue<string>('advertiseAddress');
        if (this.publishedExternalAccessories.get(advertiseAddress!) === accessory) {
          this.publishedExternalAccessories.delete(advertiseAddress!);
        }
      }
    }
  }

  private publishAccessory(republish?: boolean): Promise<void> {
    this.publishing ??= this.runPublishAccessory(republish).finally(() => {
      this.publishing = undefined;
    });
    return this.publishing;
  }

  private async runPublishAccessory(republish?: boolean): Promise<void> {
    if (!this.published) {
      try {
        await this.settleIdentity();

        const accessoryPin = await this.cameraStorage.getValue<string>('accessoryPin');
        const advertiseAddress = await this.cameraStorage.getValue<string>('advertiseAddress');
        const accessoryPortOverride = this.cameraStorage.values.accessoryPortOverride;

        if (this.publishedExternalAccessories.has(advertiseAddress!)) {
          throw new Error(`Accessory ${this.cameraDevice.name} experienced an address collision.`);
        }

        if (!republish) {
          this.cameraLogger.log(`Publishing camera (${this.advertiser})`);
        } else {
          this.cameraLogger.log(`Republishing camera (${this.advertiser})`);
        }

        // the legacy path is H.264 only, forcing it transcodes HEVC cameras
        this.sourceCodec = await this.detectSecureVideoCodec();
        this.secureVideoCodec = this.cameraStorage.values.forceLegacyPath ? 'h264' : this.sourceCodec;
        this.setupAccessory();

        this.accessory!.on(AccessoryEventTypes.LISTENING, (port: number) => {
          this.accessoryPort = port;
          this.cameraLogger.debug(`is running on port ${port}`);
          this.cameraLogger.log(`Please add the camera manually in Home app. Setup Code: ${accessoryPin}`);
        });

        const addresses = filterBindAddresses(await this.api.coreManager.getServerAddresses(), this.cameraLogger);
        let bind = addresses.length ? addresses : undefined;

        if (!bind) {
          this.cameraLogger.debug('No usable server address, binding to: 0.0.0.0');
          bind = ['0.0.0.0'];
        }

        const port = accessoryPortOverride === 0 && this.accessoryPort === undefined ? undefined : accessoryPortOverride || this.accessoryPort;

        const publishInfo: PublishInfo = {
          username: advertiseAddress!,
          pincode: accessoryPin!,
          category: this.accessory!.category,
          port,
          bind,
          addIdentifyingMaterial: true,
          advertiser: this.advertiser,
        };

        await this.accessory!.publish(publishInfo);

        this.publishedExternalAccessories.set(advertiseAddress!, this.accessory!);

        this.published = true;
      } catch (error) {
        this.cameraLogger.error('Error publishing camera', error);
        // keep the pairing, destroying the accessory here would delete it
        await this.accessory?.unpublish();
        await this.unpublishAccessory();
      }
    }
  }

  private async settleIdentity(): Promise<void> {
    if (this.identitySettled) {
      return;
    }

    await followInstance(this.cameraStorage, await this.instanceId, async () => {
      Accessory.cleanupAccessoryData((await this.cameraStorage.getValue<string>('advertiseAddress'))!);
      await this.cameraStorage.setValue('republishId', randomBytes(8).toString('hex'));
      await this.cameraStorage.setValue('accessoryPin', mac.randomPinCode());
      this.cameraLogger.attention('camera.ui runs on a copy of another server, so this camera has a new identity. Pair it again in the Home app.');
    });

    // the schema only reads the pin, one made there changes on every read
    if (!this.cameraStorage.values.accessoryPin) {
      await this.cameraStorage.setValue('accessoryPin', mac.randomPinCode());
    }
    this.identitySettled = true;
  }

  private async unpublishAccessory(reset?: boolean): Promise<void> {
    if (this.accessory) {
      if (!reset) {
        this.accessory.controllerStorage = new ControllerStorage(this.accessory);
      }

      await this.teardown(reset);
    }
  }

  private async republishAccessory(reset?: boolean): Promise<void> {
    await this.unpublishAccessory(reset);
    await this.publishAccessory(!reset);
  }

  private async resetAccessory(destroy?: boolean): Promise<void> {
    if (destroy) {
      this.accessoryPort = undefined;
    }

    await this.recordingDelegate?.stop();
    this.recordingDelegate = undefined;
    await this.streamingDelegate?.cleanup();
    this.streamingDelegate = undefined;
    this.cameraServices?.cleanup();
    this.cameraServices = undefined;
    await this.multiTierRtp?.stopAll();
    this.multiTierRtp = undefined;
    this.webrtc?.closeAll();
    this.webrtc = undefined;
    this.secureVideoController?.removeAllListeners();
    this.secureVideoController = undefined;
    this.accessory?.removeAllListeners();
    this.accessory = undefined;
    this.unsubscribe();
  }

  private setupAccessory(): void {
    this.cameraLogger.log('Configuring camera...');

    const republishId = this.cameraStorage.values.republishId;
    const accessoryUUID = uuid.generate(republishId + '-' + this.cameraDevice.id);

    this.accessory = new Accessory(generateValidAccessoryName(this.cameraDevice.name), accessoryUUID);
    this.accessory.category = this.cameraDevice.type === 'doorbell' ? Categories.VIDEO_DOORBELL : Categories.IP_CAMERA;

    const accessoryInformation = this.accessory.getService(Service.AccessoryInformation);

    accessoryInformation?.setCharacteristic(Characteristic.Name, this.cameraDevice.name);
    accessoryInformation?.setCharacteristic(Characteristic.ConfiguredName, this.cameraDevice.name);
    accessoryInformation?.setCharacteristic(Characteristic.Manufacturer, 'camera.ui');
    accessoryInformation?.setCharacteristic(Characteristic.Identify, true);

    if (this.cameraDevice.info.manufacturer) accessoryInformation?.setCharacteristic(Characteristic.Manufacturer, this.cameraDevice.info.manufacturer);
    if (this.cameraDevice.info.model) accessoryInformation?.setCharacteristic(Characteristic.Model, this.cameraDevice.info.model);
    if (this.cameraDevice.info.serialNumber) accessoryInformation?.setCharacteristic(Characteristic.SerialNumber, this.cameraDevice.info.serialNumber);
    if (this.cameraDevice.info.firmwareVersion) accessoryInformation?.setCharacteristic(Characteristic.FirmwareRevision, this.cameraDevice.info.firmwareVersion);

    this.accessory.on(AccessoryEventTypes.IDENTIFY, () => this.cameraLogger.debug('identified!'));

    this.addSubscriptions(
      this.cameraDevice.onPropertyChange('type').subscribe(({ newData }) => {
        this.cameraLogger.debug('Changing accessory category to', newData);

        if (this.accessory) {
          this.accessory.category = newData === 'doorbell' ? Categories.VIDEO_DOORBELL : Categories.IP_CAMERA;
        }
      }),

      this.cameraDevice.onPropertyChange('name').subscribe(({ newData }) => {
        this.cameraLogger.debug('Changing accessory name', newData);
        accessoryInformation?.setCharacteristic(Characteristic.Name, this.cameraDevice.name);
        accessoryInformation?.setCharacteristic(Characteristic.ConfiguredName, this.cameraDevice.name);
      }),

      this.cameraDevice.onPropertyChange('info').subscribe(({ newData }) => {
        this.cameraLogger.debug('Changing accessory information', newData);
        if (newData.manufacturer) accessoryInformation?.setCharacteristic(Characteristic.Manufacturer, newData.manufacturer);
        if (newData.model) accessoryInformation?.setCharacteristic(Characteristic.Model, newData.model);
        if (newData.serialNumber) accessoryInformation?.setCharacteristic(Characteristic.SerialNumber, newData.serialNumber);
        if (newData.firmwareVersion) accessoryInformation?.setCharacteristic(Characteristic.FirmwareRevision, newData.firmwareVersion);
      }),
    );

    this.cameraServices = new CameraServices(this.accessory, this.cameraDevice, this.attachedSensors.values());
    const cmafAudio = this.secureVideoCodec === 'hevc' && SECURE_VIDEO_CMAF_ENABLED ? SECURE_VIDEO_CMAF_AUDIO : undefined;
    this.recordingDelegate = new RecordingDelegate(this, this.accessory, this.cameraDevice, cmafAudio);

    // HKSV3 remote (WebRTC) is HEVC only and the classic path H.264 only, so the main stream codec picks the path
    if (this.secureVideoCodec === 'hevc') {
      this.cameraLogger.log('HEVC main stream, using Secure Video (HKSV3)');
      this.secureVideoController = this.createSecureVideoController(this.cameraServices.motionService);
      this.accessory.configureController(this.secureVideoController);
    } else {
      this.cameraLogger.log(this.cameraStorage.values.forceLegacyPath ? 'Legacy path forced by setting' : 'H.264 for HomeKit, using the legacy path');
      this.controller = new CameraController(this.createControllerOptions());
      this.accessory.configureController(this.controller);
    }
  }

  private createCameraStorage(): DeviceStorage<CameraStorageValues> {
    return this.cameraDevice.createStorage<CameraStorageValues>([
      {
        type: 'string',
        key: 'qrCode',
        title: 'QR Code',
        description: 'Scan in the Home app to pair the camera.',
        format: 'qrCode',
        group: 'Pairing',
        readonly: true,
        onGet: async () => {
          return this.published ? (this.accessory?.setupURI() ?? '') : '';
        },
      },
      {
        type: 'string',
        key: 'accessoryPin',
        title: 'PIN',
        description: 'Manual pairing code for the Home app.',
        group: 'Pairing',
        store: true,
        readonly: true,
        onGet: async () => {
          return this.cameraStorage.values.accessoryPin ?? '';
        },
      },
      {
        type: 'button',
        title: 'Reset Pairing',
        key: 'reset',
        group: 'Pairing',
        description: 'Unpair and generate a new pairing code.',
        color: 'danger',
        onSet: async () => {
          this.cameraLogger.log('Reset pairing...');
          await this.cameraStorage.setValue('republishId', randomBytes(8).toString('hex'));
          await this.cameraStorage.setValue('accessoryPin', mac.randomPinCode());
          await this.republishAccessory(true);
        },
      },
      {
        type: 'boolean',
        key: 'forceLegacyPath',
        title: 'Force legacy path',
        description: 'Always use the classic HomeKit camera services instead of Secure Video (HKSV3). For homes that stay on iOS 26 or older.',
        group: 'Secure Video',
        defaultValue: false,
        store: true,
        onSet: async (state: boolean) => {
          this.cameraLogger.log('Force legacy path:', state);
          await this.republishAccessory();
        },
      },
      {
        type: 'boolean',
        key: 'allowTranscodingForMobileData',
        title: 'Allow transcoding for mobile data',
        description:
          'Remote view over LTE needs a small HEVC stream. A low or mid resolution source that is not HEVC is transcoded for it, an HEVC source is always sent as it is.',
        group: 'Secure Video',
        condition: { key: 'forceLegacyPath', value: false },
        defaultValue: true,
        store: true,
        onSet: async (state: boolean) => {
          this.cameraLogger.log('Allow transcoding for mobile data:', state);
        },
      },
      {
        type: 'number',
        key: 'accessoryPort',
        title: 'Port',
        description: 'Network port the accessory currently uses.',
        group: 'Advanced',
        readonly: true,
        onGet: async () => {
          return this.accessoryPort;
        },
      },
      {
        type: 'number',
        key: 'accessoryPortOverride',
        title: 'Override Port',
        description: 'Force a fixed port (0 = automatic).',
        group: 'Advanced',
        store: true,
        required: false,
        defaultValue: 0,
        minimum: 0,
        maximum: 65535,
        onSet: async () => {
          await this.republishAccessory();
        },
      },
      {
        type: 'string',
        key: 'advertiser',
        title: 'mDNS advertiser',
        description: 'Backend used to announce the accessory on the network.',
        group: 'Advanced',
        store: true,
        defaultValue: baseAdvertiser[0],
        enum: baseAdvertiser,
        onSet: async (newAdvertiser: any) => {
          const advertiser = newAdvertiser.split(' (')[0] as MDNSAdvertiser;
          this.cameraLogger.log('Changing mDNS advertiser to:', advertiser);
          await this.republishAccessory();
        },
      },
      {
        type: 'string',
        key: 'advertiseAddress',
        title: 'Username',
        description: 'Generated accessory MAC address.',
        readonly: true,
        hidden: true,
        onGet: async () => {
          const republishId = this.cameraStorage.values.republishId;
          return mac.generate(`${republishId}-${this.cameraDevice.id}`);
        },
      },
      {
        type: 'string',
        key: 'republishId',
        title: 'Republish ID',
        description: 'Internal ID used when republishing the accessory.',
        store: true,
        hidden: true,
        defaultValue: '',
      },
      {
        type: 'boolean',
        key: 'alwaysTranscode',
        title: 'Always transcode',
        description: 'Transcode live view even when HomeKit could play the camera stream as it is. Puts extra load on the server.',
        group: 'Advanced',
        defaultValue: false,
        store: true,
        onSet: async (state: boolean) => {
          this.cameraLogger.log('Always transcode:', state);
        },
      },
      {
        type: 'boolean',
        key: 'alwaysTranscodeForRecording',
        title: 'Always transcode for HKSV',
        description:
          'Transcode recordings to H.264 in the size, frame rate and bitrate HomeKit asks for, even when it could take the stream as is. Puts extra load on the server.',
        group: 'Advanced',
        defaultValue: false,
        store: true,
        onSet: async (state: boolean) => {
          this.cameraLogger.log('Always transcode for HKSV:', state);
          this.recordingDelegate?.refreshPrebuffer();
        },
      },
      {
        type: 'boolean',
        key: 'streamAsRequested',
        title: 'Stream as requested',
        description: 'Send live view in exactly the size, frame rate and bitrate HomeKit asks for. Every live stream is transcoded.',
        group: 'Advanced',
        defaultValue: false,
        store: true,
        onSet: async (state: boolean) => {
          this.cameraLogger.log('Stream as requested:', state);
        },
      },
      {
        type: 'boolean',
        key: 'useHardwareAcceleration',
        title: 'Use Hardware Acceleration',
        description: 'When a live stream has to be transcoded, use the GPU for it if one is available. Streams HomeKit can play as they are go out without transcoding.',
        group: 'Advanced',
        defaultValue: true,
        store: true,
        onSet: async (state: boolean) => {
          this.cameraLogger.log('Use hardware acceleration:', state);
        },
      },
      {
        type: 'boolean',
        key: 'useHardwareAccelerationForRecording',
        title: 'Use Hardware Acceleration for HKSV',
        description:
          'When a HomeKit Secure Video recording has to be transcoded, use the GPU for it if one is available. Turn it off for a camera whose recordings break up.',
        group: 'Advanced',
        defaultValue: true,
        store: true,
        onSet: async (state: boolean) => {
          this.cameraLogger.log('Use hardware acceleration for HKSV:', state);
          this.recordingDelegate?.refreshPrebuffer();
        },
      },
    ]);
  }

  private followSourceHotMode(): void {
    const hotMode = this.hotMode();
    if (hotMode === this.sourceHotMode) {
      return;
    }

    this.sourceHotMode = hotMode;
    this.cameraLogger.debug(`Hot mode of the main stream turned ${hotMode ? 'on' : 'off'}`);
    this.recordingDelegate?.refreshPrebuffer();
  }

  private hotMode(): boolean {
    return this.cameraDevice.streamSource.hotMode !== false;
  }

  private async followSourceCodec(): Promise<void> {
    const codec = this.cameraDevice.streamSource.videoCodec;
    if (!this.published || this.publishing || !codec) {
      return;
    }

    if (secureVideoCodecOf(codec) === this.sourceCodec) {
      return;
    }

    this.cameraLogger.log(`Main stream codec changed to ${codec}, republishing`);
    await this.republishAccessory();
  }

  private async detectSecureVideoCodec(): Promise<SecureVideoCodec> {
    const source = this.cameraDevice.streamSource;
    let codec = source.videoCodec;
    if (!codec) {
      try {
        const timeout = new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), PROBE_TIMEOUT));
        const probe = await Promise.race([source.probeStream({ video: true, audio: false }), timeout]);
        codec = probe?.video[0]?.codec;
      } catch (error) {
        this.cameraLogger.warn('[Secure Video] Stream probe failed', error);
      }
    }
    this.cameraLogger.log(`[Secure Video] Source video codec ${codec ?? 'unknown, assuming HEVC'}`);
    if (codec && codec !== 'H264' && codec !== 'H265') {
      this.cameraLogger.log(`${codec} is neither H.264 nor H.265, HomeKit gets the stream transcoded to H.264`);
    }
    return secureVideoCodecOf(codec);
  }

  private createSecureVideoController(motionService: Service): SecureVideoController {
    const recordingDelegate = this.recordingDelegate!;
    // iOS reads the size from the SPS and accepts the native copy for any tier, so the tier list is broad
    const videoTiers = [
      { identifier: 1, quality: CameraVideoQuality.HIGHEST, width: 3840, height: 2160, frameRate: 30, targetAverageBitrate: 4500, peakBitrate: 5000 },
      { identifier: 2, quality: CameraVideoQuality.HIGHEST, width: 3840, height: 2160, frameRate: 24, targetAverageBitrate: 4500, peakBitrate: 5000 },
      { identifier: 3, quality: CameraVideoQuality.HIGH, width: 2560, height: 1440, frameRate: 30, targetAverageBitrate: 2800, peakBitrate: 3000 },
      { identifier: 4, quality: CameraVideoQuality.HIGH, width: 1920, height: 1080, frameRate: 30, targetAverageBitrate: 1700, peakBitrate: 1800 },
      { identifier: 5, quality: CameraVideoQuality.MEDIUM, width: 1920, height: 1080, frameRate: 30, targetAverageBitrate: 1700, peakBitrate: 1800 },
      { identifier: 6, quality: CameraVideoQuality.MEDIUM, width: 1280, height: 720, frameRate: 30, targetAverageBitrate: 768, peakBitrate: 800 },
      { identifier: 7, quality: CameraVideoQuality.LOW, width: 640, height: 360, frameRate: 30, targetAverageBitrate: 180, peakBitrate: 190 },
      { identifier: 8, quality: CameraVideoQuality.LOW, width: 640, height: 360, frameRate: 15, targetAverageBitrate: 180, peakBitrate: 190 },
      { identifier: 9, quality: CameraVideoQuality.LOW, width: 320, height: 240, frameRate: 30, targetAverageBitrate: 180, peakBitrate: 190 },
      { identifier: 10, quality: CameraVideoQuality.HIGH, width: 1600, height: 1200, frameRate: 30, targetAverageBitrate: 2800, peakBitrate: 3000 },
      { identifier: 11, quality: CameraVideoQuality.MEDIUM, width: 1440, height: 1080, frameRate: 30, targetAverageBitrate: 1700, peakBitrate: 1800 },
      { identifier: 12, quality: CameraVideoQuality.LOW, width: 640, height: 480, frameRate: 30, targetAverageBitrate: 180, peakBitrate: 190 },
      { identifier: 13, quality: CameraVideoQuality.HIGH, width: 1080, height: 1920, frameRate: 30, targetAverageBitrate: 1700, peakBitrate: 1800 },
      { identifier: 14, quality: CameraVideoQuality.LOW, width: 360, height: 640, frameRate: 30, targetAverageBitrate: 180, peakBitrate: 190 },
      { identifier: 15, quality: CameraVideoQuality.HIGH, width: 1440, height: 1440, frameRate: 30, targetAverageBitrate: 2800, peakBitrate: 3000 },
      { identifier: 16, quality: CameraVideoQuality.LOW, width: 480, height: 480, frameRate: 30, targetAverageBitrate: 180, peakBitrate: 190 },
    ];

    const codec = this.secureVideoCodec;
    this.multiTierRtp = new MultiTierRtpDelegate(this, this.cameraDevice, { codec, videoTiers, audioTier: SECURE_VIDEO_AUDIO_TIER, videoPayloadType, audioPayloadType });
    const remoteActive = (): boolean => !this.cameraDevice.disabled && (this.secureVideoController?.homeKitCameraActive ?? true);
    this.webrtc = new WebRtcSessions(this, this.cameraDevice, videoTiers, remoteActive);

    const sensorUUID = uuid.generate(`${this.cameraDevice.id}-sensor`);
    const cmafDelegate = SECURE_VIDEO_CMAF_ENABLED ? new CmafRecordingDelegate(this.cameraDevice, recordingDelegate) : undefined;

    const controller = new SecureVideoController({
      sensor: {
        uuid: sensorUUID,
        width: 3840,
        height: 2160,
      },
      video: {
        codec: codec === 'h264' ? StreamTierVideoCodec.H264 : StreamTierVideoCodec.H265,
        payloadType: videoPayloadType,
        tiers: videoTiers,
      },
      audio: {
        payloadType: audioPayloadType,
        tier: SECURE_VIDEO_AUDIO_TIER,
        twoWayAudio: true,
      },
      webrtc: { delegate: this.webrtc, maxSessions: secureVideoMaxRemoteSessions },
      rtp: { delegate: this.multiTierRtp },
      recording: { options: this.createRecordingOptions(), delegate: recordingDelegate },
      ...(cmafDelegate ? { ingest: { delegate: cmafDelegate, userAgent: () => this.secureVideoUserAgent() } } : {}),
      motionService,
      snapshot: () => captureSnapshot(this.cameraDevice, this.eventActive),
    });

    return controller;
  }

  private secureVideoUserAgent(): SecureVideoUserAgent {
    const information = this.accessory?.getService(Service.AccessoryInformation);
    const read = (characteristic: typeof Characteristic.Manufacturer) => {
      const value = information?.getCharacteristic(characteristic).value;
      return typeof value === 'string' ? value : '';
    };
    // the iCloud ingest wants the firmware exactly as in the accessory information
    return {
      software: 'cameraui-homekit',
      vendor: read(Characteristic.Manufacturer),
      model: read(Characteristic.Model),
      firmwareVersion: read(Characteristic.FirmwareRevision),
    };
  }

  private createControllerOptions(): CameraControllerOptions {
    this.streamingDelegate = new StreamingDelegate(this, this.cameraDevice);

    return {
      cameraStreamCount: 10,
      delegate: this.streamingDelegate,
      streamingOptions: {
        supportedCryptoSuites: [SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],
        video: {
          resolutions: [
            [320, 180, 30],
            [320, 240, 15], // required by Apple Watch
            [320, 240, 30],
            [480, 270, 30],
            [480, 360, 30],
            [640, 360, 30],
            [640, 480, 30],
            [1280, 720, 30],
            [1280, 960, 30],
            [1920, 1080, 30],
          ],
          codec: {
            profiles: [H264Profile.BASELINE],
            levels: [H264Level.LEVEL3_1, H264Level.LEVEL3_2, H264Level.LEVEL4_0],
          },
        },
        audio: {
          codecs: [
            {
              type: AudioStreamingCodecType.OPUS,
              // required by Apple Watch
              samplerate: AudioStreamingSamplerate.KHZ_8,
            },
            {
              type: AudioStreamingCodecType.OPUS,
              samplerate: AudioStreamingSamplerate.KHZ_16,
            },
            {
              type: AudioStreamingCodecType.OPUS,
              samplerate: AudioStreamingSamplerate.KHZ_24,
            },
          ],
          twoWayAudio: true,
        },
      },
      recording: {
        options: this.createRecordingOptions(),
        delegate: this.recordingDelegate!,
      },
      sensors: {
        motion: this.cameraServices!.motionService,
      },
    };
  }

  private createRecordingOptions(): CameraRecordingOptions {
    return {
      prebufferLength: 8000,
      mediaContainerConfiguration: [
        {
          type: MediaContainerType.FRAGMENTED_MP4,
          fragmentLength: 4000,
        },
      ],
      video: {
        type: VideoCodecType.H264,
        parameters: {
          levels: [H264Level.LEVEL3_1, H264Level.LEVEL3_2, H264Level.LEVEL4_0],
          profiles: [H264Profile.MAIN],
        },
        resolutions: [
          [1280, 720, 30],
          [1920, 1080, 30],
        ],
      },
      audio: {
        codecs: [
          {
            type: AudioRecordingCodecType.AAC_LC,
            bitrateMode: AudioBitrate.VARIABLE,
            samplerate: AudioRecordingSamplerate.KHZ_32,
            audioChannels: 1,
          },
        ],
      },
    };
  }
}

function secureVideoCodecOf(codec?: VideoCodec): SecureVideoCodec {
  return !codec || codec === 'H265' ? 'hevc' : 'h264';
}
