// Generated from backend/src/asr-resource-plan.ts by scripts/backend.cjs. Edit the TypeScript source.
'use strict';
const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
// os.totalmem() may report slightly above/below the marketed capacity. Keeping
// the boundary below 12 GiB catches every 8 GB SKU without throttling 12 GB PCs.
const LOW_SPEC_WINDOWS_TOTAL_BYTES = 9 * GiB;
const LOW_SPEC_WINDOWS_MAX_THREADS = 4;
const DEFAULT_MAX_THREADS = 8;
// CPU-path measurements with the production whisper.cpp arguments, rounded up.
const ASR_MODEL_RSS_BYTES = Object.freeze({
    small: 700 * MiB,
    turbo: Math.round(1.25 * GiB),
});
const ASR_FREE_MARGIN_BYTES = 768 * MiB;
const ASR_WAV_MEMORY_MULTIPLIER = 2;
function positiveInteger(value, fallback = 1) {
    const n = Number(value);
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}
function modelClassFor(modelName) {
    const name = String(modelName || '').toLowerCase();
    return /small|base|tiny/.test(name) ? 'small' : 'turbo';
}
function localAsrPlanFor({ platform = process.platform, cpuCount = 1, totalMemBytes, freeMemBytes, modelName = 'small', customModel = false, wavBytes = 0, } = {}) {
    const total = Number(totalMemBytes);
    const lowSpecWindows = platform === 'win32' && Number.isFinite(total)
        && total > 0 && total <= LOW_SPEC_WINDOWS_TOTAL_BYTES;
    const requestedModel = String(modelName || 'small');
    const effectiveModel = lowSpecWindows && !customModel ? 'small' : requestedModel;
    const modelClass = modelClassFor(effectiveModel);
    const threadCeiling = lowSpecWindows ? LOW_SPEC_WINDOWS_MAX_THREADS : DEFAULT_MAX_THREADS;
    const threads = Math.max(1, Math.min(positiveInteger(cpuCount), threadCeiling));
    const wav = Number(wavBytes);
    const safeWavBytes = Number.isFinite(wav) && wav > 0 ? wav : 0;
    const requiredFreeBytes = ASR_MODEL_RSS_BYTES[modelClass]
        + safeWavBytes * ASR_WAV_MEMORY_MULTIPLIER + ASR_FREE_MARGIN_BYTES;
    const free = Number(freeMemBytes);
    const freeKnown = freeMemBytes !== null && freeMemBytes !== undefined
        && Number.isFinite(free) && free >= 0;
    const allowed = !freeKnown || free >= requiredFreeBytes;
    return {
        modelName: effectiveModel,
        modelClass,
        threads,
        lowSpecWindows,
        requiredFreeBytes,
        allowed,
        reason: allowed ? null : 'insufficient-free-memory',
    };
}
module.exports = {
    localAsrPlanFor,
    modelClassFor,
    LOW_SPEC_WINDOWS_TOTAL_BYTES,
    LOW_SPEC_WINDOWS_MAX_THREADS,
    DEFAULT_MAX_THREADS,
    ASR_MODEL_RSS_BYTES,
    ASR_FREE_MARGIN_BYTES,
    ASR_WAV_MEMORY_MULTIPLIER,
};
