import { PTZCapability, PTZControl } from '@camera.ui/sdk';

import type { CameraDevice, PTZDirection, PTZPosition } from '@camera.ui/sdk';
import type { Onvif, PTZStatus } from '@seydx/onvif';

const POLL_INTERVAL_MS = 200;
const POSITION_EPSILON = 0.001;
const IDLE_POLLS_TO_STOP = 3;
const FAST_PATH_GRACE_MS = 1500;

export class OnvifPTZSensor extends PTZControl {
  private device: Onvif;
  private cameraDevice: CameraDevice;

  private pollingTimer?: NodeJS.Timeout;
  private lastPolledPosition?: { pan?: number; tilt?: number; zoom?: number };
  private idleStreak = 0;
  private lastPollErrorMessage?: string;
  private fastPathUntilTs = 0;

  constructor(cameraDevice: CameraDevice, device: Onvif, name = 'ONVIF PTZ') {
    super(name);
    this.cameraDevice = cameraDevice;
    this.device = device;
  }

  protected override onAssigned(): void {
    if (this.pollingTimer) return;
    this.cameraDevice.logger.debug('PTZ sensor assigned — starting motion-state polling');
    this.pollingTimer = setInterval(() => {
      this.pollStatus();
    }, POLL_INTERVAL_MS);
  }

  protected override onDeassigned(): void {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = undefined;
    }
    this.lastPolledPosition = undefined;
    this.idleStreak = 0;
    this.lastPollErrorMessage = undefined;
    this.fastPathUntilTs = 0;
    this.cameraDevice.logger.debug('PTZ sensor deassigned — stopped motion-state polling');
  }

  getDevice(): Onvif | undefined {
    return this.device;
  }

  async initialize(): Promise<void> {
    if (this.device) {
      await this.detectCapabilities();
    }
  }

  override async setPosition(position: PTZPosition): Promise<void> {
    try {
      await this.device.ptz.absoluteMove({
        position: {
          pan: position.pan,
          tilt: position.tilt,
          zoom: position.zoom,
        },
      });

      await super.setPosition(position);
    } catch (error) {
      if (!this.ignoreError(error)) {
        this.cameraDevice.logger.error('PTZ absoluteMove failed:', error);
      }
    }
  }

  override async setVelocity(velocity: PTZDirection | undefined): Promise<void> {
    if (!velocity) {
      return;
    }

    const isStop = velocity.panSpeed === 0 && velocity.tiltSpeed === 0 && velocity.zoomSpeed === 0;

    this.setMoving(!isStop);
    this.fastPathUntilTs = Date.now() + FAST_PATH_GRACE_MS;
    this.lastPolledPosition = undefined;
    this.idleStreak = 0;

    try {
      if (isStop) {
        await this.device.ptz.stop();
      } else {
        await this.device.ptz.continuousMove({
          velocity: {
            x: velocity.panSpeed ?? 0,
            y: velocity.tiltSpeed ?? 0,
            zoom: velocity.zoomSpeed ?? 0,
          },
          timeout: 1000,
        });
      }

      await super.setVelocity(velocity);
    } catch (error) {
      this.fastPathUntilTs = 0;
      this.setMoving(false);
      if (!this.ignoreError(error)) {
        this.cameraDevice.logger.error(`PTZ ${isStop ? 'stop' : 'continuousMove'} failed:`, error);
      }
    }
  }

  override async setTargetPreset(preset: string | undefined): Promise<void> {
    if (!preset) {
      return;
    }

    try {
      await this.device.ptz.gotoPreset({
        presetToken: preset,
      });

      await super.setTargetPreset(preset);
    } catch (error) {
      if (!this.ignoreError(error)) {
        this.cameraDevice.logger.error('PTZ gotoPreset failed:', error);
      }
    }
  }

  override async goHome(): Promise<void> {
    const hasHomeCapability = this.capabilities.includes(PTZCapability.Home);

    try {
      if (hasHomeCapability) {
        await this.device.ptz.gotoHomePosition({});
        await super.setPosition({ pan: 0, tilt: 0, zoom: 0 });
      } else {
        await this.setPosition({ pan: 0, tilt: 0, zoom: 0 });
      }
    } catch (error) {
      if (!this.ignoreError(error)) {
        this.cameraDevice.logger.error('PTZ goHome failed:', error);
      }
    }
  }

  private async detectCapabilities(): Promise<void> {
    const hasPTZ = this.device.defaultProfile?.PTZConfiguration !== undefined;
    const canPanTilt =
      this.device.defaultProfile?.PTZConfiguration?.defaultAbsolutePantTiltPositionSpace !== undefined ||
      this.device.defaultProfile?.PTZConfiguration?.defaultContinuousPanTiltVelocitySpace !== undefined ||
      this.device.defaultProfile?.PTZConfiguration?.defaultRelativePanTiltTranslationSpace !== undefined;
    const canZoom =
      this.device.defaultProfile?.PTZConfiguration?.defaultAbsoluteZoomPositionSpace !== undefined ||
      this.device.defaultProfile?.PTZConfiguration?.defaultContinuousZoomVelocitySpace !== undefined ||
      this.device.defaultProfile?.PTZConfiguration?.defaultRelativeZoomTranslationSpace !== undefined;

    const minPan = this.device.defaultProfile?.PTZConfiguration?.panTiltLimits?.range?.XRange?.min ?? 0;
    const maxPan = this.device.defaultProfile?.PTZConfiguration?.panTiltLimits?.range?.XRange?.max ?? 0;
    const minTilt = this.device.defaultProfile?.PTZConfiguration?.panTiltLimits?.range?.YRange?.min ?? 0;
    const maxTilt = this.device.defaultProfile?.PTZConfiguration?.panTiltLimits?.range?.YRange?.max ?? 0;
    const minZoom = this.device.defaultProfile?.PTZConfiguration?.zoomLimits?.range?.XRange?.min ?? 0;
    const maxZoom = this.device.defaultProfile?.PTZConfiguration?.zoomLimits?.range?.XRange?.max ?? 0;

    const hasPan = hasPTZ && canPanTilt && minPan !== 0 && maxPan !== 0;
    const hasTilt = hasPTZ && canPanTilt && minTilt !== 0 && maxTilt !== 0;
    const hasZoom = hasPTZ && canZoom && minZoom !== 0 && maxZoom !== 0;

    const caps: PTZCapability[] = [];
    if (hasPan) caps.push(PTZCapability.Pan);
    if (hasTilt) caps.push(PTZCapability.Tilt);
    if (hasZoom) caps.push(PTZCapability.Zoom);

    let hasHome = false;
    let maxPresets = 0;
    try {
      const nodes = await this.device.ptz.getNodes();
      const nodeValues = nodes ? Object.values(nodes) : [];
      hasHome = nodeValues.some((node) => node.homeSupported);
      if (hasHome) {
        caps.push(PTZCapability.Home);
      }
      maxPresets = nodeValues.reduce((max, node) => Math.max(max, node.maximumNumberOfPresets ?? 0), 0);
    } catch {
      // ignore
    }

    let presetsCount = 0;
    try {
      const presetsResponse = await this.device.ptz.getPresets();
      if (presetsResponse && Object.keys(presetsResponse).length > 0) {
        caps.push(PTZCapability.Presets);
        const presetsList = Object.values(presetsResponse);
        const presetNames = presetsList.map((p: { name?: string; token?: string }) => p.name ?? p.token ?? '').filter(Boolean);
        this.setPresets(presetNames);
        presetsCount = presetNames.length;
      }
    } catch {
      // ignore
    }

    this.cameraDevice.logger.log('PTZ capabilities:', {
      pan: hasPan,
      tilt: hasTilt,
      zoom: hasZoom,
      home: hasHome,
      presets: presetsCount > 0 ? `${presetsCount}/${maxPresets || '?'}` : false,
    });

    if (!hasPan && !hasTilt && !hasZoom) {
      this.cameraDevice.logger.warn('Camera does not support PTZ');
    }

    // Triggers broadcast to consumers.
    this.capabilities = caps;
  }

  private async pollStatus(): Promise<void> {
    // Fast-path grace window: suppress polling so it can't second-guess a just-committed setVelocity.
    if (Date.now() < this.fastPathUntilTs) return;

    let status: PTZStatus;
    try {
      status = await this.device.ptz.getStatus();
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      if (message !== this.lastPollErrorMessage) {
        this.cameraDevice.logger.trace('PTZ getStatus poll failed:', message);
        this.lastPollErrorMessage = message;
      }
      return;
    }

    this.lastPollErrorMessage = undefined;

    const pt = status.moveStatus?.panTilt;
    const z = status.moveStatus?.zoom;
    const pos = {
      pan: status.position?.panTilt?.x,
      tilt: status.position?.panTilt?.y,
      zoom: status.position?.zoom?.x,
    };

    // Publish position changes for the autotracker; super.setPosition only writes SDK state, no hardware action.
    const current = this.position;
    const posDelta = Math.max(
      Math.abs((pos.pan ?? 0) - (current?.pan ?? 0)),
      Math.abs((pos.tilt ?? 0) - (current?.tilt ?? 0)),
      Math.abs((pos.zoom ?? 0) - (current?.zoom ?? 0)),
    );
    if (posDelta > POSITION_EPSILON) {
      await super.setPosition({
        pan: pos.pan ?? current?.pan ?? 0,
        tilt: pos.tilt ?? current?.tilt ?? 0,
        zoom: pos.zoom ?? current?.zoom ?? 0,
      });
    }

    // Primary signal: ONVIF MoveStatus (IDLE/MOVING, not UNKNOWN); some PTZs report only panTilt or only zoom.
    const ptUsable = pt === 'IDLE' || pt === 'MOVING';
    const zUsable = z === 'IDLE' || z === 'MOVING';
    if (ptUsable || zUsable) {
      const moving = pt === 'MOVING' || z === 'MOVING';
      this.setMoving(moving);
      this.lastPolledPosition = pos;
      this.idleStreak = moving ? 0 : this.idleStreak + 1;
      return;
    }

    // Fallback: position-delta. Needs at least one prior sample.
    if (!this.lastPolledPosition) {
      this.lastPolledPosition = pos;
      return;
    }
    const delta = Math.max(
      Math.abs((pos.pan ?? 0) - (this.lastPolledPosition.pan ?? 0)),
      Math.abs((pos.tilt ?? 0) - (this.lastPolledPosition.tilt ?? 0)),
      Math.abs((pos.zoom ?? 0) - (this.lastPolledPosition.zoom ?? 0)),
    );
    this.lastPolledPosition = pos;

    if (delta > POSITION_EPSILON) {
      this.setMoving(true);
      this.idleStreak = 0;
    } else {
      this.idleStreak++;
      // Flip to IDLE only after N consecutive no-delta polls to ride out jitter.
      if (this.idleStreak >= IDLE_POLLS_TO_STOP) {
        this.setMoving(false);
      }
    }
  }

  private ignoreError(error: unknown): boolean {
    if (error instanceof Error && error.message.includes('Response does not match the HTTP/1.1 protocol')) {
      return true;
    }
    return false;
  }
}
