type LegacyDataCallback = (data: unknown) => void;
type LegacyIpcCallback = (event: unknown, data: unknown) => void;
interface LegacyBrowserIpc {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, callback: LegacyIpcCallback): void;
  removeListener(channel: string, callback: LegacyIpcCallback): void;
}
interface LegacyDroppedFile { name: string; path?: string; __nativePath?: string }
interface LegacyBrowserSettings {
  [key: string]: unknown;
  subtitleBoxColor?: string;
  subtitleBoxRotation?: number;
  subtitleFontSize?: number;
  subtitleY?: number;
  subtitleX?: number;
}
interface Window {
  __soclIpc: LegacyBrowserIpc;
  __soclPlatform: string;
  __soclDroppedPaths?: Map<string, string>;
  socl: ReturnType<typeof createLegacySoclApi>;
}
function createLegacySoclApi() {
const ipcRenderer = window.__soclIpc;
const webUtils = { getPathForFile: (file: LegacyDroppedFile) => file.__nativePath || file.path || window.__soclDroppedPaths?.get(file.name) || '' };
const process = { platform: window.__soclPlatform };

const api = {
  // [WIN-FIT] Plain string, not an IPC call. The renderer needs this before it
  // paints in order to set a layout class; an async round-trip would land after
  // first paint and flash the wrong layout. There is a `tracker:platform` IPC
  // already, but it exists for binary selection, where a tick of latency costs
  // nothing.
  platform: process.platform,
  // Pipeline
  pickVideo:    ()             => ipcRenderer.invoke('pick-video'),
  pickSubtitle: ()             => ipcRenderer.invoke('pick-subtitle'),
  runPipeline:  (payload: Record<string, unknown>)      => ipcRenderer.invoke('run-pipeline', payload),
  renderEdit:   (payload: Record<string, unknown>)      => ipcRenderer.invoke('render-edit', payload),
  // [RENDER-PROGRESS] { clipIndex, pct 0-100, stage, preview } while a gallery/editor render runs
  onRenderProgress: (cb: LegacyDataCallback) => {
    const h = (_e: unknown, d: unknown) => cb(d);
    ipcRenderer.on('render-progress', h);
    return () => ipcRenderer.removeListener('render-progress', h);
  },
  // [BATCH-CONCURRENCY] Asks main.js for a RAM/CPU-aware concurrency cap
  // before a gallery batch render starts — see the ipcMain handler's own note.
  batchRenderPlan: (payload: Record<string, unknown>)   => ipcRenderer.invoke('batch-render-plan', payload),
  renderPreview:(payload: Record<string, unknown>)      => ipcRenderer.invoke('render-preview', payload),
  applyCrop:    (payload: Record<string, unknown>)      => ipcRenderer.invoke('apply-crop', payload),
  fixTypos:     (payload: Record<string, unknown>)      => ipcRenderer.invoke('ai-fix-typos', payload),
  regenHook:    (payload: Record<string, unknown>)      => ipcRenderer.invoke('ai-regen-hook', payload),
  // [META-PERSIST] Persist edited/regenerated title/hook/description so they
  // survive a restart — History reads them back out of report.json.
  saveClipMeta: (payload: Record<string, unknown>)      => ipcRenderer.invoke('clip:saveMeta', payload),
  cancel:       ()             => ipcRenderer.invoke('cancel-pipeline'),
  // Settings
  getSettings:  ()             => ipcRenderer.invoke('get-settings'),
  // [PRESET-CATALOG] validated remote presets (data only)
  catalogGet:   ()             => ipcRenderer.invoke('catalog:get'),
  onCatalogUpdated: (cb: LegacyDataCallback)       => ipcRenderer.on('catalog:updated', (_e: unknown, d: unknown) => cb(d)),
  setSettings:  (cfg: LegacyBrowserSettings)          => ipcRenderer.invoke('set-settings', cfg),
  testProvider: (payload: Record<string, unknown>)      => ipcRenderer.invoke('ai:test-provider', payload),
  secretsAvailable: ()         => ipcRenderer.invoke('secrets:available'),
  secretsDiagnose: ()          => ipcRenderer.invoke('secrets:diagnose'),
  pickFolder:   ()             => ipcRenderer.invoke('pick-folder'),
  setCookies:   (opts?: { clear?: boolean; filePath?: string })         => ipcRenderer.invoke('set-cookies', opts),
  // [DROP-PATH] Electron 32+ removed File.path; a dropped file's disk path is
  // only reachable through webUtils in the preload.
  pathForFile:  (file: LegacyDroppedFile)         => { try { return webUtils.getPathForFile(file) || ''; } catch { return ''; } },
  appInfo:      ()             => ipcRenderer.invoke('app-info'),
  // [TITLE-LINE-GEOM] Metrik OS/2 yang canvas tidak bisa ukur (usWinAscent /
  // usWinDescent). Preview butuh itu untuk menempatkan baris judul di tempat
  // yang SAMA dengan yang diburn libass — lihat handler-nya di main.js.
  fontMetrics:  (names: string[])        => ipcRenderer.invoke('fonts:metrics', names),
  checkUpdate:  ()             => ipcRenderer.invoke('check-update'),
  openDownloadPage: ()         => ipcRenderer.invoke('open-download-page'),  // [LIC-BTN] Both Settings license buttons were rendered but never wired —
  // these are the passthroughs they needed.  clearCache:   ()             => ipcRenderer.invoke('clear-cache'),
  // History
  listHistory:  ()             => ipcRenderer.invoke('list-history'),
  historyThumb: (clipPath: string)     => ipcRenderer.invoke('history-thumb', clipPath),
  openOutput:   (sessionDir?: string)   => ipcRenderer.invoke('open-output', sessionDir),
  revealClip:   (payload: Record<string, unknown>)      => ipcRenderer.invoke('reveal-clip', payload),   // [REVEAL-CLIP]
  // Streaming events
  onProgress:   (cb: LegacyDataCallback)           => ipcRenderer.on('pipeline-progress', (_e: unknown, d: unknown) => cb(d)),
  onLog:        (cb: LegacyDataCallback)           => ipcRenderer.on('pipeline-log',      (_e: unknown, d: unknown) => cb(d)),
  onSourcePreview: (cb: LegacyDataCallback)        => ipcRenderer.on('pipeline-source-preview', (_e: unknown, d: unknown) => cb(d)),
  onClipsDetected: (cb: LegacyDataCallback)        => ipcRenderer.on('pipeline-clips-detected', (_e: unknown, d: unknown) => cb(d)),
  onClipState:  (cb: LegacyDataCallback)           => ipcRenderer.on('pipeline-clip-state', (_e: unknown, d: unknown) => cb(d)),
  onClip:       (cb: LegacyDataCallback)           => ipcRenderer.on('pipeline-clip',     (_e: unknown, d: unknown) => cb(d)),
  onDone:       (cb: LegacyDataCallback)           => ipcRenderer.on('pipeline-done',     (_e: unknown, d: unknown) => cb(d)),
  onError:      (cb: LegacyDataCallback)           => ipcRenderer.on('pipeline-error',    (_e: unknown, d: unknown) => cb(d)),
  // Watermark asset management (persistent under userData/watermarks/)
  watermark: {
    saveAsset:   (payload: Record<string, unknown>) => ipcRenderer.invoke('wm:saveAsset', payload),
    deleteAsset: (path: string)    => ipcRenderer.invoke('wm:deleteAsset', path),
  },
  // Offline transcription bundle (whisper.cpp)
  whisper: {
    status:  (model?: string) => ipcRenderer.invoke('whisper:status', model),
    ensure:  (model?: string) => ipcRenderer.invoke('whisper:ensure', model),
    remove:  () => ipcRenderer.invoke('whisper:remove'),
    onProgress: (cb: LegacyDataCallback) => {
      const h = (_e: unknown, d: unknown) => cb(d);
      ipcRenderer.on('whisper-progress', h);
      return () => ipcRenderer.removeListener('whisper-progress', h);
    },
  },
  // [CTX-MODEL] Optional offline context reader (moment picking without an AI key)
  ctxModel: {
    status:  () => ipcRenderer.invoke('ctxmodel:status'),
    ensure:  () => ipcRenderer.invoke('ctxmodel:ensure'),
    remove:  () => ipcRenderer.invoke('ctxmodel:remove'),
    onProgress: (cb: LegacyDataCallback) => {
      const h = (_e: unknown, d: unknown) => cb(d);
      ipcRenderer.on('ctxmodel-progress', h);
      return () => ipcRenderer.removeListener('ctxmodel-progress', h);
    },
  },
  // Download/render engines (yt-dlp / Deno / FFmpeg) — versions + update
  engines: {
    status:     () => ipcRenderer.invoke('engines:status'),
    update:     (id: 'ytdlp' | 'deno' | 'ffmpeg') => ipcRenderer.invoke('engines:update', id),
    fixYoutube: () => ipcRenderer.invoke('engines:fixYoutube'),
    onProgress: (cb: LegacyDataCallback) => {
      const h = (_e: unknown, d: unknown) => cb(d);
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
    onProgress:  (cb: LegacyDataCallback) => {
      const h = (_e: unknown, d: unknown) => cb(d);
      ipcRenderer.on('tracker-progress', h);
      return () => ipcRenderer.removeListener('tracker-progress', h);
    },
  },
};
return api;
}
window.socl = createLegacySoclApi();

