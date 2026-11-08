// Generated from backend/src/preset-catalog.ts by scripts/backend.cjs. Edit the TypeScript source.
'use strict';
// [PRESET-CATALOG] Presets delivered from Cloudflare, so new looks reach users
// without a release. DATA ONLY — hook presets, "Gaya kata" caption specs and
// video-effect colours. Templates that are CODE (riot, stiker pop, …) stay in
// the app on purpose: nothing fetched is ever executed.
//
//   validateCatalog(obj)  Node only (main process + publish script): strict
//                         schema, fonts must resolve in the bundled fonts,
//                         unknown keys rejected. Returns { ok, catalog, errors }.
//   applyCatalog(cat, { HookPresets, KineticTitle, VideoFx })
//                         Shared (main + renderer): ADDS entries; an id that
//                         already exists (built-in or earlier) is never replaced.
//   verifySigned(envelope, publicKeyPem)  Node only: Ed25519 over the exact
//                         payload string.
(function (root) {
    const HEX = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;
    const ID = /^[a-z][a-z0-9_]{2,40}$/;
    const isNum = (v, a, b) => typeof v === 'number' && Number.isFinite(v) && v >= a && v <= b;
    const isStr = (v, max = 60) => typeof v === 'string' && v.length > 0 && v.length <= max;
    const TITLE_STYLES = ['inverse_auto', 'white_clean', 'bw', 'cinematic_white', 'neon_green', 'neon_pink', 'yellow'];
    const ANIMS = ['none', 'pop', 'fade', 'rise', 'drop', 'zoom', 'blur', 'slam', 'type'];
    const LAYOUTS = ['auto', 'single', 'pyramid', 'rhombus'];
    const TARGETS = ['none', 'all', 'last', 'lastLine', 'first', 'firstLine', 'longest'];
    function checker(fontExists) {
        const errors = [];
        const err = (path, msg) => errors.push(`${path}: ${msg}`);
        const only = (obj, path, keys) => { for (const k of Object.keys(obj || {}))
            if (!keys.includes(k))
                err(`${path}.${k}`, 'unknown field'); };
        const font = (v, path) => { if (!isStr(v) || !fontExists(v))
            err(path, `font "${v}" is not bundled`); };
        const color = (v, path) => { if (!HEX.test(String(v)))
            err(path, 'colour must be #rrggbb'); };
        function hookPreset(p, i) {
            const at = `hookPresets[${i}]`;
            if (!p || typeof p !== 'object')
                return err(at, 'not an object');
            only(p, at, ['id', 'label', 'textCase', 'title', 'accent']);
            if (!ID.test(p.id || ''))
                err(`${at}.id`, 'bad id');
            if (!isStr(p.label, 30))
                err(`${at}.label`, 'bad label');
            if (p.textCase != null && !['upper', 'keep', 'lower'].includes(p.textCase))
                err(`${at}.textCase`, 'bad');
            const t = p.title || {};
            only(t, `${at}.title`, ['style', 'fn', 'fs', 'track', 'boxColor', 'glow', 'glowColor', 'anim', 'layout', 'lines', 'linesMinWords', 'backdrop', 'backdropColor', 'backdropOpacity']);
            if (!TITLE_STYLES.includes(t.style))
                err(`${at}.title.style`, 'unknown style');
            font(t.fn, `${at}.title.fn`);
            if (t.fs != null && !isNum(t.fs, 40, 200))
                err(`${at}.title.fs`, '40..200');
            if (t.track != null && !isNum(t.track, -0.2, 0.4))
                err(`${at}.title.track`, '-0.2..0.4');
            if (t.boxColor)
                color(t.boxColor, `${at}.title.boxColor`);
            if (t.glow != null && typeof t.glow !== 'boolean')
                err(`${at}.title.glow`, 'boolean');
            if (t.glowColor)
                color(t.glowColor, `${at}.title.glowColor`);
            if (!ANIMS.includes(t.anim))
                err(`${at}.title.anim`, 'unknown anim');
            if (!LAYOUTS.includes(t.layout))
                err(`${at}.title.layout`, 'unknown layout');
            if (t.lines != null && !isNum(t.lines, 1, 4))
                err(`${at}.title.lines`, '1..4');
            if (t.linesMinWords != null && !isNum(t.linesMinWords, 1, 12))
                err(`${at}.title.linesMinWords`, '1..12');
            if (t.backdrop != null && !['card', 'gradient'].includes(t.backdrop))
                err(`${at}.title.backdrop`, 'card|gradient');
            if (t.backdropColor)
                color(t.backdropColor, `${at}.title.backdropColor`);
            if (t.backdropOpacity != null && !isNum(t.backdropOpacity, 0, 1))
                err(`${at}.title.backdropOpacity`, '0..1');
            const a = p.accent || {};
            only(a, `${at}.accent`, ['target', 'color', 'baseColor', 'box', 'b', 'italic', 'italicAll', 'fn', 'baseFn', 'baseScale', 'baseBold', 'fs']);
            if (a.target != null && !TARGETS.includes(a.target))
                err(`${at}.accent.target`, 'unknown target');
            for (const k of ['color', 'baseColor'])
                if (a[k])
                    color(a[k], `${at}.accent.${k}`);
            for (const k of ['fn', 'baseFn'])
                if (a[k])
                    font(a[k], `${at}.accent.${k}`);
            for (const k of ['box', 'b', 'italic', 'italicAll', 'baseBold'])
                if (a[k] != null && typeof a[k] !== 'boolean')
                    err(`${at}.accent.${k}`, 'boolean');
            if (a.baseScale != null && !isNum(a.baseScale, 0.3, 1.5))
                err(`${at}.accent.baseScale`, '0.3..1.5');
            if (a.fs != null && !isNum(a.fs, 40, 240))
                err(`${at}.accent.fs`, '40..240');
        }
        function ccTemplate(c, i) {
            const at = `captionTemplates[${i}]`;
            if (!c || typeof c !== 'object')
                return err(at, 'not an object');
            only(c, at, ['id', 'label', 'spec']);
            if (!/^cc_[a-z0-9_]{2,40}$/.test(c.id || ''))
                err(`${at}.id`, 'must start with cc_');
            if (!isStr(c.label, 30))
                err(`${at}.label`, 'bad label');
            const s = c.spec || {};
            only(s, `${at}.spec`, ['font', 'px', 'case', 'color', 'next', 'past', 'nextA', 'pastA', 'current', 'stroke', 'shadow', 'glow', 'maxRows', 'wordsPerRow', 'gapY', 'gapX', 'lh', 'align', 'maxW', 'maxH', 'track', 'rowBox', 'pageBox', 'wordBox', 'pad', 'rot', 'reveal', 'flicker', 'blur', 'scaleX', 'fill']);
            font(s.font, `${at}.spec.font`);
            if (!isNum(s.px, 30, 220))
                err(`${at}.spec.px`, '30..220');
            color(s.color, `${at}.spec.color`);
            for (const k of ['next', 'past', 'glow'])
                if (s[k] != null)
                    color(s[k], `${at}.spec.${k}`);
            for (const k of ['nextA', 'pastA'])
                if (s[k] != null && !isNum(s[k], 0, 1))
                    err(`${at}.spec.${k}`, '0..1');
            if (s.case != null && !['upper', 'lower', 'keep'].includes(s.case))
                err(`${at}.spec.case`, 'upper|lower|keep');
            if (s.reveal != null && !['build', 'type', 'single'].includes(s.reveal))
                err(`${at}.spec.reveal`, 'build|type|single');
            if (s.align != null && s.align !== 'left')
                err(`${at}.spec.align`, 'left only');
            const nums = { maxRows: [1, 6], wordsPerRow: [1, 8], gapY: [0, 1], gapX: [0, 40], lh: [0.8, 1.8], maxW: [300, 1000], maxH: [100, 900], track: [-2, 6], rot: [-15, 15], blur: [0, 4], scaleX: [60, 140] };
            for (const [k, [a, b]] of Object.entries(nums))
                if (s[k] != null && !isNum(s[k], a, b))
                    err(`${at}.spec.${k}`, `${a}..${b}`);
            for (const k of ['flicker', 'fill'])
                if (s[k] != null && typeof s[k] !== 'boolean')
                    err(`${at}.spec.${k}`, 'boolean');
            for (const k of ['stroke', 'shadow'])
                if (s[k] != null) {
                    if (!Array.isArray(s[k]) || s[k].length !== 2 || !isNum(s[k][0], 0, 20))
                        err(`${at}.spec.${k}`, '[width 0..20, #colour]');
                    else
                        color(s[k][1], `${at}.spec.${k}[1]`);
                }
            if (s.pad != null && !(Array.isArray(s.pad) && s.pad.length === 2 && s.pad.every((v) => isNum(v, 0, 1.5))))
                err(`${at}.spec.pad`, '[y, x] 0..1.5');
            const box = (b, path, keys) => {
                if (b == null)
                    return;
                only(b, path, keys);
                const cols = Array.isArray(b.color) ? b.color : [b.color];
                if (!cols.length || cols.length > 4)
                    err(`${path}.color`, '1..4 colours');
                cols.forEach((v, j) => color(v, `${path}.color[${j}]`));
                if (b.radius != null && !isNum(b.radius, 0, 1))
                    err(`${path}.radius`, '0..1');
                for (const k of ['bubble', 'pop'])
                    if (b[k] != null && typeof b[k] !== 'boolean')
                        err(`${path}.${k}`, 'boolean');
                if (b.alpha != null && !isNum(b.alpha, 0, 1))
                    err(`${path}.alpha`, '0..1');
            };
            box(s.rowBox, `${at}.spec.rowBox`, ['color', 'radius']);
            box(s.pageBox, `${at}.spec.pageBox`, ['color', 'radius', 'bubble', 'pop', 'alpha']);
            box(s.wordBox, `${at}.spec.wordBox`, ['color', 'radius']);
            if (s.current != null) {
                const c2 = s.current;
                only(c2, `${at}.spec.current`, ['color', 'glow', 'pop', 'scale', 'stay', 'box']);
                if (c2.color)
                    color(c2.color, `${at}.spec.current.color`);
                if (c2.glow)
                    color(c2.glow, `${at}.spec.current.glow`);
                if (c2.pop != null && !isNum(c2.pop, 0, 200))
                    err(`${at}.spec.current.pop`, '0..200');
                if (c2.scale != null && !isNum(c2.scale, 80, 140))
                    err(`${at}.spec.current.scale`, '80..140');
                if (c2.stay != null && typeof c2.stay !== 'boolean')
                    err(`${at}.spec.current.stay`, 'boolean');
                box(c2.box, `${at}.spec.current.box`, ['color', 'radius']);
            }
        }
        function videoFx(f, i) {
            const at = `videoFx[${i}]`;
            if (!f || typeof f !== 'object')
                return err(at, 'not an object');
            only(f, at, ['id', 'label', 'kind', 'color']);
            if (!/^(cut|duo)_[a-z0-9_]{2,30}$/.test(f.id || ''))
                err(`${at}.id`, 'must start with cut_ or duo_');
            if (!isStr(f.label, 30))
                err(`${at}.label`, 'bad label');
            if (!['cutout', 'duotone'].includes(f.kind))
                err(`${at}.kind`, 'cutout|duotone');
            if (f.id && f.kind && f.id.startsWith('cut_') !== (f.kind === 'cutout'))
                err(`${at}.id`, 'prefix must match kind');
            color(f.color, `${at}.color`);
        }
        return { errors, hookPreset, ccTemplate, videoFx };
    }
    function validateCatalog(obj, { fontExists } = {}) {
        const fe = fontExists || (() => true);
        const c = checker(fe);
        if (!obj || typeof obj !== 'object')
            return { ok: false, errors: ['not an object'] };
        for (const k of Object.keys(obj))
            if (!['version', 'hookPresets', 'captionTemplates', 'videoFx'].includes(k))
                c.errors.push(`${k}: unknown section`);
        if (!Number.isInteger(obj.version) || obj.version < 1)
            c.errors.push('version: positive integer required');
        const lists = { hookPresets: c.hookPreset, captionTemplates: c.ccTemplate, videoFx: c.videoFx };
        for (const [k, fn] of Object.entries(lists)) {
            if (obj[k] == null)
                continue;
            if (!Array.isArray(obj[k]) || obj[k].length > 60) {
                c.errors.push(`${k}: array of at most 60`);
                continue;
            }
            obj[k].forEach(fn);
            const ids = obj[k].map((x) => x && x.id);
            if (new Set(ids).size !== ids.length)
                c.errors.push(`${k}: duplicate id`);
        }
        return { ok: c.errors.length === 0, errors: c.errors, catalog: c.errors.length ? null : obj };
    }
    // Adds catalog entries to the live registries. Built-ins always win.
    function applyCatalog(cat, { HookPresets, KineticTitle, VideoFx } = {}) {
        const added = { hookPresets: 0, captionTemplates: 0, videoFx: 0 };
        if (!cat)
            return added;
        if (HookPresets && Array.isArray(cat.hookPresets)) {
            for (const p of cat.hookPresets) {
                if (HookPresets.byId(p.id))
                    continue;
                HookPresets.HOOK_PRESETS.push(Object.assign({ remote: true }, JSON.parse(JSON.stringify(p))));
                added.hookPresets++;
            }
        }
        if (KineticTitle && Array.isArray(cat.captionTemplates) && KineticTitle.registerCaptionTemplate) {
            for (const c of cat.captionTemplates)
                if (KineticTitle.registerCaptionTemplate(c.id, c.label, JSON.parse(JSON.stringify(c.spec))))
                    added.captionTemplates++;
        }
        if (VideoFx && Array.isArray(cat.videoFx) && VideoFx.register) {
            for (const f of cat.videoFx)
                if (VideoFx.register(f))
                    added.videoFx++;
        }
        return added;
    }
    // Ed25519 over the exact payload string ({ payload: "<json>", sig: "<base64>" }).
    function verifySigned(envelope, publicKeyPem) {
        if (!envelope || typeof envelope.payload !== 'string' || typeof envelope.sig !== 'string')
            return null;
        try {
            const crypto = require('crypto');
            const ok = crypto.verify(null, Buffer.from(envelope.payload, 'utf8'), crypto.createPublicKey(publicKeyPem), Buffer.from(envelope.sig, 'base64'));
            return ok ? JSON.parse(envelope.payload) : null;
        }
        catch {
            return null;
        }
    }
    const api = { validateCatalog, applyCatalog, verifySigned };
    if (typeof module !== 'undefined' && module.exports)
        module.exports = api;
    else
        root.PresetCatalog = api;
})(typeof window !== 'undefined' ? window : globalThis);
