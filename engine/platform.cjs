// Generated from backend/engine/platform.ts by scripts/backend.cjs. Edit the TypeScript source.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_events_1 = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const node_child_process_1 = require("node:child_process");
const handlers = new Map();
let transport = () => { };
let nativeRequest = async () => { throw new Error('Native bridge is not connected'); };
const dataDir = process.env.SOCL_APP_DATA || path.resolve(__dirname, '../.dev-tools/tauri-data');
fs.mkdirSync(dataDir, { recursive: true });
const app = Object.assign(new node_events_1.EventEmitter(), {
    isPackaged: false,
    getPath(name) {
        const paths = { userData: dataDir, appData: path.dirname(dataDir), temp: os.tmpdir(), home: os.homedir(), videos: path.join(os.homedir(), 'Videos'), downloads: path.join(os.homedir(), 'Downloads'), exe: process.execPath };
        if (!(name in paths))
            throw new Error(`Unsupported application path: ${name}`);
        return paths[name];
    },
    getAppPath: () => path.resolve(__dirname, '..'),
    getVersion: () => require('../package.json').version,
    getName: () => 'SOCL Visuals Studio',
    setName() { },
    isReady: () => true,
});
const sender = { send: (channel, data) => transport(channel, data), isDestroyed: () => false };
const dialog = {
    showOpenDialog: (...args) => nativeRequest('select-files', args.at(-1)),
    showMessageBox: (...args) => nativeRequest('message', args.at(-1)),
    showErrorBox: (title, content) => transport('engine-error', { title, message: content }),
};
// Windows DPAPI protects API keys with the current OS account, independently of Electron.
function dpapi(buffer, decrypt) {
    if (process.platform !== 'win32')
        throw new Error('OS key storage is not available on this platform');
    const method = decrypt ? 'Unprotect' : 'Protect';
    const script = `Add-Type -AssemblyName System.Security; $bytes=[Convert]::FromBase64String([Console]::ReadLine()); $result=[Security.Cryptography.ProtectedData]::${method}($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Write([Convert]::ToBase64String($result))`;
    const result = (0, node_child_process_1.spawnSync)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        input: buffer.toString('base64') + '\n', encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024,
    });
    if (result.error || result.status !== 0)
        throw new Error('Windows key storage could not be accessed');
    return Buffer.from(result.stdout.trim(), 'base64');
}
const safeStorage = {
    isEncryptionAvailable: () => process.platform === 'win32',
    getSelectedStorageBackend: () => process.platform === 'win32' ? 'windows_dpapi' : 'unavailable',
    encryptString: (value) => dpapi(Buffer.from(value, 'utf8'), false),
    decryptString: (value) => dpapi(value, true).toString('utf8'),
};
module.exports = {
    ensureWhisper: (model, progress) => nativeRequest('whisper-install', model, progress),
    persistReport: (payload) => nativeRequest('store-report', payload),
    persistSettings: (payload) => nativeRequest('store-settings', payload),
    app, sender, handlers, dialog, safeStorage,
    net: { fetch: globalThis.fetch.bind(globalThis), request: require('./network.cjs').request },
    shell: {
        openExternal: (url) => nativeRequest('open-external', { url }),
        openPath: (filePath) => nativeRequest('open-path', { path: filePath }),
        showItemInFolder: (filePath) => nativeRequest('reveal-path', { path: filePath }),
    },
    ipcMain: { handle(channel, handler) {
            if (channel.startsWith('license:'))
                throw new Error('License IPC is not part of the Tauri engine');
            if (handlers.has(channel))
                throw new Error(`Duplicate handler: ${channel}`);
            handlers.set(channel, handler);
        } },
    connect(send, request) { transport = send; nativeRequest = request; },
};
