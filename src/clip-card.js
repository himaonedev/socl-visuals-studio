// Generated from frontend/legacy-src/clip-card.ts by scripts/backend.cjs. Edit the TypeScript source.
// Pure metadata model for the Detected Clips gallery. Loaded by both the
// Electron renderer and Node tests; it never touches the DOM or filesystem.
(function (root) {
    'use strict';
    function clean(value) {
        return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    }
    function ratioFor(format) {
        const key = clean(format).toLowerCase();
        if (key === 'landscape')
            return 'landscape';
        if (key === 'square')
            return 'square';
        return 'portrait';
    }
    function durationSeconds(clip) {
        const direct = Number(clip?.dur);
        if (Number.isFinite(direct))
            return Math.max(0, direct);
        const start = Number(clip?.start);
        const end = Number(clip?.end);
        return Number.isFinite(start) && Number.isFinite(end)
            ? Math.max(0, end - start)
            : 0;
    }
    function formatDuration(seconds) {
        const whole = Math.max(0, Math.round(Number(seconds) || 0));
        const minutes = Math.floor(whole / 60);
        const secs = whole % 60;
        return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }
    function transcriptExcerpt(words, limit = 15) {
        if (!Array.isArray(words))
            return '';
        const tokens = words.map(word => clean(word?.text)).filter(Boolean);
        if (!tokens.length)
            return '';
        const excerpt = tokens.slice(0, limit).join(' ');
        return tokens.length > limit ? `${excerpt}…` : excerpt;
    }
    function model(clip = {}, index = 0, format = 'face') {
        const rawScore = Number(clip.score);
        const score = Math.max(0, Math.min(10, Math.round(Number.isFinite(rawScore) ? rawScore : 0)));
        const hot = typeof clip.isHot === 'boolean' ? clip.isHot : score >= 8;
        const number = String(Math.max(0, Number(index) || 0) + 1).padStart(2, '0');
        return {
            number,
            score,
            scoreText: `${score}/10`,
            tier: hot ? 'hot' : (score >= 5 ? 'warm' : 'cool'),
            hot,
            duration: formatDuration(durationSeconds(clip)),
            category: clean(clip.category).toUpperCase() || 'HIGHLIGHT',
            title: clean(clip.title) || clean(clip.hook) || `Clip ${number}`,
            // AI descriptions are preferred. Offline/local detection still carries
            // timed transcript words, so use a short grounded excerpt instead of
            // leaving the entire detail row blank.
            description: clean(clip.why || clip.description)
                || transcriptExcerpt(clip.words),
            ratio: ratioFor(format),
        };
    }
    const api = { model, ratioFor, durationSeconds, formatDuration, transcriptExcerpt };
    if (typeof module !== 'undefined' && module.exports)
        module.exports = api;
    else
        root.ClipCard = api;
})(typeof self !== 'undefined' ? self : this);
