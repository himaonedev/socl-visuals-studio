import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';

type Callback = (event: unknown, data: unknown) => void;
type NativeRequest = { id: number; op: string; payload: Record<string, unknown> };
type EngineInfo = { platform: string; mediaBase: string; mediaTransport?: 'rust'; channels: string[]; runtime: string };
declare global {
  interface Window {
    __soclEditorActive?: boolean;
    __soclPrepareEffects?: Window['__soclCurrentClip'];
    __soclResumeClipping?: () => void;
    __soclApplyEffects?: (result: { originalPath: string; clipIndex: number; path: string; captionProject?: unknown; cleanFile?: string }) => Promise<void>;
    __soclCurrentClip?: () => { path: string; cleanPath?: string; title?: string; clipIndex?: number; reportFile?: string; captionProject?: unknown; subsBurned?: boolean; captions?: { text: string; start: number; end: number }[] } | null;
    __soclIpc: {
      invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
      on: (channel: string, callback: Callback) => () => void;
      removeListener: (channel: string, callback: Callback) => void;
    };
    __soclPlatform: string;
    __soclDroppedPaths: Map<string, string>;
    __soclMediaUrl: (path: string | undefined | null) => string;
  }
}

function messageDialog(options: Record<string, unknown>) {
  return new Promise<{ response: number; checkboxChecked: boolean }>(resolve => {
    const dialog = document.createElement('dialog');
    dialog.className = 'native-modal';
    const heading = document.createElement('h2');
    heading.textContent = String(options.title || 'SOCL Visuals Studio');
    const message = document.createElement('p');
    message.textContent = String(options.message || '');
    const detail = document.createElement('p');
    detail.textContent = String(options.detail || '');
    dialog.append(heading, message, detail);
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = Boolean(options.checkboxChecked);
    if (options.checkboxLabel) {
      const label = document.createElement('label');
      label.append(checkbox, document.createTextNode(' ' + String(options.checkboxLabel)));
      dialog.append(label);
    }
    let settled = false;
    const finish = (response: number) => {
      if (settled) return;
      settled = true;
      dialog.close(); dialog.remove();
      resolve({ response, checkboxChecked: checkbox.checked });
    };
    const footer = document.createElement('footer');
    const buttons = Array.isArray(options.buttons) ? options.buttons : ['OK'];
    buttons.forEach((text, index) => {
      const button = document.createElement('button');
      button.textContent = String(text);
      button.onclick = () => finish(index);
      footer.append(button);
    });
    dialog.append(footer);
    dialog.addEventListener('cancel', event => { event.preventDefault(); finish(Number(options.cancelId ?? buttons.length - 1)); });
    document.body.append(dialog);
    dialog.showModal();
    (footer.children[Number(options.defaultId || 0)] as HTMLButtonElement | undefined)?.focus();
  });
}

export async function initializeBridge() {
  if (!isTauri()) throw new Error('Jalankan aplikasi desktop melalui run-dev.cmd. Preview browser tidak memiliki akses ke engine video.');
  const listeners = new Map<string, Set<Callback>>();
  const disposers: UnlistenFn[] = [];
  const engineInvoke = (channel: string, ...args: unknown[]) => invoke('engine_invoke', { channel, args });
  disposers.push(await listen<{ channel: string; data: unknown }>('engine-event', ({ payload }) => {
    for (const callback of listeners.get(payload.channel) || []) {
      try { callback(null, payload.data); } catch (error) { console.error('Engine event handler failed', error); }
    }
  }));
  disposers.push(await listen<NativeRequest>('engine-native', ({ payload }) => {
    (async () => {
      try {
        const result = payload.op === 'message' ? await messageDialog(payload.payload)
          : await invoke('native_action', { op: payload.op, payload: payload.payload });
        await invoke('native_reply', { id: payload.id, result, error: null });
      } catch (error) {
        await invoke('native_reply', { id: payload.id, result: null, error: String(error) });
      }
    })().catch(console.error);
  }));
  const info = await invoke<EngineInfo>('engine_info');
  window.__soclPlatform = info.platform;
  window.__soclDroppedPaths = new Map();
  window.__soclMediaUrl = input => {
    if (!input) return '';
    if (/^(https?|blob|data):/i.test(input)) return input;
    if (input.startsWith('file:')) {
      const url = new URL(input);
      input = decodeURIComponent(url.pathname);
      if (url.hostname) input = '//' + url.hostname + input;
      else if (/^\/[A-Za-z]:/.test(input)) input = input.slice(1);
    }
    return info.mediaBase + (info.mediaTransport === 'rust' ? '/' : '?path=') + encodeURIComponent(input);
  };
  window.__soclIpc = {
    invoke: engineInvoke,
    on(channel, callback) {
      if (!listeners.has(channel)) listeners.set(channel, new Set());
      listeners.get(channel)!.add(callback);
      return () => listeners.get(channel)?.delete(callback);
    },
    removeListener: (channel, callback) => { listeners.get(channel)?.delete(callback); },
  };
  // Local media URLs from remaining legacy helpers also pass through the scoped server.
  const descriptors: Array<[object, string, PropertyDescriptor]> = [];
  for (const [prototype, property] of [[HTMLMediaElement.prototype, 'src'], [HTMLImageElement.prototype, 'src'], [HTMLVideoElement.prototype, 'poster'], [HTMLSourceElement.prototype, 'src']] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, property);
    if (!descriptor?.set) continue;
    descriptors.push([prototype, property, descriptor]);
    Object.defineProperty(prototype, property, { ...descriptor, set(value: string) {
      descriptor.set!.call(this, /^file:/i.test(value) ? window.__soclMediaUrl(value) : value);
    } });
  }
  const originalSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function(name, value) {
    if (['src', 'poster'].includes(name.toLowerCase()) && /^file:/i.test(value)) value = window.__soclMediaUrl(value);
    originalSetAttribute.call(this, name, value);
  };
  disposers.push(await getCurrentWebview().onDragDropEvent(async event => {
    if (event.payload.type !== 'drop' || window.__soclEditorActive) return;
    const { paths, position } = event.payload;
    await engineInvoke('engine:grant-dropped', paths);
    const transfer = new DataTransfer();
    window.__soclDroppedPaths.clear();
    for (const path of paths) {
      const name = path.split(/[\\/]/).at(-1) || 'video.mp4';
      if (!window.__soclDroppedPaths.has(name)) window.__soclDroppedPaths.set(name, path);
      const file = new File([], name);
      Object.defineProperty(file, '__nativePath', { value: path });
      transfer.items.add(file);
    }
    const target = document.elementFromPoint(position.x / devicePixelRatio, position.y / devicePixelRatio) || document.body;
    target.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
  }));
  disposers.push(await listen('engine-disconnected', () => {
    for (const callback of listeners.get('pipeline-error') || []) callback(null, { message: 'Engine video berhenti. Tutup dan buka kembali aplikasi.' });
  }));
  return () => {
    disposers.forEach(dispose => dispose());
    for (const [prototype, property, descriptor] of descriptors) Object.defineProperty(prototype, property, descriptor);
    Element.prototype.setAttribute = originalSetAttribute;
  };
}
