import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'helper', 'coreml_helper.m');
const output = join(root, 'helper', 'bin', 'libcoremlhelper.dylib');

if (process.platform !== 'darwin') {
  if (process.env.CI) {
    console.error('The CoreML helper only builds on macOS, a release needs a macOS runner');
    process.exit(1);
  }
  console.log('Skipping the CoreML helper, it only builds on macOS');
  process.exit(0);
}

mkdirSync(dirname(output), { recursive: true });
execFileSync(
  'xcrun',
  [
    'clang',
    '-dynamiclib',
    '-fobjc-arc',
    '-O2',
    '-Wall',
    '-Wextra',
    // no x86_64 slice until it has run on an Intel Mac, there the plugin falls back to coremltools
    '-arch',
    'arm64',
    '-mmacosx-version-min=12.0',
    '-install_name',
    '@rpath/libcoremlhelper.dylib',
    '-framework',
    'Foundation',
    '-framework',
    'CoreML',
    '-framework',
    'CoreVideo',
    '-framework',
    'Accelerate',
    '-o',
    output,
    source,
  ],
  { stdio: 'inherit' },
);
execFileSync('codesign', ['--sign', '-', '--force', output], { stdio: 'inherit' });
console.log(`Built ${output}`);
