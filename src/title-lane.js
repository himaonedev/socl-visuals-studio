// Generated from frontend/legacy-src/title-lane.ts by scripts/backend.cjs. Edit the TypeScript source.
// app-editor-work/src/title-lane.js
// Pure row-packing for the Caption Studio timeline's Title lane. Loaded BOTH
// by the Electron renderer (script tag → window.TitleLane) and by node tests
// (require). Never touch the DOM here — mirrors the cue-retime.js pattern.
(function (root) {
    'use strict';
    // assignRows(titles) → { rows, rowCount }
    //   rows      — NEW array (titles are shallow-copied, never mutated),
    //               sorted by `start` (stable — ties keep input order), each
    //               entry carries a `_row` (0-based) telling the caller which
    //               sub-row of the lane to draw it on.
    //   rowCount  — how many sub-rows are needed (0 for empty input).
    //
    // Greedy interval scheduling: titles are laid out in start-time order: put
    // each title on the first row whose last-placed title has ALREADY ended
    // (end <= this title's start). Rows are opened lazily, so the result is the
    // minimum row count needed for on-screen legibility (not necessarily the
    // theoretical graph-coloring minimum, but same idea most video editors use
    // and it never needs more rows than the max simultaneous overlap count).
    function assignRows(titles) {
        const list = (Array.isArray(titles) ? titles : [])
            .map((t, i) => ({ ...t, _origIndex: i }));
        list.sort((a, b) => {
            const d = (+a.start || 0) - (+b.start || 0);
            return d !== 0 ? d : a._origIndex - b._origIndex;
        });
        const rowEnds = []; // rowEnds[r] = end time of the last title placed on row r
        for (const t of list) {
            const s = Number.isFinite(+t.start) ? +t.start : 0;
            const e = Number.isFinite(+t.end) ? +t.end : s;
            let row = 0;
            while (row < rowEnds.length && rowEnds[row] > s + 1e-9)
                row++;
            t._row = row;
            rowEnds[row] = e;
        }
        list.forEach(t => { delete t._origIndex; });
        return { rows: list, rowCount: rowEnds.length };
    }
    const api = { assignRows };
    if (typeof module !== 'undefined' && module.exports)
        module.exports = api;
    else
        root.TitleLane = api;
})(typeof self !== 'undefined' ? self : this);
