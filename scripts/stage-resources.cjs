const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const dest = path.join(root, '.dev-tools/tauri-resources');
require('./backend.cjs').buildBackend();
require('./legacy-typescript.cjs').buildLegacyTypeScript();
fs.mkdirSync(dest, { recursive: true });
for (const folder of ['engine', 'src', 'assets']) fs.cpSync(path.join(root, folder), path.join(dest, folder), {
  recursive: true,
  filter: file => !/(?:^|[\\/])license(?:[\\/]|$)|license-(?:window|preload)|(?:^|[\\/])(?:main\.js|preload\.js|integrity\.json)$/.test(file),
});
fs.mkdirSync(path.join(dest, 'runtime'), { recursive: true });
fs.copyFileSync(path.join(root, '.dev-tools/node-runtime/node.exe'), path.join(dest, 'runtime/node.exe'));
fs.copyFileSync(path.join(root, 'package.json'), path.join(dest, 'package.json'));
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
for (const [name, info] of Object.entries(lock.packages)) {
  if (!name.startsWith('node_modules/') || info.dev || !fs.existsSync(path.join(root, name))) continue;
  fs.cpSync(path.join(root, name), path.join(dest, name), { recursive: true });
}
console.log('Staged engine and production dependencies for Tauri packaging.');
