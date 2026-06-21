import { appendFileSync } from 'node:fs';

const NODE = {
  'camera-ui-homekit': 'externals/hap',
  'camera-ui-onvif': 'externals/onvif',
  'camera-ui-ring': 'externals/ring',
  'camera-ui-eufy': '',
  'camera-ui-pamdiff': '',
  'camera-ui-rust-motion': '',
  'camera-ui-smtp': '',
  'camera-ui-tuya': '',
  'camera-ui-wasm-motion': '',
};

const PYTHON = [
  'camera-ui-audio-yamnet',
  'camera-ui-coreml',
  'camera-ui-opencl',
  'camera-ui-opencv',
  'camera-ui-wyze',
];

const changed = JSON.parse(process.env.CHANGED || '[]');
const allNode = changed.includes('shared-node');
const allPython = changed.includes('shared-python');

const node = Object.entries(NODE)
  .filter(([plugin]) => allNode || changed.includes(plugin))
  .map(([plugin, externals]) => ({ plugin, externals }));

const python = PYTHON.filter((plugin) => allPython || changed.includes(plugin));

const out = `node=${JSON.stringify(node)}\npython=${JSON.stringify(python)}\n`;
console.log(out);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, out);
