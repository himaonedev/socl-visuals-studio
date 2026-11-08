'use strict';
// [TOPIC-SELECT] Local (no-AI) clip selection by TOPIC, not by keyword peaks.
//
// The old local picker scored 15–20 s windows by TF-IDF where a "document" was
// one subtitle line — nearly every word is rare at that grain, so scores were
// noise, and a 20 s peak was then padded to the clip length with whatever came
// next. Strong short-form clips (studied from a competitor's 40 picks, 65–118 s
// each) cover ONE subject start to finish: "kerokan di dada", "Messi atau
// Ronaldo", "how she got cast". So:
//
//   1. Split the transcript into topics — TextTiling: lexical similarity of
//      the 30 s before vs after each 15 s gap; boundaries sit in the valleys.
//   2. Fit topics to the clip length (merge short ones into their more
//      similar neighbour, split long ones at their weakest internal gap).
//   3. Score each topic: distinctiveness (TF-IDF with topic = document),
//      focus on one subject, a strong opening, specifics (numbers, names),
//      a payoff/answer, speech density; minus filler and promo.
//   4. Pick the best non-overlapping, mutually different topics.
//
// Pure: cues in, ranked candidates out. No AI, no I/O.

const { keyphrases, __test: { STOP } } = require('./clip-hook');

const BLOCK = 15;   // seconds per TextTiling block
const tok = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}\s'-]/gu, ' ').split(/\s+/)
  .filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w));
const FILLER_RE = /\b(eh+|ee+|em+|hmm+|uh+|um+|anu|gitu|gini|kayak|like)\b/gi;
const PAYOFF_RE = /\b(karena|jadi|ternyata|makanya|akhirnya|intinya|soalnya|kesimpulannya|because|so|turns out|that's why|finally|the point)\b/i;
const OPENER_RE = /\b(kenapa|mengapa|gimana|bagaimana|rahasia|ternyata|bahaya|jangan|pernah|pertama kali|cerita|tau gak|tahu nggak|serius|gila|why|how|secret|never|story|the truth|crazy|imagine)\b/i;

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (const [k, v] of a) { na += v * v; if (b.has(k)) dot += v * b.get(k); }
  for (const v of b.values()) nb += v * v;
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
const bag = (list) => { const m = new Map(); for (const w of list) m.set(w, (m.get(w) || 0) + 1); return m; };
const textOf = (cues, a, b) => cues.filter((c) => c.start >= a - 0.01 && c.start < b).map((c) => c.text || '').join(' ');

function segmentTopics(cues, duration) {
  const n = Math.max(1, Math.ceil(duration / BLOCK));
  const blocks = Array.from({ length: n }, (_, i) => bag(tok(textOf(cues, i * BLOCK, (i + 1) * BLOCK))));
  const merge = (from, to) => { const m = new Map(); for (let i = Math.max(0, from); i < Math.min(n, to); i++) for (const [k, v] of blocks[i]) m.set(k, (m.get(k) || 0) + v); return m; };
  // Similarity across each gap g (between block g-1 and g), 2 blocks each side.
  const sim = [];
  for (let g = 1; g < n; g++) sim[g] = cosine(merge(g - 2, g), merge(g, g + 2));
  const depth = [];
  for (let g = 1; g < n; g++) {
    let l = sim[g], r = sim[g];
    for (let k = g - 1; k >= 1 && sim[k] >= l; k--) l = sim[k];
    for (let k = g + 1; k < n && sim[k] >= r; k++) r = sim[k];
    depth[g] = (l - sim[g]) + (r - sim[g]);
  }
  const ds = depth.filter((d) => d != null);
  const mean = ds.reduce((a, b) => a + b, 0) / Math.max(1, ds.length);
  const sd = Math.sqrt(ds.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, ds.length));
  const cut = [];
  for (let g = 1; g < n; g++) {
    const isMin = (g === 1 || sim[g] <= sim[g - 1]) && (g === n - 1 || sim[g] <= sim[g + 1]);
    if (isMin && depth[g] > mean - sd / 2) cut.push(g);
  }
  const bounds = [0, ...cut.map((g) => g * BLOCK), duration];
  const segs = [];
  for (let i = 0; i + 1 < bounds.length; i++) if (bounds[i + 1] > bounds[i]) segs.push({ start: bounds[i], end: bounds[i + 1] });
  return { segs, sim, simAt: (t) => sim[Math.round(t / BLOCK)] ?? 1 };
}

// Snap a time to the nearest cue start (start) / cue end (end), so a clip
// begins and ends on speech boundaries.
const snapStart = (cues, t) => { let best = t, d = Infinity; for (const c of cues) { const x = Math.abs(c.start - t); if (x < d) { d = x; best = c.start; } } return best; };
const snapEnd = (cues, t) => { let best = t, d = Infinity; for (const c of cues) { const x = Math.abs(c.end - t); if (x < d) { d = x; best = c.end; } } return best; };

function fitLengths(segs, simAt, { min, max }) {
  let out = segs.slice();
  // Merge short topics into the neighbour they are more similar to.
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      const s = out[i];
      if (s.end - s.start >= min || out.length === 1) continue;
      const left = i > 0 ? simAt(s.start) : -1, right = i + 1 < out.length ? simAt(s.end) : -1;
      const j = left >= right ? i - 1 : i + 1;
      if (j < 0 || j >= out.length) continue;
      const a = out[Math.min(i, j)], b = out[Math.max(i, j)];
      out.splice(Math.min(i, j), 2, { start: a.start, end: b.end });
      changed = true;
      break;
    }
  }
  // Split long topics at their weakest internal gap until they fit.
  const res = [];
  const split = (s) => {
    if (s.end - s.start <= max) { res.push(s); return; }
    let best = null, bestSim = Infinity;
    for (let t = s.start + min; t <= s.end - min; t += BLOCK) {
      const v = simAt(t);
      if (v < bestSim) { bestSim = v; best = t; }
    }
    if (best == null) best = s.start + max;
    split({ start: s.start, end: best });
    split({ start: best, end: s.end });
  };
  out.forEach(split);
  return res;
}

function scoreTopics(cands, cues, lang, promoRanges = []) {
  const docs = cands.map((c) => tok(c.text));
  const df = new Map();
  docs.forEach((d) => new Set(d).forEach((w) => df.set(w, (df.get(w) || 0) + 1)));
  const N = docs.length;
  const raw = cands.map((c, i) => {
    const d = docs[i];
    const tf = bag(d);
    const weights = [...tf].map(([w, k]) => (k / Math.max(1, d.length)) * Math.log(1 + N / (df.get(w) || 1)));
    weights.sort((a, b) => b - a);
    const distinct = weights.slice(0, 8).reduce((a, b) => a + b, 0);
    const top = [...tf.values()].sort((a, b) => b - a)[0] || 0;
    const focus = d.length ? Math.min(1, (top / d.length) * 12) : 0;
    const words = String(c.text).split(/\s+/).filter(Boolean);
    const opener = textOf(cues, c.start, c.start + 12);
    const openerScore = Math.min(1, (/\?/.test(opener) ? 0.45 : 0) + (OPENER_RE.test(opener) ? 0.4 : 0) + (/\d/.test(opener) ? 0.15 : 0)
      + ((opener.match(/(?<=\s)\p{Lu}\p{L}+/gu) || []).length ? 0.15 : 0));
    const specifics = Math.min(1, ((c.text.match(/\d+/g) || []).length + (c.text.match(/(?<=\s)\p{Lu}\p{L}{2,}/gu) || []).length) / Math.max(10, words.length / 6));
    const lastHalf = textOf(cues, (c.start + c.end) / 2, c.end);
    const payoff = (PAYOFF_RE.test(lastHalf) ? 0.6 : 0) + (/[.!?]\s*$/.test(lastHalf.trim()) ? 0.4 : 0);
    const wps = words.length / Math.max(1, c.end - c.start);
    const density = Math.max(0, Math.min(1, (wps - 0.8) / 1.6));
    const filler = Math.min(1, ((c.text.match(FILLER_RE) || []).length / Math.max(1, words.length)) * 8);
    // detectPromoRanges() yields {start,end,kind} objects; the [a,b] pair form is
    // kept so older callers/tests still work. Destructuring an object as a pair
    // threw "object is not iterable" and killed Detect hooks for any video with
    // a sponsor segment on the no-API-key path.
    const promo = (promoRanges || []).some((r) => {
      const a = Array.isArray(r) ? r[0] : r?.start, b = Array.isArray(r) ? r[1] : r?.end;
      return c.start < b && c.end > a;
    }) ? 1 : 0;
    return { distinct, focus, openerScore, specifics, payoff, density, filler, promo };
  });
  const maxD = Math.max(1e-6, ...raw.map((r) => r.distinct));
  const total = raw.map((r) => 0.28 * (r.distinct / maxD) + 0.18 * r.focus + 0.2 * r.openerScore + 0.1 * r.specifics + 0.12 * r.payoff + 0.12 * r.density
    - 0.25 * r.filler - 1.0 * r.promo);
  // score10 is RELATIVE to this video's best topic (1..10), like the AI's
  // virality score — an absolute scale saturated at 10 for every pick.
  const best = Math.max(1e-6, ...total);
  return cands.map((c, i) => {
    const r = raw[i], s = total[i];
    return Object.assign({}, c, { topicScore: +s.toFixed(4), parts: r,
      score10: Math.max(1, Math.min(10, Math.round(10 * Math.max(0, s) / best))),
      terms: new Set(keyphrases(c.text, { max: 6 }).map((k) => k.phrase.toLowerCase())) });
  });
}

function jaccard(A, B) {
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

// cues: [{start,end,text}], duration (s), dur: {min, ideal, max}.
function selectTopics(cues, duration, { lang = 'id', dur, numClips = 5, promoRanges = [] } = {}) {
  const clean = (cues || []).filter((c) => c && c.text && c.end > c.start);
  if (clean.length < 4 || !(duration > 0)) return [];
  const min = Math.max(15, dur.min || dur.ideal * 0.6), max = Math.max(min + 5, dur.max || dur.ideal * 1.6);
  const { segs, simAt } = segmentTopics(clean, duration);
  const fitted = fitLengths(segs, simAt, { min, max })
    .map((s) => ({ start: snapStart(clean, s.start), end: Math.min(duration, snapEnd(clean, s.end)) }))
    .filter((s) => s.end - s.start >= Math.min(min, duration * 0.9));
  const cands = fitted.map((s) => ({ ...s, text: textOf(clean, s.start, s.end) })).filter((c) => c.text.trim());
  const scored = scoreTopics(cands, clean, lang, promoRanges).sort((a, b) => b.topicScore - a.topicScore);
  const picked = [];
  for (const c of scored) {
    if (c.parts.promo) continue;
    if (picked.some((p) => c.start < p.end && c.end > p.start)) continue;
    if (picked.some((p) => jaccard(p.terms, c.terms) >= 0.25)) continue;
    picked.push(c);
    if (picked.length >= numClips) break;
  }
  return picked;
}

module.exports = { selectTopics, __test: { segmentTopics, fitLengths, scoreTopics, tok } };
