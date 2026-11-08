// Generated from frontend/legacy-src/batch-render.ts by scripts/backend.cjs. Edit the TypeScript source.
// app/src/batch-render.js
// Pure decisions behind the gallery's batch render, kept out of renderer.js so
// node tests can cover them. Loaded BOTH by the Electron renderer (script tag →
// window.BatchRender) and by node tests (require). Never touches the DOM.
//
// [GALLERY-RENDER] Both functions exist because 2.3.40-beta shipped a gallery
// whose batch controls could not be used: the whole action zone was gated on
// "at least one clip has been through the Caption Editor", and the render loop
// read a resolved { error } envelope as a success.
(function (root) {
    'use strict';
    // batchZoneState({ clipCount, editN, hotN, selectMode, dismissed })
    //   → { showZone, showNote, noteText, hotText }
    //
    // The status bar has ONE contextual slot. Select mode owns it while it's on;
    // otherwise the batch zone (Hot / Render all) is a plain toolbar and shows
    // whenever there are clips to render. The "N edit di Caption Editor" note and
    // its × are the only contextual part — dismissing the nag must not take the
    // render buttons with it, which is exactly what the old gate did.
    function batchZoneState(opts) {
        const o = opts || {};
        const clipCount = o.clipCount || 0;
        const editN = o.editN || 0;
        const hotN = o.hotN || 0;
        const showZone = clipCount > 0 && !o.selectMode;
        return {
            showZone,
            showNote: showZone && editN > 0 && !o.dismissed,
            noteText: `${editN} edit`,
            hotText: `(${hotN})`,
        };
    }
    // interpretRenderResult(res) → { ok, error, file, fileName, exportWarning }
    //
    // main.js's 'render-edit' / 'render-preview' handlers catch everything and
    // RETURN { error: … } rather than rejecting, so `await socl.renderEdit(…)`
    // inside a try/catch resolves normally on a render that never happened.
    // Anything consuming renderEdit has to go through this instead of relying on
    // the catch block.
    function interpretRenderResult(res) {
        if (!res)
            return { ok: false, error: 'render returned no result' };
        if (res.error)
            return { ok: false, error: String(res.error) };
        if (!res.file)
            return { ok: false, error: 'render returned no output file' };
        return {
            ok: true,
            file: res.file,
            fileName: res.fileName || null,
            thumbnail: res.thumbnail || null,
            exportWarning: res.exportWarning || null,
            // [AI-STICKER-CACHE] Passed through so batchRenderClips (the one caller
            // that reads the INTERPRETED result rather than the raw IPC response)
            // can still persist it onto the clip — otherwise this whitelist quietly
            // drops it and the cache never survives a batch render.
            aiStickerCache: res.aiStickerCache || null,
        };
    }
    function usableClip(clip) {
        return !!(clip && ((clip.rawFile || clip.file)
            || (clip.srcVideo && clip.start != null && clip.end != null)));
    }
    function planBatch({ clips = [], indices = [], pipelineRunning = false } = {}) {
        if (pipelineRunning) {
            return { ok: false, reason: 'pipeline-running', indices: [], skipped: 0 };
        }
        const requested = [...new Set(indices)]
            .filter((i) => Number.isInteger(i) && !!clips[i]);
        const usable = requested.filter((i) => usableClip(clips[i]));
        return usable.length
            ? { ok: true, reason: null, indices: usable, skipped: requested.length - usable.length }
            : { ok: false, reason: 'no-usable-clips', indices: [], skipped: requested.length };
    }
    // runWithConcurrency(items, limit, worker, opts) → { results, cancelledAt }
    //
    // [BATCH-CONCURRENCY] Pure, engine-agnostic worker pool — knows nothing
    // about ffmpeg or IPC. Runs at most `limit` `worker(item, i)` calls at
    // once; `results[i]` is `{ ok:true, value }` or `{ ok:false, error }` once
    // item i settles, or `undefined` if it was never started (cancelled first).
    //
    // `opts.isCancelled()` is checked before STARTING each new item — matches
    // the pre-existing between-clip cancellation semantics (a single worker
    // call, e.g. one ffmpeg render, has no cancel plumbing of its own; this
    // only ever stops the NEXT one from starting, never aborts one in flight)
    // now generalised from 1-at-a-time to N-at-a-time. `cancelledAt` is the
    // count of items actually STARTED before cancellation was observed — every
    // one of those is awaited to completion (results[i] is always populated
    // for i < cancelledAt) before this resolves; nothing at or past it was
    // ever started.
    //
    // `opts.onSettled(item, i, outcome)` fires as EACH item completes (not
    // batched at the end) so a caller can drive live per-item progress/log UI
    // the same way the old serial loop's own per-iteration code did.
    function runWithConcurrency(items, limit, worker, opts = {}) {
        const isCancelled = opts.isCancelled || (() => false);
        const onSettled = opts.onSettled || (() => { });
        const n = items.length;
        const results = new Array(n);
        let nextIndex = 0;
        let cancelledAt = -1;
        async function runOne() {
            for (;;) {
                if (cancelledAt === -1 && isCancelled())
                    cancelledAt = nextIndex;
                if (cancelledAt !== -1)
                    return;
                if (nextIndex >= n)
                    return;
                const i = nextIndex++;
                const item = items[i];
                let outcome;
                try {
                    outcome = { ok: true, value: await worker(item, i) };
                }
                catch (error) {
                    outcome = { ok: false, error };
                }
                results[i] = outcome;
                onSettled(item, i, outcome);
            }
        }
        const cap = Math.max(1, Math.min(Math.floor(limit) || 1, n || 1));
        return Promise.all(Array.from({ length: cap }, runOne))
            .then(() => ({ results, cancelledAt }));
    }
    const api = { batchZoneState, interpretRenderResult, usableClip, planBatch, runWithConcurrency };
    if (typeof module !== 'undefined' && module.exports)
        module.exports = api;
    else
        root.BatchRender = api;
})(typeof self !== 'undefined' ? self : this);
