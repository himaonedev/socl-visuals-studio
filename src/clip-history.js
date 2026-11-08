// Generated from backend/src/clip-history.ts by scripts/backend.cjs. Edit the TypeScript source.
// ─── [CLIP-HISTORY] Moments already cut from this same source ─────────────
// Local moment detection (no AI key) is deterministic: the same transcript in
// gives the same picks out, so re-running a video — the normal way to get
// "more clips from it" — produced the same clips every time (measured on real
// sessions: DHiELGxnAS4 and S3aGpoiVg-I re-runs repeated 1164–1224 s,
// 374–436 s and 926–994 s). Most Replayed peaks are equally fixed.
//
// This collects the ranges earlier sessions of the SAME source already turned
// into clips so the pipeline can look for other moments first. It is only a
// preference: when the video has nothing new left, the old moments come back
// rather than the run producing fewer clips.
const fs = require('fs');
const path = require('path');
const SESSION_RE = /^socl-\d{4}-\d{2}-\d{2}T/;
const MAX_SESSIONS_SCANNED = 80; // newest first, per root
const READ_TIMEOUT_MS = 1500; // a report on a hung network drive is skipped, never waited on
const SCAN_BUDGET_MS = 4000; // the whole scan: a slow/asleep drive costs at most this, then the run goes on
// Same YouTube video → same key whatever the URL looked like (?si=, &list=);
// same local file → name + duration, which survives re-imports of a copy.
function sourceKeyFor({ ytInfo, source, isUrl, duration } = {}) {
    if (ytInfo && ytInfo.id)
        return `yt:${ytInfo.id}`;
    if (isUrl) {
        const m = /(?:v=|youtu\.be\/|shorts\/|live\/)([\w-]{11})/.exec(String(source || ''));
        if (m)
            return `yt:${m[1]}`;
        return `url:${String(source || '').split(/[?#]/)[0]}`;
    }
    const d = Math.round(Number(duration) || 0);
    if (!source || !d)
        return null;
    return `file:${path.basename(String(source)).toLowerCase()}|${d}`;
}
function timeLimit(promise, ms) {
    let t;
    return Promise.race([promise, new Promise((_, rej) => { t = setTimeout(() => rej(new Error('timeout')), Math.max(0, ms)); })])
        .finally(() => clearTimeout(t));
}
async function readReport(dir, deadline) {
    for (const p of [path.join(dir, 'data', 'report.json'), path.join(dir, 'report.json')]) {
        const left = Math.min(READ_TIMEOUT_MS, deadline - Date.now());
        if (left <= 0)
            return null;
        try {
            return await timeLimit(fs.promises.readFile(p, 'utf8').then((t) => JSON.parse(t)), left);
        }
        catch { /* next */ }
    }
    return null;
}
// [{start,end}] from every earlier session of this source under `roots`.
// Whatever was read before the budget ran out is returned (a partial history
// still steers away from those clips).
async function pastPickRanges({ roots = [], key, excludeDir = null, budgetMs = SCAN_BUDGET_MS } = {}) {
    if (!key)
        return [];
    const deadline = Date.now() + budgetMs;
    const seen = new Set();
    const out = [];
    const exclude = excludeDir ? path.resolve(excludeDir) : null;
    for (const root of roots) {
        if (!root || seen.has(path.resolve(root)))
            continue;
        seen.add(path.resolve(root));
        if (Date.now() >= deadline)
            break;
        let names = [];
        try {
            names = (await timeLimit(fs.promises.readdir(root), deadline - Date.now())).filter((n) => SESSION_RE.test(n));
        }
        catch {
            continue;
        }
        names.sort().reverse();
        for (const n of names.slice(0, MAX_SESSIONS_SCANNED)) {
            if (Date.now() >= deadline)
                break;
            const dir = path.join(root, n);
            if (exclude && path.resolve(dir) === exclude)
                continue;
            const r = await readReport(dir, deadline);
            if (!r || !Array.isArray(r.clips))
                continue;
            const k = sourceKeyFor({ ytInfo: r.ytInfo, source: r.source, isUrl: r.isUrl, duration: r.duration });
            if (k !== key)
                continue;
            for (const c of r.clips) {
                const s = Number(c.start), e = Number(c.end);
                if (Number.isFinite(s) && Number.isFinite(e) && e > s && !c.manual)
                    out.push({ start: s, end: e, kind: 'seen' });
            }
        }
    }
    return out;
}
// How much of [start,end] an earlier clip already covered (0..1).
function seenFraction(start, end, ranges) {
    const len = Math.max(1e-6, end - start);
    let covered = 0;
    for (const r of ranges || [])
        covered += Math.max(0, Math.min(end, r.end) - Math.max(start, r.start));
    return Math.min(1, covered / len);
}
const SEEN_LIMIT = 0.35; // a candidate mostly made of an old clip counts as "already made"
const isSeen = (c, ranges) => seenFraction(Number(c.start), Number(c.end), ranges) > SEEN_LIMIT;
// Unseen candidates first (original order kept inside each group).
function preferUnseen(list, ranges) {
    if (!ranges || !ranges.length)
        return list;
    const fresh = [], old = [];
    for (const c of list)
        (isSeen(c, ranges) ? old : fresh).push(c);
    return fresh.concat(old);
}
module.exports = { sourceKeyFor, pastPickRanges, seenFraction, isSeen, preferUnseen, SEEN_LIMIT, SCAN_BUDGET_MS };
