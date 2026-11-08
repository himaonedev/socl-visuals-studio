const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('socl', {
  // [WIN-FIT] Plain string, not an IPC call. The renderer needs this before it
  // paints in order to set a layout class; an async round-trip would land after
  // first paint and flash the wrong layout. There is a `tracker:platform` IPC
  // already, but it exists for binary selection, where a tick of latency costs
  // nothing.
  platform: process.platform,
  // Pipeline
  pickVideo:    ()             => ipcRenderer.invoke('pick-video'),
  pickSubtitle: ()             => ipcRenderer.invoke('pick-subtitle'),
  runPipeline:  (payload)      => ipcRenderer.invoke('run-pipeline', payload),
  renderEdit:   (payload)      => ipcRenderer.invoke('render-edit', payload),
  // [RENDER-PROGRESS] { clipIndex, pct 0-100, stage, preview } while a gallery/editor render runs
  onRenderProgress: (cb) => {
    const h = (_e, d) => cb(d);
    ipcRenderer.on('render-progress', h);
    return () => ipcRenderer.removeListener('render-progress', h);
  },
  // [BATCH-CONCURRENCY] Asks main.js for a RAM/CPU-aware concurrency cap
  // before a gallery batch render starts — see the ipcMain handler's own note.
  batchRenderPlan: (payload)   => ipcRenderer.invoke('batch-render-plan', payload),
  renderPreview:(payload)      => ipcRenderer.invoke('render-preview', payload),
  applyCrop:    (payload)      => ipcRenderer.invoke('apply-crop', payload),
  fixTypos:     (payload)      => ipcRenderer.invoke('ai-fix-typos', payload),
  regenHook:    (payload)      => ipcRenderer.invoke('ai-regen-hook', payload),
  // [META-PERSIST] Persist edited/regenerated title/hook/description so they
  // survive a restart — History reads them back out of report.json.
  saveClipMeta: (payload)      => ipcRenderer.invoke('clip:saveMeta', payload),
  cancel:       ()             => ipcRenderer.invoke('cancel-pipeline'),
  // Settings
  getSettings:  ()             => ipcRenderer.invoke('get-settings'),
  // [PRESET-CATALOG] validated remote presets (data only)
  catalogGet:   ()             => ipcRenderer.invoke('catalog:get'),
  onCatalogUpdated: (cb)       => ipcRenderer.on('catalog:updated', (_e, d) => cb(d)),
  setSettings:  (cfg)          => ipcRenderer.invoke('set-settings', cfg),
  testProvider: (payload)      => ipcRenderer.invoke('ai:test-provider', payload),
  secretsAvailable: ()         => ipcRenderer.invoke('secrets:available'),
  secretsDiagnose: ()          => ipcRenderer.invoke('secrets:diagnose'),
  pickFolder:   ()             => ipcRenderer.invoke('pick-folder'),
  setCookies:   (opts)         => ipcRenderer.invoke('set-cookies', opts),
  // [DROP-PATH] Electron 32+ removed File.path; a dropped file's disk path is
  // only reachable through webUtils in the preload.
  pathForFile:  (file)         => { try { return webUtils.getPathForFile(file) || ''; } catch { return ''; } },
  appInfo:      ()             => ipcRenderer.invoke('app-info'),
  // [TITLE-LINE-GEOM] Metrik OS/2 yang canvas tidak bisa ukur (usWinAscent /
  // usWinDescent). Preview butuh itu untuk menempatkan baris judul di tempat
  // yang SAMA dengan yang diburn libass — lihat handler-nya di main.js.
  fontMetrics:  (names)        => ipcRenderer.invoke('fonts:metrics', names),
  checkUpdate:  ()             => ipcRenderer.invoke('check-update'),
  openDownloadPage: ()         => ipcRenderer.invoke('open-download-page'),
  getLicense:   ()             => ipcRenderer.invoke('license:getCurrent'),
  // [LIC-BTN] Both Settings license buttons were rendered but never wired —
  // these are the passthroughs they needed.
  openPurchase: ()             => ipcRenderer.invoke('license:openPurchase'),
  clearCache:   ()             => ipcRenderer.invoke('clear-cache'),
  // History
  listHistory:  ()             => ipcRenderer.invoke('list-history'),
  historyThumb: (clipPath)     => ipcRenderer.invoke('history-thumb', clipPath),
  openOutput:   (sessionDir)   => ipcRenderer.invoke('open-output', sessionDir),
  revealClip:   (payload)      => ipcRenderer.invoke('reveal-clip', payload),   // [REVEAL-CLIP]
  // Streaming events
  onProgress:   (cb)           => ipcRenderer.on('pipeline-progress', (_e, d) => cb(d)),
  onLog:        (cb)           => ipcRenderer.on('pipeline-log',      (_e, d) => cb(d)),
  onSourcePreview: (cb)        => ipcRenderer.on('pipeline-source-preview', (_e, d) => cb(d)),
  onClipsDetected: (cb)        => ipcRenderer.on('pipeline-clips-detected', (_e, d) => cb(d)),
  onClipState:  (cb)           => ipcRenderer.on('pipeline-clip-state', (_e, d) => cb(d)),
  onClip:       (cb)           => ipcRenderer.on('pipeline-clip',     (_e, d) => cb(d)),
  onDone:       (cb)           => ipcRenderer.on('pipeline-done',     (_e, d) => cb(d)),
  onError:      (cb)           => ipcRenderer.on('pipeline-error',    (_e, d) => cb(d)),
  // Watermark asset management (persistent under userData/watermarks/)
  watermark: {
    saveAsset:   (payload) => ipcRenderer.invoke('wm:saveAsset', payload),
    deleteAsset: (path)    => ipcRenderer.invoke('wm:deleteAsset', path),
  },
  // Offline transcription bundle (whisper.cpp)
  whisper: {
    status:  (model) => ipcRenderer.invoke('whisper:status', model),
    ensure:  (model) => ipcRenderer.invoke('whisper:ensure', model),
    remove:  () => ipcRenderer.invoke('whisper:remove'),
    onProgress: (cb) => {
      const h = (_e, d) => cb(d);
      ipcRenderer.on('whisper-progress', h);
      return () => ipcRenderer.removeListener('whisper-progress', h);
    },
  },
  // [CTX-MODEL] Optional offline context reader (moment picking without an AI key)
  ctxModel: {
    status:  () => ipcRenderer.invoke('ctxmodel:status'),
    ensure:  () => ipcRenderer.invoke('ctxmodel:ensure'),
    remove:  () => ipcRenderer.invoke('ctxmodel:remove'),
    onProgress: (cb) => {
      const h = (_e, d) => cb(d);
      ipcRenderer.on('ctxmodel-progress', h);
      return () => ipcRenderer.removeListener('ctxmodel-progress', h);
    },
  },
  // Download/render engines (yt-dlp / Deno / FFmpeg) — versions + update
  engines: {
    status:     () => ipcRenderer.invoke('engines:status'),
    update:     (id) => ipcRenderer.invoke('engines:update', id),
    fixYoutube: () => ipcRenderer.invoke('engines:fixYoutube'),
    onProgress: (cb) => {
      const h = (_e, d) => cb(d);
      ipcRenderer.on('engines-progress', h);
      return () => ipcRenderer.removeListener('engines-progress', h);
    },
  },
  // Smart Face Tracking bundle
  tracker: {
    isInstalled: () => ipcRenderer.invoke('tracker:isInstalled'),
    ready:       () => ipcRenderer.invoke('tracker:ready'),
    platform:    () => ipcRenderer.invoke('tracker:platform'),
    version:     () => ipcRenderer.invoke('tracker:version'),
    ensure:      () => ipcRenderer.invoke('tracker:ensure'),
    remove:      () => ipcRenderer.invoke('tracker:remove'),
    onProgress:  (cb) => {
      const h = (_e, d) => cb(d);
      ipcRenderer.on('tracker-progress', h);
      return () => ipcRenderer.removeListener('tracker-progress', h);
    },
  },
});
