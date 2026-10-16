import type { CameraUiBuildOptions } from '@camera.ui/cli';

const mode = process.env.MODE || 'production'

const config: CameraUiBuildOptions = {
  input: ['src/main.py'],
  mode: mode === 'development' ? 'development' : 'production',
  external: [],
  additionalFiles: ['helper/bin/libcoremlhelper.dylib'],
  language: 'python',
};

export default config;
