// Generated from frontend/legacy-src/clip-select.ts by scripts/backend.cjs. Edit the TypeScript source.
// app/src/clip-select.js
// Pure multi-select-set helper for the gallery's "Pilih" mode. Loaded BOTH by
// the Electron renderer (script tag → window.ClipSelect) and by node tests
// (require). Never touches the DOM — renderer.js owns turning this state
// into checkboxes/highlights. Indices are gallery indices (state.clips[i]),
// the same integers batchRenderClips(indices) already accepts.
(function (root) {
    'use strict';
    // createSelection() → { toggle, has, list, size, selectAll, clear }
    //   toggle(i)      — add i if absent, remove if present.
    //   has(i)         — membership check.
    //   list()         — ascending array snapshot (safe to hand to
    //                    batchRenderClips directly).
    //   size()         — current count.
    //   selectAll(arr) — replace the set with the given indices (deduped).
    //   clear()        — empty the set.
    function createSelection() {
        let set = new Set();
        function toggle(i) {
            if (set.has(i))
                set.delete(i);
            else
                set.add(i);
        }
        function has(i) { return set.has(i); }
        function list() { return Array.from(set).sort((a, b) => a - b); }
        function size() { return set.size; }
        function selectAll(indices) { set = new Set(indices); }
        function clear() { set = new Set(); }
        return { toggle, has, list, size, selectAll, clear };
    }
    const api = { createSelection };
    if (typeof module !== 'undefined' && module.exports)
        module.exports = api;
    else
        root.ClipSelect = api;
})(typeof self !== 'undefined' ? self : this);
