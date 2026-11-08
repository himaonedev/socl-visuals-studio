import { invoke } from '@tauri-apps/api/core';
import { initializeBridge } from '../bridge';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: () => true }));
vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({ onDragDropEvent: vi.fn(async () => () => {}) }),
}));

it.each([
  ['rust', '/'],
  [undefined, '?path='],
] as const)('routes local media through the %s transport without changing remote URLs', async (mediaTransport, separator) => {
  vi.mocked(invoke).mockResolvedValue({
    platform: 'win32', mediaBase: 'http://127.0.0.1:12345/token',
    mediaTransport, channels: [], runtime: 'Tauri 2',
  });
  const dispose = await initializeBridge();
  try {
    const path = 'D:/clips/video with spaces.mp4';
    expect(window.__soclMediaUrl(path)).toBe('http://127.0.0.1:12345/token' + separator + encodeURIComponent(path));
    expect(window.__soclMediaUrl('file:///D:/clips/video%20with%20spaces.mp4')).toBe(window.__soclMediaUrl(path));
    expect(window.__soclMediaUrl('https://example.com/image.png')).toBe('https://example.com/image.png');
    expect(window.__soclMediaUrl(null)).toBe('');
  } finally { dispose(); }
});
