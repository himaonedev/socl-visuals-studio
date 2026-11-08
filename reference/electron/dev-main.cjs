// Isolated development profile: configure paths before loading the application.
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const profileRoot = path.join(__dirname, '.dev-tools', 'dev-profile');
const userData = path.join(profileRoot, 'user-data');
const sessionData = path.join(profileRoot, 'session-data');
const diskCache = path.join(profileRoot, 'disk-cache');
for (const folder of [userData, sessionData, diskCache]) {
  fs.mkdirSync(folder, { recursive: true });
  // Fail with the actual path if this checkout is not writable.
  fs.accessSync(folder, fs.constants.W_OK);
}
app.setPath('userData', userData);
app.setPath('sessionData', sessionData);
app.commandLine.appendSwitch('disk-cache-dir', diskCache);
console.log('[dev] Profile:', profileRoot);
if (process.argv.includes('--local-dev-license')) {
  const Module = require('node:module');
  const licensePath = require.resolve('./src/license/licenseManager.js');
  const adapterModule = new Module(licensePath, module);
  adapterModule.filename = licensePath;
  adapterModule.exports = require('./dev-license.cjs');
  adapterModule.loaded = true;
  require.cache[licensePath] = adapterModule;
  console.log('[dev] Local development license adapter enabled.');
}
require('./src/main.js');

