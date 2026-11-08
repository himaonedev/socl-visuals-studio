// Generated from backend/src/pipeline-preview.ts by scripts/backend.cjs. Edit the TypeScript source.
const path = require('path');
function ms(value) {
    const n = Number(value);
    return Math.max(0, Math.round((Number.isFinite(n) ? n : 0) * 1000));
}
function candidateId(index, clip) {
    return `clip-${index + 1}-${ms(clip?.start)}-${ms(clip?.end)}`;
}
function remotePoster(info) {
    if (!info)
        return null;
    if (Array.isArray(info.thumbnails) && info.thumbnails.length) {
        const ranked = [...info.thumbnails]
            .filter(item => item?.url)
            .sort((a, b) => (Number(b.width) * Number(b.height) || 0)
            - (Number(a.width) * Number(a.height) || 0));
        if (ranked[0]?.url)
            return ranked[0].url;
    }
    return info.thumbnail || null;
}
function youtubeVideoId(source) {
    try {
        const url = new URL(String(source || ''));
        const host = url.hostname.toLowerCase().replace(/^www\./, '');
        let id = null;
        if (host === 'youtu.be') {
            id = url.pathname.split('/').filter(Boolean)[0] || null;
        }
        else if (host === 'youtube.com' || host.endsWith('.youtube.com')
            || host === 'youtube-nocookie.com' || host.endsWith('.youtube-nocookie.com')) {
            if (url.pathname === '/watch')
                id = url.searchParams.get('v');
            else
                id = /^\/(?:shorts|live|embed)\/([^/?#]+)/.exec(url.pathname)?.[1] || null;
        }
        return /^[A-Za-z0-9_-]{11}$/.test(id || '') ? id : null;
    }
    catch {
        return null;
    }
}
function youtubePosterFromSource(source) {
    const id = youtubeVideoId(source);
    return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null;
}
function candidatePosterTime(clip) {
    const start = Math.max(0, Number(clip?.start) || 0);
    const end = Number(clip?.end);
    return Number.isFinite(end) && end > start ? start + ((end - start) / 2) : start;
}
function candidatePosterSpec(format) {
    const key = String(format || 'face').toLowerCase();
    const [width, height] = key === 'landscape' ? [640, 360]
        : key === 'square' ? [640, 640]
            : [360, 640];
    const cover = `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`;
    return { width, height, filter: `${cover},setsar=1` };
}
function renderedPosterTime(duration) {
    const value = Number(duration);
    const d = Math.max(0, Number.isFinite(value) ? value : 0);
    if (d <= 0.35)
        return 0;
    return Math.min(d - 0.1, Math.max(0.25, d * 0.35));
}
// [DATA-DIR] A clip inside a session's clip folder gets its poster in
// <session>/data/thumbnails/<folder>/ (raw/ and subtitle/ share basenames, so
// the folder is kept); anything else keeps the old sibling .thumbnail.jpg.
const CLIP_FOLDERS = new Set(['raw', 'subtitle', 'edited', 'crop-biasa', 'crop-gaming', 'hasil', 'burn-edited', '_clean']);
function renderedPosterPath(videoPath) {
    const input = String(videoPath || '');
    const ext = path.extname(input);
    const folder = path.basename(path.dirname(input));
    if (CLIP_FOLDERS.has(folder)) {
        return path.join(path.dirname(path.dirname(input)), 'data', 'thumbnails', folder, `${path.basename(input, ext)}.jpg`);
    }
    return path.join(path.dirname(input), `${path.basename(input, ext)}.thumbnail.jpg`);
}
async function extractRenderedPoster(opts = {}) {
    try {
        if (!opts.input || !opts.output || typeof opts.extract !== 'function') {
            return opts.fallback || null;
        }
        // [DATA-DIR] data/thumbnails/<folder>/ does not exist until the first
        // poster of that folder; ffmpeg will not create it ("exited 251").
        await require('fs').promises.mkdir(path.dirname(opts.output), { recursive: true });
        const posterSpec = candidatePosterSpec(opts.format);
        const produced = await opts.extract({
            input: opts.input,
            output: opts.output,
            time: renderedPosterTime(opts.duration),
            posterSpec,
        });
        return produced || opts.output;
    }
    catch (error) {
        try {
            opts.onError?.(error);
        }
        catch { /* warning hooks are non-fatal too */ }
        return opts.fallback || null;
    }
}
async function extractCandidatePosters({ clips, sourceThumbnail, sessionDir, format = 'face', extract, limit = 2, }) {
    const input = Array.isArray(clips) ? clips : [];
    const results = new Array(input.length);
    let cursor = 0;
    const width = Math.max(1, Math.min(Number(limit) || 1, input.length || 1));
    const worker = async () => {
        while (true) {
            const index = cursor++;
            if (index >= input.length)
                return;
            const clip = input[index];
            const output = path.join(sessionDir, `candidate-${String(index + 1).padStart(2, '0')}.jpg`);
            const posterSpec = candidatePosterSpec(format);
            let thumbnail = sourceThumbnail || null;
            try {
                const produced = await extract({
                    clip,
                    index,
                    time: candidatePosterTime(clip),
                    output,
                    posterSpec,
                });
                thumbnail = produced || output;
            }
            catch { /* a poster is optional; keep the source fallback */ }
            results[index] = {
                ...clip,
                candidateId: candidateId(index, clip),
                index: index + 1,
                thumbnail,
                state: 'waiting',
            };
        }
    };
    await Promise.all(Array.from({ length: width }, worker));
    return results;
}
module.exports = {
    candidateId,
    remotePoster,
    youtubeVideoId,
    youtubePosterFromSource,
    candidatePosterTime,
    candidatePosterSpec,
    renderedPosterTime,
    renderedPosterPath,
    extractRenderedPoster,
    extractCandidatePosters,
};
