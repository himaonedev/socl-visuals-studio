// Background FX (dark theme only). Deep black with a few saturated
// lime light sources that drift slowly at the edges; grain and the dark
// glass cards live in styles.css. The glows are painted on a small canvas
// the browser upscales, so a frame costs a few thousand pixels, not a
// full-window repaint.
// Cards under the pointer get a lime spotlight via --fx-x/--fx-y.
// The mode lives on <html data-fx>, toggled by #fxToggle and kept in
// localStorage, the same way ui-theme.js handles data-theme.
(() => {
  const root = document.documentElement;
  const KEY = 'soclUiFx';
  const MODES = ['aurora', 'off'];
  const LABEL = { aurora: 'Aurora', off: 'Polos' };
  const CARD_SEL = '.topbar, .rail, .gallery-section, .preview-card, .inspector, .sbar, .sv-card, .ap-toggle-card, .ps-card, .cap-card, .hook-card';
  const FRAME_MS = 1000 / 12;       // the drift is slow; 12 fps is indistinguishable from 60 here
  const CANVAS_PX = 14;             // on-screen pixels per canvas pixel; fine enough for steep falloffs
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');

  let mode = 'aurora';
  try { const saved = localStorage.getItem(KEY); if (saved === 'off') mode = 'off'; } catch {}

  const LIME = [213, 255, 64];
  const HOT = [236, 255, 140];      // whiter core, so the brightest point reads as light, not paint

  // All light comes from the right and the bottom edge; the left column (the
  // rail) and the middle, where the preview is, stay black. x/y/r are
  // fractions of the canvas (r of its longer side); sx/sy squash a source
  // into an ellipse; dx/dy is the drift amplitude; px/py how far it leans
  // toward the pointer. `ring` sources are hollow — a bright band around a
  // dark centre, like a lit torus.
  const SOURCES = [
    { x: 0.70, y: 1.04, r: 0.55, sx: 1.5, sy: 0.5, a: 0.75, dx: 0.04, dy: 0.01, s: 0.035, p: 0.0, px: 0.04, py: 0.01 }, // horizon along the bottom
    { x: 0.87, y: 1.07, r: 0.30, a: 1.00, dx: 0.03, dy: 0.02, s: 0.050, p: 1.3, px: 0.05, py: 0.02 },                   // hot core, bottom right
    { x: 1.03, y: -0.08, r: 0.30, a: 0.75, dx: 0.03, dy: 0.03, s: 0.045, p: 3.6, px: 0.03, py: 0.03, ring: true },      // arc in the top-right corner
  ];

  let canvas = null, ctx = null, raf = 0, last = 0;
  // Pointer lean, eased toward the target each frame so the light follows
  // the cursor lazily instead of snapping.
  let leanX = 0, leanY = 0, targetX = 0, targetY = 0;
  // Intensity: blooms once when a render finishes.
  let wasBusy = false, bloomAt = -1;

  const isLight = () => root.dataset.theme === 'light';
  const active = () => mode !== 'off' && !isLight();
  const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${Math.min(1, a)})`;
  // `state`, `batchRunning` and `rendersInFlight` are renderer.js top-level
  // bindings, visible here because both are classic scripts. Read-only, and
  // guarded: this file loads first, and a visual effect must never be able to
  // break the app. rendersInFlight covers the Caption Editor's Apply/Preview
  // and crop Apply, which have no flag of their own.
  const busy = () => {
    try {
      return !!((typeof state !== 'undefined' && state.running)
        || (typeof batchRunning !== 'undefined' && batchRunning)
        || (typeof rendersInFlight !== 'undefined' && rendersInFlight > 0));
    } catch { return false; }
  };

  function intensity(t) {
    if (wasBusy) { bloomAt = t; wasBusy = false; }
    let m = 1;
    if (bloomAt >= 0) {
      const k = (t - bloomAt) / 1.8;                // 1.8 s afterglow
      if (k >= 1) bloomAt = -1; else m += 0.7 * (1 - k) * (1 - k);
    }
    return m;
  }

  function ensureCanvas() {
    if (canvas) return;
    canvas = document.createElement('canvas');
    canvas.className = 'fx-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    document.body.prepend(canvas);
    ctx = canvas.getContext('2d');
  }

  function sizeCanvas() {
    const w = Math.max(8, Math.ceil(window.innerWidth / CANVAS_PX));
    const h = Math.max(8, Math.ceil(window.innerHeight / CANVAS_PX));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  }

  function draw(t) {
    const { width: w, height: h } = canvas;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'lighter';
    const unit = Math.max(w, h);
    leanX += (targetX - leanX) * 0.12;
    leanY += (targetY - leanY) * 0.12;
    const m = intensity(t);
    for (const L of SOURCES) {
      const cx = (L.x + Math.sin(t * L.s + L.p) * L.dx + leanX * L.px) * w;
      const cy = (L.y + Math.cos(t * L.s * 0.8 + L.p) * L.dy + leanY * L.py) * h;
      const sx = L.sx || 1, sy = L.sy || 1;
      const r = L.r * unit;
      const a = L.a * m;
      // Draw in a scaled frame so a circular gradient becomes an ellipse.
      ctx.setTransform(sx, 0, 0, sy, cx, cy);
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
      // Steep stops: a hot core, then a quick drop to black. A gentle
      // linear falloff is what made the first version read as murky.
      if (L.ring) {
        g.addColorStop(0.00, rgba(LIME, 0));
        g.addColorStop(0.38, rgba(LIME, 0));
        g.addColorStop(0.55, rgba(HOT, a));
        g.addColorStop(0.68, rgba(LIME, a * 0.45));
        g.addColorStop(1.00, rgba(LIME, 0));
      } else {
        g.addColorStop(0.00, rgba(HOT, a));
        g.addColorStop(0.22, rgba(LIME, a * 0.85));
        g.addColorStop(0.50, rgba(LIME, a * 0.22));
        g.addColorStop(0.78, rgba(LIME, a * 0.04));
        g.addColorStop(1.00, rgba(LIME, 0));
      }
      ctx.fillStyle = g;
      ctx.fillRect(-cx / sx, -cy / sy, w / sx, h / sy);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
  }

  function loop(now) {
    raf = requestAnimationFrame(loop);
    // [FX-FREEZE] Hold still while anything renders. Every repaint of this
    // canvas makes the GPU re-blur each backdrop-filter panel above it, and a
    // render needs that GPU (hardware encode, low-end Windows). An unchanged
    // canvas costs nothing; this callback is all that still runs.
    if (busy()) { wasBusy = true; return; }
    if (now - last < FRAME_MS) return;
    last = now;
    draw(now / 1000);
  }

  function stop() { cancelAnimationFrame(raf); raf = 0; }

  function start() {
    stop();
    if (!active()) return;
    ensureCanvas();
    sizeCanvas();
    draw(performance.now() / 1000);
    if (!document.hidden && !reduceMotion?.matches) raf = requestAnimationFrame(loop);
  }

  function apply() {
    if (mode === 'off') delete root.dataset.fx;
    else root.dataset.fx = mode;
    const btn = document.getElementById('fxToggle');
    if (btn) {
      btn.title = isLight()
        ? 'Efek latar hanya untuk tema gelap'
        : `Efek latar: ${LABEL[mode]} — klik untuk ganti`;
      const label = btn.querySelector('.fx-label');
      if (label) label.textContent = LABEL[mode];
    }
    if (document.body) start();
  }

  apply();

  const setupControls = () => {
    apply();
    document.getElementById('fxToggle')?.addEventListener('click', (e) => {
      mode = mode === 'off' ? 'aurora' : 'off';
      try { localStorage.setItem(KEY, mode); } catch {}
      apply();
      // A mouse click leaves focus here, and the app's own shortcuts (F, Esc,
      // Space) then count as keyboard use and light up the focus ring. Drop
      // focus after a mouse click only; keyboard users keep theirs.
      if (e.detail > 0) e.currentTarget.blur();
    });

    // ui-theme.js flips data-theme on the same element: start or stop with it.
    new MutationObserver(apply).observe(root, { attributes: true, attributeFilter: ['data-theme'] });

    window.addEventListener('resize', () => { if (active() && canvas) { sizeCanvas(); draw(performance.now() / 1000); } });
    document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); else start(); });
    reduceMotion?.addEventListener?.('change', start);

    // Spotlight: one delegated listener, coalesced to one write per frame.
    let pending = null;
    document.addEventListener('pointermove', (e) => {
      if (!active() || busy()) return;   // [FX-FREEZE] the spotlight holds still too
      targetX = e.clientX / window.innerWidth - 0.5;
      targetY = e.clientY / window.innerHeight - 0.5;
      const card = e.target instanceof Element ? e.target.closest(CARD_SEL) : null;
      if (!card) return;
      const first = !pending;
      pending = { card, x: e.clientX, y: e.clientY };
      if (!first) return;
      requestAnimationFrame(() => {
        const { card: el, x, y } = pending; pending = null;
        const r = el.getBoundingClientRect();
        el.style.setProperty('--fx-x', `${Math.round(x - r.left)}px`);
        el.style.setProperty('--fx-y', `${Math.round(y - r.top)}px`);
      });
    }, { passive: true });
  };
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', setupControls, { once: true });
  else setupControls();
})();

