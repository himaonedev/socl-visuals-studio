import { createRoot } from 'react-dom/client';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { installLegacyEventGate } from './legacy-events';
import type { ClipForEditor } from './editor-host';
let effectsModule: ReturnType<typeof importEffects> | undefined;
function importEffects() { return import('./editor-host'); }
function preloadEffects() {
  return effectsModule ??= importEffects().catch(error => { effectsModule = undefined; throw error; });
}
const EffectsStudio = lazy(preloadEffects);
import { initializeBridge } from './bridge';
import markup from './legacy.html?raw';
import scripts from './legacy-scripts.json';
import './shell.css';
import { warmEffectsMedia } from './effects-media';
import { CloseConfirmation } from './close-confirmation';

function loadScript(name: string) {
  return new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/legacy/' + name;
    const runtimeError = (event: ErrorEvent) => {
      if (event.filename && new URL(event.filename).pathname === '/legacy/' + name) {
        window.removeEventListener('error', runtimeError);
        reject(new Error(name + ': ' + event.message));
      }
    };
    window.addEventListener('error', runtimeError);
    script.onload = () => { window.removeEventListener('error', runtimeError); resolve(); };
    script.onerror = () => { window.removeEventListener('error', runtimeError); reject(new Error('Gagal memuat ' + name)); };
    document.body.appendChild(script);
  });
}
function App() {
  const surface = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState('Menyiapkan aplikasi…');
  const [error, setError] = useState('');
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorLoaded, setEditorLoaded] = useState(false);
  const [editorClip, setEditorClip] = useState<ClipForEditor | null>(null);
  useEffect(() => { const open = (event: Event) => { const clip = (event as CustomEvent).detail || window.__soclPrepareEffects?.(); if (!clip?.path) return; setEditorClip(clip?.path ? { ...clip, requestId: Date.now() } : null); window.__soclEditorActive = true; setEditorLoaded(true); setEditorOpen(true); }; window.addEventListener('socl-open-effects', open); return () => window.removeEventListener('socl-open-effects', open); }, []);
  useEffect(() => {
    let dispose: (() => void) | undefined;
    const warmClip = () => {
      if (window.__soclEditorActive) return;
      const clip = window.__soclCurrentClip?.();
      if (clip && (!clip.subsBurned || clip.cleanPath)) warmEffectsMedia(clip.cleanPath || clip.path);
    };
    const workspace = surface.current;
    workspace?.addEventListener('loadedmetadata', warmClip, true);
    (async () => {
      dispose = await initializeBridge();
      if (!surface.current) return;
      surface.current.innerHTML = markup;
      const restoreRegistration = installLegacyEventGate();
      try { for (const script of scripts) await loadScript(script); } finally { restoreRegistration(); }
      const rail = surface.current.querySelector('.left-rail, .rail, .sidebar-rail') || surface.current.querySelector('#openEditorBtn')?.parentElement;
      if (rail) { const button = document.createElement('button'); button.className = 'rail-btn socl-effects-entry'; button.title = 'Effects Studio · Halftone, animasi teks & timeline'; button.setAttribute('aria-label', 'Buka Effects Studio'); button.innerHTML = '<span aria-hidden="true" style="font-size:22px">✦</span><span>Effects</span>'; button.onpointerenter = warmClip; button.onfocus = warmClip; button.onclick = () => { const clip = window.__soclPrepareEffects?.(); if (clip) window.dispatchEvent(new CustomEvent('socl-open-effects', { detail: clip })); }; rail.insertBefore(button, rail.querySelector('#openEditorBtn')?.nextSibling || null); }
      setStatus('');
      // Warm the editor after Clipping is usable, before the first Effects click.
      setTimeout(() => { void preloadEffects().catch(() => {}); warmClip(); }, 800);
    })().catch(reason => { setError(String(reason)); setStatus(''); });
    return () => { workspace?.removeEventListener('loadedmetadata', warmClip, true); dispose?.(); };
  }, []);
  return <>
    <CloseConfirmation />
    <div ref={surface} id="legacy-workspace" style={{ display: editorOpen ? "none" : undefined }} />
    {editorLoaded && <Suspense fallback={<div className="startup-state">Menyiapkan Effects Studio…</div>}><EffectsStudio active={editorOpen} clip={editorClip} onBack={() => { window.__soclEditorActive = false; setEditorOpen(false); requestAnimationFrame(() => window.__soclResumeClipping?.()); }} /></Suspense>}
    {(status || error) && <div className="startup-state" role="status"><h1>SOCL Visuals Studio</h1><p>{error || status}</p>{error && <button onClick={() => location.reload()}>Coba lagi</button>}</div>}
  </>;
}
createRoot(document.getElementById('root')!).render(<App />);
