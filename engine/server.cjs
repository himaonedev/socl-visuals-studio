// Generated from backend/engine/server.ts by scripts/backend.cjs. Edit the TypeScript source.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const path = require("node:path");
const Module = require("node:module");
const readline = require("node:readline");
const util = require("node:util");
const contracts_1 = require("./contracts");
const { createMediaServer } = require('./media.cjs');
const sendLine = process.stdout.write.bind(process.stdout);
const write = (data) => { sendLine(JSON.stringify(data) + '\n'); };
for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
    console[method] = (...args) => { process.stderr.write(util.format(...args) + '\n'); };
}
const platform = require('./platform.cjs');
const internals = Module;
const originalLoad = internals._load;
internals._load = function (request, parent, isMain) {
    return request === 'electron' ? platform : originalLoad.call(this, request, parent, isMain);
};
process.resourcesPath = path.resolve(__dirname, '..');
const nativeMedia = process.env.SOCL_NATIVE_MEDIA === '1';
const media = nativeMedia ? { grant() { }, grantValue() { }, close() { } } : createMediaServer();
let nativeId = 0;
const natives = new Map();
platform.connect((channel, data) => {
    media.grantValue(data);
    write({ kind: 'event', channel, data });
}, (op, payload, progress) => new Promise((resolve, reject) => {
    const id = ++nativeId;
    const timer = setTimeout(() => { natives.delete(id); reject(new Error('Native dialog timed out')); }, 10 * 60 * 1000);
    natives.set(id, { resolve, reject, timer, progress });
    write({ kind: 'native', id, op, payload });
}));
let engine;
async function start() {
    const loaded = require('../src/engine-main.cjs');
    engine = loaded;
    const settings = loaded.readCfg();
    media.grant(loaded.outputRoot, true);
    media.grantValue(settings.workRoots);
    if (settings.exportPath)
        media.grant(settings.exportPath, true);
    const mediaBase = nativeMedia ? null : await media.listen?.();
    const mediaRoots = [loaded.outputRoot, ...(settings.workRoots || []), settings.exportPath].filter(Boolean);
    write({ kind: 'ready', data: { mediaBase, mediaRoots, channels: [...platform.handlers.keys()], platform: process.platform, runtime: 'Tauri 2 + Rust + TypeScript engine' } });
}
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', async (line) => {
    let request;
    try {
        request = (0, contracts_1.parseRequest)(JSON.parse(line));
        if (request.kind === 'native-progress') {
            const pending = natives.get(request.id);
            pending?.timer.refresh();
            pending?.progress?.(request.data);
            return;
        }
        if (request.kind === 'native-result') {
            const pending = natives.get(request.id);
            if (pending) {
                clearTimeout(pending.timer);
                natives.delete(request.id);
                media.grantValue(request.result);
                if (request.error)
                    pending.reject(new Error(request.error));
                else
                    pending.resolve(request.result);
            }
            return;
        }
        if (request.kind === 'shutdown') {
            await shutdown();
            return;
        }
        if (request.channel === 'engine:grant-dropped') {
            media.grantValue(request.args);
            write({ kind: 'response', id: request.id, result: true });
            return;
        }
        const handler = platform.handlers.get(request.channel);
        if (!handler)
            throw new Error(`Unsupported engine operation: ${request.channel}`);
        media.grantValue(request.args);
        const result = await handler({ sender: platform.sender }, ...request.args);
        media.grantValue(result);
        write({ kind: 'response', id: request.id, result: result === undefined ? null : result });
    }
    catch (error) {
        write({ kind: 'response', id: request && 'id' in request ? request.id : undefined, error: (0, contracts_1.errorMessage)(error) });
    }
});
let stopping = false;
async function shutdown() {
    if (stopping)
        return;
    stopping = true;
    try {
        engine?.requestPipelineCancel();
    }
    catch { }
    for (const pending of natives.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Engine stopped'));
    }
    natives.clear();
    media.close();
    setTimeout(() => process.exit(0), 200).unref();
    lines.close();
}
lines.on('close', shutdown);
process.on('SIGTERM', shutdown);
start().catch((error) => { write({ kind: 'fatal', error: error instanceof Error ? error.stack || error.message : String(error) }); process.exitCode = 1; lines.close(); });
