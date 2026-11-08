// Small, idempotent helpers for owning one decoded media source at a time.
type LegacyCaptureMedia = HTMLMediaElement & { captureStream?: () => MediaStream };
interface LegacyMediaLifecycle {
  releaseMedia(el: HTMLMediaElement | null | undefined): void;
  setMediaSource(el: HTMLMediaElement | null | undefined, url: string | null | undefined): boolean;
  attachCaptureMirror(source: LegacyCaptureMedia | null | undefined, target: HTMLMediaElement | null | undefined): boolean;
  setMediaSourcePreservingTime(el: HTMLMediaElement, url: string, onReady?: () => void): boolean;
  loadCanvasVideo(el: HTMLVideoElement, url: string, timeoutMs?: number): Promise<void>;
  seekFrame(el: HTMLMediaElement, time: number, timeoutMs?: number): Promise<void>;
}
declare var MediaLifecycle: LegacyMediaLifecycle;
(function (root: typeof globalThis) {
  'use strict';

  function releaseMedia(el: HTMLMediaElement | null | undefined): void {
    if (!el) return;
    try { el.pause(); } catch {}
    try { el.srcObject = null; } catch {}
    try { el.removeAttribute('src'); } catch {}
    try { el.load(); } catch {}
  }

  function setMediaSource(el: HTMLMediaElement | null | undefined, url: string | null | undefined): boolean {
    releaseMedia(el);
    if (!el || !url) return false;
    el.src = url;
    try { el.load(); } catch {}
    return true;
  }

  function attachCaptureMirror(source: LegacyCaptureMedia | null | undefined, target: HTMLMediaElement | null | undefined): boolean {
    releaseMedia(target);
    if (!source || !target || typeof source.captureStream !== 'function') return false;
    try {
      target.srcObject = source.captureStream();
      return true;
    } catch {
      return false;
    }
  }

  function setMediaSourcePreservingTime(el: HTMLMediaElement, url: string, onReady?: () => void): boolean {
    const time = Number.isFinite(el.currentTime) ? el.currentTime : 0;
    const playing = !el.paused;
    const ready = () => {
      el.currentTime = Math.max(0, Math.min(time, Number.isFinite(el.duration) ? Math.max(0,el.duration-.01) : time));
      if (playing) Promise.resolve(el.play()).catch(() => {});
      if (onReady) onReady();
    };
    el.addEventListener('loadedmetadata', ready, {once:true});
    return setMediaSource(el,url);
  }

  function loadCanvasVideo(el: HTMLVideoElement, url: string, timeoutMs = 8000): Promise<void> {
    return new Promise<void>((resolve,reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const clean = () => { clearTimeout(timer); el.removeEventListener('loadeddata',ready); el.removeEventListener('error',failed); };
      const ready = () => { clean(); resolve(); };
      const failed = () => { clean(); reject(new Error('Video filmstrip tidak dapat dibaca')); };
      el.crossOrigin = 'anonymous'; el.muted = true; el.preload = 'auto';
      el.addEventListener('loadeddata',ready,{once:true}); el.addEventListener('error',failed,{once:true});
      timer = setTimeout(failed,timeoutMs);
      el.src = url; el.load();
      if (el.readyState >= 2) ready();
    });
  }

  function seekFrame(el: HTMLMediaElement, time: number, timeoutMs = 2500): Promise<void> {
    return new Promise<void>((resolve,reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const clean = () => {clearTimeout(timer);el.removeEventListener('seeked',ready);el.removeEventListener('error',failed);};
      const ready = () => {clean();resolve();};
      const failed = () => {clean();reject(new Error('Frame filmstrip tidak dapat dimuat'));};
      const target = Math.max(0,Math.min(time,Math.max(0,el.duration-.05)));
      if (Math.abs(el.currentTime-target)<.001 && el.readyState>=2) {resolve();return;}
      el.addEventListener('seeked',ready,{once:true});el.addEventListener('error',failed,{once:true});
      timer=setTimeout(failed,timeoutMs);el.currentTime=target;
    });
  }

  const api = { releaseMedia, setMediaSource, attachCaptureMirror, setMediaSourcePreservingTime, loadCanvasVideo, seekFrame };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MediaLifecycle = api;
})(typeof self !== 'undefined' ? self : this);
