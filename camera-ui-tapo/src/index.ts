import { API_EVENT, BasePlugin } from '@camera.ui/sdk';
import { Discovery } from '@seydx/onvif';

import { OnvifCamera } from './camera.js';
import { TapoDoorbellMonitor } from './doorbell-monitor.js';
import { isTapoDiscoveryIdentity, isTapoDoorbellModel } from './tapo-device.js';

import type {
  CameraConfig,
  CameraDevice,
  DeviceStorage,
  DiscoveredCamera,
  DiscoveryProvider,
  JsonSchemaWithoutCallbacks,
  JsonSchema,
  LoggerService,
  PluginAPI,
} from '@camera.ui/sdk';
import type { Onvif } from '@seydx/onvif';

interface OnvifDiscoveredDevice {
  id: string;
  name: string;
  model?: string;
  onvif: Onvif;
  urn?: string;
  username?: string;
  password?: string;
}

interface TapoPluginStorageValues {
  doorbellPort: number;
  h200Address: string;
  videoMotionFallback: boolean;
}

export default class TapoPlugin extends BasePlugin<TapoPluginStorageValues> implements DiscoveryProvider {
  private cameras = new Map<string, OnvifCamera>();

  private existingCameras = new Map<string, CameraDevice>();

  private discoveredDevices = new Map<string, OnvifDiscoveredDevice>();

  private readonly doorbellMonitor: TapoDoorbellMonitor;

  private started = false;

  constructor(logger: LoggerService, api: PluginAPI, storage: DeviceStorage<TapoPluginStorageValues>) {
    super(logger, api, storage);

    this.doorbellMonitor = new TapoDoorbellMonitor(this.logger, () => this.storage.values.doorbellPort ?? 20005);

    this.api.on(API_EVENT.FINISH_LAUNCHING, this.start.bind(this));
    this.api.on(API_EVENT.SHUTDOWN, this.stop.bind(this));
  }

  override get storageSchema(): JsonSchema[] {
    return [
      {
        type: 'number',
        key: 'doorbellPort',
        title: 'UDP-Port der Türklingel',
        description: 'Lokaler UDP-Port für Klingelereignisse von Tapo-Türklingeln und dem H200.',
        defaultValue: 20005,
        minimum: 1,
        maximum: 65535,
        step: 1,
        store: true,
        required: true,
        onSet: async () => this.doorbellMonitor.restart(),
      },
      {
        type: 'string',
        format: 'ipv4',
        key: 'h200Address',
        title: 'H200-Adresse',
        description: 'IPv4-Adresse des Tapo H200. Sie wird standardmäßig für alle eingebundenen Tapo-Türklingeln verwendet.',
        store: true,
        required: false,
      },
      {
        type: 'boolean',
        key: 'videoMotionFallback',
        title: 'Videobewegung als Fallback',
        description: 'Fügt eine lokale Bewegungserkennung hinzu, wenn eine Kamera keine nutzbaren ONVIF-Bewegungsereignisse meldet.',
        defaultValue: true,
        store: true,
        required: true,
      },
    ];
  }

  public async configureCameras(cameras: CameraDevice[]): Promise<void> {
    for (const camera of cameras) {
      this.existingCameras.set(camera.id, camera);
      await this.initializeCamera(camera);
    }
  }

  public async onCameraAdded(camera: CameraDevice): Promise<void> {
    this.existingCameras.set(camera.id, camera);

    let initialCredentials: { username: string; password: string; url: string } | undefined;
    if (camera.nativeId) {
      const device = this.discoveredDevices.get(camera.nativeId);
      if (device?.username && device?.password) {
        const onvifUrl = `http://${device.onvif.hostname}:${device.onvif.port}`;
        initialCredentials = {
          username: device.username,
          password: device.password,
          url: onvifUrl,
        };
        // Clear credentials but keep device info for onCameraReleased
        delete device.username;
        delete device.password;
      }
    }

    await this.initializeCamera(camera, initialCredentials);
  }

  public async onCameraReleased(cameraId: string): Promise<void> {
    const cameraDevice = this.existingCameras.get(cameraId);

    const onvifCamera = this.cameras.get(cameraId);
    if (onvifCamera) {
      onvifCamera.destroy();
      this.cameras.delete(cameraId);

      if (this.doorbellMonitor.sensorCount === 0) {
        this.doorbellMonitor.stop();
      }
    }

    if (cameraDevice?.nativeId) {
      const device = this.discoveredDevices.get(cameraDevice.nativeId);
      if (device) {
        await this.api.deviceManager.pushDiscoveredCameras([
          {
            id: device.id,
            name: device.name,
            model: device.model,
            address: device.onvif.hostname,
          },
        ]);
      }
    }

    this.existingCameras.delete(cameraId);
  }

  private async initializeCamera(camera: CameraDevice, initialCredentials?: { username: string; password: string; url: string }): Promise<void> {
    const onvifCamera = new OnvifCamera(camera, this.logger, {
      doorbellMonitor: this.doorbellMonitor,
      isDoorbell: isTapoDoorbellModel(camera.info.model) || camera.type === 'doorbell',
      videoMotionFallback: this.storage.values.videoMotionFallback !== false,
      getDefaultDoorbellSource: () => this.storage.values.h200Address?.trim() || undefined,
    });
    this.cameras.set(camera.id, onvifCamera);
    await onvifCamera.initialize(initialCredentials);

    if (this.started && this.doorbellMonitor.sensorCount > 0) {
      try {
        await this.doorbellMonitor.start();
      } catch (error) {
        this.logger.error(`UDP-Port ${this.storage.values.doorbellPort ?? 20005} konnte nicht für Tapo-Klingelereignisse geöffnet werden:`, error);
      }
    }
  }

  public async onDiscoverCameras(): Promise<DiscoveredCamera[]> {
    try {
      const devices = (await Discovery.probe({ timeout: 5000, resolve: true })) as Onvif[];

      for (const device of devices) {
        await this.processDiscoveredDevice(device);
      }
    } catch (error) {
      this.logger.error('Tapo-ONVIF-Erkennung fehlgeschlagen:', error);
    }

    const discovered: DiscoveredCamera[] = [];
    for (const [discoveredId, device] of this.discoveredDevices) {
      const existingCamera = Array.from(this.existingCameras.values()).find((c) => c.nativeId === discoveredId);
      if (!existingCamera) {
        discovered.push({
          id: device.id,
          name: device.name,
          model: device.model,
          address: device.onvif.hostname,
        });
      }
    }

    return discovered;
  }

  public async onGetCameraSettings(_camera: DiscoveredCamera): Promise<JsonSchemaWithoutCallbacks[]> {
    return [
      {
        type: 'string',
        key: 'username',
        title: 'Benutzername',
        description: 'Benutzername des lokalen ONVIF-/RTSP-Kamerakontos.',
        required: true,
      },
      {
        type: 'string',
        format: 'password',
        key: 'password',
        title: 'Passwort',
        description: 'Passwort des lokalen ONVIF-/RTSP-Kamerakontos.',
        required: true,
      },
    ];
  }

  public async onAdoptCamera(camera: DiscoveredCamera, settings: Record<string, unknown>): Promise<CameraConfig> {
    const device = this.discoveredDevices.get(camera.id);

    if (!device?.onvif) {
      throw new Error('Das erkannte ONVIF-Gerät ist nicht mehr verfügbar');
    }

    const onvif = device.onvif;
    const username = settings.username as string;
    const password = settings.password as string;

    if (!username || !password) {
      throw new Error('Benutzername und Passwort sind erforderlich');
    }

    onvif.username = username;
    onvif.password = password;

    this.logger.log(`Verbindung zur Tapo-Kamera ${camera.name} wird hergestellt ...`);
    await onvif.connect();

    const deviceInfo = await onvif.device.getDeviceInformation();
    const cameraName = deviceInfo?.model ? `${deviceInfo.manufacturer ?? 'ONVIF'} ${deviceInfo.model}` : camera.name;

    const media = await onvif.media.getMediaSources();

    if (media.sources.length === 0) {
      throw new Error('Die Kamera hat keine ONVIF-/RTSP-Streamadresse geliefert');
    }

    this.logger.log(`Tapo-Kamera verbunden: ${cameraName} (${media.sources.length} Streams)`);

    const config: CameraConfig = {
      name: cameraName,
      nativeId: camera.id,
      info: {
        manufacturer: deviceInfo?.manufacturer,
        model: deviceInfo?.model,
        serialNumber: deviceInfo?.serialNumber != null ? String(deviceInfo.serialNumber) : undefined,
        firmwareVersion: deviceInfo?.firmwareVersion,
      },
      sources: [],
    };

    if (media.high) {
      const safeName = media.high.profileName.toLowerCase().replace(/[^a-z0-9_]/g, '_');
      config.sources.push({
        name: safeName,
        role: 'high-resolution',
        urls: [this.embedCredentials(media.high.streamUri, username, password)],
        useForSnapshot: media.snapshot === media.high && !!media.high.snapshotUri,
        hotMode: true,
        preload: true,
      });
    }

    if (media.mid) {
      const safeName = media.mid.profileName.toLowerCase().replace(/[^a-z0-9_]/g, '_');
      config.sources.push({
        name: safeName,
        role: 'mid-resolution',
        urls: [this.embedCredentials(media.mid.streamUri, username, password)],
        useForSnapshot: false,
        hotMode: false,
        preload: false,
      });
    }

    if (media.low) {
      const safeName = media.low.profileName.toLowerCase().replace(/[^a-z0-9_]/g, '_');
      config.sources.push({
        name: safeName,
        role: 'low-resolution',
        urls: [this.embedCredentials(media.low.streamUri, username, password)],
        useForSnapshot: false,
        hotMode: false,
        preload: false,
      });
    }

    if (media.snapshot?.snapshotUri) {
      config.sources.push({
        name: 'snapshot',
        role: 'snapshot',
        urls: [this.embedCredentials(media.snapshot.snapshotUri, username, password)],
        useForSnapshot: false,
        hotMode: false,
        preload: false,
      });
    } else if (media.snapshot?.isSnapshot) {
      // JPEG RTSP stream as snapshot fallback (e.g. Tapo cameras)
      const safeName = media.snapshot.profileName.toLowerCase().replace(/[^a-z0-9_]/g, '_');
      config.sources.push({
        name: safeName,
        role: 'snapshot',
        urls: [this.embedCredentials(media.snapshot.streamUri, username, password)],
        useForSnapshot: false,
        hotMode: false,
        preload: false,
      });
    }

    device.username = username;
    device.password = password;

    return config;
  }

  private async stop(): Promise<void> {
    this.started = false;
    for (const onvifCamera of this.cameras.values()) {
      onvifCamera.destroy();
    }
    this.cameras.clear();
    this.doorbellMonitor.stop();
  }

  private async start(): Promise<void> {
    this.started = true;

    if (this.doorbellMonitor.sensorCount === 0) {
      this.logger.debug('Kein Tapo-Türklingelsensor konfiguriert; UDP-Listener wird nicht gestartet');
      return;
    }

    try {
      await this.doorbellMonitor.start();
    } catch (error) {
      this.logger.error(`UDP-Port ${this.storage.values.doorbellPort ?? 20005} konnte nicht für Tapo-Klingelereignisse geöffnet werden:`, error);
    }
  }

  private async processDiscoveredDevice(device: Onvif): Promise<void> {
    const id = device.urn ?? `onvif-${device.hostname}-${device.port}`;

    if (this.discoveredDevices.has(id)) {
      return;
    }

    // discoveryInfo comes from WS-Discovery and is available without authentication.
    const discoveryInfo = device.discoveryInfo;
    const infoName = discoveryInfo?.name?.trim();
    const infoHardware = discoveryInfo?.hardware?.trim();

    if (!isTapoDiscoveryIdentity(infoName, infoHardware)) {
      return;
    }

    let name: string;
    if (infoName && infoHardware) {
      if (infoName === infoHardware) {
        name = infoName;
      } else if (infoName.includes(infoHardware)) {
        name = infoName;
      } else if (infoHardware.includes(infoName)) {
        name = infoHardware;
      } else {
        name = `${infoName} ${infoHardware}`;
      }
    } else if (infoHardware) {
      name = infoHardware;
    } else if (infoName) {
      name = infoName;
    } else {
      name = `Tapo (${device.hostname})`;
    }

    const model = infoHardware;

    this.discoveredDevices.set(id, {
      id,
      name,
      model,
      onvif: device,
      urn: device.urn,
    });
  }

  private embedCredentials(uri: string, username: string, password: string): string {
    try {
      const url = new URL(uri);
      url.username = encodeURIComponent(username);
      url.password = encodeURIComponent(password);
      return url.toString();
    } catch {
      const protocol = uri.split('://')[0];
      const rest = uri.substring(protocol.length + 3);
      return `${protocol}://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${rest}`;
    }
  }
}
