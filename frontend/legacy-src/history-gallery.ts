// Pure helpers untuk History Clip Gallery.
// Dual-mode: dipakai sebagai global window.HistoryGallery di renderer (tanpa require),
// dan di-require oleh node --test.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.HistoryGallery = api;
})(typeof window !== 'undefined' ? window : null, function () {
  // [HISTORY-REUSE] Path-layout helpers. The pipeline writes the clean cut to
  // <session>/raw/<name> and, when captions are burned, the deliverable to the
  // sibling <session>/burn-edited/<name> — same basename in both. That makes
  // "does this file already have captions in it?" answerable from the path
  // alone, which is how reports predating the subsBurned/rawFile fields are
  // recovered. Both separators are accepted: reports are portable across OSes.
  // [TIDY-SESSION] subtitle/ is the new name of burn-edited/. Anchored to the
  // file's OWN folder: an output folder that happens to be called "subtitle"
  // must not mark every clip under it as burned.
  const BURNED_DIR_RE = /[\\/](?:burn-edited|subtitle)[\\/](?=[^\\/]+$)/;
  function isBurnedPath(file) {
    return BURNED_DIR_RE.test(String(file || ''));
  }
  // Clean plate for a burned deliverable = the raw/ sibling. A file that is
  // not in burn-edited/ is already clean and is its own plate.
  function cleanPlateFor(file) {
    const f = String(file || '');
    if (!f) return null;
    return isBurnedPath(f) ? f.replace(BURNED_DIR_RE, m => m[0] + 'raw' + m[m.length - 1]) : f;
  }

  // Ratasan: [{jobId,dir,report}, ...] (terbaru dulu) → [klip diperkaya, ...]
  function flattenHistory(sessions) {
    const out = [];
    for (const s of sessions || []) {
      const r = s && s.report;
      const clips = r && Array.isArray(r.clips) ? r.clips : null;
      if (!clips || !clips.length) continue;
      const sessionTitle = (r.ytInfo && r.ytInfo.title) || r.source || s.jobId;
      // [HISTORY-REUSE] Older reports didn't persist per-clip srcVideo — back-
      // fill from the report's top-level inputPath so re-edit / crop studio has
      // a master source. Without this, openCropStudio falls back to clip.file
      // (already-cropped) and every subsequent crop stacks on stale pixels.
      const fallbackSrc = r.inputPath || null;
      const enrichedClips = clips.map(cl => ({
        ...cl,
        srcVideo: cl.srcVideo || fallbackSrc,
        thumbnail: cl.thumbnail || r.thumbnail || null,
        // [HISTORY-REUSE] Reports written before subsBurned/rawFile were
        // persisted are already on disk, so infer both from the layout the
        // pipeline guarantees: the clean cut is <session>/raw/<name> and the
        // burned deliverable is the sibling <session>/burn-edited/<name>.
        // A clip served from burn-edited/ HAS captions baked in; without the
        // flag loadPreview draws the JS overlay on top and shows them twice.
        // Persisted values always win — this only fills a genuine gap.
        subsBurned: cl.subsBurned != null ? cl.subsBurned : isBurnedPath(cl.file),
        rawFile: cl.rawFile || cleanPlateFor(cl.file),
      }));
      enrichedClips.forEach((clip, i) => {
        out.push(Object.assign({}, clip, {
          _jobId: s.jobId,
          _dir: s.dir,
          _createdAt: r.createdAt || null,
          _sessionTitle: sessionTitle,
          _sessionClips: enrichedClips,
          _clipIndexInSession: i,
          _sessionThumb: r.thumbnail || null,
          _format: (r.cfg && r.cfg.format) || 'face',
          _resolution: (r.cfg && r.cfg.resolution) || null,
        }));
      });
    }
    return out;
  }

  // Waktu relatif berbahasa Indonesia. now default = sekarang (untuk test bisa diinjeksi).
  function relTime(iso, now) {
    if (!iso) return '';
    const t = new Date(iso).getTime();
    if (isNaN(t)) return '';
    const n = (now ? new Date(now).getTime() : Date.now());
    const s = Math.max(0, Math.floor((n - t) / 1000));
    if (s < 60) return 'baru saja';
    const m = Math.floor(s / 60);
    if (m < 60) return m + ' menit lalu';
    const h = Math.floor(m / 60);
    if (h < 24) return h + ' jam lalu';
    const d = Math.floor(h / 24);
    return d + ' hari lalu';
  }

  function isHotClip(c) {
    return c.isHot != null ? c.isHot : ((c.score || 0) >= 8);
  }

  // clips flat → filter by {filter:'all'|'hot', query:string}
  function filterHistoryClips(clips, opts) {
    const filter = (opts && opts.filter) || 'all';
    const query = ((opts && opts.query) || '').trim().toLowerCase();
    const now = (opts && opts.now) || Date.now();
    const weekAgo = now - 7 * 24 * 3600 * 1000;
    return (clips || []).filter(c => {
      if (filter === 'hot' && !isHotClip(c)) return false;
      if (filter === 'week') {
        const t = c._createdAt ? new Date(c._createdAt).getTime() : 0;
        if (!t || t < weekAgo) return false;
      }
      if (query) {
        const hay = ((c.title || '') + ' ' + (c.hook || '') + ' ' + (c._sessionTitle || '')).toLowerCase();
        if (!hay.includes(query)) return false;
      }
      return true;
    });
  }

  return { flattenHistory, relTime, filterHistoryClips, isHotClip, isBurnedPath, cleanPlateFor };
});
