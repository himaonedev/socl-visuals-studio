import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useProjectStore, selectIsDirty } from '../editor/store/project';
import { confirmDialog } from '../editor/lib/dialog';
vi.mock('../editor/lib/dialog', () => ({ confirmDialog: vi.fn() }));
import { invoke } from '@tauri-apps/api/core';
import EffectsStudio from '../editor-host';
import { warmEffectsMedia, loadEffectsMedia } from '../effects-media';

vi.mock('../editor/App', () => ({ default: () => <div data-testid="effects-editor">Timeline Effects</div> }));
vi.mock('../editor/store/theme', () => ({ initializeTheme: vi.fn() }));
vi.mock('../workspace-styles', () => ({ suspendClippingStyles: () => () => {} }));

test('Effects opens its editor immediately while metadata is still pending', async () => {
  let finish!: (value: unknown) => void;
  const metadata = new Promise(resolve => { finish = resolve; });
  vi.mocked(invoke).mockImplementation((command, args) => {
    if (command !== 'import_socl_clip') return Promise.resolve(null) as never;
    // Even a thumbnail that never completes must not block opening or Apply.
    return (args as { metadataOnly?: boolean })?.metadataOnly ? metadata as never : new Promise(() => {}) as never;
  });
  const view = render(<EffectsStudio active clip={{ path: 'D:\\clips\\opening.mp4', clipIndex: 0, requestId: 1, subsBurned: false }} onBack={() => {}} />);
  expect(screen.getByTestId('effects-editor')).toBeVisible();
  expect(screen.queryByText('Menyiapkan klip…')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Terapkan ke Clipping' })).not.toBeInTheDocument();
  expect(invoke).toHaveBeenCalledWith('import_socl_clip', { path: 'D:\\clips\\opening.mp4', metadataOnly: true });
  await act(async () => { finish({ path: 'D:\\clips\\opening.mp4', mediaType: 'video', duration: 10, width: 320, height: 180, fpsNum: 30, fpsDen: 1 }); });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Terapkan ke Clipping' })).toBeEnabled());
  const calls = vi.mocked(invoke).mock.calls.filter(([name]) => name === 'import_socl_clip').length;
  view.rerender(<EffectsStudio active={false} clip={{ path: 'D:\\clips\\opening.mp4', clipIndex: 0, requestId: 1 }} onBack={() => {}} />);
  view.rerender(<EffectsStudio active clip={{ path: 'D:\\clips\\opening.mp4', clipIndex: 0, requestId: 2 }} onBack={() => {}} />);
  expect(screen.getByTestId('effects-editor')).toBeVisible();
  expect(vi.mocked(invoke).mock.calls.filter(([name]) => name === 'import_socl_clip')).toHaveLength(calls);
  view.unmount();
});

test('prefetch and opening share one metadata request and a failed prefetch is retryable', async () => {
  vi.mocked(invoke).mockReset();
  const media = { path: 'warm.mp4', mediaType: 'video', duration: 5 };
  vi.mocked(invoke).mockResolvedValue(media);
  warmEffectsMedia('warm.mp4');
  expect(await loadEffectsMedia('warm.mp4')).toEqual(media);
  expect(invoke).toHaveBeenCalledTimes(1);
  vi.mocked(invoke).mockRejectedValueOnce(new Error('temporary failure'));
  warmEffectsMedia('retry.mp4');
  await Promise.resolve();
  await expect(loadEffectsMedia('retry.mp4')).resolves.toEqual(media);
  expect(invoke).toHaveBeenCalledTimes(3);
});

test('automatic clip import is clean; only real edits ask before returning', async () => {
  vi.mocked(invoke).mockResolvedValue({ path: 'return-test.mp4', mediaType: 'video', duration: 10, width: 320, height: 180, fpsNum: 30, fpsDen: 1 });
  vi.mocked(confirmDialog).mockReset();
  const back = vi.fn();
  const nativeConfirm = vi.spyOn(window, 'confirm').mockImplementation(() => { throw new Error('dialog.confirm not allowed'); });
  const view = render(<EffectsStudio active clip={{ path: 'return-test.mp4', requestId: 8, clipIndex: 0, subsBurned: false }} onBack={back} />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Terapkan ke Clipping' })).toBeEnabled());
  expect(selectIsDirty(useProjectStore.getState())).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: '← Clipping' }));
  expect(back).toHaveBeenCalledTimes(1);
  expect(confirmDialog).not.toHaveBeenCalled();
  act(() => { useProjectStore.getState().execute({ label: 'Rename', apply: project => ({ ok: true, project: { ...project, name: 'Changed' } }) }); });
  vi.mocked(confirmDialog).mockResolvedValueOnce(false);
  fireEvent.click(screen.getByRole('button', { name: '← Clipping' }));
  await waitFor(() => expect(confirmDialog).toHaveBeenCalledTimes(1));
  expect(back).toHaveBeenCalledTimes(1);
  expect(nativeConfirm).not.toHaveBeenCalled();
  nativeConfirm.mockRestore(); view.unmount();
});
