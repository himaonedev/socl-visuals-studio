// Generated from backend/src/work-root.ts by scripts/backend.cjs. Edit the TypeScript source.
// [WORK-ON-EXPORT-DRIVE] Where a new job's session folder (download, raw cuts,
// tracking cache, renders) is created.
//
// Reported: with Default Export Path set to another drive (D:\, an external
// SSD), clips "often error and never come out". The export path used to be a
// copy DESTINATION only — every job still downloaded and rendered into
// ~/Movies/SOCL Visuals Studio on the system drive (measured: ~1 GB per job,
// 78% of it source.mp4; 18 jobs = 29 GB). A user who points exports at D:
// because C: is small keeps filling C: anyway, and the run dies on the 2 GB
// free-space guard or mid-download with ENOSPC — before the copy to D: is
// ever reached. So when an output folder is set, each session folder is
// created directly in it and stays visible and tidy — raw/, subtitle/,
// edited/, crop-biasa/, crop-gaming/, transkrip/, source.mp4 — with hasil/
// holding one ready-to-upload file per clip (a clone/hardlink, so no extra
// space). [TIDY-SESSION] (chosen by the user over a hidden .socl-work).
// Cloud-sync folders, network shares and nearly-full drives keep the
// internal root.
//
// Anything wrong with the chosen folder (not absolute, unplugged, read-only,
// a stalled USB controller) falls back to the internal root with a reason, so
// a bad export setting can never stop a job from running.
const fs = require('fs');
const path = require('path');
const os = require('os');
// Legacy: sessions made by 2.4.7-beta test builds live in <output>/.socl-work;
// History still finds them through the remembered workRoots.
const WORK_DIRNAME = '.socl-work';
// A session folder is named after its job id: socl-2026-09-19T07-08-11.
// Anything else in an output folder is the user's own and never a session.
const SESSION_DIR_RE = /^socl-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/;
const PROBE_TIMEOUT_MS = 15000;
// Same floor as runPipeline's own [DISK-CHECK]; below it the job would fail
// on that drive, while the internal drive may be perfectly fine.
const MIN_WORK_FREE_BYTES = 2 * 1024 * 1024 * 1024;
function withTimeout(promise, ms, label) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(Object.assign(new Error(`${label}: tidak merespons setelah ${Math.round(ms / 1000)} detik (timeout — drive lambat/tidur/terputus?)`), { code: 'ETIMEDOUT' })), ms);
        promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
    });
}
// Same normalisation exportToUserFolder applies, so both agree on the folder.
function normalizeExportPath(raw) {
    let base = typeof raw === 'string' ? raw.trim() : '';
    if (!base)
        return '';
    if (base === '~' || base.startsWith('~/') || base.startsWith('~\\')) {
        base = path.join(os.homedir(), base.slice(1));
    }
    return base;
}
// Sync-client folders: a job's ~1 GB of working files there gets uploaded,
// and the client can hold files open mid-render. Exports still land there.
const CLOUD_SYNC_RE = /(^|[\\/])(My Drive|Drive Saya|Shared drives|Drive bersama|GoogleDrive[^\\/]*|Google Drive|OneDrive[^\\/]*|Dropbox( \([^\\/]*\))?|iCloud ?Drive|Mobile Documents|CloudStorage)([\\/]|$)/i;
function isCloudSynced(p) { return CLOUD_SYNC_RE.test(String(p || '')); }
// [NETWORK-SHARE] \\server\share (or //server/share). The run still makes
// short synchronous writes into its session folder, a network share is the
// drive most likely to stall mid-run (SMB timeouts run 30-60 s), and render
// I/O over SMB is slow anyway — so it only receives the finished clips.
function isNetworkShare(p) { return /^[\\/]{2}(?![?.][\\/])[^\\/]+[\\/]/.test(String(p || '')); } // not \\?\ or \\.\ device paths
// [NO-SYNC-EXTERNAL] Everything here can touch an external drive or a NAS
// and runs on Electron's main process: async + timeout only, never *Sync,
// or one hung disk freezes the whole app.
// [HISTORY-BUDGET] Generous on purpose: nothing here blocks the app any more,
// and a sleeping external HDD needs several seconds to spin up — a short
// budget silently dropped its sessions from History.
const LIST_TIMEOUT_MS = 15000;
// [HISTORY-INTERNAL-FIRST] The internal root is read first (2 at a time) and
// finished before any other root starts; other roots get ONE read at a time.
// Node has 4 libuv threads: with 2 reads per root, two hung drives filled all
// four and the internal reads never ran (round-5 review, real stuck threads).
const REPORT_READ_CONCURRENCY = 2;
const OTHER_ROOT_CONCURRENCY = 1;
// [HISTORY-DEADLINE] A root that did not answer is skipped by the next History
// opens for a while, instead of costing the full budget on every click.
const ROOT_COOLDOWN_MS = 60000;
const rootCooldown = new Map(); // resolved path -> retry-after timestamp
function __resetRootCooldown() { rootCooldown.clear(); }
// Device id of the nearest existing ancestor (the export folder itself may
// not exist yet). st_dev is the volume serial on Windows, the mount on POSIX.
async function deviceOf(p, timeoutMs = PROBE_TIMEOUT_MS) {
    let cur = path.resolve(p);
    for (;;) {
        try {
            return (await withTimeout(fs.promises.stat(cur), timeoutMs, 'Membaca drive')).dev;
        }
        catch (e) {
            if (e && e.code !== 'ENOENT')
                return null;
        }
        const up = path.dirname(cur);
        if (up === cur)
            return null;
        cur = up;
    }
}
// Node's raw text for a missing drive on Windows reads
// "ENOENT: no such file or directory, mkdir '\\?'" — meaningless to a user.
function explainFsError(e) {
    switch (e && e.code) {
        case 'ENOENT': return 'drive atau folder tidak ditemukan (dicabut / huruf drive berubah?)';
        case 'EACCES':
        case 'EPERM': return 'tidak ada izin menulis ke folder itu';
        case 'EROFS': return 'drive-nya hanya-baca';
        case 'ENOSPC': return 'drive-nya penuh';
        case 'ETIMEDOUT': return e.message;
        default: return (e && e.message) || String(e);
    }
}
// Free bytes on the volume holding `p` (nearest existing ancestor), or null
// when it cannot be read — unknown must never block a job.
async function freeBytes(p, timeoutMs = PROBE_TIMEOUT_MS) {
    if (typeof fs.promises.statfs !== 'function')
        return null;
    let cur = path.resolve(p);
    for (;;) {
        try {
            const st = await withTimeout(fs.promises.statfs(cur), timeoutMs, 'Membaca sisa ruang');
            const n = Number(st.bavail) * Number(st.bsize);
            return Number.isFinite(n) ? n : null;
        }
        catch (e) {
            if (e && e.code !== 'ENOENT')
                return null;
        }
        const up = path.dirname(cur);
        if (up === cur)
            return null;
        cur = up;
    }
}
// [WORK-IN-OUTPUT] With iCloud "Desktop & Documents" on, ~/Documents and
// ~/Desktop are synced even though their path says nothing about iCloud —
// the ~1 GB of working files per job must not go there. macOS marks the
// feature with CloudDocs/Documents (resp. Desktop) in Mobile Documents.
async function isICloudDesktopDocuments(p, { home = os.homedir(), platform = process.platform } = {}) {
    if (platform !== 'darwin')
        return false;
    for (const folder of ['Documents', 'Desktop']) {
        if (!isInside(p, path.join(home, folder)))
            continue;
        const marker = path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', folder);
        try {
            await withTimeout(fs.promises.access(marker), PROBE_TIMEOUT_MS, 'Membaca iCloud');
            return true;
        }
        catch {
            return false;
        }
    }
    return false;
}
function isInside(child, parent) {
    const rel = path.relative(path.resolve(parent), path.resolve(child));
    return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}
// → { root, fallbackReason }. fallbackReason is null when the export drive is
// used (or none is configured); otherwise a user-facing sentence.
async function resolveWorkRoot({ exportPath, defaultRoot, timeoutMs = PROBE_TIMEOUT_MS, freeBytesFn = freeBytes, icloudFn = isICloudDesktopDocuments }) {
    const base = normalizeExportPath(exportPath);
    if (!base)
        return { root: defaultRoot, fallbackReason: null };
    if (isNetworkShare(base))
        return { root: defaultRoot, fallbackReason: null };
    if (!path.isAbsolute(base)) {
        return { root: defaultRoot, fallbackReason: `folder ekspor bukan jalur lengkap ("${base}")` };
    }
    // Export folder set to (a folder inside) the internal root: nothing to move.
    if (isInside(base, defaultRoot))
        return { root: defaultRoot, fallbackReason: null };
    // [WORK-IN-OUTPUT] Any other usable output folder holds the work, even on
    // the same drive as the internal root — reported: with output in
    // ~/Documents, ~/Movies kept the source, raw/ and edited/ AND Documents got
    // a second copy of every clip. Cloud-synced folders: never work there.
    if (isCloudSynced(base) || await icloudFn(base))
        return { root: defaultRoot, fallbackReason: null };
    // [SMALL-EXPORT-DRIVE] A USB stick with < 2 GB free would fail the job's
    // own disk check on every run; the clips are small, so work internally and
    // just copy them there.
    const free = await freeBytesFn(base);
    if (free != null && free < MIN_WORK_FREE_BYTES) {
        return { root: defaultRoot, fallbackReason: `drive folder ekspor tinggal ${(free / 2 ** 30).toFixed(1)} GB (butuh 2 GB untuk proses)` };
    }
    // Sessions go straight into the output folder. Probed the way they are
    // created — as a subfolder — since D:\ itself refuses files for standard
    // Windows users ([PICK-ROOT]).
    const probe = await probeWritableFolder(base, timeoutMs);
    if (!probe.ok) {
        return { root: defaultRoot, fallbackReason: `folder ekspor tidak bisa dipakai (${base}) — ${probe.error}` };
    }
    return { root: base, fallbackReason: null };
}
// [DRIVE-ROOT-EPERM] mkdir on an EXISTING drive root (D:\) throws EPERM for
// a standard Windows user even with { recursive: true } — verified on a
// windows-latest runner. So only create what is actually missing.
async function ensureDir(dir, timeoutMs = PROBE_TIMEOUT_MS) {
    try {
        const st = await withTimeout(fs.promises.stat(dir), timeoutMs, 'Membaca folder');
        if (st.isDirectory())
            return;
    }
    catch (e) {
        if (e && e.code !== 'ENOENT')
            throw e;
    }
    await withTimeout(fs.promises.mkdir(dir, { recursive: true }), timeoutMs, 'Membuat folder');
}
// [PICK-ROOT] Can the app use this folder? What it actually needs is to
// create SUBFOLDERS in it (<job>/, .socl-work/) and files inside those — so
// test exactly that. Writing a probe FILE straight into the picked folder
// wrongly refused D:\ for standard users (and UAC-filtered admins): Windows'
// default ACL on a secondary drive root allows creating folders there but not
// files (verified on a windows-latest runner as a standard user).
async function probeWritableFolder(dir, timeoutMs = PROBE_TIMEOUT_MS) {
    const tmpDir = path.join(dir, `.socl-write-test-${process.pid}-${Date.now()}`);
    try {
        await ensureDir(dir, timeoutMs);
        await withTimeout(fs.promises.mkdir(tmpDir), timeoutMs, 'Membuat subfolder');
        await withTimeout(fs.promises.writeFile(path.join(tmpDir, 'probe'), 'ok'), timeoutMs, 'Menulis file');
        return { ok: true, error: null };
    }
    catch (e) {
        return { ok: false, error: explainFsError(e) };
    }
    finally {
        // Awaited, so the picked folder is clean when Settings shows it.
        await withTimeout(fs.promises.rm(tmpDir, { recursive: true, force: true }), timeoutMs, 'Membersihkan').catch(() => { });
    }
}
// Session roots History should scan: the internal root plus every work root a
// job has used, skipping ones that are not reachable right now (drive
// unplugged). Order-preserving and de-duplicated.
async function sessionRoots(defaultRoot, knownRoots, timeoutMs = LIST_TIMEOUT_MS) {
    const cand = [];
    const seen = new Set();
    for (const r of [defaultRoot, ...(Array.isArray(knownRoots) ? knownRoots : [])]) {
        if (typeof r !== 'string' || !r)
            continue;
        const key = path.resolve(r);
        if (seen.has(key))
            continue;
        seen.add(key);
        cand.push(r);
    }
    // In parallel, so several dead drives cost one timeout, not one each.
    const now = Date.now();
    const ok = await Promise.all(cand.map((r, i) => {
        const key = path.resolve(r);
        if (i > 0 && (rootCooldown.get(key) || 0) > now)
            return false; // the internal root is never skipped
        return withTimeout(fs.promises.stat(r), timeoutMs, 'Membaca drive').then((st) => { rootCooldown.delete(key); return st.isDirectory(); }, (e) => { if (e && e.code === 'ETIMEDOUT')
            rootCooldown.set(key, Date.now() + ROOT_COOLDOWN_MS); return false; });
    }));
    return cand.filter((_, i) => ok[i]);
}
// [MAIN-OWNED-CFG] Keys only the main process may write. The renderer sends
// its whole (possibly stale) cfg snapshot on every save, which would reset
// these to whatever they were when the window loaded.
const MAIN_OWNED_KEYS = ['workRoots'];
function stripMainOwnedSettings(cfg) {
    const out = { ...(cfg || {}) };
    for (const k of MAIN_OWNED_KEYS)
        delete out[k];
    return out;
}
// Remember a work root (most recent first, bounded) so History keeps finding
// its sessions after the user changes the export folder again.
function rememberRoot(knownRoots, root, max = 10) {
    const list = (Array.isArray(knownRoots) ? knownRoots : []).filter((r) => typeof r === 'string' && r);
    const key = path.resolve(root);
    return [root, ...list.filter((r) => path.resolve(r) !== key)].slice(0, max);
}
// report.json of a session, or null — async + bounded, since the session may
// sit on a drive that stopped answering after History listed it.
async function readReport(dir, timeoutMs = LIST_TIMEOUT_MS) {
    try {
        return await readReportOrTimeout(dir, timeoutMs);
    }
    catch {
        return null;
    }
}
// Same, but a timeout is thrown (code ETIMEDOUT) so the caller can give up on
// that drive; a missing or broken report is just null.
async function readReportOrTimeout(dir, timeoutMs) {
    let text = null;
    // [DATA-DIR] data/report.json since 2.4.7; the session root before that.
    for (const p of [path.join(dir, 'data', 'report.json'), path.join(dir, 'report.json')]) {
        try {
            text = await withTimeout(fs.promises.readFile(p, 'utf8'), timeoutMs, 'Membaca report');
            break;
        }
        catch (e) {
            if (e && e.code === 'ETIMEDOUT')
                throw e;
        }
    }
    if (text == null)
        return null;
    try {
        return JSON.parse(text);
    }
    catch {
        return null;
    }
}
// Reports for many sessions, a few at a time: 50 parallel reads queue on
// libuv's 4-thread pool and would time out while still waiting their turn.
// [HISTORY-DEADLINE] One deadline for the whole batch, not one per file: with
// per-file timeouts, 25 hung reads over 4 workers added up to ~7 timeouts.
// [HISTORY-PER-ROOT] Grouped per root (a session's parent folder): with one
// shared pool, four hung reads parked every worker and History came back with
// 4 of 25 HEALTHY internal sessions. A root's first timeout ends the reads on
// that root and puts it in the cooldown; other roots are never starved.
async function readReports(dirs, timeoutMs = LIST_TIMEOUT_MS, { firstRoot } = {}) {
    const out = new Array(dirs.length).fill(null);
    const deadline = Date.now() + timeoutMs;
    const groups = new Map();
    dirs.forEach((d, i) => {
        const root = path.dirname(path.resolve(d));
        if (!groups.has(root))
            groups.set(root, []);
        groups.get(root).push(i);
    });
    const readRoot = async ([root, idxs], width) => {
        let next = 0, dead = false;
        const worker = async () => {
            while (!dead && next < idxs.length) {
                const i = idxs[next++];
                const left = deadline - Date.now();
                if (left <= 0)
                    return; // out of time: the rest stay null
                try {
                    out[i] = await readReportOrTimeout(dirs[i], left);
                }
                catch {
                    dead = true; // this drive stopped answering
                    rootCooldown.set(root, Date.now() + ROOT_COOLDOWN_MS);
                }
            }
        };
        await Promise.all(Array.from({ length: Math.min(width, idxs.length) }, worker));
    };
    const first = firstRoot ? path.resolve(firstRoot) : null;
    if (first && groups.has(first)) {
        await readRoot([first, groups.get(first)], REPORT_READ_CONCURRENCY);
        groups.delete(first);
    }
    await Promise.all([...groups].map((g) => readRoot(g, first ? OTHER_ROOT_CONCURRENCY : REPORT_READ_CONCURRENCY)));
    return out;
}
// Newest-first across every root. Job ids are ISO timestamps
// (socl-2026-09-18T10-00-38), so the name alone orders them.
async function listSessions(roots, limit = 50, timeoutMs = LIST_TIMEOUT_MS) {
    const perRoot = await Promise.all(roots.map(async (root) => {
        let entries = [];
        try {
            entries = await withTimeout(fs.promises.readdir(root, { withFileTypes: true }), timeoutMs, 'Membaca folder');
        }
        catch {
            return [];
        }
        // Only socl-<timestamp> folders: an output folder also holds the user's
        // own folders, .thumbs, write probes and stray files.
        return entries.filter((e) => e.isDirectory() && SESSION_DIR_RE.test(e.name))
            .map((e) => ({ jobId: e.name, dir: path.join(root, e.name) }));
    }));
    const all = perRoot.flat();
    all.sort((a, b) => (a.jobId < b.jobId ? 1 : a.jobId > b.jobId ? -1 : 0));
    return all.slice(0, limit);
}
module.exports = {
    WORK_DIRNAME, resolveWorkRoot, normalizeExportPath, sessionRoots, rememberRoot, listSessions, isInside, isCloudSynced, isNetworkShare, isICloudDesktopDocuments, deviceOf, explainFsError, probeWritableFolder, stripMainOwnedSettings, ensureDir, freeBytes, readReport, readReports, LIST_TIMEOUT_MS, __resetRootCooldown,
};
