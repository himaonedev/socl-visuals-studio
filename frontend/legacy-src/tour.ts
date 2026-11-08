/* ── Tutorial tour ──────────────────────────────────────────────────────
   Spotlight walkthrough of the dashboard, shown once on first launch and
   replayable from Settings. Self-contained: the only hook into the rest of
   the renderer is the `load` listener at the bottom of this file, so a bug
   in here can never take the app down with it (every entry point is wrapped).

   The tour runs BEFORE the first pipeline run, so several things it explains
   (Render all, the clip grid) do not exist on screen yet. Every step still
   gets shown: a step falls back to `alt` selectors — the region the button
   will appear in — and, failing that, renders as a plain centered card with
   no spotlight. Explaining a button that is not there yet is the whole point
   of a tutorial; silently dropping the step is not.

   [TOUR-CLIPS] Every step also plays a short looping clip of the action it
   describes (assets/tour/<media>.webm, ~150 KB each, silent). The clips are
   authored outside this repo as HyperFrames compositions — see
   assets/tour/README.md. The media box has a fixed aspect ratio, so the card
   height is known before the video loads and reposition() never measures a
   card that is about to grow. A missing or broken clip only hides the box;
   the step itself still shows. */
(function () {
  'use strict';

  /* [TOUR-AUTOOPEN] v2: the video tour is new, and `v1` has been set since
     August on nearly every install — userData survives an uninstall on both
     platforms, so even a reinstall carried it. Bumping the key shows the tour
     once on the first launch of this version, then never again. */
  const FLAG = 'socl.tour.v2';
  const MEDIA_DIR = '../assets/tour/';

  /* Every step is one entry here — adding or reordering the tour means
     touching this array and nothing else. `place` is a preference; the card
     flips to the opposite side when it would fall off-screen. */
  const STEPS = [
    {
      sel: '.top-actions',
      media: '01-sumber',
      title: 'Mulai dari sumber video',
      body: 'Tempel link YouTube / TikTok / Reels di kolom ini, atau klik <b>Import</b> untuk memakai file video yang sudah ada di komputermu.',
      place: 'bottom',
    },
    {
      // [TOUR-CLIPS] The burned caption look is picked once, before the run —
      // every clip the pipeline cuts is rendered with it.
      sel: '#f_styleStart',
      alt: ['#panelBody', '.rail-btn[data-panel="clip"]'],
      media: '02-gaya-caption',
      title: 'Atur gaya caption dulu',
      body: 'Sebelum <b>Run pipeline</b>, pilih font, gaya (Plain white, Glow, Subtract) dan Box highlight di sini. Semua klip langsung dirender dengan gaya ini.',
      place: 'left',
    },
    {
      // [TOUR-CLIPS] Clip count, duration, format and face tracking are
      // decided before the run too — the pipeline cuts with these values.
      sel: '#f_clipCountField',
      alt: ['#panelBody', '.rail-btn[data-panel="clip"]'],
      media: '03-atur-klip',
      title: 'Atur jumlah, durasi & format klip',
      body: 'Masih di panel ini, sebelum <b>Run pipeline</b>: tentukan jumlah klip, durasi, format (Face 9:16, Blur BG, Square, Landscape), dan nyalakan Smart Face Tracking supaya wajah pembicara selalu di tengah bingkai.',
      place: 'left',
    },
    {
      sel: '#runPipeline',
      media: '04-pipeline',
      title: 'Jalankan pipeline',
      body: 'Satu tombol untuk semuanya: unduh source, buat transkrip, cari momen menarik, lalu potong jadi beberapa klip pendek otomatis.',
      place: 'bottom',
    },
    {
      sel: '.gallery-section',
      media: '05-galeri',
      title: 'Klip hasilnya muncul di sini',
      body: 'Sekarang masih kosong. Setelah pipeline selesai, tiap potongan klip tampil sebagai kartu di area ini — klik salah satu untuk mulai mengeditnya.',
      place: 'top',
    },
    {
      sel: '#openEditorBtn',
      media: '06-caption-editor',
      title: 'Caption Editor',
      body: 'Rapikan subtitle per kata: font, warna, ukuran, bold/italic, dan posisi. Yang kamu lihat di preview itulah yang akan dibakar ke video.',
      place: 'right',
    },
    {
      sel: '.rail-btn[data-panel="crop"]',
      media: '07-crop',
      title: 'Crop & framing',
      body: 'Crop Studio: geser bingkai 9:16 dan kunci dengan keyframe, atau biarkan smart face tracking mengikuti wajah. Untuk konten gaming, Split Screen menumpuk facecam di atas gameplay.',
      place: 'right',
    },
    {
      sel: '.rail-btn[data-panel="watermark"]',
      media: '08-watermark',
      title: 'Watermark',
      body: 'Pasang logo atau teks brand-mu sebagai overlay di semua klip — atur posisi, ukuran, dan transparansinya sekali, berlaku ke semuanya.',
      place: 'right',
    },
    {
      sel: '.rail-btn[data-panel="history"]',
      media: '09-history',
      title: 'History',
      body: 'Semua sesi dan klip yang pernah di-render tersimpan di sini. Buka lagi kapan pun untuk re-edit atau render ulang tanpa mengulang pipeline.',
      place: 'right',
    },
    {
      sel: '#reviewAllBtn',
      alt: ['.gtl-tools', '.gallery-section'],
      media: '10-judul-hook',
      title: 'Judul, hook & deskripsi',
      body: 'Buka daftar semua klip untuk mengedit judul, hook, dan deskripsi sekaligus — lengkap dengan tombol regenerate AI.',
      place: 'bottom',
    },
    {
      sel: '.rail-btn[data-panel="settings"]',
      media: '11-settings',
      title: 'Settings',
      body: 'API key AI, cookies YouTube, folder export, dan status lisensi. Tour ini juga bisa kamu putar ulang dari sini.',
      place: 'right',
    },
    {
      sel: '#gb_renderAll',
      alt: ['#statusBar'],
      media: '12-render-all',
      title: 'Render hasilnya',
      body: 'Begitu ada klip terdeteksi, tombol <b>Render all</b> muncul di baris status ini untuk merender semua klip sekaligus.',
      place: 'top',
    },
    {
      sel: '#openOutputBtn',
      media: '13-output',
      title: 'Folder output',
      body: 'Semua hasil render tersimpan rapi per sesi. Klik tombol ini untuk langsung membuka foldernya — atur lokasi default-nya di Settings.',
      place: 'right',
    },
  ];

  let root = null;      // overlay element while a tour is running
  let idx = 0;
  let steps = [];       // resolved {el, step} pairs for this run
  let onKey = null;

  const visible = (el) =>
    !!el && !el.hidden && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);

  /* A modal already owning the screen (bundle download, history gallery,
     crop studio…) means this is not a good moment to start talking. */
  function screenBusy() {
    return ['#settingsView', '.hg-overlay', '.crop-studio', '.caption-studio', '.modal', '.bundle-modal']
      .some((s) => Array.from(document.querySelectorAll(s)).some(visible));
  }

  /* Never drops a step. `el` is null when nothing on screen can be
     spotlighted — render() shows that step as a centered card instead. */
  function resolve() {
    return STEPS.map((step) => {
      const el = [step.sel].concat(step.alt || [])
        .map((s) => document.querySelector(s))
        .find(visible) || null;
      return { step, el };
    });
  }

  function stop(markSeen) {
    if (markSeen) { try { localStorage.setItem(FLAG, '1'); } catch (_) {} }
    if (onKey) { window.removeEventListener('keydown', onKey, true); onKey = null; }
    window.removeEventListener('resize', reposition);
    if (root) {
      const v = root.querySelector('.tour-media video');
      if (v) { v.pause(); v.removeAttribute('src'); v.load(); }
      root.remove(); root = null;
    }
    steps = [];
  }

  function go(n) {
    if (n < 0 || n >= steps.length) { stop(true); return; }
    idx = n;
    render();
  }

  function render() {
    const { el, step } = steps[idx];
    if (el) el.scrollIntoView({ block: 'center', behavior: 'auto' });

    root.querySelector('.tour-num').textContent = `${idx + 1} / ${steps.length}`;
    root.querySelector('.tour-title').innerHTML = step.title;
    root.querySelector('.tour-body').innerHTML = step.body;
    root.querySelector('.tour-back').hidden = idx === 0;
    root.querySelector('.tour-next').textContent = idx === steps.length - 1 ? 'Selesai' : 'Lanjut →';
    showMedia(step.media);

    reposition();
  }

  /* Swap the card's clip. Reduced-motion viewers get a still frame from the
     middle of the clip instead of a loop (frame 0 is a deliberate blank, the
     clips fade in so their loop point is invisible). */
  function showMedia(name) {
    const box = root.querySelector('.tour-media');
    const v = box.querySelector('video');
    const card = root.querySelector('.tour-card');
    box.hidden = !name;
    card.classList.toggle('has-media', !!name);
    if (!name) { v.pause(); v.removeAttribute('src'); return; }
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    v.src = MEDIA_DIR + name + '.webm';
    if (reduce) {
      v.addEventListener('loadedmetadata', () => { v.currentTime = v.duration * 0.6; }, { once: true });
    } else {
      const p = v.play();
      if (p && p.catch) p.catch(() => {});
    }
  }

  /* The dark screen is a single box-shadow spread from the hole, so there is
     exactly one element to keep in sync with the target's rect. */
  function reposition() {
    if (!root || !steps[idx]) return;
    const hole = root.querySelector('.tour-hole');
    const card = root.querySelector('.tour-card');

    // No anchor on screen yet (e.g. Render all before the first run): dim the
    // whole screen and centre the card, so the step still gets explained.
    root.classList.toggle('tour-noanchor', !steps[idx].el);
    if (!steps[idx].el) {
      // The dim normally comes from the hole's huge spread shadow, so with no
      // hole the root has to supply it itself.
      hole.hidden = true;
      card.style.left = `${(innerWidth - card.offsetWidth) / 2}px`;
      card.style.top = `${(innerHeight - card.offsetHeight) / 2}px`;
      return;
    }
    hole.hidden = false;

    const r = steps[idx].el.getBoundingClientRect();
    const pad = 6;
    hole.style.left = `${r.left - pad}px`;
    hole.style.top = `${r.top - pad}px`;
    hole.style.width = `${r.width + pad * 2}px`;
    hole.style.height = `${r.height + pad * 2}px`;

    const cw = card.offsetWidth, ch = card.offsetHeight, gap = 14;
    let place = steps[idx].step.place || 'bottom';

    // Flip to the opposite side when the preferred one has no room.
    if (place === 'bottom' && r.bottom + gap + ch > innerHeight) place = 'top';
    else if (place === 'top' && r.top - gap - ch < 0) place = 'bottom';
    else if (place === 'right' && r.right + gap + cw > innerWidth) place = 'left';
    else if (place === 'left' && r.left - gap - cw < 0) place = 'right';

    let x, y;
    if (place === 'bottom') { x = r.left + r.width / 2 - cw / 2; y = r.bottom + gap; }
    else if (place === 'top') { x = r.left + r.width / 2 - cw / 2; y = r.top - gap - ch; }
    else if (place === 'right') { x = r.right + gap; y = r.top + r.height / 2 - ch / 2; }
    else { x = r.left - gap - cw; y = r.top + r.height / 2 - ch / 2; }

    card.style.left = `${Math.max(12, Math.min(x, innerWidth - cw - 12))}px`;
    card.style.top = `${Math.max(12, Math.min(y, innerHeight - ch - 12))}px`;
  }

  function build() {
    root = document.createElement('div');
    root.className = 'tour-root';
    root.innerHTML = `
      <div class="tour-hole"></div>
      <div class="tour-card glass">
        <div class="tour-head">
          <span class="tour-eyebrow">TUTORIAL</span>
          <span class="tour-num"></span>
        </div>
        <div class="tour-media" hidden><video muted loop playsinline preload="auto"></video></div>
        <b class="tour-title"></b>
        <p class="tour-body"></p>
        <div class="tour-actions">
          <button class="tour-skip">Lewati</button>
          <span class="tour-spacer"></span>
          <button class="tour-back">← Kembali</button>
          <button class="tour-next">Lanjut →</button>
        </div>
      </div>`;
    document.body.appendChild(root);

    const media = root.querySelector('.tour-media');
    media.querySelector('video').addEventListener('error', () => {
      media.hidden = true;
      root.querySelector('.tour-card').classList.remove('has-media');
      reposition();
    });
    root.querySelector('.tour-next').onclick = () => go(idx + 1);
    root.querySelector('.tour-back').onclick = () => go(idx - 1);
    root.querySelector('.tour-skip').onclick = () => stop(true);
    // Click anywhere on the dimmed area (but not the card) dismisses.
    root.onclick = (e) => { if (e.target === root || e.target.classList.contains('tour-hole')) stop(true); };

    onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); stop(true); }
      else if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); go(idx + 1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); go(idx - 1); }
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', reposition);
  }

  function startTour() {
    try {
      if (root) return;                 // already running
      steps = resolve();
      if (!steps.length) return;        // nothing to point at — stay quiet
      idx = 0;
      build();
      render();
    } catch (err) {
      try { stop(false); } catch (_) {}
      try { window.logLine && window.logLine(`⚠ Tutorial tour gagal dibuka: ${err.message}`); } catch (_) {}
    }
  }

  function maybeStartTour() {
    try {
      if (localStorage.getItem(FLAG)) return;
      if (screenBusy()) return;
      startTour();
    } catch (err) {
      try { window.logLine && window.logLine(`⚠ Tutorial tour gagal dibuka: ${err.message}`); } catch (_) {}
    }
  }

  window.SoclTour = { start: startTour, maybeStart: maybeStartTour, reset: () => { try { localStorage.removeItem(FLAG); } catch (_) {} } };

  /* Boot once, whichever signal arrives first. Relying on `load` alone was
     measured to silently never fire on a reload (readyState was already
     'complete' with the tour never built), so all three paths are wired and
     the flag makes sure only one of them wins. */
  let booted = false;
  const boot = () => {
    if (booted) return;
    booted = true;
    /* Replay button lives in Settings, whose overlay covers every tour target
       — close it through the existing Close handler so the rail state stays
       consistent, then start once the dashboard is back on screen. */
    const replay = document.getElementById('sv_replayTour');
    if (replay) {
      replay.addEventListener('click', () => {
        const close = document.getElementById('svClose');
        if (close) close.click();
        setTimeout(startTour, 120);
      });
    }
    /* Plain timer, deliberately not requestAnimationFrame: rAF callbacks are
       frozen while the window is hidden or occluded — which is exactly the
       state this app is in behind its splash screen — so the tour would never
       arm itself and the whole feature would silently no-op. Measured. */
    setTimeout(armAutoStart, 400);
  };

  /* [TOUR-AUTOOPEN] One attempt at boot used to give up for good when
     anything else owned the screen at that moment (Settings, History, a
     modal), so that first launch passed with no tour at all. Keep checking
     until the screen is free; the flag ends it once the tour has been seen. */
  const ARM_EVERY_MS = 1000;
  const ARM_FOR_MS = 10 * 60 * 1000;
  function armAutoStart() {
    const until = Date.now() + ARM_FOR_MS;
    // Only "busy" re-arms: a start that throws logs once instead of every second.
    const tick = () => {
      try {
        if (root || localStorage.getItem(FLAG)) return;
        if (screenBusy()) { if (Date.now() < until) setTimeout(tick, ARM_EVERY_MS); return; }
      } catch (_) { return; }
      maybeStartTour();
    };
    tick();
  }

  window.addEventListener('load', boot);
  document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 300));
  if (document.readyState === 'complete') setTimeout(boot, 0);
})();
