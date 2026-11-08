// Generated from backend/src/bundle-download.ts by scripts/backend.cjs. Edit the TypeScript source.
'use strict';
// Shared timeout-protected downloader for on-demand runtime assets. Keeping
// this model-neutral lets Whisper reuse the proven network safeguards without
// retaining the retired local hook-model bundle.
const fs = require('node:fs');
const https = require('node:https');
const http = require('node:http');
const crypto = require('node:crypto');
const CONNECT_TIMEOUT_MS = 60_000;
const STALL_TIMEOUT_MS = 60_000;
function download(url, destPath, onProgress, opts = {}) {
    const connectTimeoutMs = opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
    const stallTimeoutMs = opts.stallTimeoutMs ?? STALL_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
        let settled = false;
        let stallTimer = null;
        const finish = (fn, value) => {
            if (settled)
                return;
            settled = true;
            if (stallTimer)
                clearTimeout(stallTimer);
            fn(value);
        };
        const doFetch = (currentUrl, redirects = 0) => {
            if (redirects > 5)
                return finish(reject, new Error('too many redirects'));
            const client = currentUrl.startsWith('http://') ? http : https;
            const req = client.get(currentUrl, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    res.resume();
                    return doFetch(res.headers.location, redirects + 1);
                }
                if (res.statusCode !== 200) {
                    res.resume();
                    return finish(reject, new Error(`HTTP ${res.statusCode} for ${currentUrl}`));
                }
                const total = parseInt(res.headers['content-length'] || '0', 10);
                let got = 0;
                const hash = crypto.createHash('sha256');
                const out = fs.createWriteStream(destPath);
                const resetStall = () => {
                    if (stallTimer)
                        clearTimeout(stallTimer);
                    stallTimer = setTimeout(() => {
                        try {
                            res.destroy(new Error('stalled'));
                        }
                        catch { }
                        try {
                            out.destroy();
                        }
                        catch { }
                        finish(reject, new Error(`Download stalled (no bytes for ${stallTimeoutMs / 1000}s)`));
                    }, stallTimeoutMs);
                };
                resetStall();
                res.on('data', (chunk) => {
                    got += chunk.length;
                    hash.update(chunk);
                    resetStall();
                    if (total)
                        onProgress?.({ got, total, percent: got / total });
                });
                res.on('error', (error) => finish(reject, error));
                out.on('error', (error) => finish(reject, error));
                out.on('finish', () => finish(resolve, { sha256: hash.digest('hex'), bytes: got }));
                res.pipe(out);
            });
            req.on('error', (error) => finish(reject, error));
            req.setTimeout(connectTimeoutMs, () => {
                req.destroy(new Error(`Connection timeout (no response headers for ${connectTimeoutMs / 1000}s)`));
            });
        };
        doFetch(url);
    });
}
module.exports = { download, CONNECT_TIMEOUT_MS, STALL_TIMEOUT_MS };
