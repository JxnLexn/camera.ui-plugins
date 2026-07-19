import {
  categorizeEvent,
  extractTopicPaths,
  getAllSupportedDetectionTypes,
  getSupportedDetectionTypes,
  Onvif,
  parseAudioEvent,
  parseDetectionEvent,
  parseMotionEvent,
} from '@seydx/onvif';
import { OnvifAudioSensor, OnvifFaceSensor, OnvifMotionSensor, OnvifObjectSensor, OnvifPTZSensor, TapoDoorbellSensor, TapoVideoMotionSensor } from './sensors/index.js';

import type { CameraDevice, DeviceStorage, LoggerService } from '@camera.ui/sdk';
import type { EventCategory, EventProperties, NotificationMessage } from '@seydx/onvif';
import type { TapoDoorbellMonitor } from './doorbell-monitor.js';

export interface TapoCameraStorageValues {
  username: string;
  password: string;
  url: string;
  motionSource: 'automatic' | 'onvif' | 'video';
}

export interface TapoCameraOptions {
  doorbellMonitor: TapoDoorbellMonitor;
  isDoorbell: boolean;
  videoMotionFallback: boolean;
  getDefaultDoorbellSource: () => string | undefined;
}

interface OnvifCapabilities {
  hasPTZ: boolean;
  hasEvents: boolean;
  eventProperties?: EventProperties;
  advertisedTypes: EventCategory[];
}

export class OnvifCamera {
  public readonly camera: CameraDevice;
  public readonly storage: DeviceStorage<TapoCameraStorageValues>;

  private device?: Onvif;
  private ptzSensor?: OnvifPTZSensor;
  private motionSensor?: OnvifMotionSensor;
  private objectSensor?: OnvifObjectSensor;
  private faceSensor?: OnvifFaceSensor;
  private audioSensor?: OnvifAudioSensor;
  private doorbellSensor?: TapoDoorbellSensor;
  private videoMotionSensor?: TapoVideoMotionSensor;
  private dynamicCapabilities = new Set<EventCategory>();
  private eventLoopRunning = false;
  private capabilities?: OnvifCapabilities;
  private lastEventErrorMessage?: string;

  private reconnectInFlight?: Promise<void>;
  private suppressReconnect = false;

  private readonly logger: LoggerService;

  constructor(
    camera: CameraDevice,
    logger: LoggerService,
    private readonly options: TapoCameraOptions,
  ) {
    this.camera = camera;
    this.logger = logger;
    this.storage = this.createStorage();
  }

  async initialize(initialCredentials?: { username: string; password: string; url: string }): Promise<void> {
    await this.setupDoorbellSensor();

    if (initialCredentials) {
      this.suppressReconnect = true;
      try {
        this.storage.values.username = initialCredentials.username;
        this.storage.values.password = initialCredentials.password;
        this.storage.values.url = initialCredentials.url;
        await this.storage.save();
      } finally {
        this.suppressReconnect = false;
      }
    }

    const values = this.storage.values;
    if (!values?.username || !values?.password || !values?.url) {
      this.camera.logger.attention('Bitte die ONVIF-Zugangsdaten in den Kameraeinstellungen eintragen');
      return;
    }

    await this.connect(values.url, values.username, values.password);
  }

  private async connect(url: string, username: string, password: string): Promise<void> {
    try {
      this.device = await this.connectToDevice(url, username, password);
      this.camera.logger.log('Mit dem Tapo-ONVIF-Gerät verbunden');

      this.camera.connect();

      this.capabilities = await this.detectCapabilities();
      this.camera.logger.debug(
        'ONVIF-Fähigkeiten:',
        JSON.stringify({ hasPTZ: this.capabilities.hasPTZ, hasEvents: this.capabilities.hasEvents, advertisedTypes: this.capabilities.advertisedTypes }),
      );
      // if (this.capabilities.eventProperties) {
      //   this.camera.logger.trace('ONVIF event properties', JSON.stringify(this.capabilities.eventProperties, null, 2));
      // }

      if (this.capabilities.hasPTZ) {
        await this.setupPTZSensor(this.device);
      }

      if (this.capabilities.hasEvents && this.capabilities.advertisedTypes.length > 0) {
        await this.setupEventSensors();
        this.updateEventLoop();
      }

      const motionSource = this.storage.values.motionSource ?? 'automatic';
      const useVideoMotion =
        motionSource === 'video' || (motionSource === 'automatic' && (this.options.isDoorbell || !this.capabilities.advertisedTypes.includes('motion')));
      if (this.options.videoMotionFallback && useVideoMotion && !this.motionSensor) {
        await this.setupVideoMotionSensor();
      }
    } catch (error) {
      this.camera.logger.error('Verbindung zum Tapo-ONVIF-Gerät fehlgeschlagen:', error);
    }
  }

  private async setupPTZSensor(device: Onvif): Promise<void> {
    if (this.ptzSensor) {
      this.ptzSensor.setDevice(device);
      if (this.ptzSensor.isAssigned) {
        await this.ptzSensor.initialize();
      }
      return;
    }

    this.ptzSensor = new OnvifPTZSensor(this.camera, device);
    await this.camera.addSensor(this.ptzSensor);

    this.ptzSensor.onAssignmentChanged.subscribe((assigned) => {
      if (assigned) {
        this.ptzSensor!.initialize();
        this.camera.logger.log('PTZ sensor initialized (assignment changed)');
      }
    });

    if (this.ptzSensor.isAssigned) {
      await this.ptzSensor.initialize();
    }
  }

  async reconnect(): Promise<void> {
    if (this.suppressReconnect) return;
    if (this.reconnectInFlight) return this.reconnectInFlight;

    this.reconnectInFlight = this.doReconnect().finally(() => {
      this.reconnectInFlight = undefined;
    });
    return this.reconnectInFlight;
  }

  private async doReconnect(): Promise<void> {
    const values = this.storage.values;

    if (!values?.username || !values?.password || !values?.url) {
      this.camera.logger.warn('Erneute Verbindung nicht möglich: Zugangsdaten fehlen');
      return;
    }

    this.detachOnvifEvents();

    this.camera.logger.log('Verbindung zum Tapo-ONVIF-Gerät wird neu aufgebaut ...');
    await this.connect(values.url, values.username, values.password);
  }

  destroy(): void {
    this.detachOnvifEvents();
    if (this.doorbellSensor) {
      this.options.doorbellMonitor.remove(this.doorbellSensor);
    }
    this.logger.log('Tapo-Kamera entfernt, Ressourcen werden freigegeben:', this.camera.name);
  }

  private async setupDoorbellSensor(): Promise<void> {
    if (!this.options.isDoorbell || this.doorbellSensor) return;

    this.doorbellSensor = new TapoDoorbellSensor(() => {
      this.camera.logger.debug('Tapo-Ereignisquelle für die Türklingel wurde geändert');
    }, this.options.getDefaultDoorbellSource);
    await this.camera.addSensor(this.doorbellSensor);
    this.options.doorbellMonitor.add(this.doorbellSensor);
  }

  private async setupVideoMotionSensor(): Promise<void> {
    if (this.videoMotionSensor) return;
    this.videoMotionSensor = new TapoVideoMotionSensor();
    await this.camera.addSensor(this.videoMotionSensor);
    this.camera.logger.log('Streambasierte Bewegungserkennung wurde als Fallback hinzugefügt');
  }

  private async setupEventSensors(): Promise<void> {
    const types = this.capabilities?.advertisedTypes ?? [];
    const motionSource = this.storage.values.motionSource ?? 'automatic';
    const useNativeMotion = motionSource === 'onvif' || (motionSource === 'automatic' && !this.options.isDoorbell);

    if (types.includes('motion') && useNativeMotion && !this.motionSensor) {
      this.motionSensor = new OnvifMotionSensor(this.camera, this.topicsForTypes(['motion']));
      await this.camera.addSensor(this.motionSensor);
      this.motionSensor.onAssignmentChanged.subscribe(() => this.updateEventLoop());
    }

    if ((types.includes('person') || types.includes('vehicle') || types.includes('animal')) && !this.objectSensor) {
      this.objectSensor = new OnvifObjectSensor(this.camera, this.topicsForTypes(['person', 'vehicle', 'animal']));
      await this.camera.addSensor(this.objectSensor);
      this.objectSensor.onAssignmentChanged.subscribe(() => this.updateEventLoop());
    }

    if (types.includes('face') && !this.faceSensor) {
      this.faceSensor = new OnvifFaceSensor(this.camera, this.topicsForTypes(['face']));
      await this.camera.addSensor(this.faceSensor);
      this.faceSensor.onAssignmentChanged.subscribe(() => this.updateEventLoop());
    }

    if (types.includes('audio') && !this.audioSensor) {
      this.audioSensor = new OnvifAudioSensor(this.camera, this.topicsForTypes(['audio']));
      await this.camera.addSensor(this.audioSensor);
      this.audioSensor.onAssignmentChanged.subscribe(() => this.updateEventLoop());
    }
  }

  private topicsForTypes(types: EventCategory[]): string[] {
    const topicSet = this.capabilities?.eventProperties?.topicSet;
    if (!topicSet) return [];
    return extractTopicPaths(topicSet).filter((topic) => types.includes(categorizeEvent(topic)));
  }

  private updateEventLoop(): void {
    const anyAssigned = [this.motionSensor, this.objectSensor, this.faceSensor, this.audioSensor].some((s) => s?.isAssigned);

    if (anyAssigned && !this.eventLoopRunning) {
      this.startEventLoop();
    } else if (!anyAssigned && this.eventLoopRunning) {
      this.stopEventLoop();
    }
  }

  private startEventLoop(): void {
    if (!this.device || !this.capabilities || this.eventLoopRunning) return;

    this.device.events.on('event', (message: NotificationMessage) => {
      this.handleEvent(message, this.capabilities!);
    });

    this.device.events.on('error', (error: Error) => {
      if (error.message !== this.lastEventErrorMessage) {
        this.camera.logger.warn('ONVIF event error:', error.message);
        this.lastEventErrorMessage = error.message;
      } else {
        this.camera.logger.trace('ONVIF event error (repeated):', error.message);
      }
    });

    this.device.events.on('pull', () => {
      if (this.lastEventErrorMessage) {
        this.camera.logger.log('ONVIF event polling recovered');
        this.lastEventErrorMessage = undefined;
      }
    });

    this.device.events.on('resubscribed', () => {
      this.camera.logger.trace('ONVIF pullpoint (re)subscribed');
    });

    this.device.events.on('renewfailed', (error: Error) => {
      this.camera.logger.debug('ONVIF subscription renew failed:', error.message ?? error);
    });

    this.device.events.startEventLoop({ messageLimit: 10 });
    this.eventLoopRunning = true;
    this.camera.logger.log('ONVIF-Ereignisempfang gestartet');
  }

  private stopEventLoop(): void {
    if (!this.device || !this.eventLoopRunning) return;

    this.device.events.stopEventLoop();
    this.eventLoopRunning = false;
    this.camera.logger.log('ONVIF-Ereignisempfang beendet');
  }

  private detachOnvifEvents(): void {
    if (!this.device) return;

    this.stopEventLoop();
    this.device.events.removeAllListeners();
    this.eventLoopRunning = false;
  }

  private handleEvent(message: NotificationMessage, capabilities: OnvifCapabilities): void {
    const motionData = parseMotionEvent(message);
    if (motionData) {
      this.trackDynamicCapability('motion', capabilities);
      if (this.motionSensor) {
        this.motionSensor.handleMotion(motionData);
      }

      return;
    }

    const detectionData = parseDetectionEvent(message);
    if (detectionData) {
      this.trackDynamicCapability(detectionData.category, capabilities);

      if (detectionData.category === 'face' && this.faceSensor) {
        this.faceSensor.handleDetection(detectionData);
      } else if ((detectionData.category === 'person' || detectionData.category === 'vehicle' || detectionData.category === 'animal') && this.objectSensor) {
        this.objectSensor.handleDetection({
          category: detectionData.category,
          isDetected: detectionData.isDetected,
          rule: detectionData.rule,
        });
      }
      return;
    }

    const audioData = parseAudioEvent(message);
    if (audioData && this.audioSensor) {
      this.audioSensor.handleAudio(audioData);
      this.trackDynamicCapability('audio', capabilities);
    }
  }

  private trackDynamicCapability(category: EventCategory, capabilities: OnvifCapabilities): void {
    if (!this.dynamicCapabilities.has(category) && !capabilities.advertisedTypes.includes(category)) {
      this.dynamicCapabilities.add(category);
      this.camera.logger.debug(`Discovered new capability (not in TopicSet): ${category}`);

      if (capabilities.eventProperties) {
        const allTypes = getAllSupportedDetectionTypes(capabilities.eventProperties, Array.from(this.dynamicCapabilities));
        this.camera.logger.debug('All detection types:', allTypes.join(', '));
      }
    } else {
      this.dynamicCapabilities.add(category);
    }
  }

  private async connectToDevice(url: string, username: string, password: string): Promise<Onvif> {
    const normalizedUrl = String(url ?? '').trim();

    let cameraUrl: URL;
    try {
      cameraUrl = new URL(normalizedUrl.includes('://') ? normalizedUrl : `http://${normalizedUrl}`);
    } catch {
      const redacted = normalizedUrl.replace(/\/\/[^@/]*@/, '//***@');
      throw new Error(`Ungültige ONVIF-Geräteadresse (${typeof url}): "${redacted}" – erwartet wird beispielsweise http://192.168.1.100`);
    }

    const hostname = cameraUrl.hostname;
    const port = cameraUrl.port;

    const device = new Onvif({
      hostname,
      username,
      password,
      port: port ? parseInt(port) : 80,
      preserveAddress: true,
    });

    return await device.connect();
  }

  private async detectCapabilities(): Promise<OnvifCapabilities> {
    if (!this.device) {
      return { hasPTZ: false, hasEvents: false, advertisedTypes: [] };
    }

    const hasPTZ = this.device.defaultProfile?.PTZConfiguration !== undefined;
    const hasEvents = this.device.uri.events !== undefined;

    let eventProperties: EventProperties | undefined;
    let advertisedTypes: EventCategory[] = [];

    if (hasEvents) {
      try {
        eventProperties = await this.device.events.getEventProperties();
        advertisedTypes = getSupportedDetectionTypes(eventProperties);
      } catch {
        // ignore
      }
    }

    return { hasPTZ, hasEvents, eventProperties, advertisedTypes };
  }

  private createStorage(): DeviceStorage<TapoCameraStorageValues> {
    return this.camera.createStorage<TapoCameraStorageValues>([
      {
        type: 'string',
        key: 'username',
        title: 'Benutzername',
        description: 'Benutzername des lokalen ONVIF-/RTSP-Kamerakontos.',
        store: true,
        required: true,
        onSet: async () => {
          await this.reconnect();
        },
      },
      {
        type: 'string',
        format: 'password',
        key: 'password',
        title: 'Passwort',
        description: 'Passwort des lokalen ONVIF-/RTSP-Kamerakontos.',
        store: true,
        required: true,
        onSet: async () => {
          await this.reconnect();
        },
      },
      {
        type: 'string',
        key: 'url',
        title: 'ONVIF-Adresse',
        description: 'Geräteadresse, beispielsweise http://192.168.1.100:2020',
        store: true,
        required: true,
        onSet: async () => {
          await this.reconnect();
        },
      },
      {
        type: 'string',
        key: 'motionSource',
        title: 'Quelle der Bewegungserkennung',
        description: 'Automatisch verwendet bei Tapo-Türklingeln die Videobewegung und bei normalen Kameras ONVIF. Änderungen werden nach einem Plugin-Neustart wirksam.',
        defaultValue: 'automatic',
        enum: ['automatic', 'onvif', 'video'],
        store: true,
        required: true,
      },
      {
        type: 'button',
        title: 'Neu verbinden',
        key: 'reconnect',
        color: 'success',
        description: 'Verbindung zur Kamera neu aufbauen.',
        onSet: async () => {
          await this.reconnect();
        },
      },
    ]);
  }
}
