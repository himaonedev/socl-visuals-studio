// Generated from backend/src/edit-input.ts by scripts/backend.cjs. Edit the TypeScript source.
// Shared by pipeline.js AND pipeline-inverse-v1.js (the active pipeline —
// see the require() in main.js). Kept in its own tiny module so neither
// pipeline has to require the other just for this helper.
const fs = require('fs');
// Pure decision helper for renderClipEdit's input selection: prefer re-cutting
// from the original source (srcVideo) — subtitles are burned onto a clean
// plate, so nothing ever stacks. Only fall back to the legacy path (burn
// directly onto srcFile) when srcVideo is missing/unreadable or the clip's
// start/end aren't known. `exists` is injectable so this is testable without
// touching the filesystem.
function resolveEditInput({ srcVideo, clipStart, clipEnd, srcFile, exists = fs.existsSync }) {
    const canRecut = !!srcVideo && exists(srcVideo) && clipStart != null && clipEnd != null;
    return canRecut
        ? { mode: 'recut', input: srcVideo }
        : { mode: 'legacy', input: srcFile };
}
module.exports = { resolveEditInput };
