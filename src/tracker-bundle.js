// Generated from backend/src/tracker-bundle.ts by scripts/backend.cjs. Edit the TypeScript source.
// ─── Smart Face Tracking runtime bundle manager ────────────────
// Downloads a portable Python + wheels + models bundle from GitHub
// Releases into userData on first Smart Track toggle. Verifies sha256
// against a pinned manifest, extracts via system `tar`, and exposes
// the resolved python/main paths back to the pipeline.
//
// Dev path (repo checkout with `sidecar/tracker/.venv` present) is
// preferred and short-circuits everything below — this module only
// kicks in for end-user builds.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { app, net } = require('electron');
const nodeHttp = require('http');
const nodeHttps = require('https');
const MANIFEST = require('./tracker-bundle-manifest.json');
const { pruneOldVersions } = require('./bundle-cleanup');
// [TRACKER-NET] Prefer Electron's net module (Chromium network stack, reads
// the OS certificate trust store) over Node's http/https — same fix as
// bootstrap.js's [BOOTSTRAP-NET] and licenseManager.js's [LIC-NET]. Node's
// http/https only trust Node's own bundled CA list, so this ~380MB bundle
// download could fail with "unable to get local issuer certificate" on a
// machine where an antivirus/proxy injects its MITM root cert into the OS
// store only — on top of the already-documented Windows hang the timeouts
// below exist to prevent.
//
// UNLIKE bootstrap.js/main.js, this module is also exercised directly under
// plain `node --test` (test/tracker-bundle-download.test.js spins up a real
// http.createServer() and calls download() against it) — outside Electron's
// runtime, `require('electron')` resolves to a path STRING, not the module,
// so `net` is undefined there. Fall back to Node's http/https in that case:
// real end-user runs (inside the packaged app) get the OS-trust-store fix,
// and the test suite keeps running under plain Node with no Electron
// dependency. requestFor() below is the one place that decision is made.
const HAVE_ELECTRON_NET = !!(net && typeof net.request === 'function');
// A tiny common surface over Electron's net.request and Node's
// http.request/https.request so download()/probeRangeSupport()/
// downloadRangeChunk() don't need to know which one they're using.
//   - request(url, {method, headers}) -> a req with .setHeader (Node path
//     no-ops it, headers already passed), .on('response'|'error'), .end(), .abort()
//   - onRedirect(req, cb) -> arms 3xx handling for BOTH backends:
//     Electron's manual redirect mode routes 3xx through a 'redirect' event
//     (never 'response'); Node's http/https route 3xx through 'response'
//     like any other status, so cb is invoked from inside the 'response'
//     handler instead. Exactly one of these fires per redirect, never both.
function requestFor(url, { method = 'GET', headers = {} } = {}) {
    if (HAVE_ELECTRON_NET) {
        const req = net.request({ method, url, redirect: 'manual' });
        for (const [k, v] of Object.entries(headers))
            req.setHeader(k, v);
        return req;
    }
    const client = url.startsWith('http://') ? nodeHttp : nodeHttps;
    return client.request(url, { method, headers });
}
function onRedirect(req, url, cb) {
    if (HAVE_ELECTRON_NET) {
        req.on('redirect', (statusCode, method, redirectUrl) => cb(redirectUrl));
    }
    // Node path: handled inline by the caller's 'response' listener instead
    // (see download()/probeRangeSupport() below) — Node never emits a
    // separate redirect event, 3xx just arrives as a normal response.
}
function isRedirectHandledSeparately() {
    return HAVE_ELECTRON_NET;
}
function platformKey() {
    const p = process.platform;
    const a = process.arch;
    if (p === 'darwin' && a === 'arm64')
        return 'darwin-arm64';
    if (p === 'darwin' && a === 'x64')
        return 'darwin-x64';
    if (p === 'win32' && a === 'x64')
        return 'win32-x64';
    if (p === 'linux' && a === 'x64')
        return 'linux-x64';
    return `${p}-${a}`;
}
function bundleParent() {
    return path.join(app.getPath('userData'), 'tracker-runtime');
}
// The directory THIS manifest version installs into (install/extract/cleanup).
function currentRoot() {
    return path.join(bundleParent(), MANIFEST.version);
}
// [KEEP-OLD-RUNTIME] A runtime bump forces every user to re-download ~400MB,
// and an install that fails (Defender, MAX_PATH, flaky network — the 2.4.36
// regression reports) used to leave them with NO tracker at all even though
// the previous version, still on disk until the new one verifies, worked fine.
// When the current version cannot be installed we run the newest intact older
// one instead, for this session; the next launch tries the install again.
let _fallbackRoot = null;
// What callers run from: the fallback while one is active, else the current dir.
function bundleRoot() {
    return _fallbackRoot || currentRoot();
}
function findFallbackRoot() {
    const parent = bundleParent();
    const ver = (n) => n.split('.').map((x) => parseInt(x, 10) || 0);
    const cmp = (a, b) => { const x = ver(a), y = ver(b); for (let i = 0; i < 3; i++) {
        if (x[i] !== y[i])
            return y[i] - x[i];
    } return 0; };
    let names = [];
    try {
        names = fs.readdirSync(parent).filter((n) => /^\d+\.\d+\.\d+$/.test(n) && n !== MANIFEST.version);
    }
    catch {
        return null;
    }
    const py = process.platform === 'win32' ? path.join('python', 'python.exe') : path.join('python', 'bin', 'python3');
    for (const n of names.sort(cmp)) {
        const root = path.join(parent, n);
        if (fs.existsSync(path.join(root, py)) && fs.existsSync(path.join(root, 'tracker', 'main.py'))
            && !fs.existsSync(path.join(root, INSTALLING)))
            return root;
    }
    return null;
}
// [DISK-LEAK] Every runtime bump installs into a NEW version directory and
// isInstalled() only ever looks at the current one, so before this the
// previous runtime stayed on disk forever — 1.1GB extracted per tracker
// release (the ~333MB in the UI copy is the compressed download).
// Safe to call only where the current version is known good; see
// bundle-cleanup.js for why it can't throw and what protects a directory a
// sidecar is still running from.
function cleanupOldVersions() {
    // Never prune while an older runtime is the one in use — it IS the sibling
    // the sweep would delete.
    if (_fallbackRoot)
        return Promise.resolve();
    return pruneOldVersions(bundleParent(), MANIFEST.version, { label: 'tracker-runtime' });
}
function bundlePaths() {
    const root = bundleRoot();
    const pyRel = process.platform === 'win32'
        ? path.join('python', 'python.exe')
        : path.join('python', 'bin', 'python3');
    return {
        root,
        python: path.join(root, pyRel),
        main: path.join(root, 'tracker', 'main.py'),
        cwd: path.join(root, 'tracker'),
    };
}
// [INSTALL-MARKER] Present for the whole extraction. tracker/ (main.py, then the
// models) is the LAST thing in the archive, so an interrupted extract could leave
// main.py in place with the model files missing — isInstalled() would call that
// healthy. The marker makes any interrupted extract count as not installed.
const INSTALLING = '.installing';
function isInstalled() {
    const { python, main, root } = bundlePaths();
    return fs.existsSync(python) && fs.existsSync(main) && !fs.existsSync(path.join(root, INSTALLING));
}
function assetForThisPlatform() {
    const key = platformKey();
    const a = MANIFEST.assets && MANIFEST.assets[key];
    if (!a || !a.url || !a.sha256) {
        throw new Error(`No Smart Track bundle published for ${key} yet.`);
    }
    return { key, ...a };
}
// [TIMEOUT] Mirrors bootstrap.js's download() — a raw http(s).get() has NO
// default timeout in Node. Without one, a network path that accepts the TCP
// connection but never sends headers (silently-dropping proxy/firewall — far
// more common on Windows corporate/home networks than macOS/Linux) or that
// stops sending bytes mid-transfer leaves this promise permanently pending:
// the awaiting runPipeline() call in pipeline-inverse-v1.js hangs forever,
// and the TrackerWorker's 600s idle watchdog never engages because it lives
// strictly downstream of this bundle-install gate. Root-caused from a user
// report of Smart Face Tracking stuck for "hari-hari" (days) on Windows —
// confirmed via code inspection that no timeout existed anywhere in this
// install path, then confirmed the sibling bootstrap.js download() already
// solves the identical problem for the ffmpeg/yt-dlp binary fetch.
// [TRANSIENT-RETRY] Mirrors bootstrap.js's [TRANSIENT-RETRY] — recognises
// network failures worth an automatic retry (WiFi drop, DNS hiccup, laptop
// waking from sleep) as opposed to failures that will never succeed again
// (bad cert, 404, disk full). Covers both Node's http/https error codes and
// Electron net's message-only net::ERR_* errors, since requestFor() above
// picks whichever backend is available. Duplicated rather than shared with
// bootstrap.js because the two files have no common module to hold it in
// without introducing one purely for this — keep any future edit in sync
// with bootstrap.js's copy.
const TRANSIENT_NODE_CODES = new Set([
    'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT',
    'ENETUNREACH', 'ENETDOWN', 'EHOSTUNREACH', 'EPIPE',
]);
const TRANSIENT_MESSAGE_RE = new RegExp([
    'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT',
    'ENETUNREACH', 'ENETDOWN', 'EHOSTUNREACH',
    'net::ERR_NAME_NOT_RESOLVED', 'net::ERR_NAME_RESOLUTION_FAILED',
    'net::ERR_INTERNET_DISCONNECTED', 'net::ERR_NETWORK_CHANGED',
    'net::ERR_CONNECTION_REFUSED', 'net::ERR_CONNECTION_RESET',
    'net::ERR_CONNECTION_CLOSED', 'net::ERR_CONNECTION_TIMED_OUT',
    'net::ERR_ADDRESS_UNREACHABLE', 'net::ERR_TIMED_OUT',
    'net::ERR_SOCKET_NOT_CONNECTED', 'net::ERR_NETWORK_IO_SUSPENDED',
    'Connection timeout', 'Download stalled', 'Range download stalled',
    'Incomplete download',
].join('|'));
function isTransientNetworkError(e) {
    if (!e)
        return false;
    if (e.code && TRANSIENT_NODE_CODES.has(e.code))
        return true;
    return TRANSIENT_MESSAGE_RE.test(String(e.message || e));
}
const DOWNLOAD_RETRY_ATTEMPTS = 3;
const DOWNLOAD_RETRY_DELAYS_MS = [2000, 5000];
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
const CONNECT_TIMEOUT_MS = 60_000; // time to receive response headers
const STALL_TIMEOUT_MS = 60_000; // reset on every chunk; total time is unbounded
// [TRACKER-NET] Uses Electron's net module (Chromium network stack) instead
// of Node's http/https — same fix as bootstrap.js's [BOOTSTRAP-NET] and
// licenseManager.js's [LIC-NET]. Node's http/https only trust Node's own
// bundled CA list, not certs an antivirus/proxy injects into the OS trust
// store, so this ~380MB Smart Face Tracking bundle download could fail with
// "unable to get local issuer certificate" on an affected machine — on top
// of the already-documented Windows hang this function's timeouts exist to
// prevent. redirect:'manual' + a manual 'redirect' handler (rather than
// Chromium's automatic follow) preserves the original code's behavior:
// enforcing its own 5-hop cap and capturing the final CDN URL, which
// probeRangeSupport()/downloadParallel() below need to target directly so
// each of the 4 parallel range requests doesn't redo the redirect itself.
function download(url, destPath, onProgress, opts = {}) {
    const connectTimeoutMs = opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
    const stallTimeoutMs = opts.stallTimeoutMs ?? STALL_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
        let settled = false;
        let stallTimer = null;
        let connectTimer = null;
        const finish = (fn, v) => {
            if (settled)
                return;
            settled = true;
            if (stallTimer)
                clearTimeout(stallTimer);
            if (connectTimer)
                clearTimeout(connectTimer);
            fn(v);
        };
        const doFetch = (u, redirects = 0) => {
            if (redirects > 5)
                return finish(reject, new Error('too many redirects'));
            const req = requestFor(u, { method: 'GET' });
            connectTimer = setTimeout(() => {
                req.abort();
                finish(reject, new Error(`Connection timeout (no response headers for ${connectTimeoutMs / 1000}s)`));
            }, connectTimeoutMs);
            onRedirect(req, u, (redirectUrl) => {
                req.abort();
                doFetch(redirectUrl, redirects + 1);
            });
            req.on('response', (res) => {
                clearTimeout(connectTimer);
                if (!isRedirectHandledSeparately() && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    res.resume();
                    return doFetch(new URL(res.headers.location, u).toString(), redirects + 1);
                }
                if (res.statusCode !== 200) {
                    res.resume();
                    return finish(reject, new Error(`HTTP ${res.statusCode} for ${u}`));
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
                res.on('error', (e) => finish(reject, e));
                out.on('error', (e) => finish(reject, e));
                out.on('finish', () => finish(resolve, { sha256: hash.digest('hex'), bytes: got }));
                res.pipe(out);
            });
            req.on('error', (e) => finish(reject, e));
            req.end();
        };
        doFetch(url);
    });
}
// [SPEED] The bundle is ~380MB and download() above uses a single TCP stream —
// throughput on that one stream is often well under the link's real capacity
// (TCP window scaling, single-flow CDN throttling), especially over Wi-Fi/VPN
// round trips typical of home/office Windows networks. GitHub Releases assets
// redirect to Azure Blob Storage (release-assets.githubusercontent.com), which
// supports byte-range GETs (verified: HEAD-equivalent probe returns 206 with a
// concrete Content-Range/total). Splitting the transfer into a handful of
// concurrent range requests and writing each straight to its offset in the
// destination file gets close to N× the single-stream throughput on a
// connection that isn't already saturated. Falls back to the exact original
// single-stream download() for any server that doesn't support ranges, or on
// any probe/setup failure — never a regression, only an opportunistic speedup.
const PARALLEL_CONNECTIONS = 4;
const MIN_PARALLEL_BYTES = 16 * 1024 * 1024; // below this, one stream is plenty
function probeRangeSupport(url, { timeoutMs = 10_000 } = {}) {
    return new Promise((resolve) => {
        const doProbe = (u, redirects = 0) => {
            if (redirects > 5)
                return resolve({ ok: false });
            const req = requestFor(u, { method: 'GET', headers: { Range: 'bytes=0-0' } });
            const timer = setTimeout(() => { req.abort(); resolve({ ok: false }); }, timeoutMs);
            onRedirect(req, u, (redirectUrl) => {
                req.abort();
                doProbe(redirectUrl, redirects + 1);
            });
            req.on('response', (res) => {
                if (!isRedirectHandledSeparately() && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    clearTimeout(timer);
                    res.resume();
                    return doProbe(new URL(res.headers.location, u).toString(), redirects + 1);
                }
                clearTimeout(timer);
                res.resume();
                const range = res.headers['content-range']; // "bytes 0-0/<total>"
                const rangeVal = Array.isArray(range) ? range[0] : range;
                const m = res.statusCode === 206 && rangeVal && /\/(\d+)\s*$/.exec(rangeVal);
                if (m)
                    resolve({ ok: true, total: parseInt(m[1], 10), url: u });
                else
                    resolve({ ok: false });
            });
            req.on('error', () => { clearTimeout(timer); resolve({ ok: false }); });
            req.end();
        };
        doProbe(url);
    });
}
// One byte-range slice of the parallel download, written directly to its
// offset in the (pre-sized) destination fd. Same connect/stall timeout shape
// as download() so a wedged range doesn't hang the whole install any longer
// than a wedged single-stream download would have.
function downloadRangeChunk(url, fd, start, end, onBytes, opts = {}) {
    const connectTimeoutMs = opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
    const stallTimeoutMs = opts.stallTimeoutMs ?? STALL_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
        let settled = false;
        let stallTimer = null;
        let pos = start;
        const finish = (fn, v) => {
            if (settled)
                return;
            settled = true;
            if (stallTimer)
                clearTimeout(stallTimer);
            fn(v);
        };
        // Always called with the already-resolved CDN URL from probeRangeSupport,
        // so no redirect handling is needed here (the original didn't have any).
        const req = requestFor(url, { method: 'GET', headers: { Range: `bytes=${start}-${end}` } });
        const connectTimer = setTimeout(() => {
            req.abort();
            finish(reject, new Error(`Connection timeout (no response headers for ${connectTimeoutMs / 1000}s)`));
        }, connectTimeoutMs);
        req.on('response', (res) => {
            clearTimeout(connectTimer);
            // 200 means the server IGNORED the Range header and is sending the whole
            // file. Accepting it here made every connection write a full copy at its
            // own offset — a same-sized but scrambled file, i.e. a sha256 mismatch
            // after a full-length download. Only a real 206 is usable.
            if (res.statusCode !== 206) {
                res.resume();
                return finish(reject, new Error(`HTTP ${res.statusCode} for range ${start}-${end}`));
            }
            const resetStall = () => {
                if (stallTimer)
                    clearTimeout(stallTimer);
                stallTimer = setTimeout(() => {
                    try {
                        res.destroy(new Error('stalled'));
                    }
                    catch { }
                    finish(reject, new Error(`Range download stalled (no bytes for ${stallTimeoutMs / 1000}s)`));
                }, stallTimeoutMs);
            };
            resetStall();
            // [CORRUPTION] fs.write() is async: the previous version fired writes and
            // moved on, then resolved on 'end' (and downloadParallel closed the fd)
            // while writes were still queued. Dropped tail bytes → silent corruption
            // surfacing only as "sha256 mismatch" after a 360MB download. Pause the
            // socket until each write lands, and don't settle until the last one has.
            let inflight = 0;
            let ended = false;
            const maybeDone = () => { if (ended && inflight === 0)
                finish(resolve); };
            res.on('data', (chunk) => {
                const at = pos;
                pos += chunk.length;
                inflight++;
                res.pause();
                fs.write(fd, chunk, 0, chunk.length, at, (err, written) => {
                    inflight--;
                    if (err)
                        return finish(reject, err);
                    if (written !== chunk.length) {
                        return finish(reject, new Error(`short write (${written}/${chunk.length}) at ${at}`));
                    }
                    resetStall();
                    onBytes(chunk.length);
                    res.resume();
                    maybeDone();
                });
            });
            res.on('error', (e) => finish(reject, e));
            res.on('end', () => { ended = true; maybeDone(); });
        });
        req.on('error', (e) => { clearTimeout(connectTimer); finish(reject, e); });
        req.end();
    });
}
async function downloadParallel(url, destPath, total, rangeUrl, onProgress) {
    const fd = fs.openSync(destPath, 'w');
    try {
        fs.ftruncateSync(fd, total);
        const chunkSize = Math.ceil(total / PARALLEL_CONNECTIONS);
        let got = 0;
        const onBytes = (n) => { got += n; onProgress?.({ got, total, percent: got / total }); };
        const jobs = [];
        for (let i = 0; i < PARALLEL_CONNECTIONS; i++) {
            const start = i * chunkSize;
            if (start >= total)
                break;
            const end = Math.min(start + chunkSize, total) - 1;
            jobs.push(downloadRangeChunk(rangeUrl, fd, start, end, onBytes));
        }
        await Promise.all(jobs);
        if (got !== total)
            throw new Error(`incomplete download: ${got}/${total} bytes`);
        fs.fsyncSync(fd);
    }
    finally {
        fs.closeSync(fd);
    }
    const hash = crypto.createHash('sha256');
    await new Promise((resolve, reject) => {
        fs.createReadStream(destPath)
            .on('data', (c) => hash.update(c))
            .on('end', resolve)
            .on('error', reject);
    });
    return { sha256: hash.digest('hex'), bytes: total };
}
// Opportunistic multi-connection download; transparently falls back to the
// battle-tested single-stream download() whenever ranges aren't supported or
// anything about the fast path fails (never a regression, only a speedup).
async function downloadFast(url, destPath, onProgress) {
    try {
        const probe = await probeRangeSupport(url);
        if (probe.ok && probe.total >= MIN_PARALLEL_BYTES) {
            return await downloadParallel(url, destPath, probe.total, probe.url, onProgress);
        }
    }
    catch {
        // fall through to the plain single-stream path below
    }
    return download(url, destPath, onProgress);
}
// [TIMEOUT] Same class of bug as download() above: a bare spawn().on('close')
// with no ceiling can wedge forever, so extraction is bounded.
// [EXTRACT-STALL] The bound used to be a flat 180s. The bundle is ~600MB of
// thousands of small files; on Windows Defender scans every file written, and a
// slow disk/AV easily needs 5-15 min for a perfectly healthy extract — the flat
// ceiling killed it, scrubbed everything and forced a full re-download that hit
// the same wall ("tar extraction timed out after 180s"). Now: `tar -v` prints a
// line per extracted file, so we only give up when NO file has been written for
// STALL ms (truly wedged), with a generous overall cap as the last backstop.
const EXTRACT_STALL_MS = 300_000;
const EXTRACT_TIMEOUT_MS = 2_400_000;
// On Windows a bare `tar` can resolve to Git-for-Windows' GNU tar (or another
// PATH shim) instead of the OS bsdtar; use the system one when present.
function tarBinary() {
    if (process.platform === 'win32') {
        const sys = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
        try {
            if (fs.existsSync(sys))
                return sys;
        }
        catch { }
    }
    return 'tar';
}
// [EXTRACT-SKIP-TESTS] The bundle ships onnx's own backend test-suite: 12,333 of
// its 25,870 entries (48% of every file Defender must scan) with paths up to 159
// chars — dead weight at runtime. On Windows the longest of them plus the install
// prefix (…\\AppData\\Roaming\\SOCL Visuals Studio\\tracker-runtime\\0.2.18\\)
// can pass MAX_PATH (260) where bsdtar fails the whole extract with "tar exited 1".
// Skipping them roughly halves extract time and caps the longest path at 126.
// Client-side so the pinned sha256 of the published archive stays valid.
const EXTRACT_EXCLUDES = ['python/Lib/site-packages/onnx/backend/test'];
function extractTarGz(archivePath, destDir, opts = {}) {
    const totalMs = opts.extractTimeoutMs ?? EXTRACT_TIMEOUT_MS;
    const stallMs = opts.extractStallMs ?? Math.min(EXTRACT_STALL_MS, totalMs);
    const onFile = opts.onFile;
    return new Promise((resolve, reject) => {
        fs.mkdirSync(destDir, { recursive: true });
        // -xzvf works on macOS/Linux tar and Windows 10+ bsdtar; -v (to stderr on
        // bsdtar, stdout on GNU) is the per-file heartbeat.
        const p = spawn(tarBinary(), [...EXTRACT_EXCLUDES.map((x) => `--exclude=${x}`), '-xzvf', archivePath, '-C', destDir], { stdio: ['ignore', 'pipe', 'pipe'] });
        let settled = false;
        let stallTimer = null;
        let totalTimer = null;
        let files = 0;
        let errTail = '';
        const killTree = () => {
            // [WIN-KILL-TREE] Same hazard as the pipeline's spawns: on Windows a
            // wedged bsdtar can hold the 600MB archive and the half-written bundle
            // open, so killing only its pid leaves both locked and the retry fails.
            if (process.platform === 'win32' && p.pid) {
                try {
                    require('child_process').execFile('taskkill', ['/pid', String(p.pid), '/T', '/F'], (err) => { if (err) {
                        try {
                            p.kill('SIGKILL');
                        }
                        catch { }
                    } });
                }
                catch {
                    try {
                        p.kill('SIGKILL');
                    }
                    catch { }
                }
            }
            else {
                try {
                    p.kill('SIGKILL');
                }
                catch { }
            }
        };
        const fail = (err) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(stallTimer);
            clearTimeout(totalTimer);
            killTree();
            reject(err);
        };
        const armStall = () => {
            clearTimeout(stallTimer);
            stallTimer = setTimeout(() => fail(new Error(`tar extraction timed out after ${stallMs / 1000}s without progress (${files} files written)`)), stallMs);
        };
        const beat = (chunk) => {
            if (settled)
                return;
            files += (String(chunk).match(/\n/g) || []).length;
            armStall();
            if (onFile) {
                try {
                    onFile(files);
                }
                catch { }
            }
        };
        armStall();
        totalTimer = setTimeout(() => fail(new Error(`tar extraction timed out after ${totalMs / 1000}s (${files} files written)`)), totalMs);
        p.stdout.on('data', beat);
        // [TAR-STDERR] "tar exited 1" alone is undiagnosable (path too long, AV
        // lock, bad dir, disk full all look the same) — keep the last of stderr.
        p.stderr.on('data', (c) => { errTail = (errTail + String(c)).slice(-600); beat(c); });
        p.on('error', (e) => { if (settled)
            return; settled = true; clearTimeout(stallTimer); clearTimeout(totalTimer); reject(e); });
        p.on('close', (code) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(stallTimer);
            clearTimeout(totalTimer);
            if (code === 0)
                return resolve();
            const tail = errTail.split(/\r?\n/).filter((l) => l && !/^x /.test(l)).slice(-3).join(' | ').trim();
            reject(new Error(`tar exited ${code}${tail ? ': ' + tail : ''}`));
        });
    });
}
// Shared in-flight guard: the toggle's install prompt AND runPipeline both
// call ensureInstalled, and the toggle can be flipped on/off/on quickly — all
// of those must JOIN one download, never start a second to the same dir (which
// would race on the temp file and corrupt the extract). Cleared when the one
// download settles (installed, or scrubbed on failure so a retry can start).
let _inflight = null;
function ensureInstalled(onProgress) {
    // Sweep on the already-installed path too, not just after a fresh download:
    // anyone who upgraded before this existed is already carrying the stale
    // directories, and their next install is the one that never happens.
    if (isInstalled())
        return cleanupOldVersions().then(() => bundlePaths());
    if (_inflight)
        return _inflight;
    _inflight = _doInstall(onProgress)
        .catch((e) => {
        const fb = findFallbackRoot();
        if (!fb)
            throw e;
        _fallbackRoot = fb;
        const version = path.basename(fb);
        onProgress?.({ phase: 'fallback', version, error: e.message });
        return { ...bundlePaths(), fallback: { version, error: e.message } };
    })
        .finally(() => { _inflight = null; });
    return _inflight;
}
async function _doInstall(onProgress) {
    if (isInstalled())
        return bundlePaths();
    const asset = assetForThisPlatform();
    const root = currentRoot();
    fs.mkdirSync(root, { recursive: true });
    // Remove any orphaned partial tarballs from a previously interrupted run
    // (app quit after download, before extract/scrub) so they don't accumulate
    // and so a stale truncated file is never mistaken for a finished download.
    try {
        for (const f of fs.readdirSync(root)) {
            if (/^bundle-\d+\.tar\.gz$/.test(f))
                fs.unlinkSync(path.join(root, f));
        }
    }
    catch { }
    // [KEEP-VERIFIED] A sha-verified tarball is kept across a failed extract so
    // Retry re-extracts instead of re-downloading 600MB. Name is version-free on
    // purpose: root is per-version already (bundleRoot()).
    const tmp = path.join(root, 'bundle-verified.tar.gz');
    const hashFile = (f) => new Promise((resolve, reject) => {
        const h = crypto.createHash('sha256');
        fs.createReadStream(f).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
    });
    // Wipe on ANY failure so a next launch doesn't see a half-extracted tree
    // and skip the download (isInstalled returns true on partial trees where
    // python/main happens to exist but wheels are truncated → cryptic runtime
    // ImportError instead of "please retry download").
    const scrub = (keepTarball) => {
        if (!keepTarball) {
            try {
                if (fs.existsSync(tmp))
                    fs.unlinkSync(tmp);
            }
            catch { }
            try {
                fs.rmSync(root, { recursive: true, force: true });
            }
            catch { }
            return;
        }
        try {
            for (const f of fs.readdirSync(root)) {
                if (f === path.basename(tmp))
                    continue;
                fs.rmSync(path.join(root, f), { recursive: true, force: true });
            }
        }
        catch { }
    };
    let verified = false;
    try {
        onProgress?.({ phase: 'download', percent: 0 });
        const report = (p) => onProgress?.({ phase: 'download', percent: p.percent, got: p.got, total: p.total });
        const want = asset.sha256.toLowerCase();
        // [TRANSIENT-RETRY] A user hit this ~380MB download failing outright on
        // a momentary DNS/connectivity blip (see bootstrap.js's [TRANSIENT-RETRY]
        // for the reported case) that a retry a few seconds later would have
        // recovered from on its own. Retry the whole downloadFast() call (which
        // already internally falls back from parallel-range to single-stream) up
        // to twice more; a non-transient failure (bad cert, disk full) still
        // fails immediately, same as before.
        let sha256;
        let reuse = false;
        if (fs.existsSync(tmp)) {
            try {
                reuse = (await hashFile(tmp)).toLowerCase() === want;
            }
            catch { }
            if (!reuse) {
                try {
                    fs.unlinkSync(tmp);
                }
                catch { }
            }
        }
        if (reuse)
            sha256 = want;
        for (let attempt = 1; !reuse; attempt++) {
            try {
                ({ sha256 } = await downloadFast(asset.url, tmp, report));
                break;
            }
            catch (e) {
                if (attempt >= DOWNLOAD_RETRY_ATTEMPTS || !isTransientNetworkError(e))
                    throw e;
                onProgress?.({ phase: 'download', percent: 0, retryAttempt: attempt, retryMax: DOWNLOAD_RETRY_ATTEMPTS, retryError: e.message });
                await sleep(DOWNLOAD_RETRY_DELAYS_MS[attempt - 1] || 5000);
            }
        }
        if (sha256.toLowerCase() !== want) {
            // A checksum mismatch means the bytes we wrote are wrong, not that the
            // release is wrong — the multi-connection path is the only thing that can
            // scramble them. Retry once on the plain single-stream download before
            // making the user click Retry on a 360MB download themselves.
            onProgress?.({ phase: 'download', percent: 0, retry: true });
            ({ sha256 } = await download(asset.url, tmp, report));
        }
        if (sha256.toLowerCase() !== want) {
            throw new Error(`sha256 mismatch: got ${sha256}, expected ${want}`);
        }
        onProgress?.({ phase: 'extract' });
        verified = true;
        const extractOpts = { onFile: (n) => { if (n % 50 === 0)
                onProgress?.({ phase: 'extract', files: n }); } };
        fs.writeFileSync(path.join(root, INSTALLING), String(Date.now()));
        try {
            await extractTarGz(tmp, root, extractOpts);
        }
        catch (e) {
            // [EXTRACT-RETRY] A bare non-zero exit (Defender/indexer briefly locking a
            // freshly written file on Windows) usually passes on a second try into a
            // clean tree. Stalls/timeouts are NOT retried — those won't fix themselves.
            if (!/^tar exited \d+/.test(e.message))
                throw e;
            scrub(true);
            await sleep(3000);
            fs.writeFileSync(path.join(root, INSTALLING), String(Date.now()));
            await extractTarGz(tmp, root, extractOpts);
        }
        // Retried: a freshly written tiny file can be briefly locked by AV on Windows,
        // and a marker that survives would make this healthy install look interrupted.
        fs.rmSync(path.join(root, INSTALLING), { force: true, maxRetries: 8, retryDelay: 250 });
        try {
            fs.unlinkSync(tmp);
        }
        catch { }
        if (!isInstalled())
            throw new Error('bundle extracted but python/main not found');
        // Strictly after the verify above: until this line the previous runtime is
        // the only working one, and everything from the sha256 check to the
        // extract can still fail into scrub().
        await cleanupOldVersions();
        onProgress?.({ phase: 'done' });
        return bundlePaths();
    }
    catch (e) {
        scrub(verified);
        throw e;
    }
}
function remove() {
    _fallbackRoot = null;
    const root = bundleParent();
    if (fs.existsSync(root))
        fs.rmSync(root, { recursive: true, force: true });
}
module.exports = {
    MANIFEST,
    platformKey,
    bundlePaths,
    findFallbackRoot,
    __resetFallback: () => { _fallbackRoot = null; },
    isInstalled,
    ensureInstalled,
    cleanupOldVersions,
    remove,
    download, // exported for the timeout regression test (test/tracker-bundle-download.test.js)
    downloadFast, // same, for the parallel-range regression test
    extractTarGz, // same
};
