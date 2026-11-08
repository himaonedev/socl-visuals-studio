import { useLayoutEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import Editor from './editor/App';
import { ErrorBoundary } from './editor/components/ErrorBoundary';
import { initializeTheme } from './editor/store/theme';
import { initMediaUrls, type ImportedMedia } from './editor/lib/media';
import { commitImportedMedia, applyPendingCanvas } from './editor/lib/importFlow';
import { addAssetToTimeline } from './editor/timeline/editor';
import { useUiStore } from './editor/store/ui';
import { useProjectStore, selectIsDirty } from './editor/store/project';
import { usePlaybackStore } from './editor/store/playback';
import { canvasFromAsset, withCanvas } from './editor/project/canvas';
import styles from './editor/index.css?inline';
import { projectDuration } from './editor/timeline/clips';
import { defaultOptions } from './editor/export/options';
import type { ExportReport } from './editor/lib/exportApi';
import { suspendClippingStyles } from './workspace-styles';
import { placeSubtitles } from './editor/timeline/subtitles';
import { ProjectSchema, type Project } from './editor/project/model';
import { useSelectionStore } from './editor/store/selection';
import { useWorkspaceStore } from './editor/store/workspace';
import { loadEffectsMedia } from './effects-media';

export type ClipForEditor = { path: string; cleanPath?: string; title?: string; requestId?: number; clipIndex?: number; reportFile?: string; mode?: 'effects' | 'caption'; captionProject?: unknown; subsBurned?: boolean; captions?: { text: string; start: number; end: number }[] };
export default function EffectsStudio({ active, clip, onBack }: { active: boolean; clip: ClipForEditor | null; onBack: () => void }) {
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const [ready, setReady] = useState(false);
  const [shellReady, setShellReady] = useState(false);
  const [applying, setApplying] = useState(false);
  const [sourceDuration, setSourceDuration] = useState(0);
  const captionMode = clip?.mode === 'caption';
  const hasTimelineContent = useProjectStore(s => s.project.tracks.some(track => track.clips.length > 0));
  const sessions = useRef(new Map<string, { project: Project; saved: Project; source: string; duration: number }>());
  const session = useRef<{ key: string; source: string; duration: number } | null>(null);
  useLayoutEffect(() => {
    if (!active) return;
    const root = document.documentElement;
    const originalTheme = root.getAttribute('data-theme');
    const originalInline = root.getAttribute('style');
    const sheet = document.createElement('style');
    sheet.dataset.soclEditor = 'true';
    sheet.textContent = styles;
    document.head.appendChild(sheet);
    const restoreClippingStyles = suspendClippingStyles();
    initializeTheme();
    return () => {
      usePlaybackStore.getState().pause();
      sheet.remove();
      restoreClippingStyles();
      if (originalTheme === null) root.removeAttribute('data-theme'); else root.setAttribute('data-theme', originalTheme);
      if (originalInline === null) root.removeAttribute('style'); else root.setAttribute('style', originalInline);
    };
  }, [active]);
  useLayoutEffect(() => {
    let alive = true;
    const key = clip?.path ? `${clip.reportFile || clip.path}#${clip.clipIndex ?? 0}:${captionMode ? 'caption' : 'effects'}` : null;
    const source = clip?.cleanPath || clip?.path;
    // Returning to the same clip only reveals the existing workspace. Keep the
    // mounted decoder, timeline, selection and playback position intact.
    if (key && session.current?.key === key && session.current.source === source) {
      setError(''); setLoading(false); setReady(true);
      return;
    }
    setError(''); setNotice(''); setLoading(true); setReady(false); setSourceDuration(0);
    useWorkspaceStore.setState({ mode: captionMode ? 'caption' : 'effects', clipBound: true });
    useUiStore.getState().setAppView('editor');
    useUiStore.getState().setSidePanel('library');
    setShellReady(true);
    if (session.current) {
      sessions.current.set(session.current.key, { ...session.current, project: useProjectStore.getState().project, saved: useProjectStore.getState().saved });
      session.current = null;
    }
    (async () => {
      if (clip?.path) {
        const key = `${clip.reportFile || clip.path}#${clip.clipIndex ?? 0}:${captionMode ? 'caption' : 'effects'}`;
        const source = clip.cleanPath || clip.path;
        const cached = sessions.current.get(key);
        const persisted = captionMode && !cached && clip.captionProject ? ProjectSchema.safeParse(clip.captionProject) : null;
        if (cached?.source === source || persisted?.success) {
          const project = cached?.source === source ? cached.project : persisted!.success ? persisted!.data : null;
          if (project) {
            if (!cached) await Promise.all([initMediaUrls(), ...project.assets.map(asset => loadEffectsMedia(asset.path))]);
            if (!alive) return;
            useProjectStore.getState().loadProject(project, '', []);
            if (cached?.source === source) useProjectStore.setState({ saved: cached.saved });
            useSelectionStore.getState().clear();
            const textIds = new Set(project.assets.filter(a => a.text).map(a => a.id));
            const selected = project.tracks.flatMap(t => t.clips).find(c => captionMode ? textIds.has(c.assetId) : !textIds.has(c.assetId));
            if (selected) useSelectionStore.getState().select(selected.id);
            const duration = cached?.duration || projectDuration(project);
            session.current = { key, source, duration }; setSourceDuration(duration);
            useUiStore.getState().setAppView('editor'); setReady(true); setLoading(false); return;
          }
        }
        useProjectStore.getState().newProject(clip.title || 'SOCL clip');
        useSelectionStore.getState().clear();
        const useClean = Boolean(clip.cleanPath || clip.subsBurned === false);
        if (!useClean && clip.subsBurned) throw new Error('Video bersih belum tersedia. Effects membutuhkan video tanpa caption; caption tetap diedit di menu Edit SOCL.');
        let media: ImportedMedia;
        try {
          const [, imported] = await Promise.all([initMediaUrls(), loadEffectsMedia(useClean ? (clip.cleanPath || clip.path) : clip.path)]);
          media = imported;
        }
        catch (reason) {
          if (!useClean || !clip.cleanPath) throw reason;
          throw new Error('Sumber video bersih tidak dapat dibuka. Pulihkan sumbernya sebelum menerapkan Effects.');
        }
        if (!alive) return;
        setSourceDuration(media.duration || 0);
        const matchCanvas = useProjectStore.getState().project.assets.length === 0;
        const result = commitImportedMedia(media);
        if (result.status === 'invalid') throw new Error('Metadata klip tidak dapat dibaca.');
        const asset = result.status === 'added' ? result.asset : result.existing;
        if (matchCanvas) useProjectStore.getState().execute({ label: 'Match SOCL clip canvas', apply: project => ({ ok: true, project: { ...withCanvas(project, canvasFromAsset(asset).canvas, false), name: clip.title || project.name } }) });
        else if (result.status === 'added') applyPendingCanvas(asset);
        const existing = useProjectStore.getState().project.tracks.some(track => track.clips.some(item => item.assetId === asset.id));
        if (!existing) {
          const added = addAssetToTimeline(asset.id);
          if (!added.ok) throw new Error(added.error.message);
          if (captionMode && clip.captions?.length) {
            const captions = clip.captions.filter(c => c.text?.trim() && Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start)
              .map(c => ({ text: c.text, start: Math.max(0, c.start), duration: Math.min(media.duration || c.end, c.end) - Math.max(0, c.start) })).filter(c => c.duration > 0);
            const placed = await placeSubtitles(captions, { label: 'Import caption SOCL', language: null, endLimit: media.duration || 0 });
            if (!placed.ok) throw new Error('Caption gagal dimuat: ' + placed.reason);
            const project = useProjectStore.getState().project;
            const ids = new Set(project.assets.filter(a => a.text).map(a => a.id));
            const first = project.tracks.flatMap(t => t.clips).find(c => ids.has(c.assetId));
            if (first) useSelectionStore.getState().select(first.id);
            useUiStore.getState().setInspectorTab('image', 'text');
          }
          setNotice(captionMode ? 'Pilih caption pada timeline. Tab Text: stabilo, coretan, Blink dan preset custom. Tab Motion: animasi serta Copy/Paste Motion.' : 'Effects mengatur visual saja. Caption tetap diedit di menu Edit SOCL setelah Terapkan ke Clipping.');
        }
        useUiStore.getState().setAppView('editor');
        session.current = { key, source, duration: media.duration || 0 };
        setReady(true);
        // Library thumbnails are optional decoration, never an opening gate.
        void invoke<ImportedMedia>('import_socl_clip', { path: media.path }).then(enriched => {
          if (!alive || !enriched?.thumbnailPath) return;
          const attach = (project: Project): Project => ({ ...project, assets: project.assets.map(item => item.id === asset.id ? { ...item, thumbnailPath: enriched.thumbnailPath } : item) });
          useProjectStore.setState(state => ({ project: attach(state.project), saved: attach(state.saved) }));
        }).catch(() => {});
      }
      if (alive) setLoading(false);
    })().catch(reason => { if (alive) { setError(String(reason)); setLoading(false); } });
    return () => { alive = false; };
  }, [clip?.requestId]);
  const applyToClipping = async () => {
    if (!clip || clip.clipIndex === undefined || !window.__soclApplyEffects) return;
    setApplying(true); setError('');
    try {
      const project = useProjectStore.getState().project;
      if (Math.abs(projectDuration(project) - sourceDuration) > 2 / project.settings.fps) throw new Error('Durasi Effects harus sama dengan klip asal agar timing caption tetap cocok.');
      // Visual text generated by Facecam styles remains part of the effect.
      // Subtitle tracks are imported only in the caption workspace.
      const report = await invoke<ExportReport>('apply_socl_effects', { project, options: defaultOptions(project), reportFile: clip.reportFile || clip.path, clipIndex: clip.clipIndex, captionMode, cleanFile: clip.cleanPath || clip.path });
      await window.__soclApplyEffects({ originalPath: clip.path, clipIndex: clip.clipIndex, path: report.path, ...(captionMode ? { captionProject: project, cleanFile: clip.cleanPath || clip.path } : {}) });
      onBack();
    } catch (reason) { setError(String(reason)); }
    finally { setApplying(false); }
  };
  const back = () => {
    // Project state stays in memory, but saving before leaving also protects it on app exit.
    if (applying) return;
    if (selectIsDirty(useProjectStore.getState()) && !window.confirm('Kembali tanpa menerapkan efek ke Clipping? Gunakan Terapkan ke Clipping untuk mengirim hasil efek. Proyek tetap tersedia selama aplikasi terbuka.')) return;
    onBack();
  };
  return <div className="socl-effects-workspace" style={{ display: active ? undefined : "none" }}>
    <header className="socl-effects-nav"><button disabled={applying} onClick={back}>← Clipping</button><div><strong>SOCL Visuals Studio</strong><span>{captionMode ? 'Edit SOCL · Teks & Motion' : 'Effects Studio'}</span></div>{ready && hasTimelineContent && <button disabled={loading || applying || !!error || clip?.clipIndex === undefined} onClick={applyToClipping}>{applying ? 'Merender…' : captionMode ? 'Terapkan Caption' : 'Terapkan ke Clipping'}</button>}</header>
    {error && <div className="socl-effects-notice" role="alert">{error}<button onClick={() => setError('')}>Tutup</button></div>}
    {notice && <div className="socl-effects-notice" role="status">{notice}<button onClick={() => setNotice('')}>Tutup</button></div>}
    {!loading && (!clip?.path || !ready) && <div className="socl-effects-loading" role="status">Pilih klip yang sudah dirender di Clipping, lalu buka {captionMode ? 'Edit' : 'Effects'}.</div>}
    {shellReady && clip?.path && <div className="socl-effects-content" aria-busy={loading} inert={applying || loading || !ready}><ErrorBoundary><Editor active={active} /></ErrorBoundary></div>}
  </div>;
}

