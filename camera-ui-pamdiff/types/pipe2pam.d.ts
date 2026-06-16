declare module 'pipe2pam' {
  import { Transform } from 'stream';

  interface Pipe2PamOptions {
    pool?: number;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface Pipe2PamHeaders {
    width: number;
    height: number;
    depth: number;
    maxval: number;
    tupltype: string;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface Pipe2PamData {
    width: number;
    height: number;
    depth: number;
    maxval: number;
    tupltype: string;
    headers: Buffer;
    pixels: Buffer;
    pam: Buffer;
  }

  class Pipe2Pam extends Transform {
    constructor(options?: Pipe2PamOptions);

    reset(): void;
  }

  export = Pipe2Pam;
}
