// Generated from backend/src/catalog-loader.ts by scripts/backend.cjs. Edit the TypeScript source.
'use strict';
// [PRESET-CATALOG] Main-process side: cached catalog first (instant, offline),
// then a background refresh from the socl-asr Worker. Only a catalog whose
// Ed25519 signature verifies AND that passes the strict schema is applied.
const fs = require('fs');
const path = require('path');
const PC = require('./preset-catalog');
const PUBLIC_KEY = require('./preset-catalog-key');
// [ISP-BLOCK] own domain first (XL Axiata blocks *.workers.dev), workers.dev as fallback.
const CATALOG_URL = 'https://cloud.socialvisuals.xyz/v1/catalog';
const CATALOG_FALLBACK = 'https://socl-asr.soclvisuals.workers.dev/v1/catalog';
let current = null; // the validated catalog object in use
function fontExists(name) {
    try {
        const FM = require('./font-metrics');
        return FM.textWidthEm('Ab', name, require('./pipeline-inverse-v1').__test.assFontsDirFs()) != null;
    }
    catch {
        return false;
    }
}
function registries() {
    return { HookPresets: require('./hook-presets'), KineticTitle: require('./kinetic-title'), VideoFx: require('./video-fx') };
}
// Envelope -> validated catalog, or null.
function open(envelope) {
    const obj = PC.verifySigned(envelope, PUBLIC_KEY);
    if (!obj)
        return null;
    const v = PC.validateCatalog(obj, { fontExists });
    return v.ok ? v.catalog : null;
}
function cachePath(userData) { return path.join(userData, 'preset-catalog.json'); }
function loadCached(userData) {
    try {
        const cat = open(JSON.parse(fs.readFileSync(cachePath(userData), 'utf8')));
        if (cat) {
            current = cat;
            PC.applyCatalog(cat, registries());
        }
    }
    catch { /* no cache yet */ }
    return current;
}
async function refresh(userData, { fetchImpl = fetch, timeoutMs = 6000, log } = {}) {
    try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), timeoutMs);
        let r;
        try {
            r = await fetchImpl(CATALOG_URL, { signal: ctl.signal });
        }
        catch {
            r = await fetchImpl(CATALOG_FALLBACK, { signal: ctl.signal });
        }
        clearTimeout(timer);
        if (!r.ok)
            return null;
        const envelope = await r.json();
        const cat = open(envelope);
        if (!cat) {
            log && log('[catalog] rejected: bad signature or schema');
            return null;
        }
        if (current && cat.version <= current.version)
            return null; // nothing newer
        fs.writeFileSync(cachePath(userData), JSON.stringify(envelope));
        current = cat;
        const added = PC.applyCatalog(cat, registries());
        log && log(`[catalog] v${cat.version}: +${added.hookPresets} hook, +${added.captionTemplates} gaya kata, +${added.videoFx} efek`);
        return cat;
    }
    catch {
        return null;
    }
}
module.exports = { loadCached, refresh, current: () => current, CATALOG_URL, __test: { open } };
