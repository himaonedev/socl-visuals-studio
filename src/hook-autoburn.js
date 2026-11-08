// Generated from backend/src/hook-autoburn.ts by scripts/backend.cjs. Edit the TypeScript source.
'use strict';
// [HOOK-AUTOBURN] The pipeline puts each clip's AI headline on the video as a
// hook for its first seconds, in the hook preset the user picked in Clip
// Options — no Caption Editor visit needed.
//
// This was tried once before (2.3.72-beta, [AUTO-TITLE-REMOVED]) and pulled
// after a real Windows run put the title on top of the opening captions. That
// version GUESSED: it put the title in whichever half cfg.subtitleY left free,
// without knowing how tall the caption block really was. This one MEASURES:
// it reads the exact ASS events buildAss emits for this clip's own captions
// and for the hook itself (WrapStyle 2 — lines only break on an explicit \N,
// so the line count in the file is the line count libass draws), and places
// the hook in the free space around them. If the hook cannot fit anywhere
// without touching a caption, it is left off that clip rather than overlap.
//
// Node-only (the pipeline is the only caller). The returned title object is
// the same shape the Caption Editor writes, tagged src:'headline', so the
// editor, the "Judul & hook" review and the dashboard preview all pick it up
// as the clip's existing headline layer.
const { applyHookPreset, byId } = require('./hook-presets');
const TL = require('./title-layout');
const DEFAULT_PRESET = 'blok_neon';
const HOOK_DUR = TL.TITLE_DEFAULT_DUR; // 3.5s, same as "+ Add title"
// Canonical 1080x1920 space. The bottom band is where TikTok/Reels draw their
// caption, buttons and progress bar; the top band holds the app's own header.
const SAFE_TOP = 200;
const SAFE_BOTTOM = 1920 - 400;
const GAP = 40;
// Centre of the hook when no caption shares its window: the lower band
// (~62% down), clear of a centred face and of the bottom UI strip.
const NO_CAPTION_CENTER = 1200;
const SLACK = 6; // minimum clear space between hook and caption, canonical px
const MIN_FS = 56; // never shrink a hook below this to make it fit
// Kinetic lockups draw their letters far larger per point (riot: 150 px at
// fs 96), so the same legibility floor sits lower on their scale: fs 40 still
// sets riot letters at ~62 px, about a caption's size.
const MIN_FS_KINETIC = 40;
const MAX_WORDS = 8;
const MAX_CHARS = 48;
// Words a hook must not END on — a cut that leaves "…GAGAL VISA DI" reads as
// broken (LokaClip ships hooks cut exactly like that).
const TRAILING_STOP = new Set([
    'di', 'ke', 'dari', 'dan', 'yang', 'bukan', 'tidak', 'tak', 'belum', 'jangan', 'not', 'atau', 'untuk', 'dengan', 'pada', 'si', 'sang', 'para', 'ini', 'itu', 'karena', 'tapi', 'kalau', 'jika', 'agar', 'saat',
    'the', 'a', 'an', 'of', 'to', 'and', 'or', 'for', 'with', 'in', 'on', 'at', 'by', 'from', 'my', 'your', 'his', 'her', 'their', 'is', 'are', 'was', 'but',
]);
// The headline as hook text: trimmed at a WORD boundary (never mid-word, never
// on a dangling connector), quotes/emoji dropped, upper-cased unless the
// preset is the one deliberately soft, mixed-case look.
function hookTextFor(title, presetId, caseMode = '') {
    let s = String(title || '')
        .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
        .replace(/["“”«»]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (!s)
        return '';
    let words = s.split(' ');
    if (words.length > MAX_WORDS)
        words = words.slice(0, MAX_WORDS);
    while (words.length > 1 && words.join(' ').length > MAX_CHARS)
        words.pop();
    const cut = words.length < s.split(' ').length;
    if (cut) {
        // Only a cut can strand a connector or a mid-sentence comma.
        while (words.length > 2 && TRAILING_STOP.has(words[words.length - 1].toLowerCase().replace(/[^\p{L}]/gu, '')))
            words.pop();
        words[words.length - 1] = words[words.length - 1].replace(/[,;:\-–—]+$/, '');
    }
    const text = words.join(' ').trim();
    // The preset decides the case of AUTO text: shouting looks upper-case, the
    // card / two-tone looks keep the headline's own case, editorial goes lower.
    const p = byId(presetId) || byId(DEFAULT_PRESET);
    // [HOOK-CASE] Clip setting → Huruf hook overrides the look's own case.
    if (caseMode === 'title')
        return text.toLowerCase().replace(/(^|[\s(\-"])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
    const mode = caseMode === 'upper' || caseMode === 'lower' ? caseMode : (p.textCase || (p.id === 'pastel_lembut' ? 'keep' : 'upper'));
    // An all-caps hook (the clip's hookText) shown in a "keep case" look reads
    // better as a headline than as shouting.
    if (mode === 'keep')
        return text === text.toUpperCase() && /\p{L}/u.test(text)
            ? text.toLowerCase().replace(/(^|\s)(\p{L})/gu, (m, a, b) => a + b.toUpperCase())
            : text;
    if (mode === 'lower')
        return text.toLowerCase();
    return text.toUpperCase();
}
// `fs` is the size the hook would have at the editor's default 96; a preset
// with its own base size (e.g. a 150px impact look) keeps that ratio, so the
// shrink-to-fit in placeHook scales every preset the same way.
const MAX_LINE_W = 960; // canonical px; 60 px margin each side of 1080
function widestLinePx(T) {
    let FM, dir;
    try {
        FM = require('./font-metrics');
        dir = require('./pipeline-inverse-v1').__test.assFontsDirFs();
    }
    catch {
        return 0;
    }
    const toks = Array.isArray(T.tokens) && T.tokens.length ? T.tokens : String(T.text || '').split(/\s+/).filter(Boolean).map((w) => ({ text: w }));
    const breaks = T.layout === 'single' ? [] : (TL.autoTitleBreaks(toks.map((t) => t.text).join(' '), T.layout, T.lines) || []);
    const fit = TL.autoFitScale ? (TL.autoFitScale(breaks.length + 1) || 1) : 1;
    let widest = 0, cur = 0, start = 0;
    const bounds = breaks.concat([toks.length]);
    for (const end of bounds) {
        cur = 0;
        for (let i = start; i < end; i++) {
            const st = toks[i].style || {};
            // Same rule as buildAss: an explicit per-word size is used as-is; only
            // the title's own size takes the line-count fit.
            const px = +st.fs || (+T.fs || TL.TITLE_DEFAULT_FS) * fit;
            const em = FM.textWidthEm(`${toks[i].text}${i < end - 1 ? ' ' : ''}`, st.fn || T.fn || 'Open Sauce Two Bold', dir, !!st.b, !!st.i);
            cur += (em == null ? 0.6 * toks[i].text.length : em) * px;
        }
        widest = Math.max(widest, cur + 2 * (+T.outline || 6));
        start = end;
    }
    return widest;
}
// [HOOK-SUB] Hook text for a two-part preset: "MAIN | SMALL". The small line
// is the preset's fixed label, or ('title') the clip headline cut at a word
// boundary to ~7 words / 44 chars, never ending on a connector, and dropped
// when it would only repeat the hook. Cased like the hook itself.
function caseLike(text, caseMode, presetId) {
    const p = byId(presetId) || byId(DEFAULT_PRESET);
    const mode = caseMode || p.textCase || 'upper';
    if (mode === 'lower')
        return text.toLowerCase();
    if (mode === 'title' || mode === 'keep')
        return text.toLowerCase().replace(/(^|[\s(\-"])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
    return text.toUpperCase();
}
function hookTextWithSub(hookText, title, presetId, caseMode = '') {
    const main = hookTextFor(hookText || title, presetId, caseMode);
    const p = byId(presetId);
    if (!main || !p || !p.sub)
        return main;
    let sub = '';
    if (p.sub === 'title') {
        const clean = String(title || '').replace(/["“”«»|]/g, '').replace(/\s+/g, ' ').trim();
        // A whole clause reads as a sub-headline; a cut sentence does not
        // ("…: KENAPA KULITMU"). First clause of 3–7 words wins.
        const clause = clean.split(/\s*[:;?!–—]\s*|\s+-\s+|,\s+/).map((x) => x.trim()).find((x) => { const n = x.split(' ').length; return n >= 3 && n <= 7 && x.length <= 44; });
        let ws = (clause || clean).split(' ').filter(Boolean);
        while (ws.length > 7 || (ws.length > 1 && ws.join(' ').length > 44))
            ws.pop();
        while (ws.length > 2 && TRAILING_STOP.has(ws[ws.length - 1].toLowerCase().replace(/[^\p{L}]/gu, '')))
            ws.pop();
        if (ws.length)
            ws[ws.length - 1] = ws[ws.length - 1].replace(/[,;:\-–—]+$/, '');
        sub = ws.join(' ');
        const norm = (x) => String(x).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
        if (!sub || norm(sub) === norm(main) || norm(main).includes(norm(sub)))
            sub = '';
    }
    else
        sub = String(p.sub);
    return sub ? `${main} | ${caseLike(sub, caseMode, presetId)}` : main;
}
function makeHookTitle(text, clipDur, presetId, y = 960, fs = TL.TITLE_DEFAULT_FS) {
    const end = Math.max(0.5, Math.min(HOOK_DUR, Number(clipDur) || HOOK_DUR));
    const base = {
        id: 'ttl_hook0', src: 'headline', text, start: 0, end,
        x: TL.TITLE_DEFAULT_X, y, fs: TL.TITLE_DEFAULT_FS, style: 'white_clean', anim: 'pop', glow: true,
    };
    const T = applyHookPreset(byId(presetId) ? presetId : DEFAULT_PRESET, base);
    let k = (+fs || TL.TITLE_DEFAULT_FS) / TL.TITLE_DEFAULT_FS;
    // [HOOK-FIT-WIDTH] A preset that enlarges its accent words can make one
    // line wider than the frame ("RAHASIA-RAHASIA TERTENTU" ran off both edges
    // in aksen_miring / kuning_tebal / pastel_lembut). Measure each line with
    // each word's own face and size and shrink the whole hook until the widest
    // line fits inside MAX_LINE_W.
    if (!T.kinetic)
        k *= Math.min(1, MAX_LINE_W / Math.max(1, widestLinePx(T)));
    if (k !== 1) {
        T.fs = Math.round((+T.fs || TL.TITLE_DEFAULT_FS) * k);
        for (const tk of T.tokens || [])
            if (tk.style && tk.style.fs)
                tk.style.fs = Math.round(tk.style.fs * k);
    }
    return T;
}
// ---- ASS measurement ------------------------------------------------------
function tcSec(tc) {
    const m = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(String(tc).trim());
    return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : NaN;
}
function parseAss(ass) {
    const lines = String(ass || '').split(/\r?\n/);
    let playResY = 1920;
    const styles = {};
    let styleFmt = null;
    let evFmt = null;
    const events = [];
    for (const ln of lines) {
        let m;
        if ((m = /^PlayResY:\s*(\d+)/.exec(ln)))
            playResY = +m[1];
        else if (/^Format:/.test(ln)) {
            const f = ln.slice(7).split(',').map(x => x.trim());
            if (f.includes('Fontname'))
                styleFmt = f;
            else
                evFmt = f;
        }
        else if (/^Style:/.test(ln) && styleFmt) {
            const v = ln.slice(6).split(',').map(x => x.trim());
            const o = {};
            styleFmt.forEach((k, i) => { o[k] = v[i]; });
            styles[o.Name] = { fs: +o.Fontsize || 0, align: +o.Alignment || 2, marginV: +o.MarginV || 0, bord: +o.Outline || 0 };
        }
        else if (/^Dialogue:/.test(ln) && evFmt) {
            const rest = ln.slice(9).trim();
            const parts = rest.split(',');
            const n = evFmt.length;
            const o = {};
            evFmt.forEach((k, i) => { o[k] = i < n - 1 ? (parts[i] || '').trim() : parts.slice(n - 1).join(','); });
            events.push(o);
        }
    }
    return { playResY, styles, events };
}
const num = (re, s) => { const m = re.exec(s); return m ? +m[1] : null; };
// Vertical extent [top, bottom] of one event in ASS pixels, at its settled
// state (pop/zoom scale-ins end at 100%; any larger scale tag is honoured).
function eventExtent(ev, styles) {
    const st = styles[ev.Style] || styles.Default || { fs: 64, align: 2, marginV: 0, bord: 0 };
    const text = String(ev.Text || '');
    const tags = (text.match(/\{[^}]*\}/g) || []).join('');
    const align = num(/\\an(\d)/, tags) || st.align;
    let yA, yB;
    const mv = /\\move\(\s*[-\d.]+\s*,\s*([-\d.]+)\s*,\s*[-\d.]+\s*,\s*([-\d.]+)/.exec(tags);
    const ps = /\\pos\(\s*[-\d.]+\s*,\s*([-\d.]+)\s*\)/.exec(tags);
    if (mv) {
        yA = Math.min(+mv[1], +mv[2]);
        yB = Math.max(+mv[1], +mv[2]);
    }
    else if (ps) {
        yA = yB = +ps[1];
    }
    else {
        const mV = (+ev.MarginV) || st.marginV;
        yA = yB = (align >= 7) ? mV : null; // top-anchored margin; others resolved below
        if (yA === null)
            yA = yB = mV; // bottom/mid-anchored: treat margin as the anchor
    }
    const scales = (tags.match(/\\fscy([\d.]+)/g) || []).map(t => +t.slice(5)).filter(Number.isFinite);
    const scale = Math.max(100, ...scales) / 100;
    const bord = Math.max(st.bord, ...((tags.match(/\\bord([\d.]+)/g) || []).map(t => +t.slice(5))));
    let h;
    if (/\\p[1-9]/.test(tags)) {
        // Vector drawing (box highlight): its own coordinates are its size.
        const body = text.replace(/\{[^}]*\}/g, ' ');
        const ys = [];
        const toks = body.trim().split(/\s+/);
        for (let i = 0; i < toks.length; i++) {
            if (/^[a-z]$/.test(toks[i]))
                continue;
            if (Number.isFinite(+toks[i]) && Number.isFinite(+toks[i + 1])) {
                ys.push(+toks[i + 1]);
                i++;
            }
        }
        if (!ys.length)
            return null;
        h = (Math.max(...ys) - Math.min(...ys)) * scale;
    }
    else {
        const plain = text.replace(/\{[^}]*\}/g, (t) => t.replace(/\\N/g, '\u0000')).replace(/\{[^}]*\}/g, '');
        if (!plain.replace(/\\N|\\n|\\h|\s/g, ''))
            return null;
        // Font size per line: the largest \fs active on that line (a tag carries
        // over to the following lines until another \fs replaces it).
        const segs = text.split('\\N');
        let cur = st.fs;
        h = 0;
        for (const seg of segs) {
            let lineMax = cur;
            for (const t of (seg.match(/\\fs([\d.]+)/g) || [])) {
                cur = +t.slice(3);
                lineMax = Math.max(lineMax, cur);
            }
            h += lineMax * 1.2;
        }
        h = h * scale + 2 * bord;
    }
    let top;
    if (align >= 7)
        top = yA;
    else if (align >= 4)
        top = yA - h / 2;
    else
        top = yA - h;
    const bottom = top + h + (yB - yA);
    return { top, bottom };
}
// Union extent of every visible event overlapping [t0, t1). null if none.
function assExtent(ass, t0, t1) {
    const { playResY, styles, events } = parseAss(ass);
    let top = Infinity, bottom = -Infinity;
    for (const ev of events) {
        const s = tcSec(ev.Start), e = tcSec(ev.End);
        if (!(e > t0 && s < t1))
            continue;
        // A gradient band darkens the lower frame on purpose — it is allowed to
        // run under the captions, so it is not part of the hook's footprint.
        if (String(ev.Name || '').trim() === 'backdrop-gradient')
            continue;
        // [KINETIC-EXTENT] A kinetic event states its own visible footprint.
        const kx = /^kinetic-[^@]*@(-?\d+):(-?\d+)$/.exec(String(ev.Name || '').trim());
        const ex = kx ? { top: +kx[1], bottom: +kx[2] } : eventExtent(ev, styles);
        if (!ex)
            continue;
        top = Math.min(top, ex.top);
        bottom = Math.max(bottom, ex.bottom);
    }
    return Number.isFinite(top) ? { top, bottom, playResY } : null;
}
// ---- placement ------------------------------------------------------------
// buildHookAss(T) must return the ASS buildAss would emit for ONLY that title
// (same format / font settings as the clip). captionsAss is the clip's caption
// ASS without the hook. Returns { title, reason } — title null = left off.
function placeHook({ text, clipDur, presetId, captionsAss, buildHookAss, avoid = [], center = false, centerY = NO_CAPTION_CENTER }) {
    if (!text)
        return { title: null, reason: 'no_title' };
    // [HOOK-CENTER] Centred, nothing to avoid; the captions are held back until
    // the hook ends (hideCaptions → trimCuesUnderHook), so the two never overlap.
    if (center) {
        const r = placeHook({ text, clipDur, presetId, captionsAss: '', buildHookAss, avoid: [], centerY: 960 }); // screen middle
        if (r.title) {
            r.title.hideCaptions = true;
            return { title: r.title, reason: 'placed_center' };
        }
        return r;
    }
    const probe = makeHookTitle(text, clipDur, presetId, 960);
    const win = [probe.start, probe.end];
    const cap = assExtent(captionsAss, win[0], win[1]);
    const measure = (T) => assExtent(buildHookAss(T), win[0], win[1]);
    let fs = TL.TITLE_DEFAULT_FS;
    for (let attempt = 0; attempt < 5; attempt++) {
        const a = measure(makeHookTitle(text, clipDur, presetId, 960, fs));
        const b = measure(makeHookTitle(text, clipDur, presetId, 1060, fs));
        if (!a || !b)
            return { title: null, reason: 'unmeasurable' };
        const R = a.playResY / 1920; // ASS px per canonical px
        const slope = (b.top - a.top) / 100; // ASS px per canonical y unit
        const H = a.bottom - a.top;
        const safeTop = SAFE_TOP * R, safeBot = SAFE_BOTTOM * R, gap = GAP * R;
        // [HOOK-FACE] Blocked bands: the captions, plus every face seen in the
        // hook window (avoid[] in canonical px). A hook "next to the captions"
        // landed on the speaker's face in a talking-head crop — faces are now as
        // off-limits as captions.
        const blocked = [];
        if (cap)
            blocked.push([cap.top, cap.bottom]);
        for (const f of avoid || [])
            if (f && f.bottom > f.top)
                blocked.push([f.top * R, f.bottom * R]);
        blocked.sort((p, q) => p[0] - q[0]);
        const regions = [];
        let cur = safeTop;
        for (const [t0, t1] of blocked) {
            if (t0 - gap > cur)
                regions.push([cur, Math.min(safeBot, t0 - gap)]);
            cur = Math.max(cur, t1 + gap);
        }
        if (cur < safeBot)
            regions.push([cur, safeBot]);
        // Prefer a band that touches the captions (one reading area), then the
        // roomiest one.
        const touchesCap = ([lo, hi]) => cap && (Math.abs(lo - (cap.bottom + gap)) < 2 || Math.abs(hi - (cap.top - gap)) < 2);
        const fits = regions.filter(([lo, hi]) => hi - lo >= H)
            .sort((p, q) => (touchesCap(q) - touchesCap(p)) || ((q[1] - q[0]) - (p[1] - p[0])));
        if (fits.length && slope > 0) {
            const [lo, hi] = fits[0];
            let wantTop;
            if (cap && Math.abs(lo - (cap.bottom + gap)) < 2)
                wantTop = Math.min(hi - H, lo + SLACK * R); // under the captions
            else if (cap && Math.abs(hi - (cap.top - gap)) < 2)
                wantTop = Math.max(lo, hi - H - SLACK * R); // over the captions
            else if (!cap && !(avoid || []).length)
                wantTop = Math.min(hi - H, Math.max(lo, centerY * R - H / 2));
            else
                wantTop = lo + (hi - lo - H) / 2; // centred in a free band
            const y = Math.round(960 + (wantTop - a.top) / slope);
            const T = makeHookTitle(text, clipDur, presetId, y, fs);
            const got = measure(T);
            const clear = got && got.top >= safeTop - 1 && got.bottom <= safeBot + 1
                && blocked.every(([t0, t1]) => got.bottom + gap - 1 <= t0 || got.top - gap + 1 >= t1);
            if (clear)
                return { title: T, reason: 'placed' };
        }
        const biggest = Math.max(0, ...regions.map(([lo, hi]) => hi - lo));
        if (!(biggest > 0))
            break;
        const next = Math.floor(fs * Math.min(0.9, (biggest / H) * 0.95));
        if (next < (probe.kinetic ? MIN_FS_KINETIC : MIN_FS) || next >= fs)
            break;
        fs = next;
    }
    // [HOOK-OVER-CAPTIONS] No band fits beside the captions without touching a
    // face: give the hook the caption area for its few seconds instead — the
    // captions start when the hook ends (the usual CapCut/TikTok pattern).
    // Faces stay off-limits.
    if (cap && !arguments[0]._noCap) {
        const r2 = placeHook(Object.assign({}, arguments[0], { captionsAss: '', _noCap: true }));
        if (r2.title) {
            r2.title.hideCaptions = true;
            return { title: r2.title, reason: 'placed_hide_captions' };
        }
    }
    return { title: null, reason: 'no_room' };
}
module.exports = {
    DEFAULT_PRESET, HOOK_DUR, SAFE_TOP, SAFE_BOTTOM, GAP, MIN_FS,
    hookTextFor, hookTextWithSub, makeHookTitle, parseAss, assExtent, placeHook,
};
