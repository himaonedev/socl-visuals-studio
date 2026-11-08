'use strict';
// [KINETIC-TITLE] Motion-graphic title templates (the "kinetic" hook looks).
//
// One template = one function that lays out a headline as a flat list of
// ELEMENTS (single letters, words, filled shapes, stroked doodles), each with
// its own keyframes. Two writers consume that list:
//   toAssEvents()  -> libass Dialogue lines   (burn, this file)
//   renderer.js    -> absolutely positioned DOM + WAAPI keyframes (preview)
// so the preview and the burned clip are driven by the SAME geometry and the
// SAME timing — the lesson of every earlier preview≠burn bug in this app.
//
// Timing follows the kinetic-typography principles (easeOutExpo-ish entries,
// chars 20-40 ms apart, words 40-70 ms, whole reveal capped near ~800 ms):
// libass \t accel < 1 is an ease-out curve, used for every entry.
//
// Element shape:
//   { kind:'text', text, font, px, color, oc, ow, sc, sd, bold, x, y, rot,
//     keys:[{t, sx, sy, rot, a, x, y, blur, clip}] , a0, ord }
//   { kind:'shape', path, color, oc, ow, fillA, x, y, rot, keys:[...] }
// x/y are the element CENTRE in canonical 1080x1920 space; `keys` are deltas
// applied over time (t in ms from the title start). sx/sy in %, a = opacity 0..1,
// rot in degrees (absolute), clip = [l,t,r,b] in element-local px (wipe mask).
(function (root) {
const IS_NODE = typeof module !== 'undefined' && module.exports && typeof window === 'undefined';
const FM = IS_NODE ? require('./font-metrics') : null;

const EASE_OUT = 0.45;   // libass \t accel: <1 decelerates (easeOut)

// Relative luminance 0..1 of #rrggbb (sRGB weights, no gamma: a ranking only).
function glowLum(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return 1;
  const n = parseInt(m[1], 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
}
function hexToAss(hex) {
  const h = String(hex || '#ffffff').replace('#', '').padEnd(6, 'f');
  return `&H${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}&`.toUpperCase();
}
function alphaHex(a) {
  const v = Math.round(255 * (1 - Math.max(0, Math.min(1, a))));
  return `&H${v.toString(16).padStart(2, '0').toUpperCase()}&`;
}

// Deterministic PRNG so one headline always gets the same "random" jitter —
// preview, burn and a re-render must agree letter for letter.
function rng(seedStr) {
  let h = 2166136261;
  for (const ch of String(seedStr)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 10000) / 10000; };
}

let _fontsDir = null;
function fontsDir() {
  if (_fontsDir || !IS_NODE) return _fontsDir;
  try { _fontsDir = require('./pipeline-inverse-v1').__test.assFontsDirFs(); } catch { _fontsDir = ''; }
  return _fontsDir;
}
function setFontsDir(d) { _fontsDir = d; }

// Width in px of `text` set at CSS px `px` (font-metrics gives em widths).
// Browser: canvas advance widths of the same @font-face files libass burns.
let _ctx = null;
function canvasWidthEm(text, font, italic) {
  if (!_ctx) _ctx = document.createElement('canvas').getContext('2d');
  _ctx.font = `${italic ? 'italic ' : ''}100px "${font}"`;
  return _ctx.measureText(String(text)).width / 100;
}
// [KINETIC-WIDTHS] One table for burn and preview (see gen-kinetic-widths.js).
const WIDTHS = IS_NODE ? require('./kinetic-widths') : (root.KineticWidths || null);
function tableWidthEm(text, font) {
  const t = WIDTHS && WIDTHS[font];
  if (!t) return null;
  let sum = 0;
  for (const ch of String(text)) {
    const a = t[ch.codePointAt(0).toString(36)];
    if (a == null) return null;
    sum += a;
  }
  return sum;
}
function widthPx(text, font, px, italic = false) {
  let em = italic ? null : tableWidthEm(text, font);
  if (em == null) em = FM ? FM.textWidthEm(text, font, fontsDir(), false, italic) : canvasWidthEm(text, font, italic);
  return (em == null ? 0.55 * String(text).length : em) * px;
}

// Lay letters of `word` left->right starting at x0; returns centres.
function letterCentres(word, font, px, x0) {
  const out = [];
  const chars = Array.from(word);
  for (let i = 0; i < chars.length; i++) {
    const pre = widthPx(chars.slice(0, i).join(''), font, px);
    const w = widthPx(chars[i], font, px);
    out.push({ ch: chars[i], cx: x0 + pre + w / 2, w });
  }
  return out;
}

// Greedy line split by a max width.
function wrapWords(words, font, px, maxW) {
  const lines = [];
  let cur = [];
  for (const w of words) {
    const tryL = cur.concat(w).join(' ');
    if (cur.length && widthPx(tryL, font, px) > maxW) { lines.push(cur); cur = [w]; } else cur.push(w);
  }
  if (cur.length) lines.push(cur);
  return lines;
}

// Split words into exactly k lines minimising the widest line (words <= ~10,
// so trying every cut is cheap). Balanced lines read as a designed lockup.
function balancedLines(words, k, font, px) {
  k = Math.max(1, Math.min(k, words.length));
  let best = null;
  const rec = (start, left, acc) => {
    if (left === 1) {
      const lines = acc.concat([words.slice(start)]);
      const m = Math.max(...lines.map((l) => widthPx(l.join(' '), font, px)));
      if (!best || m < best.m) best = { m, lines };
      return;
    }
    for (let e = start + 1; e <= words.length - left + 1; e++) rec(e, left - 1, acc.concat([words.slice(start, e)]));
  };
  rec(0, k, []);
  return best.lines;
}

// Rotate point (x,y) about (ox,oy) by deg (screen coords, +deg = clockwise
// like CSS rotate; libass \frz is counter-clockwise, handled in the writer).
function rotPt(x, y, ox, oy, deg) {
  const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  const dx = x - ox, dy = y - oy;
  return [ox + dx * c - dy * s, oy + dx * s + dy * c];
}

// ---------------------------------------------------------------------------
// Drawing helpers (ASS \p1 paths in a local box, origin top-left).
const P = {
  rect: (w, h) => `m 0 0 l ${w} 0 ${w} ${h} 0 ${h}`,
  // parallelogram band skewed by k px
  band: (w, h, k) => `m ${k} 0 l ${w} 0 ${w - k} ${h} 0 ${h}`,
  // torn tape: jagged short edges
  tape: (w, h, r) => {
    const pts = [[0, 0]];
    const teeth = 5;
    for (let i = 1; i <= teeth; i++) pts.push([w - (i % 2 ? r() * 14 : 0), (h * i) / teeth]);
    for (let i = teeth - 1; i >= 0; i--) pts.push([(i % 2 ? r() * 14 : 0), (h * i) / teeth]);
    // close: top edge back to start already implied
    const [first, ...rest] = [[0, 0], [w, 0], ...pts.slice(1)];
    return `m ${first[0]} ${first[1]} l ${rest.map((p) => `${p[0] | 0} ${p[1] | 0}`).join(' ')}`;
  },
  // torn paper strip: ragged top and bottom edges, slightly uneven ends
  paper: (w, h, r) => {
    const top = [], bot = [];
    const n = Math.max(6, Math.round(w / 22));
    for (let i = 0; i <= n; i++) top.push([(w * i) / n, r() * 6]);
    for (let i = n; i >= 0; i--) bot.push([(w * i) / n, h - r() * 6]);
    const pts = top.concat([[w - r() * 4, h * 0.5]], bot, [[r() * 4, h * 0.5]]);
    return `m ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)} l ${pts.slice(1).map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ')}`;
  },
  // tapered spike (burst line) pointing up-right, length L
  spike: (L, w) => `m 0 ${w} l ${L} 0 ${L} ${w * 0.35} 0 ${w * 1.35}`,
  // tick / check mark
  check: (s) => `m 0 ${s * 0.55} l ${s * 0.22} ${s * 0.38} ${s * 0.42} ${s * 0.62} ${s} 0 ${s * 1.12} ${s * 0.16} ${s * 0.42} ${s * 0.92}`,
  // ring arc (thick quarter ring) — approximated with line segments
  arc: (R, th, a0, a1) => {
    const n = 14, o = [], i2 = [];
    for (let i = 0; i <= n; i++) {
      const a = (a0 + (a1 - a0) * (i / n)) * Math.PI / 180;
      o.push([R + R * Math.cos(a), R + R * Math.sin(a)]);
      i2.push([R + (R - th) * Math.cos(a), R + (R - th) * Math.sin(a)]);
    }
    const pts = o.concat(i2.reverse());
    return `m ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)} l ${pts.slice(1).map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ')}`;
  },
  // hand-drawn ellipse loop (stroke via outline only)
  loop: (w, h, r) => {
    const n = 22, pts = [];
    for (let i = 0; i <= n + 3; i++) {
      const a = (i / n) * Math.PI * 2 - 0.4;
      const j = 1 + (r() - 0.5) * 0.08;
      pts.push([w / 2 + (w / 2) * Math.cos(a) * j, h / 2 + (h / 2) * Math.sin(a) * j]);
    }
    return `m ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)} l ${pts.slice(1).map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ')}`;
  },
  // scribble strike line
  strike: (w, r) => {
    const pts = [];
    for (let i = 0; i <= 8; i++) pts.push([(w * i) / 8, (r() - 0.5) * 10 + (i % 2) * 3]);
    return `m ${pts[0][0]} ${pts[0][1].toFixed(1)} l ${pts.slice(1).map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ')}`;
  },
};

// ---------------------------------------------------------------------------
// TEMPLATES. Each returns { elements, box:{top,bottom,left,right} } for a title
// centred at (cx, cy) with base size `px` (canonical 1080x1920 space).

function letterPop(lines, { font, px, color, oc, ow, sc, sd, lineGap, cx, cy, rot, t0, stagger, popMs, from = 0, overshoot = 118, lineStyle }) {
  const els = [];
  const lh = px * lineGap;
  const total = lines.length * lh;
  let k = 0;
  lines.forEach((ln, li) => {
    const st = lineStyle ? lineStyle(li) : {};
    const fpx = st.px || px;
    const text = ln.join(' ');
    const W = widthPx(text, st.font || font, fpx);
    const y = cy - total / 2 + lh * li + lh / 2;
    letterCentres(text, st.font || font, fpx, cx - W / 2).forEach((L) => {
      if (L.ch === ' ') return;
      const [x, yy] = rotPt(L.cx, y, cx, cy, rot);
      const t = t0 + k * stagger;
      k++;
      els.push({
        kind: 'text', text: L.ch, font: st.font || font, px: fpx, color: st.color || color, oc: st.oc || oc, ow: st.ow ?? ow,
        sc: st.sc || sc, sd: st.sd ?? sd, x, y: yy, rot,
        keys: [{ t: 0, sx: from, sy: from, a: 0 }, { t, sx: from, sy: from, a: 0 }, { t: t + 1, a: 1 },
          { t: t + popMs * 0.6, sx: overshoot, sy: overshoot }, { t: t + popMs, sx: 100, sy: 100 }],
      });
    });
  });
  return els;
}

// [HOOK-SUB] "MAIN | SMALL" — the small line (kicker label / sub-headline) rides
// in the same title text after a bar, so it stays editable as one field.
// Pure connectors only: "BISA SEMBUNYIKAN" keeps "BISA" inside the box.
const SOROT_SKIP = new Set('yang dan di ke dari ini itu untuk dengan karena jadi tapi atau the a an to of and or in on for'.split(' '));
// [KIN-CAP-NO-BLINK] Fade-out of a kinetic caption cue: none when the next cue
// follows within `gap` s (it replaces this one), else a short 80 ms fade.
// Shared by the burn (toAssEvents) and the preview (paintKineticTitle).
function kinCapFadeMs(cue, next, gap = 0.05) {
  return next && cue && (+next.start - +cue.end) <= gap ? 0 : 80;
}
function splitSub(text) {
  const t = String(text || '');
  const i = t.indexOf('|');
  return i < 0 ? [t.trim(), ''] : [t.slice(0, i).trim(), t.slice(i + 1).trim()];
}
// Wrap at maxW, shrinking the size until it fits in maxLines.
function fitWrap(words, font, px, maxW, maxLines) {
  let p = px, lines = wrapWords(words, font, p, maxW);
  while (lines.length > maxLines && p > px * 0.55) { p *= 0.9; lines = wrapWords(words, font, p, maxW); }
  return { lines, px: p };
}

const TEMPLATES = {
  // Sticker headline: chunky rounded pink letters popping in one by one, the
  // second line on a lime skewed ribbon that wipes in, plus burst spikes,
  // spinning arcs and a check mark. Whole lockup tilted a few degrees.
  stiker_pop(text, o) {
    const r = rng(text);
    const words = text.split(/\s+/).filter(Boolean);
    const px = (o.px || 140) * (o.k || 1);
    const font = 'CooperBlkBT-Regular';
    const rot = -5;
    // Reference lockup: a short BIG line on top, the rest on the ribbon.
    // Top = first ~40% of the words (1-3), shrunk to fit one line; ribbon =
    // the rest, shrunk to fit one line too.
    const up = words.map((w) => w.toUpperCase());
    const nRib = up.length <= 2 ? up.length - 1 : Math.min(3, Math.floor(up.length / 2));
    const top = up.slice(0, up.length - nRib);
    const rib = up.slice(up.length - nRib);
    const fitPx = (t, f, p0, maxW) => Math.min(p0, Math.floor(p0 * maxW / Math.max(1, widthPx(t, f, p0))));
    const ribFont = 'CooperBlkBT-Regular';
    const big = Math.max(px, 140);
    const nL = Math.min(3, wrapWords(top, font, big, 920).length);
    const topLines = balancedLines(top, nL, font, big);
    // 860 not 920: the lockup is tilted, so its corners reach further out.
    const topPx = Math.min(...topLines.map((l) => fitPx(l.join(' '), font, big, 860)));
    const ribPx = rib.length ? fitPx(rib.join(' '), ribFont, Math.round(topPx * 0.62), 860) : 0;
    const cx = o.cx, cy = o.cy;
    const topH = topPx * 1.0 * topLines.length;
    const ribH = rib.length ? ribPx * 1.75 : 0;
    const H = topH + ribH;
    const topCy = cy - H / 2 + topH / 2;
    const ribCy = cy + H / 2 - ribH / 2 + ribPx * 0.12;
    const els = [];
    // Ribbon band first (drawn under its text).
    if (rib.length) {
      const rt = rib.join(' ');
      const rw = widthPx(rt, ribFont, ribPx) + ribPx * 1.1;
      const bh = ribPx * 1.32;
      const [bx, by] = rotPt(cx, ribCy, cx, cy, rot);
      els.push({ kind: 'shape', path: P.band(rw, bh, bh * 0.28), w: rw, h: bh, color: '#29b34a', oc: '#0b4f22', ow: 5, sd: 7, sc: '#0b3a1a', x: bx, y: by, rot,
        keys: [{ t: 0, a: 0, clip: [0, 0, 0, bh] }, { t: 180, a: 1, clip: [0, 0, 0, bh] }, { t: 520, clip: [0, -40, rw + 40, bh + 40] }] });
    }
    els.push(...letterPop(topLines, { font, px: topPx, color: '#ff3fa4', oc: '#5c0a3a', ow: 7, sc: '#3b0726', sd: 7, lineGap: 1.0, cx, cy: topCy, rot, t0: 60, stagger: Math.min(38, 640 / Math.max(1, topLines.flat().join("").length)), popMs: 260 }));
    if (rib.length) {
      const n0 = topLines.flat().join('').length;
      els.push(...letterPop([rib], { font: ribFont, px: ribPx, color: '#f2ff3b', oc: '#0b4f22', ow: 5, sc: '#0b3a1a', sd: 4, lineGap: 1.0, cx, cy: ribCy + 2, rot, t0: 260 + n0 * 10, stagger: 30, popMs: 220 }));
    }
    // Decorations around the lockup.
    const halfW = Math.min(500, Math.max(...topLines.map((l) => widthPx(l.join(' '), font, topPx))) / 2 + 30);
    const burst = ['#ffe81a', '#ffe81a', '#36c759', '#3a6bff', '#ff9f1a'];
    burst.forEach((c, i) => {
      const ang = -120 + i * 14 + (r() - 0.5) * 6;
      const L = 70 + r() * 50;
      const bx = cx - halfW + 10 + i * 12, by = cy - H / 2 - 30 - (i % 2) * 14;
      els.push({ kind: 'shape', path: P.spike(L, 12), w: L, h: 16, color: c, x: bx, y: by, rot: ang,
        keys: [{ t: 0, a: 0, sx: 0, sy: 100 }, { t: 340 + i * 30, a: 0, sx: 0 }, { t: 341 + i * 30, a: 1 }, { t: 520 + i * 30, sx: 115 }, { t: 640 + i * 30, sx: 100 }] });
    });
    [['#36e0ff', 56, 18, 0], ['#3a46ff', 40, 14, 40]].forEach(([c, R, th, d], i) => {
      els.push({ kind: 'shape', path: P.arc(R, th, 120, 300), w: R * 2, h: R * 2, color: c, x: cx - halfW + 10 + i * 6, y: cy + H / 2 + 40 + i * 4, rot: 0,
        keys: [{ t: 0, a: 0, rot: -90 }, { t: 420 + d, a: 0, rot: -90 }, { t: 421 + d, a: 1 }, { t: 900 + d, rot: 30 }, { t: 3200, rot: 70 }] });
    });
    els.push({ kind: 'shape', path: P.check(78), w: 88, h: 88, color: '#ff3fa4', oc: '#5c0a3a', ow: 4, x: cx + halfW - 10, y: cy + H / 2 + 36, rot: -6,
      keys: [{ t: 0, a: 0, sx: 0, sy: 0 }, { t: 560, a: 0, sx: 0, sy: 0 }, { t: 561, a: 1 }, { t: 720, sx: 125, sy: 125 }, { t: 840, sx: 100, sy: 100 }] });
    return { elements: els, box: { top: cy - H / 2 - 110, bottom: cy + H / 2 + 90 } };
  },

  // Riot zine: condensed yellow capitals, every letter dropped in with its own
  // tilt and bounce, then a scribbled loop around the last word, a strike
  // under the first and a black ticker strip of the text scrolling below.
  riot(text, o) {
    const r = rng(text);
    const words = text.toUpperCase().split(/\s+/).filter(Boolean);
    const px = (o.px || 150) * (o.k || 1);
    const font = 'Anton';
    const cx = o.cx, cy = o.cy;
    const lines = wrapWords(words, font, px, 860);
    const lh = px * 1.08;
    const H = lines.length * lh;
    const els = [];
    let k = 0;
    // Random drop order inside the reveal window (like the reference: letters
    // land scattered, not left-to-right).
    const all = [];
    lines.forEach((ln, li) => {
      const t = ln.join(' ');
      const W = widthPx(t, font, px);
      const wordTilt = ln.map(() => (r() - 0.5) * 10);
      let wi = 0;
      const y = cy - H / 2 + lh * li + lh / 2;
      letterCentres(t, font, px, cx - W / 2).forEach((L) => {
        if (L.ch === ' ') { wi++; return; }
        all.push({ L, y: y + (r() - 0.5) * 14, rot: wordTilt[wi] + (r() - 0.5) * 7, line: li, word: wi });
      });
    });
    const order = all.map((_, i) => i).sort(() => r() - 0.5);
    order.forEach((idx, n) => { all[idx].t = 80 + n * Math.min(40, 560 / all.length); });
    all.forEach((A) => {
      const t = A.t;
      els.push({ kind: 'text', text: A.L.ch, font, px, color: '#f5f01f', oc: '#111111', ow: 6, sc: '#000000', sd: 0, x: A.L.cx, y: A.y, rot: A.rot,
        keys: [{ t: 0, a: 0, sx: 170, sy: 170, rot: A.rot + (r() - 0.5) * 40, y: A.y - 90 }, { t, a: 0 }, { t: t + 1, a: 1 },
          { t: t + 140, sx: 92, sy: 92, rot: A.rot, y: A.y }, { t: t + 230, sx: 100, sy: 100 }] });
      k++;
    });
    const doneT = 80 + all.length * Math.min(40, 560 / all.length) + 60;   // doodles start as the last letters land
    // Loop around the last word.
    const lastLine = lines[lines.length - 1];
    const lastW = widthPx(lastLine[lastLine.length - 1], font, px);
    const lineW = widthPx(lastLine.join(' '), font, px);
    const lx = cx + lineW / 2 - lastW / 2, ly = cy + H / 2 - lh / 2;
    els.push({ kind: 'shape', path: P.loop(lastW + 70, lh * 0.95, r), w: lastW + 70, h: lh * 0.95, color: '#ffffff', fillA: 0, oc: '#ffffff', ow: 3, x: lx, y: ly, rot: -8,
      keys: [{ t: 0, a: 0, clip: [0, 0, 0, lh] }, { t: doneT, a: 0 }, { t: doneT + 1, a: 1 }, { t: doneT + 380, clip: [-20, -20, lastW + 100, lh + 20] }] });
    // Strike through the first word.
    const firstW = widthPx(lines[0][0], font, px);
    const fW0 = widthPx(lines[0].join(' '), font, px);
    const sx0 = cx - fW0 / 2 + firstW / 2, sy0 = cy - H / 2 + lh * 0.5;
    els.push({ kind: 'shape', path: P.strike(firstW + 30, r), w: firstW + 30, h: 14, color: '#ffffff', oc: '#ffffff', ow: 2, fillA: 0, x: sx0, y: sy0, rot: -4,
      keys: [{ t: 0, a: 0, clip: [0, -20, 0, 34] }, { t: doneT + 150, a: 0 }, { t: doneT + 151, a: 1 }, { t: doneT + 400, clip: [-10, -20, firstW + 50, 34] }] });
    // Ticker strip.
    const tick = (`${words.join(' ')} • `).repeat(4);
    const tpx = 46;
    const tW = widthPx(tick, font, tpx);
    const ty = cy + H / 2 + 70;
    els.push({ kind: 'shape', bleed: true, path: P.rect(1300, 72), w: 1300, h: 72, color: '#111111', x: 540, y: ty, rot: -3,
      keys: [{ t: 0, a: 0, clip: [0, 0, 0, 72] }, { t: doneT - 150, a: 0 }, { t: doneT - 149, a: 0.92 }, { t: doneT + 200, clip: [0, 0, 1300, 72] }] });
    els.push({ kind: 'text', bleed: true, text: tick, font, px: tpx, color: '#f2f2f2', oc: '#111111', ow: 0, sd: 0, x: 540 + tW / 2 - 700, y: ty + 2, rot: -3,
      keys: [{ t: 0, a: 0 }, { t: doneT, a: 0 }, { t: doneT + 200, a: 1 }, { t: 3500, x: 540 + tW / 2 - 700 - 360, y: ty + 2 - 19 }] });
    return { elements: els, box: { top: cy - H / 2 - 40, bottom: ty + 50 } };
  },

  // Tape label: a torn yellow strip of tape wipes across, then the headline
  // types onto it as ransom-note letters (alternating faces, some inverted).
  lakban(text, o) {
    const r = rng(text);
    const words = text.toUpperCase().split(/\s+/).filter(Boolean);
    const px = (o.px || 96) * (o.k || 1);
    const faces = ['Anton', 'CooperBlkBT-Regular', 'Times New Roman MT Condensed', 'Anton', "Editor'sNote-Semibold"];
    const cx = o.cx, cy = o.cy;
    // Pick each letter's face/size first, then wrap on those real widths so
    // the tape never runs off the frame.
    const specOf = (ch) => {
      const f = faces[Math.floor(r() * faces.length)];
      const p = px * (0.9 + r() * 0.25);
      return { ch, f, p, w: ch === ' ' ? px * 0.35 : widthPx(ch, f, p) + 6, inv: r() < 0.22 };
    };
    const wordSpecs = words.map((w) => Array.from(w).map(specOf));
    const wW = (ws) => ws.reduce((a, c) => a + c.w, 0);
    const MAXW = 840;
    const lines = [];
    let cur = [];
    wordSpecs.forEach((ws) => {
      const next = cur.length ? cur.concat([[specOf(' ')], ws]) : [ws];
      if (cur.length && wW(next.flat()) > MAXW) { lines.push(cur); cur = [ws]; } else cur = next;
    });
    if (cur.length) lines.push(cur);
    const lh = px * 1.45;
    const H = lines.length * lh;
    const els = [];
    let k = 0;
    const nCh = words.join('').length;
    lines.forEach((ln, li) => {
      const y = cy - H / 2 + lh * li + lh / 2;
      let spec = ln.flat();
      let W = wW(spec);
      if (W > MAXW) { const f = MAXW / W; spec = spec.map((c) => Object.assign({}, c, { p: c.p * f, w: c.w * f })); W = MAXW; }
      const tw = W + 70;
      const tT = li * 110;
      els.push({ kind: 'shape', path: P.tape(tw, lh * 0.92, r), w: tw, h: lh * 0.92, color: '#ffe100', x: cx, y, rot: li % 2 ? 1.5 : -2,
        keys: [{ t: 0, a: 1, clip: [0, -10, 0, lh + 10] }, { t: tT, clip: [0, -10, 0, lh + 10] }, { t: tT + 300, clip: [-10, -10, tw + 20, lh + 10] }] });
      let x = cx - W / 2;
      spec.forEach((c) => {
        const ccx = x + c.w / 2; x += c.w;
        if (c.ch === ' ') return;
        const at = tT + 260 + k * Math.min(34, 520 / Math.max(1, nCh)); k++;
        const rot = (r() - 0.5) * 8;
        if (c.inv) {
          els.push({ kind: 'shape', path: P.rect(c.w + 2, c.p * 0.95), w: c.w + 2, h: c.p * 0.95, color: '#111111', x: ccx, y, rot,
            keys: [{ t: 0, a: 0 }, { t: at, a: 0 }, { t: at + 1, a: 1 }] });
        }
        els.push({ kind: 'text', text: c.ch, font: c.f, px: c.p, color: c.inv ? '#ffe100' : '#111111', oc: '#000000', ow: 0, sd: 0, x: ccx, y: y + 2, rot,
          keys: [{ t: 0, a: 0, sx: 140, sy: 140 }, { t: at, a: 0, sx: 140, sy: 140 }, { t: at + 1, a: 1 }, { t: at + 90, sx: 100, sy: 100 }] });
      });
    });
    return { elements: els, box: { top: cy - H / 2, bottom: cy + H / 2 } };
  },

  // [HOOK-SOROTAN] News-highlight look: a small red pill label on top, a
  // condensed white headline, and the payoff phrase of one line knocked out on
  // a red box. Text: "HEADLINE | LABEL" (label defaults to SOROTAN).
  sorotan(text, o) {
    const [main, kick0] = splitSub(text);
    // Case comes from the hook text itself (Huruf hook setting), never forced.
    const words = main.split(/\s+/).filter(Boolean);
    if (!words.length) return { elements: [], box: null };
    const font = 'Anton', kfont = 'Inter SOCL Black';
    const cx = o.cx, cy = o.cy;
    const fit = fitWrap(words, font, (o.px || 118) * (o.k || 1), 900, 3);
    const lines = fit.lines, px = fit.px;
    const lh = px * 1.1;
    const H = lines.length * lh;
    const els = [];
    // Label pill.
    const kick = kick0 || 'SOROTAN';
    const kpx = Math.max(22, px * 0.27);
    const kW = widthPx(kick, kfont, kpx) + kpx * 1.2, kH = kpx * 1.75;
    const ky = cy - H / 2 - kH / 2 - px * 0.14;
    els.push({ kind: 'shape', path: P.rect(kW, kH), w: kW, h: kH, color: '#E5202E', x: cx, y: ky, rot: 0,
      keys: [{ t: 0, a: 0, sx: 60, sy: 60 }, { t: 40, a: 0, sx: 60, sy: 60 }, { t: 41, a: 1 }, { t: 200, sx: 108, sy: 108 }, { t: 280, sx: 100, sy: 100 }] });
    els.push({ kind: 'text', text: kick, font: kfont, px: kpx, color: '#FFFFFF', oc: '#000000', ow: 0, sd: 0, x: cx, y: ky + kpx * 0.04, rot: 0,
      keys: [{ t: 0, a: 0 }, { t: 120, a: 0 }, { t: 220, a: 1 }] });
    // Which line carries the payoff box: the middle of three, else the last.
    const hiLine = lines.length >= 3 ? 1 : lines.length - 1;
    lines.forEach((ln, li) => {
      const y = cy - H / 2 + lh * li + lh / 2;
      const t = ln.join(' ');
      const W = widthPx(t, font, px);
      const at = 160 + li * 110;
      if (li === hiLine && lines.length > 1 || (lines.length === 1 && ln.length > 1)) {
        // Box the phrase after any leading connector words ("YANG [BISA SEMBUNYIKAN]").
        let s0 = 0;
        while (s0 < ln.length - 1 && SOROT_SKIP.has(ln[s0].toLowerCase())) s0++;
        if (lines.length === 1) s0 = Math.max(s0, Math.ceil(ln.length / 2));
        const pre = ln.slice(0, s0).join(' ');
        const hi = ln.slice(s0).join(' ');
        const x0 = cx - W / 2 + (pre ? widthPx(pre + ' ', font, px) : 0);
        const hw = widthPx(hi, font, px), pad = px * 0.12;
        const bw = hw + pad * 2, bh = px * 1.02;
        els.push({ kind: 'shape', path: P.rect(bw, bh), w: bw, h: bh, color: '#E5202E', x: x0 + hw / 2, y: y + px * 0.02, rot: 0,
          keys: [{ t: 0, a: 1, clip: [0, -4, 0, bh + 4] }, { t: at + 120, clip: [0, -4, 0, bh + 4] }, { t: at + 360, clip: [-4, -4, bw + 4, bh + 4] }] });
      }
      // Thin hard shadow: burn (\shad) and preview (text-shadow) draw it the same.
      els.push({ kind: 'text', text: t, font, px, color: '#FFFFFF', oc: '#000000', ow: 0, sc: '#000000', sd: 2, x: cx, y, rot: 0,
        keys: [{ t: 0, a: 0, y: y + px * 0.35 }, { t: at, a: 0, y: y + px * 0.35 }, { t: at + 240, a: 1, y }] });
    });
    return { elements: els, box: { top: ky - kH / 2, bottom: cy + H / 2 } };
  },

  // [HOOK-KERTAS] Torn-paper headline: each line on its own ragged white strip,
  // heavy black capitals, and a yellow sub-headline bar under it.
  // Text: "HEADLINE | SUB-HEADLINE" (no bar = headline only).
  kertas_sobek(text, o) {
    const r = rng(text);
    const [main, sub] = splitSub(text);
    const words = main.split(/\s+/).filter(Boolean);
    if (!words.length) return { elements: [], box: null };
    const font = 'Inter SOCL Black';
    const cx = o.cx, cy = o.cy;
    const fit = fitWrap(words, font, (o.px || 100) * (o.k || 1), 820, 3);
    const lines = fit.lines, px = fit.px;
    const sh = px * 1.16, gap = px * 0.1;
    const subWords = sub.split(/\s+/).filter(Boolean);
    const sfit = subWords.length ? fitWrap(subWords, font, Math.max(24, px * 0.34), 900, 2) : { lines: [], px: 0 };
    const spx = sfit.px, slh = spx * 1.6;
    const Hm = lines.length * sh + (lines.length - 1) * gap;
    const Hs = sfit.lines.length ? sfit.lines.length * slh + px * 0.22 : 0;
    const top = cy - (Hm + Hs) / 2;
    const els = [];
    lines.forEach((ln, li) => {
      const t = ln.join(' ');
      const W = widthPx(t, font, px);
      const y = top + li * (sh + gap) + sh / 2;
      const pw = W + px * 0.5;
      const rot = li % 2 ? 0.6 : -0.8;
      const at = 60 + li * 130;
      els.push({ kind: 'shape', path: P.paper(pw, sh, r), w: pw, h: sh, color: '#F6F5F0', x: cx, y, rot, sc: '#000000', sd: 0,
        keys: [{ t: 0, a: 0, sx: 118, sy: 118 }, { t: at, a: 0, sx: 118, sy: 118 }, { t: at + 1, a: 1 }, { t: at + 150, sx: 98, sy: 98 }, { t: at + 230, sx: 100, sy: 100 }] });
      els.push({ kind: 'text', text: t, font, px, color: '#111111', oc: '#000000', ow: 0, sd: 0, x: cx, y: y + px * 0.03, rot,
        keys: [{ t: 0, a: 0, sx: 118, sy: 118 }, { t: at + 40, a: 0, sx: 118, sy: 118 }, { t: at + 41, a: 1 }, { t: at + 190, sx: 98, sy: 98 }, { t: at + 270, sx: 100, sy: 100 }] });
    });
    const subT = 60 + lines.length * 130 + 160;
    sfit.lines.forEach((ln, si) => {
      const t = ln.join(' ');
      const W = widthPx(t, font, spx);
      const y = top + Hm + px * 0.22 + si * slh + slh / 2;
      const bw = W + spx * 0.9, bh = spx * 1.5;
      els.push({ kind: 'shape', path: P.rect(bw, bh), w: bw, h: bh, color: '#FFE14D', x: cx, y, rot: 0,
        keys: [{ t: 0, a: 1, clip: [0, -4, 0, bh + 4] }, { t: subT + si * 80, clip: [0, -4, 0, bh + 4] }, { t: subT + si * 80 + 260, clip: [-4, -4, bw + 4, bh + 4] }] });
      els.push({ kind: 'text', text: t, font, px: spx, color: '#111111', oc: '#000000', ow: 0, sd: 0, x: cx, y: y + spx * 0.04, rot: 0,
        keys: [{ t: 0, a: 0 }, { t: subT + si * 80 + 160, a: 0 }, { t: subT + si * 80 + 300, a: 1 }] });
    });
    return { elements: els, box: { top, bottom: top + Hm + Hs } };
  },

  // From the kinetic-typography recipes: mask/clip reveal — each line wipes
  // up out of a hidden baseline, 80 ms apart, easeOutExpo, clean bold sans.
  mask_naik(text, o) {
    const words = text.split(/\s+/).filter(Boolean);
    const px = (o.px || 128) * (o.k || 1);
    const font = 'Open Sauce Two ExtraBold';
    const cx = o.cx, cy = o.cy;
    const lines = wrapWords(words, font, px, 900);
    const lh = px * 1.12;
    const H = lines.length * lh;
    const els = [];
    lines.forEach((ln, li) => {
      const t = ln.join(' ');
      const y = cy - H / 2 + lh * li + lh / 2;
      const W = widthPx(t, font, px);
      const at = 60 + li * 90;
      els.push({ kind: 'text', text: t, font, px, color: '#ffffff', oc: '#000000', ow: 0, sc: '#000000', sd: 0, shadowSoft: true, x: cx, y, rot: 0,
        // Mask band a bit taller than the line so descenders (g, y) are not cut.
        clipAbs: [cx - W / 2 - 30, y - lh * 0.6, cx + W / 2 + 30, y + lh * 0.66],
        keys: [{ t: 0, y: y + lh }, { t: at, y: y + lh }, { t: at + 560, y }] });
      // accent bar under the last line, wiping left->right
      if (li === lines.length - 1) {
        els.push({ kind: 'shape', path: P.rect(W * 0.4, 12), w: W * 0.4, h: 12, color: '#c8ff2e', x: cx - W / 2 + W * 0.2, y: y + lh * 0.66, rot: 0,
          keys: [{ t: 0, clip: [0, 0, 0, 12] }, { t: at + 400, clip: [0, 0, 0, 12] }, { t: at + 760, clip: [0, 0, W * 0.4, 12] }] });
      }
    });
    return { elements: els, box: { top: cy - H / 2, bottom: cy + H / 2 + 24 } };
  },

  // Blur-in focus pull, per-word stagger (recipes #2 + word stagger).
  fokus_blur(text, o) {
    const words = text.split(/\s+/).filter(Boolean);
    const px = (o.px || 132) * (o.k || 1);
    const font = "Editor'sNote-Medium";
    const cx = o.cx, cy = o.cy;
    const lines = wrapWords(words, font, px, 900);
    const lh = px * 1.05;
    const H = lines.length * lh;
    const els = [];
    let k = 0;
    lines.forEach((ln, li) => {
      const y = cy - H / 2 + lh * li + lh / 2;
      const W = widthPx(ln.join(' '), font, px);
      let x = cx - W / 2;
      ln.forEach((w) => {
        const wf = k % 3 === 1 ? "Editor'sNote-MediumItalic" : font;   // every 3rd word italic
        const ww = widthPx(w, wf, px);
        const at = 60 + k * 70; k++;
        els.push({ kind: 'text', text: w, font: wf, px, color: '#ffffff', oc: '#000000', ow: 0, sd: 0, glowSoft: true, x: x + ww / 2, y, rot: 0,
          keys: [{ t: 0, a: 0, blur: 14, sx: 108, sy: 108 }, { t: at, a: 0, blur: 14 }, { t: at + 500, a: 1, blur: 0, sx: 100, sy: 100 }] });
        x += ww + widthPx(' ', font, px);
      });
    });
    return { elements: els, box: { top: cy - H / 2, bottom: cy + H / 2 } };
  },
};

// ---------------------------------------------------------------------------
// [KINETIC-CAPTION] Caption templates: one cue (a short phrase) builds up word
// by word with a size hierarchy — small connective words, one big KEY word.
// opts: { cx, top, px, dur (cue length, ms) }. The key word is the most
// "contentful" one: longest word that is not a connector.
const CAP_STOP = new Set(('yang dan di ke dari itu ini aku saya gua gue lu lo kamu dia kita kami mereka untuk dengan karena jadi ada juga tapi aja saja sih kok nya pun lagi udah sudah akan bisa kalau kalo atau the a an to of and is are was in on it that this for you i we they be so but').split(' '));
function keyIndex(words) {
  let best = -1, bl = -1;
  words.forEach((w, i) => {
    const c = w.toLowerCase().replace(/[^a-z0-9À-ɏ]/g, '');
    const l = CAP_STOP.has(c) ? 0 : c.length;
    if (l >= bl) { bl = l; best = i; }
  });
  return best < 0 ? words.length - 1 : best;
}
// Word i appears at a time proportional to the characters before it, inside
// the first 70% of the cue (so the phrase is complete while it is spoken).
function wordTimes(words, dur) {
  const span = Math.max(120, Math.min(dur * 0.7, words.length * 420));
  const tot = words.reduce((a, w) => a + w.length + 1, 0) || 1;
  let acc = 0;
  return words.map((w) => { const t = (acc / tot) * span; acc += w.length + 1; return Math.round(t); });
}
// Lay a run of words on one line (centred at cx, or starting at x0 when left).
function wordRow(words, font, px, { cx, x0, y, italic }) {
  const sp = widthPx(' ', font, px);
  const ws = words.map((w) => widthPx(w, font, px, italic));
  const W = ws.reduce((a, b) => a + b, 0) + sp * Math.max(0, words.length - 1);
  let x = x0 != null ? x0 : cx - W / 2;
  return { W, items: words.map((w, i) => { const it = { w, x: x + ws[i] / 2, ww: ws[i] }; x += ws[i] + sp; return it; }), y };
}
function capPop(el, t, big) {
  el.keys = [{ t: 0, a: 0, sx: big ? 135 : 112, sy: big ? 135 : 112, blur: 6, y: el.y + (big ? 0 : 14) }, { t, a: 0 }, { t: t + 1, a: 1 },
    { t: t + (big ? 200 : 170), sx: 100, sy: 100, blur: 0, y: el.y }];
  return el;
}
// Fit a set of rows (each { words, font, px }) into maxW by shrinking all.
function fitRows(rows, maxW) {
  let k = 1;
  rows.forEach((r) => { const w = widthPx(r.words.join(' '), r.font, r.px, r.italic); if (w * k > maxW) k = maxW / w; });
  rows.forEach((r) => { r.px *= k; });
  return rows;
}
function capBuild(text, o, spec) {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return { elements: [], box: null };
  const ki = keyIndex(words);
  const times = wordTimes(words, o.dur || 1500);
  const rows = spec.rows(words, ki).filter((r) => r.words.length);
  fitRows(rows, spec.maxW || 900);
  const els = [];
  let y = o.top;
  rows.forEach((r) => {
    const lh = r.px * (r.lh || 1.05);
    const cy = y + lh / 2;
    const row = wordRow(r.words, r.font, r.px, { cx: o.cx, x0: spec.left ? o.cx - (spec.maxW || 900) / 2 + (r.indent || 0) : null, y: cy, italic: r.italic });
    // Keep every row on screen whatever the caption X is (a caption moved to
    // x=242 put the key word 12 px off the left edge).
    if (row.items.length) {
      const l = row.items[0].x - row.items[0].ww / 2, rr = row.items[row.items.length - 1].x + row.items[row.items.length - 1].ww / 2;
      const M = 40;
      const dx = l < M ? M - l : (rr > 1080 - M ? 1080 - M - rr : 0);
      if (dx) row.items.forEach((it) => { it.x += dx; });
    }
    row.items.forEach((it, j) => {
      const wi = r.idx[j];
      els.push(capPop({ kind: 'text', text: it.w, font: r.font, italic: false, px: r.px, color: r.color, oc: r.oc || '#000000', ow: r.ow || 0, sd: 0,
        shadowSoft: !r.glow, shade: true, glow: r.glow || null, x: it.x, y: cy, rot: 0 }, times[wi], wi === ki));
    });
    y += lh;
  });
  return { elements: els, box: { top: o.top, bottom: y } };
}
function capGlow(text, o, color, glow) {
  const px = (o.px || 140) * (o.k || 1);
  return capBuild(text, o, {
    rows: (w, k) => [
      { words: w.slice(0, k), idx: w.slice(0, k).map((_, i) => i), font: 'Open Sauce Two ExtraBold', px: px * 0.58, color: '#ffffff', lh: 1.1 },
      { words: [w[k]], idx: [k], font: 'Open Sauce Two ExtraBold', px, color, glow, lh: 1.0 },
      { words: w.slice(k + 1), idx: w.slice(k + 1).map((_, i) => k + 1 + i), font: 'Open Sauce Two ExtraBold', px: px * 0.58, color: '#ffffff', lh: 1.1 },
    ],
  });
}
// [CAP-FOKUS] Keynote-style captions (2026-10-12): a clean bold sans in two
// STAGGERED lines (one nudged right, the other left), every word focusing in
// from a blur, and the key word set apart — orange, or italic / capitals.
function capFocusEl(el, t) {
  el.keys = [{ t: 0, a: 0, blur: 16, sx: 96, sy: 96 }, { t, a: 0, blur: 16, sx: 96, sy: 96 }, { t: t + 340, a: 1, blur: 0, sx: 100, sy: 100 }];
  return el;
}
function capFocus(text, o, mode) {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return { elements: [], box: null };
  const r = rng(text);
  const ki = keyIndex(words);
  const times = wordTimes(words, o.dur || 1500);
  let px = (o.px || 104) * (o.k || 1);
  // Open Sauce Two (user's pick, 2026-10-12): the Bold the app already ships
  // plus its own Bold Italic (identical advance widths, renamed the same way).
  // [SOROT-XB] Sorot (2026-10-12): Open Sauce ExtraBold squeezed to 92 %.
  const oranye = mode === 'oranye';
  const base = oranye ? 'Open Sauce Two ExtraBold' : 'Open Sauce Two Bold', ital = 'Open Sauce Two Bold Italic';
  const SX = oranye ? 86 : 100;   // [SOROT-NARROW] narrower (user, 2026-10-12)
  const glowKey = oranye && r() < 0.5 ? '#ff7a00' : null;   // sometimes the orange word glows
  // Two lines when there are 3+ words, split where the halves balance.
  let cut = words.length;
  if (words.length >= 3) {
    let best = Infinity;
    for (let i = 1; i < words.length; i++) {
      const d = Math.abs(widthPx(words.slice(0, i).join(' '), base, px) - widthPx(words.slice(i).join(' '), base, px));
      if (d < best) { best = d; cut = i; }
    }
  }
  const lines = [words.slice(0, cut), words.slice(cut)].filter((l) => l.length);
  const idxOf = (li, j) => (li === 0 ? j : cut + j);
  // Look B: a 3+ word second line is set in capitals; otherwise the key word
  // is the italic one. Look A: the key word is orange.
  const capsLine = mode === 'miring' && lines.length > 1 && lines[1].length >= 3 ? 1 : -1;
  const styleOf = (wi, li) => {
    if (li === capsLine) return { font: base, text: words[wi].toUpperCase(), color: '#FFFFFF' };
    if (wi === ki && mode === 'oranye') return { font: base, text: words[wi], color: '#F7A21B' };
    if (wi === ki && mode === 'miring') return { font: ital, text: words[wi], color: '#FFFFFF' };
    return { font: base, text: words[wi], color: '#FFFFFF' };
  };
  // [CAP-FOKUS-TRACK] Slightly tight tracking (user, 2026-10-12): -3.5% of
  // the size per glyph, carried on each element as `fsp` so the burn (\\fsp)
  // and the preview (letter-spacing) apply the same amount.
  const TRACK = -0.035;
  const wordW = (st) => (widthPx(st.text, st.font, px) + TRACK * px * st.text.length) * SX / 100;
  const spW = () => widthPx(' ', base, px) * SX / 100;
  const rowW = (ln, li) => ln.reduce((a, w, j) => a + wordW(styleOf(idxOf(li, j), li)), 0) + spW() * (ln.length - 1);
  // Keep the widest line inside the frame.
  const maxW = 900;
  const widest = Math.max(...lines.map(rowW));
  if (widest > maxW) px *= maxW / widest;
  const Ws = lines.map(rowW);
  const shift = lines.length > 1 ? Math.min(140, Math.max(...Ws) * 0.16) * (r() < 0.5 ? 1 : -1) : 0;
  const lh = px * 1.08;
  const els = [];
  // [SOROT-MIX] a shuffled run of the five entrances: neighbouring words never share one
  const order = [0, 1, 2, 3, 4];
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  lines.forEach((ln, li) => {
    const y = o.top + lh * li + lh / 2;
    const W = Ws[li];
    let x = o.cx - W / 2 + (li === 0 ? shift : -shift);
    // stay on screen whatever the caption X is
    const M = 40;
    if (x < M) x = M; if (x + W > 1080 - M) x = 1080 - M - W;
    ln.forEach((_, j) => {
      const wi = idxOf(li, j);
      const st = styleOf(wi, li);
      const ww = wordW(st);
      // [SOROT-BOLD] the coloured word heavier: a same-colour stroke on top of ExtraBold
      const heavy = oranye && wi === ki;
      const el = capFocusEl({ kind: 'text', text: st.text, font: st.font, px, fsp: TRACK * px, color: st.color, oc: heavy ? st.color : '#000000', ow: heavy ? 0.028 * px : 0, sc: '#000000', sd: 2, x: x + ww / 2, y, rot: 0,
        glow: wi === ki ? glowKey : null }, times[wi]);
      if (oranye) el.keys = sorotKeys(order[wi % order.length], times[wi], x + ww / 2, y, SX);   // [SOROT-MIX] each word its own entrance
      els.push(el);
      x += ww + spW();
    });
  });
  return { elements: els, box: { top: o.top, bottom: o.top + lh * lines.length } };
}
// [SOROT-MIX] Per-word entrances mixed inside one cue: blur focus, rise or pop.
// [SOROT-MIX] Five calm "podcast" entrances (soft, no bounce), one per word:
// 0 blur focus · 1 rise + fade · 2 settle down from 116 % · 3 slide in from the
// left · 4 drop from above. All land on the same final state.
function sorotKeys(kind, t, x, y, sx) {
  const end = { a: 1, blur: 0, sx, sy: 100, x, y };
  switch (kind) {
    case 0: return [{ t: 0, a: 0, blur: 18, sx: sx * 0.97, sy: 97 }, { t, a: 0, blur: 18, sx: sx * 0.97, sy: 97 }, Object.assign({ t: t + 380 }, end)];
    case 1: return [{ t: 0, a: 0, y: y + 30, sx, sy: 100 }, { t, a: 0, y: y + 30 }, Object.assign({ t: t + 300 }, end)];
    case 2: return [{ t: 0, a: 0, blur: 6, sx: sx * 1.16, sy: 116 }, { t, a: 0, blur: 6, sx: sx * 1.16, sy: 116 }, Object.assign({ t: t + 340 }, end)];
    case 3: return [{ t: 0, a: 0, x: x - 36, sx, sy: 100 }, { t, a: 0, x: x - 36 }, Object.assign({ t: t + 300 }, end)];
    default: return [{ t: 0, a: 0, y: y - 26, blur: 8, sx, sy: 100 }, { t, a: 0, y: y - 26, blur: 8 }, Object.assign({ t: t + 320 }, end)];
  }
}
// [CAP-QUOTE] Quote (2026-10-12, replaces Tegas + Lirik): Bootzy, lowercase,
// pure white solid, at its own width. Cues come 1–4 words (mixChunks max 4):
// 1–2 words sit on one line; 3–4 words stack (small lead-in / big key word /
// small tail, the capAcak stack). The key word is sometimes set in Open Sauce
// ExtraBold Italic. o.glow (the caption Glow switch) adds a soft white halo.
function capQuote(text, o) {
  const raw = text.split(/\s+/).filter(Boolean);
  if (!raw.length) return { elements: [], box: null };
  const r = rng(`quote|${text}`);
  // italic only on 1–2 word lines: in the 3–4 word stack its taller ascenders
  // and descenders collide with the tight rows above and below
  const italic = raw.length <= 2 && r() < 0.45;
  const L = raw.length >= 3 ? capAcak(text, o, 'bootzy') : capSauceMix(text, Object.assign({}, o, { quote: true, quoteItal: italic }));
  if (o.glow) L.elements.forEach((e) => { e.glow = '#ffffff'; });
  return L;
}
// [CAP-ESTETIK] Podcast-clip look, calibrated frame by frame on the user's
// reference (2026-10-14, 30 fps, 15 fps zoom sheets):
//   • three rows, left-aligned block: small lead-in words on top, ONE big key
//     word, small tail words below; small = 0.42x big, rows nearly touching;
//   • lead-in row flush RIGHT with the big word ("berapa / Lama"); a one-word
//     tail flush right ("tuh ?"), a longer tail flush left ("lama mereka");
//   • Poppins Bold, pure white, key word thickened with a same-colour stroke,
//     Title Case (short words) or CAPS, tracking -2 %;
//   • readability from a soft DARK halo behind every word, not a coloured glow;
//   • each small word focuses in as it is spoken: blur 10 -> 0, rises 12 px,
//     fades in over ~230 ms (4 frames); the big word blurs in harder
//     (blur 24 -> 0) rising 40 px with a 104 % -> 100 % settle over ~330 ms.
// Key word for the Estetik stack: a content word (thing / quality), never a
// question word or helper, and verbs with an affix count less — the
// reference picks "berapa LAMA", "menentukan HOOK", "bisa dapetin SENSE".
const EST_AUX = new Set('berapa bagaimana gimana apa apakah kenapa mengapa siapa kapan dimana mana bisa harus mau akan sudah udah sampe sampai menurut kalian kamu aku gue gua lu dia mereka kita kami seorang sebuah yang dan atau tapi tuh sih nih dong deh kok loh lho ya yah oh wow eh ah oke nya itu ini juga lagi aja banget sangat lebih paling how what why who when where can will would should the a an to of and is are was'.split(' '));
function estKeyIndex(words) {
  let best = -1, bs = -1;
  words.forEach((w, i) => {
    const c = w.toLowerCase().replace(/[^a-z0-9À-ɏ]/g, '');
    let sc = c.length;
    if (!c || EST_AUX.has(c) || CAP_STOP.has(c)) sc = 0.5;
    else if (/^(me|mem|men|meng|meny|ber|di|nge|ng)[a-z]{3,}/.test(c) || /[a-z]{3,}(kan|in)$/.test(c)) sc *= 0.4;
    if (sc >= bs) { bs = sc; best = i; }
  });
  return best < 0 ? words.length - 1 : best;
}
function capEstetik(text, o) {
  const raw = text.split(/\s+/).filter(Boolean);
  if (!raw.length) return { elements: [], box: null };
  const r = rng(`estetik|${text}`);
  const ki = estKeyIndex(raw);
  const times = wordTimes(raw, o.dur || 1500);
  const FONT = 'Poppins Bold';
  const TRACK = -0.02;
  let big = (o.px || 150) * (o.k || 1);
  const key = raw[ki].replace(/^["'“(]+|[,.;:"'”)]+$/g, '');
  const bigText = key.length <= 7 && r() < 0.45 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1).toLowerCase();
  const maxW = 900;
  const wBig = () => widthPx(bigText, FONT, big) * (1 + TRACK);
  const big0 = big;
  if (wBig() > maxW) big *= maxW / wBig();
  // a long key word shrinks to fit, but the small rows must stay readable
  const small = Math.max(big * 0.42, big0 * 0.36);
  const lead = raw.slice(0, ki).map((w) => w.toLowerCase());
  const tail = raw.slice(ki + 1).map((w) => w.toLowerCase());
  const rowW = (ws) => (ws.length ? widthPx(ws.join(' '), FONT, small) : 0);
  const Wb = wBig(), Wt = rowW(lead), Wl = rowW(tail);
  const W = Math.max(Wb, Wt, Wl);
  const left = o.align === 'left' ? 60 : Math.max(40, Math.min(1080 - 40 - W, o.cx - W / 2));
  const els = [];
  const word = (w, px, x, y, t, isBig) => {
    const el = { kind: 'text', text: w, font: FONT, px, fsp: TRACK * px, color: '#ffffff',
      oc: '#ffffff', ow: isBig ? 0.022 * px : 0, sd: 0, shade: true, x, y, rot: 0 };
    el.keys = isBig
      ? [{ t: 0, a: 0, blur: 24, y: y + 40, sx: 104, sy: 104 }, { t, a: 0, blur: 24, y: y + 40, sx: 104, sy: 104 }, { t: t + 330, a: 1, blur: 0, y, sx: 100, sy: 100 }]
      : [{ t: 0, a: 0, blur: 10, y: y + 12 }, { t, a: 0, blur: 10, y: y + 12 }, { t: t + 230, a: 1, blur: 0, y }];
    return el;
  };
  const row = (ws, idx0, x0, y) => {
    const sp = widthPx(' ', FONT, small);
    let x = x0;
    ws.forEach((w, j) => {
      const ww = widthPx(w, FONT, small);
      els.push(word(w, small, x + ww / 2, y, times[idx0 + j], false));
      x += ww + sp;
    });
  };
  let y = o.top;
  if (lead.length) {
    const cy = y + small * 0.5;
    row(lead, 0, Wt <= Wb ? left + Wb - Wt : left, cy);
    y += small * 0.88;
  }
  const by = y + big * 0.46;
  els.push(word(bigText, big, left + Wb / 2, by, times[ki], true));
  y += big * 0.86;
  if (tail.length) {
    const cy = y + small * 0.5;
    row(tail, ki + 1, tail.length === 1 && Wl <= Wb ? left + Wb - Wl : left, cy);
    y += small * 1.0;
  }
  return { elements: els, box: { top: o.top, bottom: y } };
}
// [CAP-STACK] Stacked lyric captions, calibrated 1:1 on the user's
// references ("never / complain", "and what it / means"): all lowercase,
// pure white, the key word big on its own row, the words before it in one
// small row above (0.55x) and the words after it in one row below; rows
// almost touching, word gaps 80 % of a space, tracking -2 %. Never random:
// the stack is centred, or left-aligned with o.align === 'left'.
// Big word always bold: Open Sauce ExtraBold at 92 % width, or Bootzy
// thickened with a same-colour stroke.
function capAcak(text, o, mode) {
  const raw = text.split(/\s+/).filter(Boolean);
  if (!raw.length) return { elements: [], box: null };
  const bootzy = mode === 'bootzy';
  const words = raw.map((w) => w.toLowerCase());
  const ki = keyIndex(raw);
  const times = wordTimes(raw, o.dur || 1500);
  let px = (o.px || 150) * (o.k || 1);
  const FONT = bootzy ? 'Bootzy TM' : 'Open Sauce Two ExtraBold';
  const SXB = bootzy ? 100 : 92, SXS = bootzy ? 100 : 96;
  const BOLDEN = 0;
  const TRACK = bootzy ? 0.03 : -0.02;
  const SMALL = 0.55;
  const left = o.align === 'left';
  const rows = [];
  if (ki > 0) rows.push({ big: false, idx: raw.slice(0, ki).map((_, i) => i) });
  rows.push({ big: true, idx: [ki] });
  if (ki < raw.length - 1) rows.push({ big: false, idx: raw.slice(ki + 1).map((_, i) => ki + 1 + i) });
  const sx = (row) => (row.big ? SXB : SXS);
  const stroke = (row, size) => (row.big ? BOLDEN * size : 0);
  const wordW = (i, row, size) => (widthPx(words[i], FONT, size) + TRACK * size * words[i].length) * sx(row) / 100 + 2 * stroke(row, size);
  const gap = (row, size) => widthPx(' ', FONT, size) * 0.8 * sx(row) / 100;
  const sizeOf = (row) => px * (row.big ? 1 : SMALL);
  const rowW = (row) => row.idx.reduce((a, i) => a + wordW(i, row, sizeOf(row)), 0) + gap(row, sizeOf(row)) * (row.idx.length - 1);
  let widest = Math.max(...rows.map(rowW));
  if (widest > 900) { px *= 900 / widest; widest = 900; }
  const xh = 0.74;                           // lowercase body + ascender share of the size
  const els = [];
  let y = o.top, prevH = 0;
  const blockL = o.cx - widest / 2;
  rows.forEach((row, ri) => {
    const size = sizeOf(row), h = size * xh;
    y += ri === 0 ? h / 2 : prevH / 2 + h / 2 + Math.min(prevH, h) * 0.06;
    prevH = h;
    const W = rowW(row);
    let x = left ? blockL : o.cx - W / 2;
    const M = 50;
    if (x < M) x = M; if (x + W > 1080 - M) x = 1080 - M - W;
    row.idx.forEach((i) => {
      const w = wordW(i, row, size);
      const t = times[i];
      const s0 = sx(row);
      const el = { kind: 'text', text: words[i], font: FONT, px: size, fsp: TRACK * size, color: '#FFFFFF',
        oc: '#FFFFFF', ow: stroke(row, size), sc: '#000000', sd: 2, x: x + w / 2, y, rot: 0 };
      el.keys = row.big
        ? [{ t: 0, a: 0, sx: s0 * 1.12, sy: 112 }, { t, a: 0, sx: s0 * 1.12, sy: 112 }, { t: t + 1, a: 1 },
          { t: t + 140, sx: s0 * 0.97, sy: 97 }, { t: t + 260, sx: s0, sy: 100 }]
        : [{ t: 0, a: 0, blur: 8, y: y + 12, sx: s0, sy: 100 }, { t, a: 0, blur: 8, y: y + 12 }, { t: t + 220, a: 1, blur: 0, y }];
      els.push(el);
      x += w + gap(row, size);
    });
  });
  return { elements: els, box: { top: o.top, bottom: y + prevH / 2 } };
}
// [SAUCE-MIX] Mixed cue lengths (1–3 words) for the Sauce campur look: a long
// content word stands alone ("dream"), connectors gather up to three
// ("enter my"), a spoken pause or punctuation always ends a cue. Shared by
// the pipeline (chunkWordsToCues) and the preview (ensureCueWords).
// [CAP-ESTETIK] Reference groups run 2–5 words around ONE key word ("berapa
// LAMA tuh?", "menurut kalian BERAPA lama mereka"): break only on a real
// pause or a sentence end, never on a heavy word, and fold a lone word into
// its neighbour when they are spoken together.
function estChunks(ws, max = 5) {
  const out = [];
  let cur = [];
  const flush = () => { if (cur.length) out.push(cur); cur = []; };
  ws.forEach((w, i) => {
    const gap = i > 0 ? (+w.start) - (+ws[i - 1].end) : 0;
    if (cur.length && gap > 0.45) flush();
    cur.push(w);
    if (/[.!?]["'”)]*$/.test(String(w.text || '')) || cur.length >= max) flush();
  });
  flush();
  for (let i = 0; i < out.length; i++) {
    if (out[i].length !== 1) continue;
    const prev = out[i - 1], next = out[i + 1];
    const gp = prev ? (+out[i][0].start) - (+prev[prev.length - 1].end) : Infinity;
    const gn = next ? (+next[0].start) - (+out[i][0].end) : Infinity;
    const endsSentence = (g) => /[.!?]["'”)]*$/.test(String(g[g.length - 1].text || ''));
    if (prev && gp <= 0.6 && prev.length < max && !endsSentence(prev) && (gp <= gn || !next)) { prev.push(out[i][0]); out.splice(i--, 1); }
    else if (next && gn <= 0.6 && next.length < max && !endsSentence(out[i])) { next.unshift(out[i][0]); out.splice(i--, 1); }
  }
  return out;
}
function mixChunks(ws, max = 3) {
  const out = [];
  let cur = [];
  const flush = () => { if (cur.length) out.push(cur); cur = []; };
  ws.forEach((w, i) => {
    const plain = String(w.text || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    const heavy = plain.length >= 5 && !CAP_STOP.has(plain);
    const gap = i > 0 ? (+w.start) - (+ws[i - 1].end) : 0;
    // max 4 (Quote/Sorot): a heavy word ENDS its cue ("and what it means") instead of standing alone
    if (cur.length && (gap > 0.35 || (heavy && max <= 3))) flush();
    cur.push(w);
    if (heavy || /[.!?,;:]$/.test(String(w.text || '')) || cur.length >= max) flush();
  });
  flush();
  return out;
}
// [SAUCE-MIX] One face family: Open Sauce ExtraBold squeezed to 90 %,
// lowercase, tight; the key word sometimes in its own ExtraBold Italic
// (more often when it stands alone), words focusing in from a blur, the cue
// placed a little differently each time.
function capSauceMix(text, o) {
  const raw = text.split(/\s+/).filter(Boolean);
  if (!raw.length) return { elements: [], box: null };
  const r = rng(`mix|${text}`);
  const words = raw.map((w) => w.toLowerCase());
  const ki = keyIndex(raw);
  const italic = o.quote ? !!o.quoteItal : r() < (raw.length === 1 ? 0.6 : 0.4);
  const times = wordTimes(raw, o.dur || 1500);
  const FONT = o.quote ? 'Bootzy TM' : 'Open Sauce Two ExtraBold', ITAL = 'Open Sauce Two ExtraBold Italic';
  const SX = o.quote ? 100 : 90, TRACK = o.quote ? 0.03 : -0.02;
  let px = (o.px || 140) * (o.k || 1) * (raw.length === 1 ? 1.12 : 1);
  const fontOf = (i) => (italic && i === ki ? ITAL : FONT);
  const trk = (i) => (fontOf(i) === ITAL ? -0.02 : TRACK);
  const wordW = (i, size) => (widthPx(words[i], fontOf(i), size) + trk(i) * size * words[i].length) * SX / 100;
  const gap = (size) => widthPx(' ', FONT, size) * 0.72 * SX / 100;
  const lineW = (idx, size) => idx.reduce((a, i) => a + wordW(i, size), 0) + gap(size) * (idx.length - 1);
  let lines = [raw.map((_, i) => i)];
  if (lineW(lines[0], px) > 880 && raw.length > 1) {
    const cut = Math.ceil(raw.length / 2);
    lines = [lines[0].slice(0, cut), lines[0].slice(cut)];
  }
  const widest = Math.max(...lines.map((l) => lineW(l, px)));
  if (widest > 880) px *= 880 / widest;
  const dx = 0, dy = 0;   // [CAP-STACK] never random — centred or left
  const lh = px * 0.98;
  const els = [];
  lines.forEach((idx, li) => {
    const y = o.top + dy + lh * li + lh / 2;
    const W = lineW(idx, px);
    let x = o.align === 'left' ? o.cx - widest / 2 : o.cx + dx - W / 2;
    const M = 50;
    if (x < M) x = M; if (x + W > 1080 - M) x = 1080 - M - W;
    idx.forEach((i) => {
      const w = wordW(i, px);
      const t = times[i];
      els.push({ kind: 'text', text: words[i], font: fontOf(i), px, fsp: trk(i) * px, color: '#FFFFFF', oc: '#000000', ow: 0, sc: '#000000', sd: 2, x: x + w / 2, y, rot: 0,
        keys: [{ t: 0, a: 0, blur: 10, sx: SX * 1.04, sy: 104 }, { t, a: 0, blur: 10, sx: SX * 1.04, sy: 104 }, { t: t + 240, a: 1, blur: 0, sx: SX, sy: 100 }] });
      x += w + gap(px);
    });
  });
  return { elements: els, box: { top: o.top + dy, bottom: o.top + dy + lh * lines.length } };
}
const CAP_TEMPLATES = {
  // Small lead-in words, then the key word big; anything after it small again.
  cap_susun(text, o) {
    const px = (o.px || 150) * (o.k || 1);
    return capBuild(text, o, {
      rows: (w, k) => [
        { words: w.slice(0, k), idx: w.slice(0, k).map((_, i) => i), font: 'Open Sauce Two Bold', px: px * 0.36, color: '#ffffff', lh: 1.15 },
        { words: [w[k]], idx: [k], font: 'Open Sauce Two ExtraBold', px, color: '#ffffff', lh: 1.08 },
        { words: w.slice(k + 1), idx: w.slice(k + 1).map((_, i) => k + 1 + i), font: 'Open Sauce Two Bold', px: px * 0.36, color: '#ffffff', lh: 1.15 },
      ],
    });
  },
  // White words, key word large and glowing: orange, lime or white.
  cap_glow(text, o) { return capGlow(text, o, '#ff8a1f', '#ff6a00'); },
  cap_glow_lime(text, o) { return capGlow(text, o, '#c8ff2e', '#8fe000'); },
  cap_glow_putih(text, o) { return capGlow(text, o, '#ffffff', '#ffffff'); },
  // [CAP-FOKUS] keynote look: staggered lines, blur-in words, orange key word
  cap_fokus_oranye(text, o) { return capFocus(text, o, 'oranye'); },
  // [CAP-FOKUS] same, key word italic (or a 3+ word second line in capitals)
  cap_fokus_miring(text, o) { return capFocus(text, o, 'miring'); },
  // [CAP-ACAK] scattered lyric look: narrow small words + Bootzy big words
  cap_acak_bootzy(text, o) { return capAcak(text, o, 'bootzy'); },
  // [CAP-ACAK] same, big words in Open Sauce squeezed narrow, lowercase
  cap_acak_sauce(text, o) { return capAcak(text, o, 'sauce'); },
  // [SAUCE-MIX] one family, mixed 1–3 word cues, key word sometimes italic
  cap_sauce_mix(text, o) { return capSauceMix(text, o); },
  cap_quote(text, o) { return capQuote(text, o); },
  cap_estetik(text, o) { return capEstetik(text, o); },
  // Left-aligned stack: small sans lead, key word as big caps (long words) or
  // a glowing serif italic (short words), tail small and indented.
  cap_campur(text, o) {
    const px = (o.px || 150) * (o.k || 1);
    return capBuild(text, o, {
      left: true, maxW: 860,
      rows: (w, k) => {
        const big = w[k].length >= 6;
        return [
          { words: w.slice(0, k), idx: w.slice(0, k).map((_, i) => i), font: 'Open Sauce Two Bold', px: px * 0.4, color: '#ffffff', lh: 1.2 },
          big
            ? { words: [w[k].toUpperCase()], idx: [k], font: 'Anton', px, color: '#ffffff', lh: 1.02, indent: 30 }
            : { words: [w[k]], idx: [k], font: "Editor'sNote-MediumItalic", px: px * 0.92, color: '#ffb547', glow: '#ff7a00', lh: 1.0, indent: 30 },
          { words: w.slice(k + 1), idx: w.slice(k + 1).map((_, i) => k + 1 + i), font: 'Open Sauce Two Bold', px: px * 0.4, color: '#ffffff', lh: 1.2, indent: 70 },
        ];
      },
    });
  },
};
Object.assign(TEMPLATES, CAP_TEMPLATES);
const CAPTION_LIST = [
  { id: 'cap_susun', label: 'Susun' },
  { id: 'cap_glow', label: 'Bara' },
  { id: 'cap_glow_lime', label: 'Neon' },
  { id: 'cap_glow_putih', label: 'Halo' },
  { id: 'cap_campur', label: 'Klasik' },
  { id: 'cap_fokus_oranye', label: 'Sorot' },
  { id: 'cap_fokus_miring', label: 'Miring' },
  { id: 'cap_acak_bootzy', label: 'Tumpuk' },
  { id: 'cap_quote', label: 'Quote' },
  { id: 'cap_estetik', label: 'Estetik' },
];

// ---------------------------------------------------------------------------
// [WORD-STATE-CAPTION] "Gaya kata" caption templates: the whole phrase shows,
// and the word being spoken takes a CURRENT style (colour, box, pop), words
// already spoken a PAST style, words still to come a NEXT style. Design ideas
// adapted (ATM — own names, own implementation) from the MIT-licensed
// CaptionCat preset catalog (github.com/ItisShikhar/captioncat, (c) 2026
// Shikhar Srivastava); see assets/fonts/licenses/THIRD-PARTY.txt.
//
// One cue = one page. Word i is "current" from its share of the cue (by
// characters) until the next word starts.
P.round = (w, h, r) => {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  if (!r) return P.rect(w, h);
  const k = 0.5523 * r;   // cubic Bézier circle approximation
  return `m ${r} 0 l ${w - r} 0 b ${w - r + k} 0 ${w} ${r - k} ${w} ${r} l ${w} ${h - r} b ${w} ${h - r + k} ${w - r + k} ${h} ${w - r} ${h}`
    + ` l ${r} ${h} b ${r - k} ${h} 0 ${h - r + k} 0 ${h - r} l 0 ${r} b 0 ${r - k} ${r - k} 0 ${r} 0`;
};
// Chat bubble with a tail at the bottom right.
P.bubble = (w, h, r) => `${P.round(w, h, r)} m ${w - r * 0.9} ${h - 2} l ${w + r * 0.35} ${h + r * 0.45} ${w - r * 0.15} ${h - r * 0.55}`;

function stateAt(el, t) {
  const K = resolvedKeys(el);
  let cur = K[0];
  for (const k of K) { if (k.t <= t) cur = k; else break; }
  return cur;
}
function caseOf(w, c) { return c === 'upper' ? w.toUpperCase() : c === 'lower' ? w.toLowerCase() : w; }
// Word timing over the WHOLE cue (current word follows the speech).
function wordWindows(words, dur) {
  const tot = words.reduce((a, w) => a + w.length + 1, 0) || 1;
  let acc = 0;
  const st = words.map((w) => { const t = (acc / tot) * dur; acc += w.length + 1; return Math.round(t); });
  return st.map((t, i) => [t, i + 1 < st.length ? st[i + 1] : Math.round(dur)]);
}
function ccRows(words, s, px, maxW) {
  const sp = widthPx(' ', s.font, px);
  if (s.wordsPerRow) {
    const out = [];
    for (let i = 0; i < words.length; i += s.wordsPerRow) out.push(words.slice(i, i + s.wordsPerRow).map((_, j) => i + j));
    return out;
  }
  const rows = [];
  let cur = [], w = 0;
  words.forEach((wd, i) => {
    const ww = widthPx(wd, s.font, px) + (s.track || 0) * wd.length;
    if (cur.length && w + sp + ww > maxW) { rows.push(cur); cur = []; w = 0; }
    w += (cur.length ? sp : 0) + ww; cur.push(i);
  });
  if (cur.length) rows.push(cur);
  return rows;
}
function ccBuild(text, o, s) {
  const raw = text.split(/\s+/).filter(Boolean);
  if (!raw.length) return { elements: [], box: null };
  if (s.reveal === 'single') return ccSingle(raw, o, s);
  // Keep the block within maxH (default 560 px): a tall stack shrinks.
  if (!o._fitH) {
    const first = ccBuild(text, Object.assign({}, o, { _fitH: true }), s);
    const h = first.box ? first.box.bottom - first.box.top : 0;
    const maxH = s.maxH || 560;
    if (h > maxH) return ccBuild(text, Object.assign({}, o, { _fitH: true, k: (o.k || 1) * maxH / h }), s);
    return first;
  }
  const words = raw.map((w) => caseOf(w, s.case));
  const dur = o.dur || 1500;
  const win = wordWindows(words, dur);
  let px = (s.px || 100) * (o.k || 1);
  const maxW = s.maxW || 860;
  // Fit: rows of a fixed count shrink to the widest row; 'fill' scales one
  // row up/down to the full width.
  let rows = ccRows(words, s, px, maxW);
  if (s.maxRows && rows.length > s.maxRows) {
    // Too many rows for this template: shrink until it fits.
    for (let t = 0; t < 8 && rows.length > s.maxRows; t++) { px *= 0.88; rows = ccRows(words, s, px, maxW); }
  }
  const sp = widthPx(' ', s.font, px) + (s.gapX || 0);
  const rowW = (r) => r.reduce((a, i) => a + widthPx(words[i], s.font, px) + (s.track || 0) * words[i].length, 0) + sp * (r.length - 1);
  const widest = Math.max(...rows.map(rowW));
  if (s.fill || widest > maxW) px *= (s.fill ? Math.min(1.6, maxW / widest) : maxW / widest);
  const sp2 = widthPx(' ', s.font, px) + (s.gapX || 0) * px / (s.px || 100);
  const lh = px * (s.lh || 1.15);
  const gapY = (s.gapY || 0) * px;
  const H = rows.length * lh + (rows.length - 1) * gapY;
  const cx = o.cx, top = o.top;
  const rot = s.rot || 0;
  const ocy = top + H / 2;
  const R = (x, y) => rotPt(x, y, cx, ocy, rot);
  const els = [];
  const pad = s.pad || [0.18, 0.3];   // [y, x] in em
  // Page box (behind everything).
  const rowGeom = rows.map((r, ri) => {
    const W = r.reduce((a, i) => a + widthPx(words[i], s.font, px) + (s.track || 0) * words[i].length, 0) + sp2 * (r.length - 1);
    const y = top + ri * (lh + gapY) + lh / 2;
    let x = s.align === 'left' ? cx - maxW / 2 : cx - W / 2;
    const items = r.map((i) => { const ww = widthPx(words[i], s.font, px) + (s.track || 0) * words[i].length; const it = { i, x: x + ww / 2, ww }; x += ww + sp2; return it; });
    return { r, W, y, items, x0: items[0].x - items[0].ww / 2 };
  });
  const allW = Math.max(...rowGeom.map((g) => g.W));
  if (s.pageBox) {
    const b = s.pageBox, py = pad[0] * px, pxx = pad[1] * px;
    const w = allW + 2 * pxx, h = H + 2 * py;
    const [bx, by] = R(cx, ocy);
    els.push({ kind: 'shape', path: b.bubble ? P.bubble(w, h, b.radius * px) : P.round(w, h, (b.radius || 0) * px), w, h, color: b.color, x: bx, y: by, rot,
      keys: [{ t: 0, a: b.alpha != null ? b.alpha : 1, sx: b.pop ? 70 : 100, sy: b.pop ? 70 : 100 }, { t: b.pop ? 160 : 0, sx: 100, sy: 100 }] });
  }
  rowGeom.forEach((g, ri) => {
    if (s.rowBox) {
      const b = s.rowBox, py = pad[0] * px, pxx = pad[1] * px;
      const w = g.W + 2 * pxx, h = lh * (b.h || 1) + 2 * py - lh * 0.15;
      const [bx, by] = R(g.x0 + g.W / 2, g.y);
      const color = Array.isArray(b.color) ? b.color[ri % b.color.length] : b.color;
      els.push({ kind: 'shape', path: P.round(w, h, (b.radius || 0) * px), w, h, color, x: bx, y: by, rot, keys: [{ t: 0, a: 1 }] });
    }
  });
  rowGeom.forEach((g) => g.items.forEach((it) => {
    const [t0, t1] = win[it.i];
    const [x, y] = R(it.x, g.y);
    const base = { kind: 'text', text: words[it.i], font: s.font, px, oc: s.stroke ? s.stroke[1] : '#000000', ow: s.stroke ? s.stroke[0] * px / 100 : 0,
      sc: s.shadow ? s.shadow[1] : '#000000', sd: s.shadow ? s.shadow[0] * px / 100 : 0, glow: s.glow || null, x, y, rot, sxFix: s.scaleX };
    const appear = s.reveal === 'build' ? t0 : 0;
    const SX = s.scaleX || 100;   // narrowed letters (glass look)
    // Word box behind every word (twitch style).
    if (s.wordBox) {
      const b = s.wordBox, w = it.ww + 2 * pad[1] * px, h = lh + 2 * pad[0] * px - lh * 0.15;
      els.push({ kind: 'shape', path: P.round(w, h, (b.radius || 0) * px), w, h, color: b.color, x, y, rot, keys: [{ t: 0, a: appear ? 0 : 1 }, { t: appear, a: 1 }] });
    }
    // Box behind the current word only.
    if (s.current && s.current.box) {
      const b = s.current.box, w = it.ww + 2 * pad[1] * px, h = lh + 2 * pad[0] * px - lh * 0.15;
      els.push({ kind: 'shape', path: P.round(w, h, (b.radius || 0) * px), w, h, color: b.color, x, y, rot,
        keys: [{ t: 0, a: 0 }, { t: t0, a: 1, sx: 80, sy: 80 }, { t: t0 + 90, sx: 100, sy: 100 }, { t: t1, a: 0 }] });
    }
    // NEXT style until the word starts, PAST after it ends (or one colour).
    const nextC = s.next || s.color, pastC = s.past || s.color;
    const nextA = s.nextA != null ? s.nextA : 1, pastA = s.pastA != null ? s.pastA : 1;
    if (s.reveal === 'type') {
      // Typewriter: characters of this word arrive one by one inside its window.
      const chars = Array.from(words[it.i]);
      const per = Math.max(16, Math.min(60, (t1 - t0) / Math.max(1, chars.length)));
      let cx0 = x - it.ww / 2;
      chars.forEach((ch, ci) => {
        const cw = widthPx(ch, s.font, px) + (s.track || 0);
        const at = t0 + ci * per;
        els.push(Object.assign({}, base, { text: ch, color: s.color, x: cx0 + cw / 2, keys: [{ t: 0, a: 0 }, { t: at, a: 1 }] }));
        cx0 += cw;
      });
      return;
    }
    if (nextC === pastC && nextA === pastA && !s.reveal) {
      els.push(Object.assign({}, base, { color: s.color, keys: [{ t: 0, a: nextA, sx: SX }, ...(s.flicker ? flickerKeys(it.i, dur, nextA) : [])] }));
    } else {
      els.push(Object.assign({}, base, { color: nextC, keys: [{ t: 0, a: appear ? 0 : nextA }, { t: appear || 0, a: nextA }, { t: t0, a: 0 }] }));
      els.push(Object.assign({}, base, { color: pastC, keys: [{ t: 0, a: 0 }, { t: t1, a: pastA }] }));
    }
    if (s.current) {
      const c = s.current, pop = c.pop != null ? c.pop : 100;
      els.push(Object.assign({}, base, { color: c.color || s.color, glow: c.glow || base.glow, blur: 0,
        keys: [{ t: 0, a: 0, sx: pop, sy: pop }, { t: t0, a: 0 }, { t: t0 + 1, a: 1 }, { t: t0 + 120, sx: c.scale || 100, sy: c.scale || 100 }, { t: t1, a: c.stay ? 1 : 0 }] }));
    }
  }));
  // Constant blur (soft glass look) on every text element.
  if (s.blur) els.forEach((e) => { if (e.kind === 'text') e.keys = (e.keys || []).map((k) => Object.assign({ blur: s.blur }, k)); });
  // Word-state changes are SWITCHES (a word is current or it is not): hold the
  // previous state until 1 ms before each opacity change, or both the ASS \t
  // and the preview's keyframes would fade it across the whole gap.
  els.forEach((e) => { e.keys = switchKeys(e.keys || []); });
  return { elements: els, box: { top: top - pad[0] * px, bottom: top + H + pad[0] * px } };
}
// One word at a time in the same spot (each replaces the last).
function ccSingle(raw, o, s) {
  const words = raw.map((w) => caseOf(w, s.case));
  const dur = o.dur || 1500;
  const win = wordWindows(words, dur);
  const els = [];
  let px = (s.px || 100) * (o.k || 1);
  const maxWord = Math.max(...words.map((w) => widthPx(w, s.font, px)));
  if (maxWord > (s.maxW || 860)) px *= (s.maxW || 860) / maxWord;
  const y = o.top + px * 0.6;
  words.forEach((w, i) => {
    const [t0, t1] = win[i];
    const pop = (s.current && s.current.pop) || 100;
    els.push({ kind: 'text', text: w, font: s.font, px, color: (s.current && s.current.color) || s.color,
      oc: s.stroke ? s.stroke[1] : '#000000', ow: s.stroke ? s.stroke[0] * px / 100 : 0, sc: s.shadow ? s.shadow[1] : '#000000', sd: s.shadow ? s.shadow[0] * px / 100 : 0,
      x: o.cx, y, rot: 0,
      keys: [{ t: 0, a: 0, sx: pop, sy: pop, blur: 4 }, { t: t0, a: 0 }, { t: t0 + 1, a: 1 }, { t: t0 + 110, sx: 100, sy: 100, blur: 0 }, { t: Math.max(t0 + 120, t1), a: i === words.length - 1 ? 1 : 0 }] });
  });
  return { elements: els, box: { top: o.top, bottom: o.top + px * 1.2 } };
}
function switchKeys(keys) {
  const out = [];
  let a = null, prevT = 0;
  for (const k of keys) {
    if (k.a != null && a != null && k.a !== a && k.t - prevT > 2) out.push({ t: k.t - 1 });
    out.push(k);
    if (k.a != null) a = k.a;
    prevT = k.t;
  }
  return out;
}
function flickerKeys(seed, dur, a) {
  const r = rng(`flicker${seed}`);
  const out = [];
  for (let t = 200 + r() * 300; t < dur - 150; t += 250 + r() * 600) { out.push({ t, a: 0 }, { t: t + 40 + r() * 50, a }); }
  return out;
}
const CC = {
  //       font, base px, case, colours, effects
  cc_dua_pita:      { label: 'Dua pita',      font: 'Poppins Bold', px: 82, case: 'upper', color: '#000000', maxRows: 2, lh: 1.2, gapY: 0.32, rowBox: { color: ['#ff2020', '#22d3ee'] }, pad: [0.12, 0.3] },
  cc_lirik_lembut:  { label: 'Lirik lembut',  font: 'Inter SOCL Bold', px: 92, color: '#ffffff', next: '#ffffff', nextA: 0.6, past: '#ffffff', pastA: 0.95, current: { color: '#ffffff' }, maxRows: 3, gapY: 0.25 },
  cc_dialog_ikon:   { label: 'Dialog ikon',   font: 'Sour Gummy SOCL Bold', px: 80, color: '#ffffff', stroke: [10, '#000000'], current: { color: '#00ff6e' }, maxRows: 3, align: 'left', maxW: 760, track: 1 },
  cc_komik_kuning:  { label: 'Komik kuning',  font: 'Bangers', px: 140, case: 'upper', color: '#ffffff', stroke: [10, '#000000'], shadow: [6, '#000000'], current: { color: '#ffe600', pop: 40, scale: 108 }, maxRows: 2, gapY: 0.12, gapX: 8 },
  cc_berita_kilat:  { label: 'Berita kilat',  font: 'Poppins Bold', px: 80, case: 'upper', color: '#ffffff', maxRows: 3, rowBox: { color: '#ef4444' }, pad: [0.12, 0.3], gapY: 0.18 },
  cc_kedip_kaca:    { label: 'Kedip kaca',    font: 'Noto Sans SOCL Medium', px: 82, color: '#ffffff', nextA: 0.9, blur: 1.2, flicker: true, scaleX: 87.5, maxRows: 3, track: 1 },
  cc_gamer_ungu:    { label: 'Gamer ungu',    font: 'Luckiest Guy', px: 118, case: 'upper', color: '#c045ff', stroke: [9, '#000000'], current: { color: '#80ef80', pop: 115 }, maxRows: 2, gapY: 0.12 },
  cc_viral_lila:    { label: 'Viral lila',    font: 'Bangers', px: 120, case: 'upper', color: '#b286ff', stroke: [9, '#000000'], current: { color: '#ffffff', pop: 115 }, maxRows: 2, gapY: 0.12, gapX: 8 },
  cc_siaga_hijau:   { label: 'Siaga hijau',   font: 'Inter SOCL Bold', px: 80, color: '#000000', rot: -8, maxRows: 2, pageBox: { color: '#2cff05', pop: true }, pad: [0.35, 0.4], gapY: 0.2 },
  cc_serif_kilat:   { label: 'Serif kilat',   font: 'DM Serif Text', px: 150, color: '#ffffff', reveal: 'single', shadow: [3, '#00000099'], current: { color: '#ffffff', pop: 130 } },
  cc_mesin_ketik:   { label: 'Mesin ketik',   font: 'Noto Sans SOCL Medium', px: 64, color: '#ffffff', reveal: 'type', maxRows: 3, pageBox: { color: '#000000' }, pad: [0.4, 0.45], gapY: 0.35, track: 2 },
  cc_gelembung:     { label: 'Gelembung chat', font: 'Noto Sans SOCL Medium', px: 66, color: '#ffffff', wordsPerRow: 5, maxRows: 2, pageBox: { color: '#0183f7', bubble: true, radius: 0.55, pop: true }, pad: [0.45, 0.7], gapY: 0.1 },
  cc_tegas_besar:   { label: 'Tegas besar',   font: 'Inter SOCL Black', px: 96, case: 'upper', color: '#ffffff', stroke: [6, '#000000'], fill: true, maxRows: 3, gapY: 0.06, lh: 1.05 },
  cc_tokoh_utama:   { label: 'Tokoh utama',   font: 'DM Serif Text', px: 104, color: '#ffd606', maxRows: 4, lh: 1.05, track: -0.25 },
  cc_tanpa_konteks: { label: 'Tanpa konteks', font: 'Inter SOCL Bold', px: 92, case: 'lower', color: '#ffffff', wordsPerRow: 1, maxRows: 6, reveal: 'build', shadow: [5, '#00000088'], lh: 1.05, track: 1 },
  cc_mint_pop:      { label: 'Mint pop',      font: 'Staatliches', px: 136, case: 'upper', color: '#76f9d2', next: '#fffb91', past: '#76f9d2', current: { color: '#045b41', box: { color: '#ffffff', radius: 0.18 } }, maxRows: 2, gapY: 0.12, shadow: [5, '#00000066'], pad: [0.05, 0.14], gapX: 4 },
  cc_presentasi:    { label: 'Presentasi',    font: 'Poppins Bold', px: 82, case: 'upper', color: '#000000', wordsPerRow: 3, maxRows: 3, rowBox: { color: '#ffffff' }, pad: [0.1, 0.22], gapY: 0.3 },
  cc_tinju_kuning:  { label: 'Tinju kuning',  font: 'Poppins Bold', px: 98, case: 'upper', color: '#ffffff', stroke: [8, '#000000'], shadow: [5, '#000000'], current: { color: '#ffe600' }, maxRows: 2, gapY: 0.12 },
  cc_geser_lembut:  { label: 'Geser lembut',  font: 'Inter SOCL Bold', px: 92, color: '#ffffff', next: '#ffffff', nextA: 0.45, current: { color: '#fff3b0', glow: '#ffcc33' }, maxRows: 3, gapY: 0.4 },
  cc_siaran_ungu:   { label: 'Siaran ungu',   font: 'Inter SOCL Bold', px: 84, color: '#ffffff', wordBox: { color: '#9147ff' }, maxRows: 2, gapY: 0.12, pad: [0.16, 0.08], gapX: 2, track: 1 },
};
Object.keys(CC).forEach((id) => { TEMPLATES[id] = (text, o) => ccBuild(text, o, CC[id]); });
const CC_LIST = Object.keys(CC).map((id) => ({ id, label: CC[id].label }));
// [PRESET-CATALOG] A "Gaya kata" spec delivered as data (validated in the main
// process first). Its face must already have a width table, or preview and
// burn could lay it out differently. Built-in ids are never replaced.
function registerCaptionTemplate(id, label, spec) {
  if (!/^cc_[a-z0-9_]+$/.test(String(id)) || TEMPLATES[id] || !spec || !KINETIC_FONTS.includes(spec.font)) return false;
  CC[id] = Object.assign({ label }, spec);
  TEMPLATES[id] = (text, o) => ccBuild(text, o, CC[id]);
  CC_LIST.push({ id, label, remote: true });
  return true;
}

// Every face a template can use — the preview waits for these before laying
// out, or canvas would measure a fallback font.
const KINETIC_FONTS = ['CooperBlkBT-Regular', 'Anton', 'Bootzy TM', 'Liberation Sans Narrow', 'Open Sauce Two Bold', 'Open Sauce Two Bold Italic', 'Open Sauce Two ExtraBold Italic', 'Poppins Bold', 'Inter SOCL Bold', 'Inter SOCL Black', 'Sour Gummy SOCL Bold', 'Noto Sans SOCL Medium', 'Bangers', 'Luckiest Guy', 'Staatliches', 'DM Serif Text', 'Times New Roman MT Condensed', "Editor'sNote-Semibold", "Editor'sNote-Medium", "Editor'sNote-MediumItalic", 'Open Sauce Two ExtraBold'];

const TEMPLATE_LIST = [
  { id: 'stiker_pop', label: 'Stiker pop' },
  { id: 'riot', label: 'Riot' },
  { id: 'lakban', label: 'Lakban' },
  { id: 'sorotan', label: 'Sorotan' },
  { id: 'kertas_sobek', label: 'Kertas sobek' },
  { id: 'mask_naik', label: 'Mask naik' },
  { id: 'fokus_blur', label: 'Fokus blur' },
];

function layout(templateId, text, opts = {}) {
  const fn = TEMPLATES[templateId];
  if (!fn || !String(text || '').trim()) return { elements: [], box: null };
  return fn(String(text).trim(), Object.assign({ cx: 540, cy: 760 }, opts));
}

// Resolve the full state (sx, sy, rot, a, x, y, blur, clip) at key i by carrying
// values forward — keys only list what changes.
function resolvedKeys(el) {
  const base = { sx: 100, sy: 100, rot: el.rot || 0, a: 1, x: el.x, y: el.y, blur: 0, clip: null };
  const out = [];
  let cur = Object.assign({}, base);
  (el.keys || []).forEach((k) => { cur = Object.assign({}, cur, k); out.push(cur); });
  if (!out.length) out.push(Object.assign({ t: 0 }, base));
  return out;
}

// [KINETIC-EXTENT] The element's true vertical footprint over the whole
// window: the union of every keyed state in which it is VISIBLE (a > 0),
// with its scale and rotation applied. Placement reads this instead of
// guessing from the ASS tags — the guess took the drop-in start position, the
// 170% pop and the ticker as if they were all on screen together and called a
// 600 px lockup 1130 px tall, so long hooks were skipped as "no room".
function visibleExtent(el) {
  const w = el.kind === 'shape' ? el.w : widthPx(el.text, el.font, el.px, el.italic);
  const h = el.kind === 'shape' ? el.h : el.px * 1.0;
  let top = Infinity, bot = -Infinity;
  for (const k of resolvedKeys(el)) {
    if (!(k.a > 0)) continue;
    const r = Math.abs((k.rot || 0) * Math.PI / 180);
    const sx = (k.sx || 100) / 100, sy = (k.sy || 100) / 100;
    const half = (Math.abs(Math.sin(r)) * w * sx + Math.cos(r) * h * sy) / 2 + (el.ow || 0) + (el.glow ? 10 : 0);
    top = Math.min(top, k.y - half); bot = Math.max(bot, k.y + half + (el.sd || 0));
  }
  return Number.isFinite(top) ? { top, bottom: bot } : null;
}

function fmtTime(sec) {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  const cs = Math.round((s - Math.floor(s)) * 100);
  const ss = Math.floor(s % 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(ss + (cs === 100 ? 1 : 0)).padStart(2, '0')}.${String(cs === 100 ? 0 : cs).padStart(2, '0')}`;
}

// ASS writer. `scale` maps canonical 1080x1920 to PlayRes (sx, sy, ox, oy).
function toAssEvents(layoutRes, { start, end, map = {}, fadeOutMs = 220 }) {
  const lines = [];
  const durMs = Math.round((end - start) * 1000);
  const S = map.s || 1;
  // Uniform scale S about the anchor (cx,cy) -> (cxOut,cyOut).
  const cx = map.cx || 0, cy = map.cy || 0;
  const cxo = map.cxOut != null ? map.cxOut : cx * S, cyo = map.cyOut != null ? map.cyOut : cy * S;
  const X = (x) => +(cxo + (x - cx) * S).toFixed(1);
  const Y = (y) => +(cyo + (y - cy) * S).toFixed(1);
  layoutRes.elements.forEach((el, idx) => {
    const K = resolvedKeys(el);
    const k0 = K[0];
    const makeTags = (glow) => {
    const tags = [];
    tags.push('\\an5');
    // Position: one \move between the first and last key that changes x/y.
    const mv = K.filter((k, i) => i === 0 || k.x !== K[i - 1].x || k.y !== K[i - 1].y);
    if (mv.length > 1) {
      const a = mv[0], b = mv[mv.length - 1];
      const tA = K[K.indexOf(b) - 1] ? K[K.indexOf(b) - 1].t : 0;
      tags.push(`\\move(${X(a.x)},${Y(a.y)},${X(b.x)},${Y(b.y)},${Math.round(tA)},${Math.round(b.t)})`);
    } else tags.push(`\\pos(${X(k0.x)},${Y(k0.y)})`);
    tags.push(`\\frz${(-k0.rot).toFixed(1)}`);
    tags.push(`\\fscx${k0.sx}\\fscy${k0.sy}`);
    // Glow pass: fill and shadow hidden, the outline IS the halo.
    // [GLOW-VISIBLE] Two glow passes: a tight bright core + a wide soft halo
    // (one 10px outline under a 12px blur read as barely-there on video).
    // [GLOW-READ] A third, DARK pass under both: a coloured glow on a light
    // background (white shirt, grey wall) washed the letter edges away. The
    // dark halo keeps every letter crisp; the coloured glow still shows on top.
    // Bright glows (white Halo, lime Neon) on a light shirt / hijab vanish:
    // the brighter the glow (or the text, for shade-only words), the darker
    // and wider the shade, and the softer the wide halo.
    const lit = glowLum(el.glow || el.color);
    const GL = glow === 'tight' ? { op: lit > 0.7 ? 0.85 : 1, bord: 3, blur: 3 }
      : glow === 'shade' ? (lit > 0.55 ? { op: 0.9, bord: 10, blur: 11 } : { op: 0.75, bord: 8, blur: 12 })
      : { op: lit > 0.7 ? 0.5 : lit > 0.55 ? 0.62 : 0.75, bord: 14, blur: 16 };
    const A = (a) => (glow ? `\\1a&HFF&\\3a${alphaHex(a * GL.op)}\\4a&HFF&`
      : el.fillA === 0 ? `\\1a&HFF&\\3a${alphaHex(a)}\\4a${alphaHex(a)}` : `\\alpha${alphaHex(a)}`);
    const B = (v) => (glow ? GL.blur * S + v : v);
    tags.push(A(k0.a));
    if (k0.blur || glow) tags.push(`\\blur${B(k0.blur).toFixed(1)}`);
    const bord = glow ? GL.bord * S : (el.ow || 0) * S;
    tags.push(`\\bord${bord.toFixed(1)}\\3c${hexToAss(glow === 'shade' ? '#000000' : glow ? el.glow : (el.oc || '#000000'))}`);
    const shad = (el.sd || 0) * S;
    tags.push(`\\shad${shad.toFixed(1)}\\4c${hexToAss(el.sc || '#000000')}`);
    if (!glow && (el.shadowSoft || el.glowSoft)) tags.push(`\\shad${(4 * S).toFixed(1)}\\4a&H70&`);
    tags.push(`\\1c${hexToAss(el.color)}`);
    const clipTag = (c, k) => {
      // clip is element-local (top-left of the element's box); convert to frame.
      const w = el.kind === 'shape' ? el.w : widthPx(el.text, el.font, el.px);
      const h = el.kind === 'shape' ? el.h : el.px * 1.3;
      const x0 = k.x - w / 2, y0 = k.y - h / 2;
      return `\\clip(${X(x0 + c[0])},${Y(y0 + c[1])},${X(x0 + c[2])},${Y(y0 + c[3])})`;
    };
    if (el.clipAbs) tags.push(`\\clip(${X(el.clipAbs[0])},${Y(el.clipAbs[1])},${X(el.clipAbs[2])},${Y(el.clipAbs[3])})`);
    if (k0.clip) tags.push(clipTag(k0.clip, k0));
    for (let i = 1; i < K.length; i++) {
      const p = K[i - 1], k = K[i];
      const ch = [];
      if (k.sx !== p.sx) ch.push(`\\fscx${k.sx}`);
      if (k.sy !== p.sy) ch.push(`\\fscy${k.sy}`);
      if (k.rot !== p.rot) ch.push(`\\frz${(-k.rot).toFixed(1)}`);
      if (k.a !== p.a) ch.push(A(k.a));
      if (k.blur !== p.blur) ch.push(`\\blur${B(k.blur).toFixed(1)}`);
      if (k.clip && JSON.stringify(k.clip) !== JSON.stringify(p.clip)) ch.push(clipTag(k.clip, k));
      if (!ch.length) continue;
      const t1 = Math.round(p.t), t2 = Math.max(t1 + 1, Math.round(k.t));
      // Instant steps (1 ms) are plain switches; others ease out.
      tags.push(t2 - t1 <= 1 ? `\\t(${t1},${t2},${ch.join('')})` : `\\t(${t1},${t2},${EASE_OUT},${ch.join('')})`);
    }
    // Shared fade-out at the end of the title window.
    if (fadeOutMs > 0) tags.push(`\\t(${Math.max(0, durMs - fadeOutMs)},${durMs},${A(0)})`);
    let body;
    if (el.kind === 'shape') {
      body = `{\\p1}${scalePath(el.path, S)}{\\p0}`;
    } else {
      const fsz = Math.round(el.px * S * ((FM && FM.fontEmScale(el.font, fontsDir(), false, !!el.italic)) || 1));
      // \\fsp0: buildAss stamps the caption style's tracking (\\fsp-4) on every
      // line; a kinetic layout already placed each glyph, so it must not apply.
      tags.unshift(`\\fn${el.font}\\fs${fsz}\\fsp${el.fsp ? (el.fsp * S).toFixed(2) : 0}\\b0${el.italic ? '\\i1' : '\\i0'}`);   // [CAP-FOKUS-TRACK] el.fsp
      body = String(el.text).replace(/\\/g, '＼').replace(/[{}]/g, '');
    }
    return { tags, body };
    };
    const { tags, body } = makeTags(false);
    // The settled footprint rides in the Name field (free text, ignored by
    // libass) as @top:bottom in output pixels, for hook placement.
    const ve = visibleExtent(el);
    const foot = ve ? `@${Y(ve.top).toFixed(0)}:${Y(ve.bottom).toFixed(0)}` : '';
    const base = `kinetic-${el.bleed ? 'bleed-' : ''}${idx}`;
    const name = `${base}${foot}`;
    // pass suffix BEFORE the @top:bottom footprint, which readers parse at the end
    if ((el.glow || el.shade) && el.kind === 'text') {
      const sh = makeTags('shade');
      lines.push(`Dialogue: 10,${fmtTime(start)},${fmtTime(end)},Default,${base}-glow-shade${foot},0,0,0,,{${sh.tags.join('')}}${sh.body}`);
    }
    if (el.glow && el.kind === 'text') {
      for (const pass of ['wide', 'tight']) {
        const g = makeTags(pass);
        lines.push(`Dialogue: 11,${fmtTime(start)},${fmtTime(end)},Default,${base}-glow-${pass}${foot},0,0,0,,{${g.tags.join('')}}${g.body}`);
      }
    }
    lines.push(`Dialogue: ${10 + (el.kind === 'text' ? 2 : 1)},${fmtTime(start)},${fmtTime(end)},Default,${name},0,0,0,,{${tags.join('')}}${body}`);
  });
  return lines;
}

function scalePath(path, s) {
  if (s === 1) return path;
  return path.replace(/-?\d+(\.\d+)?/g, (n) => (+n * s).toFixed(1));
}

const api = { glowLum, mixChunks, estChunks, kinCapFadeMs, splitSub, visibleExtent, stateAt, CC_LIST, registerCaptionTemplate, TEMPLATES, TEMPLATE_LIST, CAPTION_LIST, keyIndex, wordTimes, layout, toAssEvents, resolvedKeys, widthPx, setFontsDir, rng, hexToAss, FONTS: KINETIC_FONTS, __test: { wrapWords, letterCentres, rotPt, fmtTime, scalePath, balancedLines } };
if (IS_NODE) module.exports = api; else root.KineticTitle = api;
})(typeof window !== 'undefined' ? window : globalThis);
