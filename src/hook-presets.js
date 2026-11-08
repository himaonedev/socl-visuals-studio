// Generated from backend/src/hook-presets.ts by scripts/backend.cjs. Edit the TypeScript source.
'use strict';
// [HOOK-PRESET] One-click hook looks for persistent Titles.
//
// A preset is DATA plus one pure function. It writes only fields buildAss
// already honours — T.style / T.fn / T.boxColor / T.glow / T.anim / T.layout
// and per-word tokens[i].style — so the burn needs no change at all, and the
// preview stays in step for free because both sides read the same fields.
//
// Same dual-mode shape as caption-box.js / title-layout.js: require() in node
// tests, window.HookPresets in the renderer. No DOM here, ever — two copies of
// this logic is exactly how preview/burn drift bugs start in this codebase.
(function (root) {
    const TL = (typeof module !== 'undefined' && module.exports)
        ? require('./title-layout')
        : root.TitleLayout;
    // Which words an accent lands on. The line shapes come from the SAME
    // autoTitleBreaks the preview and the burn use, so a preset can say "the
    // last line" and mean the same words everywhere.
    function lineRanges(text, shape, lines) {
        const words = String(text || '').trim().split(/\s+/).filter(Boolean);
        if (!words.length)
            return [];
        const breaks = TL.autoTitleBreaks(text, shape, lines);
        const ranges = [];
        let start = 0;
        for (const b of breaks) {
            ranges.push([start, b]);
            start = b;
        }
        ranges.push([start, words.length]);
        return ranges;
    }
    function targetIndices(text, shape, target, lines) {
        const ranges = lineRanges(text, shape, lines);
        if (!ranges.length)
            return [];
        // [HOOK-PRESET-V2] Whole-title looks: every word, or none of them.
        if (target === 'all') {
            const n = ranges[ranges.length - 1][1];
            return Array.from({ length: n }, (_, i) => i);
        }
        if (target === 'none')
            return [];
        let r;
        if (target === 'firstLine')
            r = ranges[0];
        else if (target === 'middleLine')
            r = ranges[Math.floor((ranges.length - 1) / 2)];
        else
            r = ranges[ranges.length - 1]; // 'lastLine' (default)
        // A title short enough to stay on ONE line has no separate payoff line, so
        // accenting "the last line" would colour every word and read as no accent
        // at all. Fall back to the final word — the same payoff, inline.
        if (ranges.length === 1 && target !== 'firstLine' && r[1] - r[0] > 1) {
            return [r[1] - 1];
        }
        const out = [];
        for (let i = r[0]; i < r[1]; i++)
            out.push(i);
        return out;
    }
    // [HOOK-FONT] Presets deliberately leave `fn` empty (follow the Style's own
    // face). Anton was the first choice for the impact look, but its box comes
    // out roughly half the width of its own text: titleBoxRects measures in px
    // while the text burns at assFs(px, font), and fontEmScale over-corrects for
    // this face. Verified by burning the identical title in four faces — default,
    // Arial Nova Cond and Times New Roman MT Condensed all box correctly; only
    // Anton does not. Tracked separately; until it is fixed a preset must not
    // pick a face whose box does not fit.
    // [HOOK-STYLE-LIST] A preset may only name a style the Titles panel itself
    // offers (TITLE_STYLES in renderer.js). blok_neon first used bw_hi_lime,
    // which is a caption style: the burn honoured it, but the panel's <select>
    // had no such <option> so it displayed a different style entirely — and the
    // moment the user touched that dropdown, their "no change" overwrote the
    // preset. A boxed word takes contrastInk regardless of style, so white_clean
    // renders identically here.
    // [HOOK-TRACK] Every preset states `track: 0`. The burn's default is
    // TRACK_EM = -0.07em — captions are set tight on purpose so a long line fits
    // — but a hook is a few big words and that same -7% reads as cramped, with
    // the word gaps closing up too (\fsp narrows spaces as well as letters).
    // The mockups these presets copy sit at roughly zero tracking, so the
    // presets say so outright instead of inheriting the caption default.
    const HOOK_PRESETS = [
        {
            id: 'blok_neon',
            label: 'Blok neon',
            title: { style: 'white_clean', fn: 'Anton', track: 0, boxColor: '#C6FF00', glow: false, anim: 'pop', layout: 'auto', lines: 3, linesMinWords: 5 },
            accent: { target: 'middleLine', box: true },
        },
        {
            id: 'aksen_miring',
            label: 'Aksen miring',
            // [HOOK-GLOW] Style chosen for its GLOW colour, not its text colour: glowC2
            // comes from the style (white_clean glows white at alpha A0 and a small
            // blur — deliberately subtle, and invisible as a halo). neon_green glows
            // lime at full strength, so the accent line actually reads as lit. Word
            // colours are stated outright below, so the style's own text colour
            // never shows through.
            title: { style: 'neon_green', fn: 'Open Sauce Two Bold', track: 0, boxColor: '', glow: true, glowColor: '#5DCAA5', anim: 'pop', layout: 'auto' },
            accent: { target: 'lastLine', color: '#5DCAA5', italic: true, scale: 1.25, italicAll: true, baseColor: '#FFFFFF', glow: true },
        },
        {
            id: 'kuning_tebal',
            label: 'Kuning tebal',
            // [HOOK-GLOW] `yellow` glows warm orange (#FF9540) at full strength.
            title: { style: 'yellow', fn: 'Anton', track: 0, boxColor: '', glow: true, glowColor: '#FAC775', anim: 'pop', layout: 'pyramid', lines: 2, linesMinWords: 2 },
            accent: { target: 'lastLine', color: '#FAC775', scale: 1.3, baseColor: '#FFFFFF', glow: true },
        },
        {
            id: 'outline_tebal',
            label: 'Outline tebal',
            title: { style: 'white_clean', fn: 'Anton', track: 0, boxColor: '', glow: false, anim: 'pop', layout: 'pyramid', lines: 2, linesMinWords: 2 },
            // Opening line hollow, payoff line solid — the contrast IS the look.
            accent: { target: 'firstLine', outline: true, outlineColor: '#FFFFFF', baseColor: '#FFFFFF' },
        },
        {
            id: 'kotak_merah',
            label: 'Kotak merah',
            title: { style: 'white_clean', fn: 'Anton', track: 0, boxColor: '#E24B4A', glow: false, anim: 'pop', layout: 'pyramid', lines: 3, linesMinWords: 5 },
            accent: { target: 'middleLine', box: true },
        },
        {
            id: 'pastel_lembut',
            label: 'Pastel lembut',
            // [HOOK-FONT] 'Poppins Bold', not 'Poppins': styles.css declares the
            // canonical family names, so a bare 'Poppins' rendered as a fallback
            // serif in the preview while the burn resolved the real face — the two
            // showed different typefaces for the same preset.
            // The only preset that is not shouting: rounded face, two soft colours,
            // no box and no glow. Mixed case is the user's own text — a preset never
            // rewrites words.
            title: { style: 'white_clean', fn: 'Poppins Bold', track: 0, boxColor: '', glow: false, anim: 'pop', layout: 'pyramid', lines: 2, linesMinWords: 2 },
            accent: { target: 'lastLine', color: '#F1EFE8', scale: 1.3, baseColor: '#ED93B1' },
        },
        // [HOOK-PRESET-V2] Second wave, 2026-10-11 — the looks short-form clippers
        // ship as hook titles now (cover card, cinema band, highlighter quote,
        // impact slam, two-tone, editorial serif, typed label). Studied from what
        // the market shows, then redrawn in our own fonts, colours and names.
        // New fields, all optional and all understood by buildAss + the preview:
        //   title.fs          base size (canonical px) instead of the editor's 96
        //   title.backdrop    'card' | 'gradient' (+ backdropColor/backdropOpacity)
        //   textCase          how the AUTO hook text is cased: 'upper' (default),
        //                     'keep' or 'lower' — a preset never re-cases text the
        //                     user typed themselves
        //   accent.fn/b       face / bold for the accented words
        //   accent.baseFn/baseScale/baseBold   the same for every other word
        {
            id: 'kartu_bersih',
            label: 'Kartu bersih',
            textCase: 'keep',
            title: { style: 'white_clean', fn: 'Hanken Grotesk', fs: 80, track: 0, boxColor: '', glow: false, anim: 'pop', layout: 'auto', lines: 2, linesMinWords: 4,
                backdrop: 'card', backdropColor: '#FFFFFF', backdropOpacity: 1 },
            accent: { target: 'none', baseColor: '#141414', baseBold: true },
        },
        {
            id: 'layar_lebar',
            label: 'Layar lebar',
            title: { style: 'white_clean', fn: 'Open Sauce Two ExtraBold', fs: 84, track: 0, boxColor: '', glow: false, anim: 'rise', layout: 'auto', lines: 3, linesMinWords: 6,
                backdrop: 'gradient', backdropColor: '#000000', backdropOpacity: 0.8 },
            accent: { target: 'none', baseColor: '#FFFFFF' },
        },
        {
            id: 'stabilo_putih',
            label: 'Stabilo putih',
            title: { style: 'white_clean', fn: 'Poppins Bold', fs: 74, track: 0, boxColor: '#FFFFFF', glow: false, anim: 'pop', layout: 'auto', lines: 2, linesMinWords: 4 },
            accent: { target: 'all', box: true },
        },
        {
            id: 'hantam',
            label: 'Hantam',
            title: { style: 'yellow', fn: 'Anton', fs: 150, track: 0, boxColor: '', glow: false, anim: 'slam', layout: 'pyramid', lines: 3, linesMinWords: 4 },
            accent: { target: 'none', baseColor: '#FFE600' },
        },
        {
            id: 'dua_nada',
            label: 'Dua nada',
            textCase: 'keep',
            // An edged style (not white_clean): the orange line needs the dark
            // outline to stay readable over a light background.
            title: { style: 'neon_green', fn: 'Hanken Grotesk', fs: 86, track: 0, boxColor: '', glow: false, anim: 'rise', layout: 'auto', lines: 2, linesMinWords: 4 },
            accent: { target: 'lastLine', color: '#FF8A3D', baseColor: '#FFFFFF', b: true, baseBold: true },
        },
        {
            id: 'editorial',
            label: 'Editorial',
            textCase: 'lower',
            // No glow: a white halo on the small line bled into the serif line
            // under it and read as overlapping text in a real render.
            title: { style: 'white_clean', fn: 'Hanken Grotesk', fs: 112, track: 0, boxColor: '', glow: false, anim: 'fade', layout: 'pyramid', lines: 2, linesMinWords: 3 },
            accent: { target: 'lastLine', fn: "Editor'sNote-BoldItalic", color: '#FFFFFF',
                baseFn: 'Hanken Grotesk', baseScale: 0.62, baseColor: '#F3F3F3', baseBold: false },
        },
        {
            id: 'label_ketik',
            label: 'Label ketik',
            textCase: 'keep',
            title: { style: 'white_clean', fn: 'Hanken Grotesk', fs: 66, track: 0, boxColor: '#FFFFFF', glow: false, anim: 'type', layout: 'auto', lines: 2, linesMinWords: 5 },
            accent: { target: 'all', box: true, b: true },
        },
        // [KINETIC-TITLE] Motion-graphic templates: the whole lockup (letters,
        // ribbons, doodles, timing) comes from kinetic-title.js, so `fn`/`style`
        // here only matter if the title is later edited as a plain title.
        {
            id: 'stiker_pop',
            label: 'Stiker pop',
            textCase: 'keep',
            title: { kinetic: 'stiker_pop', style: 'white_clean', fn: 'CooperBlkBT-Regular', fs: 96, track: 0, boxColor: '', glow: false, anim: 'none', layout: 'auto' },
            accent: { target: 'none' },
        },
        {
            id: 'riot',
            label: 'Riot',
            textCase: 'keep',
            title: { kinetic: 'riot', videoFx: 'duotone_pink', style: 'white_clean', fn: 'Anton', fs: 96, track: 0, boxColor: '', glow: false, anim: 'none', layout: 'auto' },
            accent: { target: 'none' },
        },
        {
            id: 'lakban',
            label: 'Lakban',
            textCase: 'keep',
            title: { kinetic: 'lakban', style: 'white_clean', fn: 'Anton', fs: 96, track: 0, boxColor: '', glow: false, anim: 'none', layout: 'auto' },
            accent: { target: 'none' },
        },
        {
            id: 'mask_naik',
            label: 'Mask naik',
            textCase: 'keep',
            title: { kinetic: 'mask_naik', style: 'white_clean', fn: 'Open Sauce Two ExtraBold', fs: 96, track: 0, boxColor: '', glow: false, anim: 'none', layout: 'auto' },
            accent: { target: 'none' },
        },
        {
            id: 'fokus_blur',
            label: 'Fokus blur',
            textCase: 'keep',
            title: { kinetic: 'fokus_blur', style: 'white_clean', fn: "Editor'sNote-Medium", fs: 96, track: 0, boxColor: '', glow: false, anim: 'none', layout: 'auto' },
            accent: { target: 'none' },
        },
        // [HOOK-SUB] Two-part looks (2026-10-12). `sub` fills the small line of
        // the "MAIN | SMALL" text: a fixed label, or 'title' = the clip's own
        // headline, shortened (hook-autoburn.hookTextWithSub).
        {
            id: 'sorotan',
            label: 'Sorotan',
            sub: 'SOROTAN',
            title: { kinetic: 'sorotan', style: 'white_clean', fn: 'Anton', fs: 96, track: 0, boxColor: '', glow: false, anim: 'none', layout: 'auto' },
            accent: { target: 'none' },
        },
        {
            id: 'kertas_sobek',
            label: 'Kertas sobek',
            sub: 'title',
            title: { kinetic: 'kertas_sobek', style: 'white_clean', fn: 'Inter SOCL Black', fs: 96, track: 0, boxColor: '', glow: false, anim: 'none', layout: 'auto' },
            accent: { target: 'none' },
        },
    ];
    const byId = (id) => HOOK_PRESETS.find(p => p.id === id) || null;
    // Returns a NEW title. `text`, `start`, `end`, `x` and `y` are the user's —
    // a preset never moves a title or changes its words.
    function applyHookPreset(preset, title) {
        const p = (typeof preset === 'string') ? byId(preset) : preset;
        const src = title || {};
        if (!p)
            return { ...src };
        const out = { ...src, ...p.title };
        // A plain preset must clear a template left by an earlier kinetic one.
        if (!p.title.kinetic)
            delete out.kinetic;
        if (!p.title.videoFx)
            delete out.videoFx;
        // [HOOK-SHAPE] A preset's line count is a REQUEST, not a rule. Forcing
        // three lines on a four-word hook split it as "TANPA HOOK / NOL /
        // PENONTON" — a one-word middle line, and the box landed on "NOL". Below
        // the preset's own minimum, hand the shaping back to the length-based
        // default, which is tuned for exactly that case.
        if (out.linesMinWords) {
            const wc = String(src.text || '').trim().split(/\s+/).filter(Boolean).length;
            if (wc < out.linesMinWords)
                delete out.lines;
            delete out.linesMinWords;
        }
        const text = String(src.text || '');
        const words = text.trim().split(/\s+/).filter(Boolean);
        if (!words.length) {
            out.tokens = [];
            return out;
        }
        const hit = new Set(targetIndices(text, out.layout, p.accent && p.accent.target, out.lines));
        const a = p.accent || {};
        // [HOOK-PRESET-V2] A preset may set its own base size; accents scale off
        // whatever size the title ends up with.
        const baseFs = +out.fs || +src.fs || TL.TITLE_DEFAULT_FS;
        out.tokens = words.map((w, i) => {
            const style = {};
            // [HOOK-AUTO-ACCENT] With no boxed word, buildAss turns on its OWN accent
            // — hookWordIndices() tints the last two words — and that lands on top of
            // a preset's accent, so a preset colouring one word saw its neighbour go
            // lime as well. Stating every word's colour outright overrides it, so the
            // preset is the only thing choosing colours.
            if (a.baseColor)
                style.color = a.baseColor;
            if (a.italicAll)
                style.i = true;
            if (!hit.has(i)) {
                if (a.baseFn)
                    style.fn = a.baseFn;
                if (a.baseBold != null)
                    style.b = !!a.baseBold;
                if (a.baseScale)
                    style.fs = Math.round(baseFs * a.baseScale);
            }
            if (hit.has(i)) {
                if (a.fn)
                    style.fn = a.fn;
                if (a.b != null)
                    style.b = !!a.b;
                if (a.color)
                    style.color = a.color;
                if (a.italic)
                    style.i = true;
                if (a.box)
                    style.box = true;
                if (a.outline) {
                    style.ol = true;
                    if (a.outlineColor)
                        style.olc = a.outlineColor;
                    // A hollow word must carry NO fill colour, or the base colour the
                    // preset stamps on every other word would fill it in.
                    delete style.color;
                }
                // [TITLE-WORD-GLOW] Only the payoff line lights up. The mockups glow
                // one line, not the whole hook — a title-wide halo washes the opening
                // line out and the accent stops reading as an accent.
                if (a.glow)
                    style.gl = true;
                if (a.scale)
                    style.fs = Math.round(baseFs * a.scale);
            }
            return Object.keys(style).length ? { text: w, style } : { text: w };
        });
        return out;
    }
    const api = { HOOK_PRESETS, applyHookPreset, byId, targetIndices };
    if (typeof module !== 'undefined' && module.exports)
        module.exports = api;
    else
        root.HookPresets = api;
})(typeof self !== 'undefined' ? self : this);
