// Generated from backend/src/context-model/worker.ts by scripts/backend.cjs. Edit the TypeScript source.
// ─── [CTX-MODEL] Embedding worker (separate process) ───────────────────────
// Runs the e5 model in its own process so the ~0.5-0.9 GB it needs is returned
// to the OS the moment it exits, and a native crash cannot take the app down.
// Packaged builds have the RunAsNode fuse off, so the host starts this with
// Electron's utilityProcess; under plain Node (tests, CI) it is a fork().
//
// Request : { bundleDir, groups: { name: [text, …] }, threads? }
// Response: { ok, dim, vectors: { name: base64(Float32Array) }, stats } | { ok:false, error }
const path = require('path');
const { XlmrTokenizer } = require('./tokenizer');
const port = process.parentPort || null;
const send = (msg) => (port ? port.postMessage(msg) : process.send(msg));
const onMessage = (fn) => (port ? port.on('message', (e) => fn(e.data)) : process.on('message', fn));
let peakRss = 0;
const sample = () => { const r = process.memoryUsage().rss; if (r > peakRss)
    peakRss = r; };
async function embedAll({ bundleDir, groups, threads }) {
    const t0 = Date.now();
    const ort = require(path.join(bundleDir, 'node_modules', 'onnxruntime-node'));
    const tok = XlmrTokenizer.fromFile(path.join(bundleDir, 'model', 'tokenizer.json'));
    const session = await ort.InferenceSession.create(path.join(bundleDir, 'model', 'model_quantized.onnx'), {
        executionProviders: ['cpu'],
        graphOptimizationLevel: 'all',
        enableCpuMemArena: false, // the arena keeps the peak allocation for the process lifetime
        intraOpNumThreads: threads || 0,
    });
    sample();
    const t1 = Date.now();
    const needsTypeIds = session.inputNames.includes('token_type_ids');
    const outName = session.outputNames.includes('last_hidden_state') ? 'last_hidden_state' : session.outputNames[0];
    const vectors = {};
    let dim = 0, tokens = 0;
    for (const [name, texts] of Object.entries(groups)) {
        const ids = texts.map((t) => tok.encode('query: ' + String(t || ''), 128));
        // length-sorted batches: padding cost is what makes long transcripts slow
        const order = ids.map((_, k) => k).sort((a, b) => ids[a].length - ids[b].length);
        let out = null;
        for (let b = 0; b < order.length; b += 16) {
            const batch = order.slice(b, b + 16);
            const L = Math.max(...batch.map((k) => ids[k].length));
            const inp = new BigInt64Array(batch.length * L).fill(BigInt(tok.pad));
            const mask = new BigInt64Array(batch.length * L);
            batch.forEach((k, r) => ids[k].forEach((id, c) => { inp[r * L + c] = BigInt(id); mask[r * L + c] = 1n; }));
            tokens += batch.reduce((s, k) => s + ids[k].length, 0);
            const feeds = {
                input_ids: new ort.Tensor('int64', inp, [batch.length, L]),
                attention_mask: new ort.Tensor('int64', mask, [batch.length, L]),
            };
            if (needsTypeIds)
                feeds.token_type_ids = new ort.Tensor('int64', new BigInt64Array(batch.length * L), [batch.length, L]);
            const res = await session.run(feeds);
            const h = res[outName];
            const D = h.dims[2];
            dim = D;
            if (!out)
                out = new Float32Array(texts.length * D);
            const data = h.data;
            batch.forEach((k, r) => {
                const v = new Float64Array(D);
                let cnt = 0;
                for (let c = 0; c < L; c++) {
                    if (mask[r * L + c] === 0n)
                        continue;
                    cnt++;
                    const off = (r * L + c) * D;
                    for (let d = 0; d < D; d++)
                        v[d] += data[off + d];
                }
                let norm = 0;
                for (let d = 0; d < D; d++) {
                    v[d] /= cnt || 1;
                    norm += v[d] * v[d];
                }
                norm = Math.sqrt(norm) || 1;
                for (let d = 0; d < D; d++)
                    out[k * D + d] = v[d] / norm;
            });
            sample();
        }
        vectors[name] = Buffer.from((out || new Float32Array(0)).buffer).toString('base64');
    }
    try {
        await session.release?.();
    }
    catch { }
    return { ok: true, dim, vectors,
        stats: { loadMs: t1 - t0, embedMs: Date.now() - t1, tokens, peakRssMb: Math.round(peakRss / 1048576) } };
}
onMessage(async (msg) => {
    try {
        send(await embedAll(msg));
    }
    catch (e) {
        send({ ok: false, error: String(e && e.message || e) });
    }
});
