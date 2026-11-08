import { EventEmitter } from 'node:events';
import fs = require('node:fs');
import path = require('node:path');
import os = require('node:os');
import { spawnSync } from 'node:child_process';
import type { PlatformBridge } from './contracts';

const handlers: PlatformBridge['handlers'] = new Map();
let transport: (channel: string, data: unknown) => void = () => {};
let nativeRequest: (op: string, payload: unknown, progress?: (value: unknown) => void) => Promise<unknown> = async () => { throw new Error('Native bridge is not connected'); };
const dataDir = process.env.SOCL_APP_DATA || path.resolve(__dirname, '../.dev-tools/tauri-data');
fs.mkdirSync(dataDir, { recursive: true });
const app = Object.assign(new EventEmitter(), {
  isPackaged: false,
  getPath(name: string): string {
    const paths = { userData: dataDir, appData: path.dirname(dataDir), temp: os.tmpdir(), home: os.homedir(), videos: path.join(os.homedir(), 'Videos'), downloads: path.join(os.homedir(), 'Downloads'), exe: process.execPath };
    if (!(name in paths)) throw new Error(`Unsupported application path: ${name}`);
    return paths[name as keyof typeof paths];
  },
  getAppPath: () => path.resolve(__dirname, '..'),
  getVersion: () => require('../package.json').version,
  getName: () => 'SOCL Visuals Studio',
  setName() {},
  isReady: () => true,
});
const sender = { send: (channel: string, data: unknown) => transport(channel, data), isDestroyed: () => false };
const dialog = {
  showOpenDialog: (...args: unknown[]) => nativeRequest('select-files', args.at(-1)),
  showMessageBox: (...args: unknown[]) => nativeRequest('message', args.at(-1)),
  showErrorBox: (title: string, content: string) => transport('engine-error', { title, message: content }),
};
// Windows DPAPI protects API keys with the current OS account, independently of Electron.
function dpapi(buffer: Buffer, decrypt: boolean): Buffer {
  if (process.platform !== 'win32') throw new Error('OS key storage is not available on this platform');
  const method = decrypt ? 'Unprotect' : 'Protect';
  const script = `Add-Type -AssemblyName System.Security; $bytes=[Convert]::FromBase64String([Console]::ReadLine()); $result=[Security.Cryptography.ProtectedData]::${method}($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Write([Convert]::ToBase64String($result))`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    input: buffer.toString('base64') + '\n', encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error('Windows key storage could not be accessed');
  return Buffer.from(result.stdout.trim(), 'base64');
}
const safeStorage = {
  isEncryptionAvailable: () => process.platform === 'win32',
  getSelectedStorageBackend: () => process.platform === 'win32' ? 'windows_dpapi' : 'unavailable',
  encryptString: (value: string) => dpapi(Buffer.from(value, 'utf8'), false),
  decryptString: (value: Buffer) => dpapi(value, true).toString('utf8'),
};
module.exports = {
  ensureWhisper: (model: string, progress?: (value: unknown) => void) => nativeRequest('whisper-install', model, progress),
  persistReport: (payload: unknown) => nativeRequest('store-report', payload),
  persistSettings: (payload: unknown) => nativeRequest('store-settings', payload),
  app, sender, handlers, dialog, safeStorage,
  net: { fetch: globalThis.fetch.bind(globalThis), request: require('./network.cjs').request },
  shell: {
    openExternal: (url: string) => nativeRequest('open-external', { url }),
    openPath: (filePath: string) => nativeRequest('open-path', { path: filePath }),
    showItemInFolder: (filePath: string) => nativeRequest('reveal-path', { path: filePath }),
  },
  ipcMain: { handle(channel: string, handler: PlatformBridge['handlers'] extends Map<string, infer Handler> ? Handler : never) {
    if (channel.startsWith('license:')) throw new Error('License IPC is not part of the Tauri engine');
    if (handlers.has(channel)) throw new Error(`Duplicate handler: ${channel}`);
    handlers.set(channel, handler);
  } },
  connect(send: typeof transport, request: typeof nativeRequest) { transport = send; nativeRequest = request; },
};

