// Generated from backend/src/audit.ts by scripts/backend.cjs. Edit the TypeScript source.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
function audit(event, detail) {
    try {
        const line = JSON.stringify({ t: new Date().toISOString(), event, detail: detail || null }) + '\n';
        fs.appendFileSync(path.join(app.getPath('userData'), 'audit.log'), line);
    }
    catch { }
}
module.exports = { audit };
