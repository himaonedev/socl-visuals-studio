const fs = require('node:fs');
const path = require('node:path');
const { buildBackend } = require('./backend.cjs');
function buildLegacyTypeScript({ check = false } = {}) {
  const modules = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../frontend/legacy-modules.json'), 'utf8'));
  buildBackend({ modules, check, label: 'Clipping/Edit UI' });
}
module.exports = { buildLegacyTypeScript };
if (require.main === module) buildLegacyTypeScript({ check: process.argv.includes('--check') });
