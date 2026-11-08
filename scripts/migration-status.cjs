const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const legacy = fs.readFileSync(path.join(root, 'backend/src/engine-main.ts'), 'utf8');
const native = fs.readFileSync(path.join(root, 'src-tauri/src/legacy_native.rs'), 'utf8');
const declaration = /pub const CHANNELS[^=]*=\s*&\[([\s\S]*?)\];/.exec(native);
if (!declaration) throw new Error('Native channel registry not found');
const nativeChannels = [...declaration[1].matchAll(/"([^"]+)"/g)].map(match => match[1]);
nativeChannels.push('engine:grant-dropped');
const oldChannels = [...legacy.matchAll(/ipcMain\.handle\(\s*["']([^"']+)["']/g)].map(match => match[1]);
const pending = [...new Set(oldChannels)].filter(channel => !nativeChannels.includes(channel)).sort();
const status = {
  nodeEngineRequired: true,
  nativeChannels: [...new Set(nativeChannels)].sort(),
  remainingNodeChannels: pending,
  note: 'This registry tracks IPC ownership, not full feature parity. The Node pipeline and startup are still required.',
};
console.log(JSON.stringify(status, null, 2));
if (process.argv.includes('--write')) fs.writeFileSync(path.join(root, 'MIGRATION-STATUS.json'), JSON.stringify(status, null, 2) + '\n');
