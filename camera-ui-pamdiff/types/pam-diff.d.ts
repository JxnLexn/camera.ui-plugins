declare module 'pam-diff' {
  import { Transform } from 'stream';

  interface PamDiffOptions {
    difference?: number;
    percent?: number;
    response?: 'percent' | 'bounds' | 'blobs';
    regions?: PamDiffRegion[];
    mask?: boolean;
    draw?: boolean;
    debug?: boolean;
  }

  interface PamDiffCoords {
    x: number;
    y: number;
  }

  interface PamDiffRegion {
    name: string;
    difference?: number;
    percent?: number;
    polygon?: PamDiffCoords[];
  }

  interface Trigger {
    name: string;
    percent: number;
    minX?: number;
    maxX?: number;
    minY?: number;
    maxY?: number;
    blobs?: Blob[];
  }

  export interface Blob {
    label: number;
    percent: number;
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
  }

  interface DiffResult {
    trigger: Trigger[];
    pam: Buffer;
    headers: Buffer;
    pixels: Buffer;
    debug?: {
      name: string;
      count: number;
      duration: number;
    };
  }

  class PamDiff extends Transform {
    constructor(options?: PamDiffOptions, callback?: Function);

    config: PamDiffOptions;
    difference: number;
    percent: number;
    response: string;
    regions: PamDiffRegion[];
    mask: boolean;
    draw: boolean;
    debug: boolean;
    callback?: Function;

    setDifference(num: number): PamDiff;
    setPercent(num: number): PamDiff;
    setResponse(str: string): PamDiff;
    setRegions(arr: PamDiffRegion[]): PamDiff;
    setMask(bool: boolean): PamDiff;
    setDraw(bool: boolean): PamDiff;
    setDebug(bool: boolean): PamDiff;
    setCallback(func: Function): PamDiff;
    resetCache(): PamDiff;
    reset(): PamDiff;

    on(event: 'diff', callback: (data: DiffResult) => void): PamDiff;
    on(event: 'data', callback: (data: any) => void): PamDiff;
  }

  export = PamDiff;
}
