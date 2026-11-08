// Generated from backend/src/session-files.ts by scripts/backend.cjs. Edit the TypeScript source.
// [DATA-DIR] Where a session keeps its app data. The user asked for it to be
// out of the way of the clips: report.json, pipeline.log, metadata.json,
// highlights.json, source.info.json, thumbnail.jpg, candidate-NN.jpg and the
// per-clip poster JPEGs live in <session>/data/. Writers always use data/;
// readers look in data/ first and then at the session root, which is where
// sessions made before 2.4.7 keep them.
const fs = require('fs');
const path = require('path');
const DATA_DIRNAME = 'data';
function dataPath(sessionDir, name) {
    return name ? path.join(sessionDir, DATA_DIRNAME, name) : path.join(sessionDir, DATA_DIRNAME);
}
// Existing report.json of a session: data/ (new) or the root (old). Returns
// the data/ path when neither exists, so a first write lands in data/.
function reportPathFor(sessionRoot) {
    const current = dataPath(sessionRoot, 'report.json');
    if (fs.existsSync(current))
        return current;
    const legacy = path.join(sessionRoot, 'report.json');
    return fs.existsSync(legacy) ? legacy : current;
}
module.exports = { DATA_DIRNAME, dataPath, reportPathFor };
