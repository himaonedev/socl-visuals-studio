// Generated from backend/src/context-model/picker.ts by scripts/backend.cjs. Edit the TypeScript source.
// ─── [CTX-MODEL] Context-aware moment picker (pure, no I/O) ─────────────────
// Scores sentence-aligned windows of the transcript with sentence embeddings
// from multilingual-e5-small plus the cues a human editor listens for, then
// picks diverse moments. Port of the feasibility harness in
// docs/riset-konteks-lokal-2026-10-19 (5 real videos: clean sentence starts
// 8 → 24 of 25, complete endings 13 → 23 of 25 vs the TF-IDF/topic picker).
//
// Embedding similarities from e5 sit in a narrow high band, so every semantic
// signal is a DIFFERENCE against bland exposition, z-normalised over the video.
// What an opening that makes people stay sounds like (ID + EN).
const HOOK = [
    "Here's the thing nobody tells you about this.", 'The biggest mistake people make is this.',
    'I was completely wrong about this for years.', 'What if everything you believe about this is wrong?',
    'This one decision changed my life.', 'Let me tell you a crazy story.', 'The truth is most people never figure this out.',
    'I lost everything because of this.', 'Why do people keep doing this?', 'Stop doing this immediately.',
    'It sounds insane, but it actually works.', "I'll never forget the day this happened.",
    'Ini yang orang jarang tahu.', 'Kesalahan terbesar orang itu sebenarnya ini.', 'Jujur, dulu gue salah besar soal ini.',
    'Kenapa sih orang selalu begini?', 'Gue pernah hampir kehilangan semuanya.', 'Ceritanya gini, waktu itu gue',
    'Rahasianya sebenarnya cuma satu.', 'Banyak orang nggak sadar soal ini.', 'Kalau mau berubah, berhenti lakukan ini.',
    'Ini yang bikin hidup gue berubah total.', 'Sumpah, ini gila banget.', 'Lo bayangin deh kalau itu terjadi sama lo.',
    'Yang paling bikin kaget itu ternyata', 'Gue kasih tau ya, ini penting banget.',
];
const PAYOFF = [
    "And that's exactly why it matters.", 'So the lesson is simple.', "That's the whole point.", 'And everybody started laughing.',
    'So the answer is actually the opposite.', 'And that changed everything for me.',
    'Jadi intinya adalah itu.', 'Itulah kenapa ini penting.', 'Makanya jangan pernah begitu.', 'Dan semua orang langsung ketawa.',
    'Jadi jawabannya justru kebalikannya.', 'Dan sejak itu semuanya berubah.',
];
const WEAK = [
    'Hi everyone, welcome back to the channel.', "Don't forget to like and subscribe.", "Okay, let's move on to the next one.",
    'This video is sponsored by', "Let's take a quick break.", 'The link is in the description.', 'Okay so yeah, um, right.',
    'Halo semuanya, selamat datang di channel kita.', 'Jangan lupa like dan subscribe ya.', 'Oke kita lanjut ya.',
    'Video ini disponsori oleh', 'Linknya ada di deskripsi.', 'Iya iya, oke, hmm.',
    'Thanks for watching, see you in the next episode.', 'Welcome back to another episode of the podcast.',
    'Channel ini selalu menyajikan konten terbaik untuk Anda.', 'Terima kasih sudah menonton, sampai jumpa di episode berikutnya.',
    'Selamat datang kembali di podcast kita.', 'Shout out buat semua yang sudah support, makasih ya.',
    "I'm your host, the best-selling author, and this is my co-host.", 'Saya host kalian hari ini, dan di sebelah saya partner saya.',
];
const DANGLING = [
    "And that's what I was saying earlier.", 'So yeah, like I said before.', "Exactly, that's it, right.",
    'Dan itu yang tadi gue bilang.', 'Jadi seperti yang tadi itu.', 'Nah itu dia, iya bener.',
];
const NEUTRAL = [
    'The study measured several variables over a period of time.', 'There are a few different factors to consider here.',
    'We then looked at the data from the second group.', 'It depends on the situation and the context.',
    'Ada beberapa faktor yang perlu kita pertimbangkan.', 'Kemudian kita lihat data dari kelompok kedua.',
    'Itu tergantung situasi dan kondisinya.', 'Jadi prosesnya ada beberapa tahap.',
];
const PROTOTYPES = { hook: HOOK, payoff: PAYOFF, weak: WEAK, dangle: DANGLING, neutral: NEUTRAL };
const LEX = {
    question: /\?/g,
    number: /\d|juta|miliar|ribu|million|billion|thousand|percent|persen|%|\$/gi,
    extreme: /\b(paling|terbesar|terburuk|nggak pernah|gak pernah|ga pernah|selalu|never|always|most|biggest|worst|best|everyone|semua orang)\b/gi,
    contrast: /\b(tapi|ternyata|justru|padahal|malah|but|actually|turns out|instead|however)\b/gi,
    you: /\b(you|your|lo|lu|elo|kamu|kalian|anda)\b/gi,
    story: /\b(waktu itu|pas gue|dulu gue|gue dulu|aku dulu|one day|when i was|i remember|i was|gue pernah|aku pernah)\b/gi,
    emotion: /\b(gila|anjir|parah|sedih|takut|kaget|marah|malu|crazy|insane|scared|terrified|shocked|embarrass\w*|love|hate|benci)\b/gi,
    laugh: /\[laughter\]|\(tertawa\)|\[tertawa\]|\bhaha+\b|\bwkwk+\b|\[applause\]|\[tepuk tangan\]/gi,
};
const FILLER_START = /^(and|so|but|yeah|yes|right|exactly|okay|ok|um|uh|dan|jadi|terus|nah|iya|ya|oke|tapi|makanya|itu|karena|soalnya|kan|because|cuz|he|she|they|dia|mereka)\b/i;
const SENT_END = /[.?!…]["')\]]*$/;
const SPEAKER = /^(?:>{2,}|&gt;&gt;)$/;
const count = (re, s) => (String(s).match(re) || []).length;
// Words (preferred: real per-word timing) or cues → sentences. A sentence ends
// on . ? ! … or a pause > 1.5 s; very long run-ons are cut at 45 words but such
// a cut is not a "hard" end, so a clip never stops there.
function buildSentences({ words = [], cues = [] } = {}) {
    let ws = (Array.isArray(words) ? words : [])
        .map((w) => ({ t: String(w.text ?? w.word ?? '').trim(), s: +w.start, e: +w.end }))
        .filter((w) => w.t && !SPEAKER.test(w.t) && Number.isFinite(w.s) && Number.isFinite(w.e) && w.e > w.s)
        .map((w) => ({ ...w, t: w.t.replace(/^(?:>{2,}|&gt;&gt;)/, '') }))
        .filter((w) => w.t);
    if (!ws.length) { // no word timing: spread each cue's words evenly over the cue
        ws = [];
        for (const c of Array.isArray(cues) ? cues : []) {
            const toks = String(c.text || '').replace(/(^|\s)(?:>{2,}|&gt;&gt;)/g, '$1').split(/\s+/).filter(Boolean);
            const a = +c.start, b = +c.end;
            if (!toks.length || !(b > a))
                continue;
            const step = (b - a) / toks.length;
            toks.forEach((t, k) => ws.push({ t, s: a + k * step, e: a + (k + 1) * step }));
        }
    }
    const out = [];
    let cur = [];
    const flush = (hard) => {
        if (!cur.length)
            return;
        out.push({ s: cur[0].s, e: cur[cur.length - 1].e, text: cur.map((x) => x.t).join(' '), n: cur.length, hard });
        cur = [];
    };
    ws.forEach((w, i) => {
        cur.push(w);
        const gap = i + 1 < ws.length ? ws[i + 1].s - w.e : 9;
        const punct = SENT_END.test(w.t);
        if (punct || gap > 1.5)
            flush(true);
        else if (cur.length >= 45)
            flush(false);
    });
    flush(true);
    out.forEach((s, k) => { s.cleanStart = k === 0 || out[k - 1].hard; });
    return out;
}
function percentile(sorted, q) {
    if (!sorted.length)
        return 0;
    const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
function zscore(xs) {
    const a = Array.from(xs, Number);
    const sorted = [...a].sort((x, y) => x - y);
    const med = percentile(sorted, 0.5);
    let iqr = percentile(sorted, 0.75) - percentile(sorted, 0.25);
    if (!iqr) {
        const mean = a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
        iqr = Math.sqrt(a.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, a.length)) || 1;
    }
    return a.map((x) => (x - med) / iqr);
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function dot(a, b) { let s = 0; for (let k = 0; k < a.length; k++)
    s += a[k] * b[k]; return s; }
function meanUnit(rows) {
    const d = rows[0].length, c = new Float64Array(d);
    for (const r of rows)
        for (let k = 0; k < d; k++)
            c[k] += r[k];
    let n = 0;
    for (let k = 0; k < d; k++)
        n += c[k] * c[k];
    n = Math.sqrt(n) || 1;
    for (let k = 0; k < d; k++)
        c[k] /= n;
    return c;
}
const maxSim = (v, protos) => protos.reduce((m, p) => Math.max(m, dot(v, p)), -Infinity);
function heatAt(heatmap, a, b) {
    let tot = 0, len = 0;
    for (const h of heatmap || []) {
        const ov = Math.min(b, +h.end_time) - Math.max(a, +h.start_time);
        if (ov > 0 && Number.isFinite(+h.value)) {
            tot += ov * +h.value;
            len += ov;
        }
    }
    return len ? tot / len : 0;
}
const overlaps = (a, b, r) => Math.min(b, r.end) - Math.max(a, r.start);
// S: sentences; V: one unit vector per sentence; P: {hook,payoff,weak,dangle,neutral}: arrays of unit vectors.
// dur: {min, ideal, max, flex}. promo: hard blocks (≥1 s overlap). seen: earlier clips (soft, >35 % coverage).
function pickMoments({ S, V, P, numClips = 5, dur, promo = [], seen = [], heatmap = null }) {
    const n = S.length;
    if (!n || V.length !== n)
        return { picks: [], candidates: 0 };
    const raw = {};
    for (const k of Object.keys(PROTOTYPES))
        raw[k] = V.map((v) => maxSim(v, P[k]));
    const diff = (k) => raw[k].map((x, i) => x - raw.neutral[i]);
    const hookZ = zscore(diff('hook')), payZ = zscore(diff('payoff'));
    const weakZ = zscore(diff('weak')), dangZ = zscore(diff('dangle'));
    const lex = {};
    for (const [k, re] of Object.entries(LEX))
        lex[k] = S.map((s) => count(re, s.text));
    const lexOpen = S.map((_, i) => 0.35 * Math.min(lex.question[i], 1) + 0.25 * Math.min(lex.number[i], 1)
        + 0.25 * Math.min(lex.extreme[i], 1) + 0.2 * Math.min(lex.contrast[i], 1) + 0.15 * Math.min(lex.you[i], 1)
        + 0.3 * Math.min(lex.story[i], 1) + 0.25 * Math.min(lex.emotion[i], 1));
    // topic turns: meaning of the ~45 s before vs after each sentence
    const shift = new Array(n).fill(0);
    for (let i = 1; i < n; i++) {
        const before = [], after = [];
        for (let j = i - 1; j >= 0 && S[i].s - S[j].s <= 45; j--)
            before.push(V[j]);
        for (let j = i; j < n && S[j].s - S[i].s <= 45; j++)
            after.push(V[j]);
        if (before.length && after.length)
            shift[i] = 1 - dot(meanUnit(before), meanUnit(after));
    }
    const shiftZ = zscore(shift);
    const wpsZ = zscore(S.map((s) => s.n / Math.max(0.3, s.e - s.s)));
    // a sponsor/CTA/intro line: an outlier on "weak" AND genuinely closer to the
    // weak prototypes than to plain exposition (the z alone flags any oddity
    // when a video's weak scores barely vary)
    const weakDiff = diff('weak');
    const promoSent = weakZ.map((w, i) => w > 3.0 && weakDiff[i] > 0);
    const blocked = (a, b) => promo.some((r) => overlaps(a, b, r) >= 1);
    const { min: lo, ideal, max: hi, flex } = dur;
    const cands = [];
    for (let i = 0; i < n; i++) {
        if (promoSent[i] || !S[i].cleanStart)
            continue;
        for (let j = i; j < n; j++) {
            const L = S[j].e - S[i].s;
            if (L > hi || promoSent[j])
                break;
            if (L < lo || !S[j].hard)
                continue;
            if (blocked(S[i].s, S[j].e))
                continue;
            const seg = V.slice(i, j + 1);
            const c = meanUnit(seg);
            const coh = seg.reduce((s, v) => s + dot(v, c), 0) / seg.length;
            // clamp per sentence: the FIRST sentence being the hook must outrank a hook that only comes second
            const open = clamp(hookZ[i], -3, 3) + (i + 1 <= j ? 0.5 * clamp(hookZ[i + 1], -3, 3) + 0.5 * lexOpen[i + 1] : 0) + lexOpen[i];
            let laughNearEnd = 0;
            for (let k = Math.max(i, j - 1); k <= Math.min(n - 1, j + 1); k++)
                laughNearEnd += lex.laugh[k];
            const close = payZ[j] + (laughNearEnd ? 0.6 : 0);
            const dangle = dangZ[i] + (FILLER_START.test(S[i].text) ? 2.0 : 0);
            const toks = S.slice(i, j + 1).map((s) => s.text.toLowerCase()).join(' ').match(/[\p{L}\p{N}_]+/gu) || [];
            const freq = new Map();
            for (const t of toks)
                freq.set(t, (freq.get(t) || 0) + 1);
            const ttr = freq.size / Math.max(1, toks.length);
            const top = Math.max(0, ...freq.values()) / Math.max(1, toks.length);
            const listy = toks.length >= 30 && (ttr < 0.42 || top > 0.12) ? 1 : 0; // roll-calls, chants, repeats
            const runon = S[i].n > 28 ? 1 : 0; // no clean first sentence
            let internal = 0;
            for (let k = i + 1; k <= j; k++)
                internal = Math.max(internal, shiftZ[k]);
            let weak = 0, dens = 0, laughs = 0;
            for (let k = i; k <= j; k++) {
                weak += weakZ[k];
                dens += wpsZ[k];
            }
            for (let k = i; k <= Math.min(n - 1, j + 1); k++)
                laughs += lex.laugh[k];
            cands.push({ start: S[i].s, end: S[j].e, i, j, c, L, listy, runon,
                f: { open, close, coh, boundary: shiftZ[i], internal: j > i ? internal : 0, weak: weak / (j - i + 1),
                    dangle, dens: dens / (j - i + 1), laughs } });
        }
    }
    if (!cands.length)
        return { picks: [], candidates: 0 };
    const cohZ = zscore(cands.map((c) => c.f.coh));
    cands.forEach((c, k) => {
        const f = c.f;
        const fit = flex ? 0 : -0.6 * Math.abs(c.L - ideal) / ideal;
        c.score = 1.0 * clamp(f.open, -4.5, 4.5) + 0.6 * clamp(f.close, -3, 3) + 0.5 * clamp(cohZ[k], -3, 3)
            + 0.35 * clamp(f.boundary, -1, 2) - 0.35 * clamp(f.internal, 0, 2)
            - 0.6 * f.weak - 0.5 * f.dangle + 0.15 * f.dens + 0.25 * Math.min(2, f.laughs)
            + fit - 2.0 * c.listy - 1.0 * c.runon;
    });
    if (Array.isArray(heatmap) && heatmap.length >= 5) { // Most Replayed as one more signal, same z scale
        const hz = zscore(cands.map((c) => heatAt(heatmap, c.start, c.end)));
        cands.forEach((c, k) => { c.score += 0.8 * clamp(hz[k], -1, 3); });
    }
    cands.sort((a, b) => b.score - a.score);
    const picks = [];
    for (const c of cands) { // diverse: no overlap (±5 s), no near-duplicate meaning, not an earlier clip
        if (picks.some((p) => c.start < p.end + 5 && c.end > p.start - 5))
            continue;
        if (picks.some((p) => dot(c.c, p.c) > 0.96))
            continue;
        if (seen.some((r) => overlaps(c.start, c.end, r) > 0.35 * (c.end - c.start)))
            continue;
        picks.push(c);
        if (picks.length >= numClips)
            break;
    }
    return {
        candidates: cands.length,
        picks: picks.map((p) => ({
            start: p.start, end: p.end, score: +p.score.toFixed(3),
            text: S.slice(p.i, p.j + 1).map((s) => s.text).join(' '),
            features: Object.fromEntries(Object.entries(p.f).map(([k, v]) => [k, +(+v).toFixed(3)])),
        })),
    };
}
module.exports = { PROTOTYPES, buildSentences, pickMoments, zscore, heatAt };
