// Generated from frontend/legacy-src/caption-extras-ui.ts by scripts/backend.cjs. Edit the TypeScript source.
(function (root) {
    const defaults = () => ({ motion: 'none', duration: .5, distance: 80, flicker: 'none', flickerDuration: 1, speed: 2, depth: 1,
        mark: { kind: 'none', color: '#f5ed28', thickness: 10, duration: .4, delay: 0, opacity: .65, rotation: 0, words: [] } });
    const field = (label, key, type, value, min, max, step) => `<label>${label}<input data-extra="${key}" type="${type}" value="${value}" ${min == null ? '' : `min="${min}" max="${max}" step="${step}"`}></label>`;
    function html() {
        return `<div class="cap-card ce-extra-panel"><div class="cap-sec">Teks & Motion</div>
      <p class="hint">Style, font, warna, dan box SOCL tetap digunakan. Motion/flicker di sini menggantikan animasi masuk cue; stabilo dan coretan ditambahkan di belakang teks.</p>
      <label>Terapkan ke<select data-extra="scope"><option value="current">Cue aktif</option><option value="selected">Cue yang dipilih di timeline</option><option value="all">Semua cue</option></select></label>
      <label>Motion teks<select data-extra="motion"><option value="none">Ikuti animasi SOCL</option><option value="rise">Apple Smooth Rise</option><option value="scale">Apple Soft Scale</option><option value="left">Masuk dari kiri</option><option value="right">Masuk dari kanan</option><option value="top">Masuk dari atas</option><option value="bottom">Masuk dari bawah</option></select></label>
      <div class="ce-extra-grid">${field('Durasi masuk (s)', 'duration', 'number', .5, .1, 5, .1)}${field('Jarak (px)', 'distance', 'number', 80, 0, 500, 5)}</div>
      <label>Kedap-kedip<select data-extra="flicker"><option value="none">Tidak ada</option><option value="blink">Blink</option><option value="neon">Neon Flicker</option><option value="pulse">Soft Pulse</option></select></label>
      <div class="ce-extra-grid">${field('Durasi flicker (s)', 'flickerDuration', 'number', 1, .2, 3, .1)}${field('Kecepatan', 'speed', 'number', 2, .5, 4, .1)}${field('Kedalaman', 'depth', 'number', 1, 0, 1, .05)}</div>
      <div class="cap-sec">Stabilo & coretan</div>
      <label>Jenis tanda<select data-extra="mark.kind"><option value="none">Tidak ada</option><option value="highlight">Stabilo</option><option value="underline">Garis bawah</option><option value="strike">Coretan tengah</option><option value="scribble">Coretan zigzag</option></select></label>
      <p class="hint">Pilih kata di bawah. Tanpa pilihan berarti semua kata.</p><div data-extra-words class="ce-extra-words"></div>
      <div class="ce-extra-grid">${field('Warna', 'mark.color', 'color', '#f5ed28')}${field('Ketebalan (px)', 'mark.thickness', 'number', 10, 1, 80, 1)}${field('Durasi gambar (s)', 'mark.duration', 'number', .4, .1, 5, .1)}${field('Delay (s)', 'mark.delay', 'number', 0, 0, 5, .1)}${field('Opacity', 'mark.opacity', 'number', .65, 0, 1, .05)}${field('Rotasi tanda (°)', 'mark.rotation', 'number', 0, -180, 180, 1)}</div>
      <div class="ce-extra-actions"><button type="button" data-extra-action="apply">Terapkan</button><button type="button" data-extra-action="copy">Copy Motion</button><button type="button" data-extra-action="paste">Paste Motion</button><button type="button" data-extra-action="clear">Reset tambahan</button></div>
      <div class="cap-sec">Preset tambahan sendiri</div><label>Nama preset<input data-extra-name placeholder="Mis. Stabilo + Smooth Rise"></label><div class="ce-extra-actions"><button type="button" data-extra-action="save">Simpan preset</button><select data-extra-presets><option value="">Pilih preset tambahan…</option></select></div><p role="status" data-extra-status class="hint"></p></div>`;
    }
    let clipboard = null;
    function mount(panel, ctx) {
        if (!panel)
            return;
        let settings = defaults(), lastCue = null, scope = 'current', frame = 0, disposed = false, geometryKey = '', geometry = [];
        const controls = [...panel.querySelectorAll('[data-extra]')], status = panel.querySelector('[data-extra-status]');
        const wordsHost = panel.querySelector('[data-extra-words]'), presets = panel.querySelector('[data-extra-presets]');
        const presetKey = 'socl-caption-motion-presets-v1';
        let saved = {};
        try {
            saved = JSON.parse(localStorage.getItem(presetKey) || '{}');
        }
        catch { }
        if (!saved || Array.isArray(saved) || typeof saved !== 'object')
            saved = {};
        const fillPresets = () => { presets.replaceChildren(new Option('Pilih preset tambahan…', '')); Object.keys(saved).forEach(name => presets.add(new Option(name, name))); };
        fillPresets();
        const activeCue = () => ctx.cues().find(c => ctx.time() >= c.start && ctx.time() < c.end) || ctx.cues()[ctx.activeIndex()] || null;
        function writeControls() {
            controls.forEach(input => { const key = input.dataset.extra; if (key === 'scope')
                return; const [a, b] = key.split('.'); input.value = b ? settings[a][b] : settings[a]; });
        }
        function wordButtons(cue) {
            wordsHost.replaceChildren();
            String(cue?.text || '').split(/\s+/).filter(Boolean).forEach((word, index) => {
                const b = document.createElement('button');
                b.type = 'button';
                b.textContent = word;
                b.classList.toggle('active', settings.mark.words.includes(index));
                b.setAttribute('aria-pressed', String(settings.mark.words.includes(index)));
                b.onclick = () => { settings.mark.words = settings.mark.words.includes(index) ? settings.mark.words.filter(i => i !== index) : [...settings.mark.words, index]; wordButtons(cue); };
                wordsHost.append(b);
            });
        }
        function targets() {
            if (scope === 'all')
                return ctx.cues();
            if (scope === 'selected')
                return [...new Set(ctx.selection().map(i => ctx.cues()[i]).filter(Boolean))];
            const cue = activeCue();
            return cue ? [cue] : [];
        }
        function apply(clear) {
            const cues = targets();
            if (!cues.length) {
                status.textContent = 'Pilih cue pada timeline terlebih dahulu.';
                return;
            }
            cues.forEach(cue => { if (clear)
                delete cue.textMotion;
            else
                cue.textMotion = structuredClone(settings); });
            geometryKey = '';
            ctx.changed();
            Promise.resolve(ctx.persist()).then(() => { status.textContent = `${cues.length} cue diperbarui. Style SOCL tetap digunakan.`; }).catch(e => { status.textContent = 'Pengaturan belum tersimpan: ' + String(e); });
        }
        controls.forEach(input => input.addEventListener('change', () => {
            const key = input.dataset.extra;
            if (key === 'scope') {
                scope = input.value;
                return;
            }
            const value = input.type === 'number' ? Math.max(+input.min, Math.min(+input.max, +input.value)) : input.value;
            const [a, b] = key.split('.');
            if (b)
                settings[a][b] = value;
            else
                settings[a] = value;
        }));
        panel.querySelector('[data-extra-action="apply"]').onclick = () => apply(false);
        panel.querySelector('[data-extra-action="clear"]').onclick = () => { settings = defaults(); writeControls(); wordButtons(activeCue()); apply(true); };
        panel.querySelector('[data-extra-action="copy"]').onclick = () => { clipboard = structuredClone(activeCue()?.textMotion || settings); status.textContent = 'Motion dan tanda disalin.'; };
        panel.querySelector('[data-extra-action="paste"]').onclick = () => { if (!clipboard)
            return; settings = structuredClone(clipboard); writeControls(); wordButtons(activeCue()); apply(false); };
        panel.querySelector('[data-extra-action="save"]').onclick = () => {
            const name = panel.querySelector('[data-extra-name]').value.trim().slice(0, 80);
            if (!name || ['__proto__', 'prototype', 'constructor'].includes(name))
                return;
            saved[name] = structuredClone(settings);
            try {
                localStorage.setItem(presetKey, JSON.stringify(saved));
                fillPresets();
                status.textContent = 'Preset tambahan disimpan; preset Style SOCL tidak berubah.';
            }
            catch (e) {
                status.textContent = 'Preset gagal disimpan: ' + String(e);
            }
        };
        presets.onchange = () => { if (!Object.prototype.hasOwnProperty.call(saved, presets.value))
            return; settings = { ...defaults(), ...structuredClone(saved[presets.value]), mark: { ...defaults().mark, ...saved[presets.value].mark } }; writeControls(); wordButtons(activeCue()); };
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 1080 1920');
        svg.setAttribute('preserveAspectRatio', 'none');
        Object.assign(svg.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', pointerEvents: 'none', zIndex: '0' });
        ctx.stage.append(svg);
        ctx.overlay.style.zIndex = '1';
        function preview() {
            if (disposed || !panel.isConnected) {
                dispose();
                return;
            }
            const cue = activeCue(), t = ctx.time();
            if (cue !== lastCue) {
                lastCue = cue;
                settings = { ...defaults(), ...structuredClone(cue?.textMotion || {}), mark: { ...defaults().mark, ...structuredClone(cue?.textMotion?.mark || {}) } };
                writeControls();
                wordButtons(cue);
                geometryKey = '';
            }
            const s = cue?.textMotion;
            const visible = cue && t >= cue.start && t < cue.end && !ctx.hidden();
            const v = visible ? root.CaptionExtras.sample(s, t - cue.start) : { x: 0, y: 0, scale: 1, opacity: 1 };
            const scale = ctx.stage.getBoundingClientRect().height / 1920;
            ctx.overlay.style.transform = `translateX(-50%) translate(${v.x * scale}px,${v.y * scale}px) scale(${v.scale})`;
            ctx.overlay.style.opacity = String(v.opacity);
            svg.replaceChildren();
            if (visible && s?.mark && s.mark.kind !== 'none') {
                const key = JSON.stringify([cue, s, ctx.signature()]);
                if (key !== geometryKey) {
                    geometry = ctx.capture(cue);
                    geometryKey = key;
                }
                const m = s.mark, reveal = Math.max(0, Math.min(1, (t - cue.start - (+m.delay || 0)) / (+m.duration || .4)));
                geometry.filter(r => !m.words?.length || m.words.includes(r.word)).forEach(r => {
                    const h = m.kind === 'highlight' ? r.height * Math.max(.05, Math.min(2, (+m.thickness || 10) / 20)) : +m.thickness || 10;
                    const y = r.y + (m.kind === 'highlight' ? (r.height - h) / 2 : m.kind === 'underline' ? r.height : r.height * .5);
                    const rect = document.createElementNS(svg.namespaceURI, m.kind === 'scribble' ? 'polyline' : 'rect');
                    const w = r.width * reveal;
                    if (m.kind === 'scribble') {
                        rect.setAttribute('points', `0,${h / 2} ${w * .2},0 ${w * .4},${h} ${w * .6},0 ${w * .8},${h} ${w},${h / 2}`);
                        rect.setAttribute('fill', 'none');
                        rect.setAttribute('stroke', m.color);
                        rect.setAttribute('stroke-width', String(h / 3));
                    }
                    else {
                        rect.setAttribute('width', String(w));
                        rect.setAttribute('height', String(h));
                        rect.setAttribute('fill', m.color);
                    }
                    rect.setAttribute('transform', `translate(${r.x + v.x},${y + v.y}) rotate(${+m.rotation || 0})`);
                    rect.setAttribute('opacity', String((m.opacity ?? .65) * v.opacity));
                    svg.append(rect);
                });
            }
            frame = requestAnimationFrame(preview);
        }
        function dispose() { if (disposed)
            return; disposed = true; cancelAnimationFrame(frame); svg.remove(); ctx.overlay.style.opacity = ''; ctx.overlay.style.transform = 'translateX(-50%)'; }
        frame = requestAnimationFrame(preview);
        return dispose;
    }
    root.CaptionExtrasUI = { html, mount };
})(window);
