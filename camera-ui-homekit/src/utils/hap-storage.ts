import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { DeviceStorage, LoggerService } from '@camera.ui/sdk';
import type { HAPStorageBackend } from '../hap.js';

const STORAGE_KEY = 'hap';

export class PluginHapStorage implements HAPStorageBackend {
  private readonly items = new Map<string, unknown>();
  private persisted: Record<string, unknown>;

  constructor(
    private readonly storage: DeviceStorage,
    legacyDir: string,
    logger: LoggerService,
  ) {
    const stored = storage.values[STORAGE_KEY] as Record<string, unknown> | undefined;
    this.persisted = stored ?? readLegacyFiles(legacyDir);
    for (const [key, value] of Object.entries(this.persisted)) {
      this.items.set(key, value);
    }

    if (!stored && this.items.size > 0) {
      storage.setInternalValueSync(STORAGE_KEY, this.persisted);
      logger.log(`Moved the HomeKit pairings from ${legacyDir} into the plugin config`);
    }
  }

  public getItem(key: string): unknown {
    return this.items.get(key);
  }

  public setItemSync(key: string, value: unknown): void {
    this.write({ ...this.persisted, [key]: JSON.parse(JSON.stringify(value)) });
    this.items.set(key, value);
  }

  public removeItemSync(key: string): void {
    if (key in this.persisted) {
      const { [key]: _removed, ...rest } = this.persisted;
      this.write(rest);
    }
    this.items.delete(key);
  }

  private write(persisted: Record<string, unknown>): void {
    this.storage.setInternalValueSync(STORAGE_KEY, persisted);
    this.persisted = persisted;
  }
}

function readLegacyFiles(dir: string): Record<string, unknown> {
  const items: Record<string, unknown> = {};
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return items;
  }

  for (const name of names) {
    if (name.startsWith('.')) {
      continue;
    }

    try {
      const file = join(dir, name);
      if (statSync(file).isFile()) {
        items[name] = JSON.parse(readFileSync(file, 'utf8'));
      }
    } catch {
      // the file storage reads an unreadable file as missing too
    }
  }

  return items;
}
