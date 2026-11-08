import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import EffectsStudio from '../editor-host';
import { useProjectStore } from '../editor/store/project';
import { installLegacyEventGate } from '../legacy-events';
import { placeSubtitles } from '../editor/timeline/subtitles';
import { makeProject } from '../editor/test/makeProject';

vi.mock('../editor/App', () => ({ default: () => <p>Effects editor ready</p> }));
vi.mock('../editor/index.css?inline', () => ({ default: ':root{--accent:#d5ff40}' }));
vi.mock('../editor/timeline/subtitles', () => ({ placeSubtitles: vi.fn(async () => ({ ok: true, added: 2 })) }));

beforeEach(() => {
  useProjectStore.getState().newProject('SOCL clip');
  vi.mocked(invoke).mockReset();
  vi.mocked(placeSubtitles).mockClear();
  vi.mocked(invoke).mockImplementation(async command => command === 'import_socl_clip' ? {
    path: 'D:/clips/portrait.mp4', mediaType: 'video', duration: 8,
    width: 1080, height: 1920, fpsNum: 30, fpsDen: 1,
  } : null);
});

it('restores the saved per-clip caption project rather than regenerating its text styles', async () => {
  const project = makeProject();
  project.name = 'Caption dengan preset custom';
  const view = render(<EffectsStudio active clip={{ mode: 'caption', path: 'D:/clips/captioned.mp4', cleanPath: 'D:/clips/raw.mp4', requestId: 12, clipIndex: 0, captionProject: project }} onBack={() => {}} />);
  await screen.findByText('Effects editor ready');
  expect(useProjectStore.getState().project).toEqual(project);
  expect(placeSubtitles).not.toHaveBeenCalled();
  for (const asset of project.assets) expect(invoke).toHaveBeenCalledWith('import_socl_clip', { path: asset.path });
  view.unmount();
});

it('imports only clean visuals and leaves caption editing in SOCL', async () => {
  vi.mocked(invoke).mockImplementation(async (command, args) => command === 'import_socl_clip' ? {
    path: (args as { path: string }).path, mediaType: 'video', duration: 8,
    width: 1080, height: 1920, fpsNum: 30, fpsDen: 1,
  } : null);
  const view = render(<EffectsStudio active clip={{ path: 'D:/clips/rendered.mp4', cleanPath: 'D:/clips/raw.mp4', subsBurned: true, requestId: 2,
    captions: [{ text: 'Kalimat pertama', start: 0, end: 2 }, { text: 'Kalimat berikut', start: 2, end: 4 }] }} onBack={() => {}} />);
  await screen.findByText('Effects editor ready');
  expect(invoke).toHaveBeenCalledWith('import_socl_clip', { path: 'D:/clips/raw.mp4' });
  expect(useProjectStore.getState().project.assets[0].path).toBe('D:/clips/raw.mp4');
  expect(placeSubtitles).not.toHaveBeenCalled();
  expect(useProjectStore.getState().project.tracks.flatMap(track => track.clips)).toHaveLength(1);
  view.unmount();
});

it('imports captions only from Edit and applies them without overwriting the clean effects plate', async () => {
  const onBack = vi.fn();
  window.__soclApplyEffects = vi.fn(async () => {});
  vi.mocked(invoke).mockImplementation(async command => command === 'import_socl_clip' ? {
    path: 'D:/clips/effect-clean.mp4', mediaType: 'video', duration: 8, width: 1080, height: 1920,
  } : command === 'apply_socl_effects' ? { path: 'D:/clips/captioned.mp4' } : null);
  const view = render(<EffectsStudio active clip={{ mode: 'caption', path: 'D:/clips/rendered.mp4', cleanPath: 'D:/clips/effect-clean.mp4', requestId: 9, clipIndex: 0,
    captions: [{ text: 'Kalimat pertama', start: 0, end: 2 }] }} onBack={onBack} />);
  await screen.findByText('Effects editor ready');
  expect(placeSubtitles).toHaveBeenCalledWith([{ text: 'Kalimat pertama', start: 0, duration: 2 }], expect.anything());
  fireEvent.click(screen.getByRole('button', { name: 'Terapkan Caption' }));
  await waitFor(() => expect(window.__soclApplyEffects).toHaveBeenCalledWith(expect.objectContaining({ path: 'D:/clips/captioned.mp4', cleanFile: 'D:/clips/effect-clean.mp4', captionProject: expect.any(Object) })));
  expect(onBack).toHaveBeenCalledOnce();
  view.unmount(); delete window.__soclApplyEffects;
});

it('refuses burned-caption fallback if the clean plate cannot be imported', async () => {
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command !== 'import_socl_clip') return null;
    if ((args as { path: string }).path.endsWith('raw.mp4')) throw new Error('File missing');
    return { path: 'D:/clips/rendered.mp4', mediaType: 'video', duration: 8, width: 1080, height: 1920 };
  });
  const view = render(<EffectsStudio active clip={{ path: 'D:/clips/rendered.mp4', cleanPath: 'D:/clips/raw.mp4', subsBurned: true, requestId: 3,
    captions: [{ text: 'Caption', start: 0, end: 2 }] }} onBack={() => {}} />);
  await screen.findByRole('alert');
  expect(screen.getByRole('alert')).toHaveTextContent('Sumber video bersih tidak dapat dibuka');
  expect(useProjectStore.getState().project.assets).toHaveLength(0);
  expect(placeSubtitles).not.toHaveBeenCalled();
  view.unmount();
});

it('shows clip selection guidance instead of New/Open when Effects has no selected clip', async () => {
  const view = render(<EffectsStudio active clip={null} onBack={() => {}} />);
  await screen.findByText('Pilih klip yang sudah dirender di Clipping, lalu buka Effects.');
  expect(screen.queryByText('Effects editor ready')).not.toBeInTheDocument();
  expect(screen.queryByText('New Project')).not.toBeInTheDocument();
  expect(screen.queryByText('Open Project')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Terapkan ke Clipping' })).not.toBeInTheDocument();
  expect(invoke).not.toHaveBeenCalledWith('import_socl_clip', expect.anything());
  view.unmount();
});

it('hides Apply again when the last timeline clip is removed', async () => {
  const view = render(<EffectsStudio active clip={{ path: 'D:/clips/raw.mp4', subsBurned: false, clipIndex: 0, requestId: 20 }} onBack={() => {}} />);
  await screen.findByRole('button', { name: 'Terapkan ke Clipping' });
  act(() => useProjectStore.setState(s => ({ project: { ...s.project, tracks: s.project.tracks.map(track => ({ ...track, clips: [] })) } })));
  expect(screen.queryByRole('button', { name: 'Terapkan ke Clipping' })).not.toBeInTheDocument();
  view.unmount();
});

it('renders effects and returns the clean result to the matching SOCL clip', async () => {
  const onBack = vi.fn();
  window.__soclApplyEffects = vi.fn(async () => {});
  vi.mocked(invoke).mockImplementation(async command => command === 'import_socl_clip' ? {
    path: 'D:/clips/raw.mp4', mediaType: 'video', duration: 8, width: 1080, height: 1920,
  } : command === 'apply_socl_effects' ? { path: 'D:/clips/effect.mp4' } : null);
  const view = render(<EffectsStudio active clip={{ path: 'D:/clips/rendered.mp4', cleanPath: 'D:/clips/raw.mp4', requestId: 5, clipIndex: 0 }} onBack={onBack} />);
  await screen.findByText('Effects editor ready');
  fireEvent.click(screen.getByRole('button', { name: 'Terapkan ke Clipping' }));
  await waitFor(() => expect(window.__soclApplyEffects).toHaveBeenCalledWith({ originalPath: 'D:/clips/rendered.mp4', clipIndex: 0, path: 'D:/clips/effect.mp4' }));
  expect(onBack).toHaveBeenCalledOnce();
  expect(placeSubtitles).not.toHaveBeenCalled();
  view.unmount(); delete window.__soclApplyEffects;
});

it('imports a SOCL clip into the timeline, matches portrait canvas and preserves edits across workspace changes', async () => {
  const clip = { path: 'D:/clips/portrait.mp4', requestId: 1 };
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/legacy/styles.css';
  document.head.append(link);
  document.documentElement.dataset.theme = 'light';
  const onBack = vi.fn();
  const view = render(<EffectsStudio active clip={clip} onBack={onBack} />);
  await screen.findByText('Effects editor ready');
  await waitFor(() => expect(useProjectStore.getState().project.assets).toHaveLength(1));
  const project = useProjectStore.getState().project;
  expect(project.settings.width).toBe(1080);
  expect(project.settings.height).toBe(1920);
  expect(project.tracks.flatMap(track => track.clips)).toHaveLength(1);
  expect(link.disabled).toBe(false);
  expect(link.media).toBe('not all');
  view.rerender(<EffectsStudio active={false} clip={clip} onBack={onBack} />);
  expect(document.documentElement.dataset.theme).toBe('light');
  expect(link.disabled).toBe(false);
  expect(link.hasAttribute('media')).toBe(false);
  view.rerender(<EffectsStudio active clip={clip} onBack={onBack} />);
  expect(useProjectStore.getState().project).toBe(project);
  expect(project.tracks.flatMap(track => track.clips)).toHaveLength(1);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  fireEvent.click(screen.getByRole('button', { name: '← Clipping' }));
  expect(onBack).toHaveBeenCalledOnce();
  expect(useProjectStore.getState().project).toBe(project);
  view.unmount(); link.remove();
});

it('keeps legacy keyboard handlers out of the effects editor and removes wrapped listeners correctly', () => {
  const restore = installLegacyEventGate();
  const handler = vi.fn();
  window.addEventListener('keydown', handler);
  restore();
  window.__soclEditorActive = true;
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete' }));
  expect(handler).not.toHaveBeenCalled();
  window.__soclEditorActive = false;
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete' }));
  expect(handler).toHaveBeenCalledOnce();
  window.removeEventListener('keydown', handler);
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete' }));
  expect(handler).toHaveBeenCalledOnce();
});
