import { act, fireEvent, render, screen } from '@testing-library/react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { CloseConfirmation } from '../close-confirmation';

test('Home and Effects share a close dialog without navigation; cancel and quit work', async () => {
  let request!: (event: { preventDefault: () => void }) => void;
  const destroy = vi.fn();
  const off = vi.fn();
  vi.mocked(getCurrentWindow).mockReturnValue({
    onCloseRequested: vi.fn(async (callback: typeof request) => { request = callback; return off; }), destroy,
  } as never);
  const navigate = vi.fn();
  window.addEventListener('socl-open-effects', navigate);
  const view = render(<CloseConfirmation />);
  for (const active of [false, true]) {
    window.__soclEditorActive = active;
    const event = { preventDefault: vi.fn() };
    act(() => request(event));
    expect(event.preventDefault).toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  }
  expect(destroy).not.toHaveBeenCalled();
  act(() => request({ preventDefault() {} }));
  fireEvent.click(screen.getByRole('button', { name: 'Quit without saving' }));
  expect(destroy).toHaveBeenCalledTimes(1);
  expect(navigate).not.toHaveBeenCalled();
  view.unmount();
  await act(async () => {});
  expect(off).toHaveBeenCalled();
  window.removeEventListener('socl-open-effects', navigate);
});
