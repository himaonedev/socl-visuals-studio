// Generated from frontend/legacy-src/custom-chunks.ts by scripts/backend.cjs. Edit the TypeScript source.
// app/src/custom-chunks.js
// Pure logic behind "Custom" words-per-chunk: per-clip time-ranged rules that
// override the global words-per-chunk (and optionally the font) for whichever
// section of the clip the user draws a rule over. Loaded BOTH by the Electron
// renderer (script tag → window.CustomChunks) and by node tests (require).
// Never touches the DOM or clip.cueWords directly — renderer.js owns turning
// this into UI and committing the result.
(function (root) {
    'use strict';
    const EPS = 1e-6;
    // sanitizeRules(rules, clipDur) → cleaned, sorted, non-overlapping rules.
    // Drops anything degenerate (end<=start, words<1) after clamping into
    // [0, clipDur], then resolves overlaps by trimming a later rule's start
    // back to the end of whichever earlier rule it collides with — simple and
    // deterministic rather than rejecting the edit outright, so a user dragging
    // one rule's edge past another never loses either rule.
    function sanitizeRules(rules, clipDur) {
        const dur = Math.max(0, +clipDur || 0);
        const clamped = (Array.isArray(rules) ? rules : [])
            .map((r) => ({
            id: r.id,
            start: Math.max(0, Math.min(dur, +r.start || 0)),
            end: Math.max(0, Math.min(dur, +r.end || 0)),
            words: Math.max(1, Math.min(15, Number.isFinite(+r.words) ? Math.round(+r.words) : 3)),
            font: r.font || '',
        }))
            .filter((r) => r.end - r.start > EPS)
            .sort((a, b) => a.start - b.start);
        const out = [];
        for (const r of clamped) {
            const prev = out[out.length - 1];
            if (prev && r.start < prev.end - EPS) {
                if (r.end - prev.end <= EPS)
                    continue; // fully swallowed by the earlier rule
                out.push({ ...r, start: prev.end });
            }
            else {
                out.push(r);
            }
        }
        return out;
    }
    // buildChunkSegments(rules, globalN, clipDur) → ordered segments covering
    // [0, clipDur] with no gaps. Each segment carries the words-per-chunk and
    // font that apply to it: a rule's own values inside its range, the global N
    // and no font override everywhere else.
    function buildChunkSegments(rules, globalN, clipDur) {
        const dur = Math.max(0, +clipDur || 0);
        const clean = sanitizeRules(rules, dur);
        const bounds = new Set([0, dur]);
        for (const r of clean) {
            bounds.add(r.start);
            bounds.add(r.end);
        }
        const sorted = [...bounds].sort((a, b) => a - b);
        const segments = [];
        for (let i = 0; i < sorted.length - 1; i++) {
            const start = sorted[i], end = sorted[i + 1];
            if (end - start <= EPS)
                continue;
            const rule = clean.find((r) => start >= r.start - EPS && end <= r.end + EPS);
            segments.push({
                start, end,
                words: rule ? rule.words : Math.max(1, Math.min(8, +globalN || 3)),
                font: rule ? rule.font : '',
            });
        }
        return segments;
    }
    // rechunkWithRules(flatWords, rules, globalN, clipDur) → cueWords array.
    // `flatWords` matches the shape renderer.js's rechunkCues already builds
    // from clip.words: [{ text, style?, start, end }, ...]. Each word is
    // assigned to the segment its start time falls in, then grouped into that
    // segment's chunk size; a segment's font (if any) is stamped onto every
    // token in its chunks via style.fn — the SAME per-word override buildAss
    // already reads for ordinary caption cues, so no burn-side change is needed.
    function rechunkWithRules(flatWords, rules, globalN, clipDur) {
        const words = Array.isArray(flatWords) ? flatWords : [];
        const dur = Math.max(+clipDur || 0, words.length ? words[words.length - 1].end : 0);
        const segments = buildChunkSegments(rules, globalN, dur);
        const out = [];
        let wi = 0;
        for (const seg of segments) {
            const segWords = [];
            while (wi < words.length && words[wi].start < seg.end - EPS) {
                if (words[wi].start >= seg.start - EPS)
                    segWords.push(words[wi]);
                wi++;
            }
            for (let i = 0; i < segWords.length; i += seg.words) {
                const chunk = segWords.slice(i, i + seg.words);
                if (!chunk.length)
                    continue;
                const tokens = chunk.map((w) => {
                    const style = { ...(w.style || {}) };
                    if (seg.font)
                        style.fn = seg.font;
                    return Object.keys(style).length ? { text: w.text, style } : { text: w.text };
                });
                out.push({
                    start: chunk[0].start,
                    end: chunk[chunk.length - 1].end,
                    text: chunk.map((w) => w.text).join(' '),
                    tokens,
                    // [BOX-PREVIEW-RECHUNK] No `.words` field — box highlight derives
                    // per-word timing fresh from tokens+cue bounds at use time
                    // (deriveWordTiming in caption-box.js), not from a stored array
                    // this rechunker would need to remember to attach.
                });
            }
        }
        return out;
    }
    const api = { sanitizeRules, buildChunkSegments, rechunkWithRules };
    if (typeof module !== 'undefined' && module.exports)
        module.exports = api;
    else
        root.CustomChunks = api;
})(typeof self !== 'undefined' ? self : this);
