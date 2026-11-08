const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const target = path.join(root, '.dev-tools/node-runtime/node.exe');
const version = require('./node-runtime.cjs').prepareNodeRuntime(target);
console.log(`Node sidecar runtime ready (${version}):`, target);

const binaries = path.join(root, 'src-tauri/binaries');
fs.mkdirSync(binaries, { recursive: true });
for (const [name, source] of [['ffmpeg.exe', require('ffmpeg-static')], ['ffprobe.exe', require('@ffprobe-installer/ffprobe').path]]) {
 const destination = path.join(binaries, name);
 if (!fs.existsSync(destination) || fs.statSync(destination).size !== fs.statSync(source).size) fs.copyFileSync(source, destination);
}

