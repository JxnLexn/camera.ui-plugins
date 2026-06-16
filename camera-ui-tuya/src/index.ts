import { API_EVENT, BasePlugin } from '@camera.ui/sdk';

import { Camera } from './camera.js';
import { TuyaCloudApiClient } from './tuya/cloudApi.js';
import { TuyaSmartApiClient } from './tuya/smartApi.js';
import { AVAILABLE_REGIONS } from './tuya/types.js';

import type {
  CameraConfig,
  CameraDevice,
  DeviceStorage,
  DiscoveredCamera,
  DiscoveryProvider,
  JsonSchema,
  JsonSchemaWithoutCallbacks,
  LoggerService,
  PluginAPI,
} from '@camera.ui/sdk';
import type { Device } from './tuya/types.js';
import type { TuyaConfig } from './types.js';

export default class TuyaPlugin extends BasePlugin<TuyaConfig> implements DiscoveryProvider {
  /** Initialized camera controllers (tuyaCameraId -> Camera) */
  private tuyaCameras = new Map<string, Camera>();

  /** Tuya devices discovered from Tuya API (tuyaDeviceId -> Device) */
  private discoveredTuyaDevices = new Map<string, Device>();

  /** Cameras already added to camera.ui (cameraDeviceId -> CameraDevice) */
  private existingCameras = new Map<string, CameraDevice>();

  /** Promise lock to prevent multiple simultaneous connections */
  private connectPromise: Promise<void> | null = null;

  constructor(logger: LoggerService, api: PluginAPI, storage: DeviceStorage<TuyaConfig>) {
    super(logger, api, storage);

    this.api.on(API_EVENT.FINISH_LAUNCHING, this.start.bind(this));
    this.api.on(API_EVENT.SHUTDOWN, this.stop.bind(this));
  }

  get storageSchema(): JsonSchema[] {
    return [
      {
        type: 'string',
        key: 'email',
        title: 'Email',
        format: 'email',
        description: 'Tuya account email',
        required: true,
        store: true,
        group: 'Smart API',
        onSet: this.scheduleConnect.bind(this),
      },
      {
        type: 'string',
        key: 'password',
        title: 'Password',
        description: 'Tuya account password',
        format: 'password',
        required: true,
        store: true,
        group: 'Smart API',
        onSet: this.scheduleConnect.bind(this),
      },
      {
        type: 'string',
        key: 'clientId',
        title: 'Client ID',
        description: 'Cloud Project client ID',
        required: true,
        store: true,
        group: 'Cloud API',
        onSet: this.scheduleConnect.bind(this),
      },
      {
        type: 'string',
        key: 'clientSecret',
        title: 'Client Secret',
        description: 'Cloud Project client secret',
        required: true,
        store: true,
        group: 'Cloud API',
        onSet: this.scheduleConnect.bind(this),
      },
      {
        type: 'string',
        key: 'uid',
        title: 'User ID',
        description: 'Cloud Project user ID (uid)',
        required: true,
        store: true,
        group: 'Cloud API',
        onSet: this.scheduleConnect.bind(this),
      },
      {
        type: 'string',
        key: 'region',
        title: 'Region',
        description: 'Account region',
        required: true,
        store: true,
        defaultValue: 'West America',
        enum: AVAILABLE_REGIONS.map((region) => region.description),
        onSet: this.scheduleConnect.bind(this),
      },
    ];
  }

  public async configureCameras(cameras: CameraDevice[]): Promise<void> {
    for (const camera of cameras) {
      this.existingCameras.set(camera.id, camera);
      // Note: onCameraAdded will be called when Tuya API connects and device is available
    }
  }

  public async onCameraAdded(camera: CameraDevice): Promise<void> {
    this.existingCameras.set(camera.id, camera);

    // Find the corresponding Tuya device by nativeId
    const tuyaDeviceId = camera.nativeId;
    if (!tuyaDeviceId) {
      this.logger.warn(`Camera ${camera.name} has no nativeId, skipping initialization`);
      return;
    }

    const tuyaDevice = this.discoveredTuyaDevices.get(tuyaDeviceId);
    if (tuyaDevice) {
      // Tuya device is available, initialize it
      await this.initializeCamera(tuyaDevice, camera);
    } else {
      this.logger.debug(`Tuya device ${tuyaDeviceId} not yet discovered, will initialize when available`);
    }
  }

  public async onCameraReleased(cameraId: string): Promise<void> {
    const cameraDevice = this.existingCameras.get(cameraId);
    if (cameraDevice?.nativeId) {
      const cameraController = this.tuyaCameras.get(cameraDevice.nativeId);
      if (cameraController) {
        this.tuyaCameras.delete(cameraDevice.nativeId);
      }

      // Push the camera back as discovered immediately
      const tuyaDevice = this.discoveredTuyaDevices.get(cameraDevice.nativeId);
      if (tuyaDevice) {
        await this.api.deviceManager.pushDiscoveredCameras([
          {
            id: `tuya:${cameraDevice.nativeId}`,
            name: tuyaDevice.deviceName,
            manufacturer: 'Tuya',
            model: tuyaDevice.category ?? undefined,
          },
        ]);
      }
    }
    this.existingCameras.delete(cameraId);
  }

  public async onDiscoverCameras(): Promise<DiscoveredCamera[]> {
    return this.getDiscoveredCameras();
  }

  public async onGetCameraSettings(_camera: DiscoveredCamera): Promise<JsonSchemaWithoutCallbacks[]> {
    // No additional credentials needed - already logged in via plugin config
    return [];
  }

  public async onAdoptCamera(camera: DiscoveredCamera, _settings: Record<string, unknown>): Promise<CameraConfig> {
    // Extract tuya device ID from discovery ID (tuya:deviceId -> deviceId)
    const tuyaDeviceId = camera.id.replace('tuya:', '');
    const tuyaDevice = this.discoveredTuyaDevices.get(tuyaDeviceId);

    if (!tuyaDevice) {
      throw new Error(`Tuya device ${tuyaDeviceId} not found`);
    }

    // Return camera config - backend will create the camera
    const config: CameraConfig = {
      name: tuyaDevice.deviceName,
      nativeId: tuyaDeviceId,
      isCloud: true,
      info: {
        manufacturer: 'Tuya',
        model: tuyaDevice.category,
        serialNumber: tuyaDevice.uuid,
        supportUrl: 'https://support.tuya.com/en/help',
      },
      sources: [
        {
          name: 'P2P',
          role: 'high-resolution',
          useForSnapshot: true,
          hotMode: false,
          preload: false,
          prebuffer: false,
        },
      ],
    };

    this.logger.log(`Adopted camera: ${tuyaDevice.deviceName}`);

    return config;
  }

  private async start(): Promise<void> {
    const hasSmartApiCredentials = !!(this.storage.values.email && this.storage.values.password);
    const hasCloudApiCredentials = !!(this.storage.values.clientId && this.storage.values.clientSecret && this.storage.values.uid);
    const hasRegion = !!this.storage.values.region;

    if ((hasSmartApiCredentials || hasCloudApiCredentials) && hasRegion) {
      try {
        await this.scheduleConnect();
      } catch (error: any) {
        this.logger.error('An error occured during connecting:', error);
      }
    }
  }

  private stop(): void {
    this.discoveredTuyaDevices.clear();
    this.tuyaCameras.clear();
  }

  private async scheduleConnect(): Promise<void> {
    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = this.connect().finally(() => {
      this.connectPromise = null;
    });

    return this.connectPromise;
  }

  private async connect(): Promise<void> {
    try {
      const email = this.storage.values.email;
      const password = this.storage.values.password;
      const clientId = this.storage.values.clientId;
      const clientSecret = this.storage.values.clientSecret;
      const uid = this.storage.values.uid;
      const region = AVAILABLE_REGIONS.find((r) => r.description === this.storage.values.region);

      if (!region) {
        this.logger.error('Invalid region selected. Please select a valid region.');
        return;
      }

      const devices: Device[] = [];
      const useSmartApi = !!(email && password);
      const useCloudApi = !!(clientId && clientSecret && uid);

      if (!useSmartApi && !useCloudApi) {
        this.logger.error('No valid credentials provided. Please provide either Tuya Smart API or Tuya Cloud API credentials.');
        return;
      }

      if (useSmartApi) {
        const smartApi = new TuyaSmartApiClient(region.host, email, password);
        await smartApi.login();

        const devs = await smartApi.getDeviceList();
        for (const device of devs) {
          const deviceExist = devices.some((d) => d.deviceId === device.deviceId);
          if (!deviceExist) {
            devices.push(device);
          }
        }
      }

      if (useCloudApi) {
        const cloudApi = new TuyaCloudApiClient(region.cloudHost, uid, clientId, clientSecret);
        await cloudApi.login();

        const devs = await cloudApi.getDevices();
        for (const device of devs) {
          const deviceExist = devices.some((d) => d.deviceId === device.deviceId);
          if (!deviceExist) {
            devices.push(device);
          }
        }
      }

      // Update discovered devices
      await this.updateDiscoveredDevices(devices);
    } catch (error: any) {
      this.logger.error('An error occured during connecting:', error);
    }
  }

  private async updateDiscoveredDevices(devices: Device[]): Promise<void> {
    // Store all tuya devices and initialize existing ones
    for (const device of devices) {
      const tuyaDeviceId = device.deviceId;
      this.discoveredTuyaDevices.set(tuyaDeviceId, device);

      // Try to initialize existing camera
      await this.initializeExistingCamera(device);
    }

    // Push new cameras to discovery manager
    await this.pushDiscoveredCameras();
  }

  private async initializeExistingCamera(device: Device): Promise<void> {
    const tuyaDeviceId = device.deviceId;

    // Skip if already initialized
    if (this.tuyaCameras.has(tuyaDeviceId)) {
      return;
    }

    // Find existing camera device by nativeId
    const cameraDevice = Array.from(this.existingCameras.values()).find((camera) => camera.nativeId === tuyaDeviceId);

    if (cameraDevice) {
      await this.initializeCamera(device, cameraDevice);
    }
  }

  private async initializeCamera(device: Device, cameraDevice: CameraDevice): Promise<void> {
    const tuyaDeviceId = device.deviceId;

    // Skip if already initialized
    if (this.tuyaCameras.has(tuyaDeviceId)) {
      return;
    }

    const camera = new Camera(this.storage, cameraDevice, device, this.api);
    await camera.initialize();

    this.tuyaCameras.set(tuyaDeviceId, camera);
    this.logger.debug(`Initialized camera: ${device.deviceName}`);
  }

  private async pushDiscoveredCameras(): Promise<void> {
    const discovered = this.getDiscoveredCameras();

    if (discovered.length > 0) {
      this.logger.debug(`Found ${discovered.length} new camera(s), pushing to discovery...`);
      await this.api.deviceManager.pushDiscoveredCameras(discovered);
    }
  }

  private getDiscoveredCameras(): DiscoveredCamera[] {
    const discovered: DiscoveredCamera[] = [];

    for (const [tuyaDeviceId, device] of this.discoveredTuyaDevices) {
      // Skip cameras that are already added to camera.ui
      const existingCamera = Array.from(this.existingCameras.values()).find((camera) => camera.nativeId === tuyaDeviceId);
      if (existingCamera) {
        continue;
      }

      discovered.push({
        id: `tuya:${tuyaDeviceId}`,
        name: device.deviceName,
        manufacturer: 'Tuya',
        model: device.category.toUpperCase(),
      });
    }

    return discovered;
  }
}
