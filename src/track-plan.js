// Generated from backend/src/track-plan.ts by scripts/backend.cjs. Edit the TypeScript source.
// app/src/track-plan.js
// Pure logic converting a tracker `trackPlan` into ffmpeg-ready framing.
// DOM-free and dependency-free so it unit-tests like cue-retime.js.
'use strict';
const clamp01 = v => Math.max(0, Math.min(1, v));
function rectIou(a, b) {
    if (!a || !b || a.w == null || a.h == null || b.w == null || b.h == null)
        return 0;
    const ax1 = clamp01(a.x), ay1 = clamp01(a.y), ax2 = clamp01(a.x + a.w), ay2 = clamp01(a.y + a.h);
    const bx1 = clamp01(b.x), by1 = clamp01(b.y), bx2 = clamp01(b.x + b.w), by2 = clamp01(b.y + b.h);
    const iw = Math.max(0, Math.min(ax2, bx2) - Math.max(ax1, bx1));
    const ih = Math.max(0, Math.min(ay2, by2) - Math.max(ay1, by1));
    const inter = iw * ih;
    const ua = Math.max(0, ax2 - ax1) * Math.max(0, ay2 - ay1)
        + Math.max(0, bx2 - bx1) * Math.max(0, by2 - by1) - inter;
    return ua > 1e-9 ? inter / ua : 0;
}
function rectCenterDistance(a, b) {
    if (!a || !b || a.w == null || a.h == null || b.w == null || b.h == null)
        return 1;
    const ax = clamp01(a.x + a.w / 2), ay = clamp01(a.y + a.h / 2);
    const bx = clamp01(b.x + b.w / 2), by = clamp01(b.y + b.h / 2);
    return Math.hypot(ax - bx, ay - by);
}
function splitPanelsTooSimilar(a, b) {
    return rectIou(a, b) >= 0.72 || rectCenterDistance(a, b) <= 0.08;
}
function rectToSingleTarget(r) {
    if (!r || r.w == null || r.h == null)
        return { x: 0.5, y: 0.5, scale: 1 };
    return {
        x: clamp01(r.x + r.w / 2),
        y: clamp01(r.y + r.h / 2),
        scale: 1,
    };
}
// Build an EASED (smoothstep) fraction (0..1) expression over ffmpeg time `t`
// from keyframes [{t, <key>}]. Unlike pipeline-inverse-v1's step-hold
// piecewiseFrac, values ramp between keyframes. Before the first kf holds the
// first value; after the last kf holds the last. Commas are NOT escaped here —
// callers escape when embedding in a crop expression.
//
// Smoothstep (3p²-2p³) instead of a straight linear ramp: velocity is zero at
// both ends of every segment, so the crop glides into and out of each move
// instead of snapping to a new constant speed at each keyframe boundary —
// that snap is what reads as robotic/jerky panning even when the underlying
// tracked positions are already noise-free.
function piecewiseLerp(kf, key) {
    const val = i => clamp01(Number(kf[i][key]) || 0);
    if (kf.length === 1)
        return val(0).toFixed(4);
    let expr = val(kf.length - 1).toFixed(4);
    for (let i = kf.length - 2; i >= 0; i--) {
        const t0 = kf[i].t, t1 = kf[i + 1].t;
        const v0 = val(i), v1 = val(i + 1);
        const invDt = (t1 - t0) > 1e-6 ? 1 / (t1 - t0) : 0;
        const p = `((t-${t0.toFixed(3)})*${invDt.toFixed(6)})`;
        const seg = `(${v0.toFixed(4)}+(${(v1 - v0).toFixed(4)})*(3*${p}*${p}-2*${p}*${p}*${p}))`;
        expr = `if(lt(t,${t1.toFixed(3)}),${seg},${expr})`;
    }
    expr = `if(lt(t,${kf[0].t.toFixed(3)}),${val(0).toFixed(4)},${expr})`;
    return expr;
}
// [KF-BUDGET-2026-08-06] piecewiseLerp bakes EVERY surviving point into one
// nested ffmpeg if()-expression, one nesting level per point. Measured on a
// real render: 50 points parses fine, 100 fails ffmpeg's expression parser
// outright ("Missing ')' or too many args in ..."). Denser tracker sampling
// (needed for genuinely smooth motion — the coarse ~1 keyframe/1.2s default
// reads as robotic panning between sparse anchors) makes hitting that wall a
// certainty on anything longer than a few seconds of continuous motion.
//
// Fix: keep the tracker's dense output as ground truth, then simplify each
// axis (x, y independently — they're already interpolated as separate
// piecewiseLerp calls) down to a point count the expression parser can
// actually handle, via Ramer-Douglas-Peucker: drop a point only when the
// straight line between its neighbours already approximates it within
// `epsilon`, so genuine direction/speed changes survive and near-linear
// stretches (which is most of a real camera path) collapse to their
// endpoints. The first and last point of a run always survive untouched.
function rdpSimplify(points, epsilon) {
    if (points.length <= 2)
        return points;
    const p0 = points[0], p1 = points[points.length - 1];
    const dt = p1.t - p0.t;
    let maxDist = -1, maxIdx = 0;
    for (let i = 1; i < points.length - 1; i++) {
        const p = points[i];
        const frac = dt > 1e-9 ? (p.t - p0.t) / dt : 0;
        const onLine = p0.v + (p1.v - p0.v) * frac;
        const dist = Math.abs(p.v - onLine);
        if (dist > maxDist) {
            maxDist = dist;
            maxIdx = i;
        }
    }
    if (maxDist <= epsilon)
        return [p0, p1];
    const left = rdpSimplify(points.slice(0, maxIdx + 1), epsilon);
    const right = rdpSimplify(points.slice(maxIdx), epsilon);
    return left.slice(0, -1).concat(right);
}
// Point-budget wrapper: RDP's output size depends on how much the curve
// actually moves, which has no upper bound — a busy clip could still blow
// past the ffmpeg ceiling at any fixed epsilon. Doubles down on epsilon
// until the result fits maxPoints, so the render is safe REGARDLESS of how
// much genuine motion the tracker captured. Monotonic in epsilon (RDP never
// grows its output as epsilon rises), so this always converges.
const KF_KEEP_ENDPOINTS = 2;
function simplifyToBudget(points, maxPoints, startEpsilon = 0.004) {
    if (points.length <= maxPoints)
        return points;
    let epsilon = startEpsilon;
    let out = rdpSimplify(points, epsilon);
    let guard = 0;
    while (out.length > maxPoints && out.length > KF_KEEP_ENDPOINTS && guard < 30) {
        epsilon *= 1.6;
        out = rdpSimplify(points, epsilon);
        guard++;
    }
    return out;
}
// Empirically: 50 keyframes renders fine, 100 fails. 40 keeps real margin
// below that measured line rather than riding right up against it.
const MAX_LERP_POINTS = 40;
// A layout signature distinguishes segments that must render differently.
// Explicit `_seg` is still honored for hard cuts, but continuation keyframes
// (`cut` absent/null/false) in single/split mode can merge so one FFmpeg job
// renders the whole camera move instead of one tiny file per tracker sub-slice.
function _segKey(kf) {
    if (kf._seg != null)
        return String(kf._seg);
    if (kf.mode === 'grid') {
        const rows = Array.isArray(kf.rows) ? kf.rows : [];
        return 'grid:' + rows.map(r => (Array.isArray(r) ? r.length : 0)).join(',');
    }
    return kf.mode;
}
function canContinueSegment(last, kf) {
    if (!last || kf.cut === true)
        return false;
    if (last.mode !== kf.mode)
        return false;
    if (kf.mode === 'single')
        return true;
    if (kf.mode !== 'split')
        return false;
    const prev = last.items[last.items.length - 1] || {};
    return (prev.orientation || '') === (kf.orientation || '');
}
// Group a trackPlan's keyframes into contiguous same-layout render segments.
// Each segment: { mode, start, end, keyframes:[{t(rebased), ...framing}] }.
// A layout boundary is a hard cut (no cross-segment interpolation). Continuous
// same-layout keyframes may merge even when their tracker `_seg` differs.
// When the plan has no keyframes, return one default single-mode segment.
function planToSegments(plan, clipDur) {
    const kfs = (plan && Array.isArray(plan.keyframes)) ? plan.keyframes : [];
    if (kfs.length === 0) {
        return [{ mode: 'single', start: 0, end: clipDur,
                keyframes: [{ t: 0, target: { x: 0.5, y: 0.5, scale: 1 } }] }];
    }
    const sorted = [...kfs].sort((a, b) => a.t - b.t);
    const groups = [];
    for (const kf of sorted) {
        const last = groups[groups.length - 1];
        if (canContinueSegment(last, kf) || (last && last.key === _segKey(kf)))
            last.items.push(kf);
        else
            groups.push({ mode: kf.mode, key: _segKey(kf), items: [kf] });
    }
    return groups.map((g, i) => {
        const start = g.items[0].t;
        const end = (i + 1 < groups.length) ? groups[i + 1].items[0].t : clipDur;
        const keyframes = g.items.map(kf => {
            const { t, mode, ...framing } = kf;
            return { t: +(t - start).toFixed(3), ...framing };
        });
        return { mode: g.mode, start, end, keyframes };
    });
}
// Resolution tiers mirror pipeline-inverse-v1.js RES_MAP (short side px).
const RES_SHORT = { '720p': 720, '1080p': 1080, '2K': 1440, '4K': 2160 };
const even = n => { n = Math.round(n); return n % 2 ? n + 1 : n; };
const escNoComma = s => s.replace(/,/g, '\\,');
// Output canvas dimensions for a given clipFormat + resolution tier. Matches
// the branches in pipeline-inverse-v1.js vfFor(): face/blur = 9:16 portrait,
// square = 1:1, landscape = 16:9. The tier's number sets the short side.
function outputDims(format, resolution) {
    const u = RES_SHORT[resolution] || 1080;
    const long = even(u * 16 / 9);
    switch (format) {
        case 'square': return { W: u, H: u };
        case 'landscape': return { W: long, H: u };
        case 'face':
        case 'blur':
        default: return { W: u, H: long };
    }
}
// Build a -vf for one SINGLE-mode segment. Output is 9:16 at the given tier.
// scale (0.3..1) is the fraction of the full-height window to crop; x,y are the
// top-left window position as a fraction of the available slack (0..1).
function vfSingleTrack(seg, resolution, format) {
    const { W, H } = outputDims(format || 'face', resolution);
    const kfs = seg.keyframes.length ? seg.keyframes : [{ t: 0, target: { x: 0.5, y: 0.5, scale: 1 } }];
    const sc = Math.max(0.3, Math.min(1, Number(kfs[0].target.scale) || 1));
    const cw = even(W * sc), ch = even(H * sc);
    const xk = simplifyToBudget(kfs.map(k => ({ t: k.t, v: k.target.x })), MAX_LERP_POINTS);
    const yk = simplifyToBudget(kfs.map(k => ({ t: k.t, v: k.target.y })), MAX_LERP_POINTS);
    let xExpr, yExpr;
    if (kfs.length >= 2) {
        xExpr = escNoComma(`(in_w-${cw})*(${piecewiseLerp(xk, 'v')})`);
        yExpr = escNoComma(`(in_h-${ch})*(${piecewiseLerp(yk, 'v')})`);
    }
    else {
        xExpr = `floor((in_w-${cw})*${clamp01(xk[0].v).toFixed(4)})`;
        yExpr = `floor((in_h-${ch})*${clamp01(yk[0].v).toFixed(4)})`;
    }
    const zoomTail = sc < 1 ? `,scale=${W}:${H}` : '';
    return `scale=${W}:${H}:force_original_aspect_ratio=increase,`
        + `crop=${cw}:${ch}:${xExpr}:${yExpr}${zoomTail},setsar=1`;
}
function rectExprKfs(panelKfs, key) {
    return simplifyToBudget(panelKfs.map(k => ({ t: k.t, v: clamp01(k[key]) })), MAX_LERP_POINTS);
}
function medianPanelValue(panelKfs, key, fallback) {
    const vals = panelKfs
        .map(k => Number(k[key]))
        .filter(v => Number.isFinite(v))
        .sort((a, b) => a - b);
    if (!vals.length)
        return fallback;
    return vals[Math.floor(vals.length / 2)];
}
// One panel's crop→scale chain for the SPLIT layout.
//
// Preferred contract (matches vfGrid): the keyframe carries a source-normalized
// rect {x, y, w, h}. FFmpeg's crop filter on our bundled build supports dynamic
// x/y but not dynamic w/h, so continuous split segments keep the first rect size
// and interpolate panel position. That mirrors LokaClip's "one trajectory,
// one render job" shape while avoiding hundreds of tiny segment renders.
//
// Backward compat: if the keyframe only has {x, y, scale}, fall back to the
// legacy cover-scale-then-crop path.
function panelChain(inLabel, outLabel, panelKfs, panelW, panelH) {
    const first = panelKfs[0] || {};
    if (first.w != null && first.h != null) {
        const posExpr = (key) => panelKfs.length >= 2
            ? escNoComma(piecewiseLerp(rectExprKfs(panelKfs, key), 'v'))
            : clamp01(first[key]).toFixed(5);
        const w = clamp01(medianPanelValue(panelKfs, 'w', first.w)).toFixed(5);
        const h = clamp01(medianPanelValue(panelKfs, 'h', first.h)).toFixed(5);
        const x = posExpr('x'), y = posExpr('y');
        return `[${inLabel}]crop=iw*${w}:ih*${h}`
            + `:iw*(${x}):ih*(${y}),`
            + `scale=${panelW}:${panelH}:force_original_aspect_ratio=increase,`
            + `crop=${panelW}:${panelH}[${outLabel}]`;
    }
    // Legacy {x, y, scale} — kept for any pre-refactor plan files.
    const sc = Math.max(0.3, Math.min(1, Number(first.scale) || 1));
    const cw = even(panelW * sc), ch = even(panelH * sc);
    const xk = simplifyToBudget(panelKfs.map(k => ({ t: k.t, v: k.x })), MAX_LERP_POINTS);
    const yk = simplifyToBudget(panelKfs.map(k => ({ t: k.t, v: k.y })), MAX_LERP_POINTS);
    let xExpr, yExpr;
    if (panelKfs.length >= 2) {
        xExpr = escNoComma(`(in_w-${cw})*(${piecewiseLerp(xk, 'v')})`);
        yExpr = escNoComma(`(in_h-${ch})*(${piecewiseLerp(yk, 'v')})`);
    }
    else {
        xExpr = `floor((in_w-${cw})*${clamp01(xk[0].v).toFixed(4)})`;
        yExpr = `floor((in_h-${ch})*${clamp01(yk[0].v).toFixed(4)})`;
    }
    const zoomTail = sc < 1 ? `,scale=${panelW}:${panelH}` : '';
    return `[${inLabel}]scale=${panelW}:${panelH}:force_original_aspect_ratio=increase,`
        + `crop=${cw}:${ch}:${xExpr}:${yExpr}${zoomTail}[${outLabel}]`;
}
// Build a filtergraph for one SPLIT segment. Orientation follows the output
// aspect: landscape → hstack (left/right panels), otherwise vstack (top/bottom).
// The keyframe carries either {top,bottom} or {left,right} depending on that
// orientation — the tracker (grid.py) already picks per-format.
function vfSplitTrack(seg, resolution, format) {
    const dims = outputDims(format || 'face', resolution);
    const isLandscape = (format === 'landscape');
    const kfs = seg.keyframes.length ? seg.keyframes : null;
    const firstKf = kfs ? kfs[0] : null;
    // Prefer explicit orientation if the tracker provided it.
    const hstack = firstKf && firstKf.orientation
        ? firstKf.orientation === 'hstack'
        : isLandscape;
    const panelW = hstack ? even(dims.W / 2) : dims.W;
    const panelH = hstack ? dims.H : even(dims.H / 2);
    const [aKey, bKey] = hstack ? ['left', 'right'] : ['top', 'bottom'];
    const safeKfs = kfs || [{ t: 0,
            [aKey]: { x: 0, y: 0, w: hstack ? 0.5 : 1, h: hstack ? 1 : 0.5 },
            [bKey]: { x: hstack ? 0.5 : 0, y: hstack ? 0 : 0.5, w: hstack ? 0.5 : 1, h: hstack ? 1 : 0.5 } }];
    const aKfs = safeKfs.map(k => ({ t: k.t, ...(k[aKey] || {}) }));
    const bKfs = safeKfs.map(k => ({ t: k.t, ...(k[bKey] || {}) }));
    if (splitPanelsTooSimilar(aKfs[0], bKfs[0])) {
        return vfSingleTrack({
            mode: 'single',
            start: seg.start,
            end: seg.end,
            keyframes: safeKfs.map(k => ({ t: k.t, target: rectToSingleTarget(k[aKey] || k[bKey]) })),
        }, resolution, format);
    }
    const stack = hstack ? 'hstack' : 'vstack';
    return `[0:v]split[a_src][b_src];`
        + panelChain('a_src', 'a', aKfs, panelW, panelH) + ';'
        + panelChain('b_src', 'b', bKfs, panelW, panelH) + ';'
        + `[a][b]${stack},setsar=1`;
}
// Build a filtergraph for one GRID segment. `rows` is a list of rows, each a
// list of panels; every panel is a source-normalized crop rect {x,y,w,h}. Rows
// tile vertically at equal height; panels within a row tile horizontally at
// equal width. Each panel's rect is cropped, cover-scaled to its cell, then
// hstacked per row and vstacked. Output is the full 9:16 frame at the tier.
// A grid is static within its segment (no per-frame interpolation).
function vfGrid(seg, resolution, format) {
    const { W, H } = outputDims(format || 'face', resolution);
    const rows = (seg.keyframes[0] && seg.keyframes[0].rows) || [[{ x: 0, y: 0, w: 1, h: 1 }]];
    const R = rows.length;
    const cellH = even(H / R);
    const parts = [];
    const rowLabels = [];
    let idx = 0;
    const total = rows.reduce((n, r) => n + r.length, 0);
    const splitOuts = Array.from({ length: total }, (_, k) => `p${k}`);
    parts.push(`[0:v]split=${total}[${splitOuts.join('][')}]`);
    rows.forEach((row, ri) => {
        const C = row.length;
        const cellW = even(W / C);
        const cellLabels = [];
        row.forEach(p => {
            const x = clamp01(p.x).toFixed(5), y = clamp01(p.y).toFixed(5);
            const w = clamp01(p.w).toFixed(5), h = clamp01(p.h).toFixed(5);
            const cl = `c${idx}`;
            parts.push(`[p${idx}]crop=iw*${w}:ih*${h}:iw*${x}:ih*${y},`
                + `scale=${cellW}:${cellH}:force_original_aspect_ratio=increase,`
                + `crop=${cellW}:${cellH}[${cl}]`);
            cellLabels.push(cl);
            idx++;
        });
        const rl = `r${ri}`;
        if (C === 1)
            parts.push(`[${cellLabels[0]}]copy[${rl}]`);
        else
            parts.push(`[${cellLabels.join('][')}]hstack=inputs=${C}[${rl}]`);
        rowLabels.push(rl);
    });
    if (R === 1)
        parts.push(`[${rowLabels[0]}]setsar=1`);
    else
        parts.push(`[${rowLabels.join('][')}]vstack=inputs=${R},setsar=1`);
    return parts.join(';');
}
// Blur-background "wide" layout: the full source is fit (letterbox-free) into
// 9:16 by scaling to fit width, centered, over a blurred cover-scaled copy of
// itself. Used for establishing / crowded moments where cropping to faces would
// lose context (matches the reference's blurred-fill full-group shot).
function vfBlurBg(resolution, format) {
    const { W, H } = outputDims(format || 'face', resolution);
    return `[0:v]split[bg][fg];`
        + `[bg]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},gblur=sigma=30[bgb];`
        + `[fg]scale=${W}:${H}:force_original_aspect_ratio=decrease[fgs];`
        + `[bgb][fgs]overlay=(W-w)/2:(H-h)/2,setsar=1`;
}
// Turn a trackPlan into an ordered list of ffmpeg segment jobs. Each job:
//   { ss, to, kind:'vf'|'filter', vf?, graph? }
// ss/to are clip-local seconds; the renderer adds -ss/-to and the filter arg.
// buildSegmentJobs(plan, { clipDur, resolution, format }): the `format` is the
// user's Face 9:16 / Blur BG 9:16 / Square 1:1 / Landscape 16:9 choice. It
// dictates the output canvas aspect for every mode; the tracker's normalized
// coords are aspect-agnostic. 'blur' is not a smart mode — the JS-side vfFor
// already handles blurred-BG letterbox for the user's chosen ratio.
function buildSegmentJobs(plan, { clipDur, resolution, format }) {
    const fmt = format || 'face';
    // [BLUR-NOT-TRACKED] Blur BG means "keep the WHOLE frame, letterboxed over a
    // blurred copy of itself" — there is no crop for a face tracker to steer, so
    // the tracker's segments must not be applied at all. The comment above said
    // exactly this, but the code below never acted on it: with Smart Track on,
    // 'blur' fell through to vfSingleTrack/vfSplitTrack and the user got
    // face-cropped panels (a two-panel close-up on a 9:16 canvas) instead of the
    // full footage they picked. Reported on a real run, 2026-08-10.
    //
    // Handled here rather than at the call sites so every consumer is covered by
    // one rule: the pipeline, the Caption Editor's Apply, batch re-render, and
    // any clip whose trackPlan was already persisted before this fix.
    if (fmt === 'blur') {
        return [{ ss: 0, to: Math.max(0.1, clipDur), kind: 'filter',
                graph: vfBlurBg(resolution, fmt) }];
    }
    return planToSegments(plan, clipDur).map(seg => {
        if (seg.mode === 'split') {
            return { ss: seg.start, to: seg.end, kind: 'filter',
                graph: vfSplitTrack(seg, resolution, fmt) };
        }
        // wide and grid kept as identifiers for older plans but treated as single.
        return { ss: seg.start, to: seg.end, kind: 'vf',
            vf: vfSingleTrack(seg, resolution, fmt) };
    });
}
module.exports = { piecewiseLerp, clamp01, planToSegments, vfSingleTrack, vfSplitTrack, vfGrid, vfBlurBg, buildSegmentJobs, rdpSimplify, simplifyToBudget, MAX_LERP_POINTS };
