// Generated from backend/src/legacy-hook-model-cleanup.ts by scripts/backend.cjs. Edit the TypeScript source.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
// Retired local-hook artifacts are exact children of Electron's userData.
// Never broaden these targets: tracker/Whisper data beside them is still live.
const LEGACY_HOOK_MODEL_TARGETS = Object.freeze([
    'hook-model',
    'llama-gpu-probe.json',
]);
async function removeLegacyHookModel(userData, remove = fs.promises.rm) {
    const removed = [];
    const warnings = [];
    for (const name of LEGACY_HOOK_MODEL_TARGETS) {
        const target = path.join(userData, name);
        if (!fs.existsSync(target))
            continue;
        try {
            await remove(target, { recursive: true, force: true });
            removed.push(name);
        }
        catch (error) {
            warnings.push({ name, message: error?.message || String(error) });
        }
    }
    return { removed, warnings };
}
module.exports = { removeLegacyHookModel, LEGACY_HOOK_MODEL_TARGETS };
