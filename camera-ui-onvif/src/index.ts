import { API_EVENT, BasePlugin } from '@camera.ui/sdk';
import { Discovery } from '@seydx/onvif';

import { OnvifCamera } from './camera.js';

import type {
  CameraConfig,
  CameraDevice,
  DeviceStorage,
  DiscoveredCamera,
  DiscoveryProvider,
  JsonSchemaWithoutCallbacks,
  LoggerService,
  PluginAPI,
} from '@camera.ui/sdk';
import type { Onvif } from '@seydx/onvif';

interface OnvifDiscoveredDevice {
  // DiscoveredCamera fields
  id: string;
  name: string;
  model?: string;
  // Metadata
  onvif: Onvif;
  urn?: string;
  // Credentials (set during adoption, used in onCameraAdded)
  username?: string;
  password?: string;
}

export default class OnvifPlugin extends BasePlugin implements DiscoveryProvider {
  private cameras = new Map<string, OnvifCamera>();

  /** Cameras already added to camera.ui (cameraDeviceId -> CameraDevice) */
  private existingCameras = new Map<string, CameraDevice>();

  /** Discovered ONVIF devices (before adoption) */
  private discoveredDevices = new Map<string, OnvifDiscoveredDevice>();

  constructor(logger: LoggerService, api: PluginAPI, storage: DeviceStorage<any>) {
    super(logger, api, storage);

    this.api.on(API_EVENT.SHUTDOWN, this.stop.bind(this));
  }

  public async configureCameras(cameras: CameraDevice[]): Promise<void> {
    for (const camera of cameras) {
      this.existingCameras.set(camera.id, camera);
      await this.initializeCamera(camera);
    }
  }

  public async onCameraAdded(camera: CameraDevice): Promise<void> {
    this.existingCameras.set(camera.id, camera);

    // Get credentials from discovered device if this is a newly adopted camera
    let initialCredentials: { username: string; password: string; url: string } | undefined;
    if (camera.nativeId) {
      const device = this.discoveredDevices.get(camera.nativeId);
      if (device?.username && device?.password) {
        // Build ONVIF URL from device info
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
    }

    // Push the camera back as discovered immediately
    if (cameraDevice?.nativeId) {
      const device = this.discoveredDevices.get(cameraDevice.nativeId);
      if (device) {
        await this.api.deviceManager.pushDiscoveredCameras([
          {
            id: device.id,
            name: device.name,
            model: device.model,
          },
        ]);
      }
    }

    this.existingCameras.delete(cameraId);
  }

  private async initializeCamera(camera: CameraDevice, initialCredentials?: { username: string; password: string; url: string }): Promise<void> {
    const onvifCamera = new OnvifCamera(camera, this.logger);
    this.cameras.set(camera.id, onvifCamera);
    await onvifCamera.initialize(initialCredentials);
  }

  public async onDiscoverCameras(): Promise<DiscoveredCamera[]> {
    try {
      const devices = (await Discovery.probe({ timeout: 5000, resolve: true })) as Onvif[];

      for (const device of devices) {
        await this.processDiscoveredDevice(device);
      }
    } catch (error) {
      this.logger.error('ONVIF discovery scan failed:', error);
    }

    // Filter out cameras that are already added to camera.ui
    const discovered: DiscoveredCamera[] = [];
    for (const [discoveredId, device] of this.discoveredDevices) {
      const existingCamera = Array.from(this.existingCameras.values()).find((c) => c.nativeId === discoveredId);
      if (!existingCamera) {
        discovered.push({
          id: device.id,
          name: device.name,
          model: device.model,
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
        title: 'Username',
        description: 'ONVIF username for authentication',
        required: true,
      },
      {
        type: 'string',
        format: 'password',
        key: 'password',
        title: 'Password',
        description: 'ONVIF password for authentication',
        required: true,
      },
    ];
  }

  public async onAdoptCamera(camera: DiscoveredCamera, settings: Record<string, unknown>): Promise<CameraConfig> {
    const device = this.discoveredDevices.get(camera.id);

    if (!device?.onvif) {
      throw new Error('ONVIF device instance not found');
    }

    const onvif = device.onvif;
    const username = settings.username as string;
    const password = settings.password as string;

    if (!username || !password) {
      throw new Error('Username and password are required');
    }

    // Set credentials and connect
    onvif.username = username;
    onvif.password = password;

    this.logger.log(`Connecting to ONVIF device: ${camera.name}...`);
    await onvif.connect();

    // Get device information (must be called explicitly after connect)
    const deviceInfo = await onvif.device.getDeviceInformation();
    const cameraName = deviceInfo?.model ? `${deviceInfo.manufacturer ?? 'ONVIF'} ${deviceInfo.model}` : camera.name;

    // Get all media sources using the new categorized method
    const media = await onvif.media.getMediaSources();

    if (media.sources.length === 0) {
      throw new Error('Failed to get any stream URI from ONVIF device');
    }

    this.logger.log(`ONVIF device connected: ${cameraName} (${media.sources.length} stream(s))`);

    // Build camera config with categorized streams
    const config: CameraConfig = {
      name: cameraName,
      nativeId: camera.id,
      info: {
        manufacturer: deviceInfo?.manufacturer,
        model: deviceInfo?.model,
        // Some cameras return serialNumber as number, ensure it's a string
        serialNumber: deviceInfo?.serialNumber != null ? String(deviceInfo.serialNumber) : undefined,
        firmwareVersion: deviceInfo?.firmwareVersion,
      },
      sources: [],
    };

    // High resolution stream
    if (media.high) {
      const safeName = media.high.profileName.toLowerCase().replace(/[^a-z0-9_]/g, '_');
      config.sources.push({
        name: safeName,
        role: 'high-resolution',
        urls: [this.embedCredentials(media.high.streamUri, username, password)],
        useForSnapshot: media.snapshot === media.high && !!media.high.snapshotUri,
        hotMode: true,
        preload: true,
        prebuffer: false,
      });
    }

    // Mid resolution stream (if available)
    if (media.mid) {
      const safeName = media.mid.profileName.toLowerCase().replace(/[^a-z0-9_]/g, '_');
      config.sources.push({
        name: safeName,
        role: 'mid-resolution',
        urls: [this.embedCredentials(media.mid.streamUri, username, password)],
        useForSnapshot: false,
        hotMode: false,
        preload: false,
        prebuffer: false,
      });
    }

    // Low resolution stream (if available)
    if (media.low) {
      const safeName = media.low.profileName.toLowerCase().replace(/[^a-z0-9_]/g, '_');
      config.sources.push({
        name: safeName,
        role: 'low-resolution',
        urls: [this.embedCredentials(media.low.streamUri, username, password)],
        useForSnapshot: false,
        hotMode: false,
        preload: false,
        prebuffer: false,
      });
    }

    // Snapshot source - dedicated HTTP URL or JPEG RTSP stream
    if (media.snapshot?.snapshotUri) {
      // Dedicated HTTP Snapshot URL available
      config.sources.push({
        name: 'snapshot',
        role: 'snapshot',
        urls: [this.embedCredentials(media.snapshot.snapshotUri, username, password)],
        useForSnapshot: false,
        hotMode: false,
        preload: false,
        prebuffer: false,
      });
    } else if (media.snapshot?.isSnapshot) {
      // JPEG RTSP Stream as snapshot fallback (e.g., Tapo cameras)
      const safeName = media.snapshot.profileName.toLowerCase().replace(/[^a-z0-9_]/g, '_');
      config.sources.push({
        name: safeName,
        role: 'snapshot',
        urls: [this.embedCredentials(media.snapshot.streamUri, username, password)],
        useForSnapshot: false,
        hotMode: false,
        preload: false,
        prebuffer: false,
      });
    }

    // Store credentials in device for onCameraAdded to use
    device.username = username;
    device.password = password;

    // Keep discoveredDevices so we can push it back if camera is released
    // Credentials will be cleared in onCameraAdded after being saved to storage

    return config;
  }

  private async stop(): Promise<void> {
    for (const onvifCamera of this.cameras.values()) {
      onvifCamera.destroy();
    }
    this.cameras.clear();
  }

  private async processDiscoveredDevice(device: Onvif): Promise<void> {
    // Use URN or hostname:port as unique ID
    const id = device.urn ?? `onvif-${device.hostname}-${device.port}`;

    // Skip if already discovered
    if (this.discoveredDevices.has(id)) {
      return;
    }

    // Use discoveryInfo from WS-Discovery (available WITHOUT authentication)
    const discoveryInfo = device.discoveryInfo;
    const infoName = discoveryInfo?.name?.trim();
    const infoHardware = discoveryInfo?.hardware?.trim();

    // Build camera name from discoveryInfo
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
      name = `ONVIF (${device.hostname})`;
    }

    const model = infoHardware;

    // Store discovered device with all info
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
      // If URL parsing fails, try simple string replacement
      const protocol = uri.split('://')[0];
      const rest = uri.substring(protocol.length + 3);
      return `${protocol}://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${rest}`;
    }
  }
}
