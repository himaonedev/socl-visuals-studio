import path = require('node:path');
import Module = require('node:module');
import readline = require('node:readline');
import util = require('node:util');
import { parseRequest, errorMessage } from './contracts';
import type { ClippingEngine, EngineRequest, MediaTransport, PlatformBridge } from './contracts';

const { createMediaServer } = require('./media.cjs') as { createMediaServer(): MediaTransport };
const sendLine = process.stdout.write.bind(process.stdout);
const write = (data: unknown): void => { sendLine(JSON.stringify(data) + '\n'); };
for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
  console[method] = (...args: unknown[]) => { process.stderr.write(util.format(...args) + '\n'); };
}
const platform = require('./platform.cjs') as PlatformBridge;
type Loader = (request: string, parent: unknown, isMain: boolean) => unknown;
const internals = Module as unknown as { _load: Loader };
const originalLoad = internals._load;
internals._load = function(request, parent, isMain) {
  return request === 'electron' ? platform : originalLoad.call(this, request, parent, isMain);
};
(process as NodeJS.Process & { resourcesPath: string }).resourcesPath = path.resolve(__dirname, '..');
const nativeMedia = process.env.SOCL_NATIVE_MEDIA === '1';
const media: MediaTransport = nativeMedia ? { grant() {}, grantValue() {}, close() {} } : createMediaServer();
let nativeId = 0;
type PendingNative = { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout; progress?: (value: unknown) => void };
const natives = new Map<number, PendingNative>();
platform.connect((channel, data) => {
  media.grantValue(data);
  write({ kind: 'event', channel, data });
}, (op, payload, progress) => new Promise<unknown>((resolve, reject) => {
  const id = ++nativeId;
  const timer = setTimeout(() => { natives.delete(id); reject(new Error('Native dialog timed out')); }, 10 * 60 * 1000);
  natives.set(id, { resolve, reject, timer, progress });
  write({ kind: 'native', id, op, payload });
}));
let engine: ClippingEngine | undefined;
async function start(): Promise<void> {
  const loaded = require('../src/engine-main.cjs') as ClippingEngine;
  engine = loaded;
  const settings = loaded.readCfg();
  media.grant(loaded.outputRoot, true);
  media.grantValue(settings.workRoots);
  if (settings.exportPath) media.grant(settings.exportPath, true);
  const mediaBase = nativeMedia ? null : await media.listen?.();
  const mediaRoots = [loaded.outputRoot, ...(settings.workRoots || []), settings.exportPath].filter(Boolean);
  write({ kind: 'ready', data: { mediaBase, mediaRoots, channels: [...platform.handlers.keys()], platform: process.platform, runtime: 'Tauri 2 + Rust + TypeScript engine' } });
}
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', async (line: string) => {
  let request: EngineRequest | undefined;
  try {
    request = parseRequest(JSON.parse(line) as unknown);
    if (request.kind === 'native-progress') {
      const pending = natives.get(request.id);
      pending?.timer.refresh();
      pending?.progress?.(request.data);
      return;
    }
    if (request.kind === 'native-result') {
      const pending = natives.get(request.id);
      if (pending) {
        clearTimeout(pending.timer); natives.delete(request.id);
        media.grantValue(request.result);
        if (request.error) pending.reject(new Error(request.error)); else pending.resolve(request.result);
      }
      return;
    }
    if (request.kind === 'shutdown') { await shutdown(); return; }
    if (request.channel === 'engine:grant-dropped') { media.grantValue(request.args); write({ kind: 'response', id: request.id, result: true }); return; }
    const handler = platform.handlers.get(request.channel);
    if (!handler) throw new Error(`Unsupported engine operation: ${request.channel}`);
    media.grantValue(request.args);
    const result = await handler({ sender: platform.sender }, ...request.args);
    media.grantValue(result);
    write({ kind: 'response', id: request.id, result: result === undefined ? null : result });
  } catch (error: unknown) {
    write({ kind: 'response', id: request && 'id' in request ? request.id : undefined, error: errorMessage(error) });
  }
});
let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  try { engine?.requestPipelineCancel(); } catch {}
  for (const pending of natives.values()) { clearTimeout(pending.timer); pending.reject(new Error('Engine stopped')); }
  natives.clear();
  media.close();
  setTimeout(() => process.exit(0), 200).unref();
  lines.close();
}
lines.on('close', shutdown);
process.on('SIGTERM', shutdown);
start().catch((error: unknown) => { write({ kind: 'fatal', error: error instanceof Error ? error.stack || error.message : String(error) }); process.exitCode = 1; lines.close(); });
