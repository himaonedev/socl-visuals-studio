'use strict';

const fs = require('fs');
const path = require('path');

// [TIDY-SESSION] keep in step with pipeline-inverse-v1.js SESSION_CLIP_SUBDIRS.
const SESSION_CLIP_SUBDIRS = new Set(['raw', 'subtitle', 'edited', 'crop-biasa', 'crop-gaming', 'hasil', 'burn-edited', '_clean']);
const ALLOWED_CLIP_FIELDS = new Set([
  'file',
  'thumbnail',
  'rawFile',
  'subsBurned',
  'splitCrop',
  'aiStickerCache',
  // [META-PERSIST] The per-clip metadata the user can actually edit — the
  // "Judul & Hook" fields and the AI "Regenerate" button. These were missing,
  // so BOTH paths only ever changed `clip.*` in renderer memory: nothing wrote
  // them back, and `clip.metaEdited = true` was set at both call sites but read
  // nowhere, which is the fingerprint of a save step that was planned and never
  // built. Reported symptom: regenerate a title, reopen the app, History reads
  // report.json again and the OLD title is back. `why` is the description field
  // (that is the name it carries in report.json — see the clip shape there).
  'title',
  'hook',
  'why',
  // [TITLE-PERSIST] The on-screen Titles the user places in the Caption Editor
  // and burns via Apply. Same fingerprint as the [META-PERSIST] and subsBurned
  // gaps above: the renderer set clip.titles / clip.titlesBurned /
  // clip.watermarkBurnedSnapshot in memory after Apply, but nothing wrote them
  // back — so on a History reopen the title (already baked into the delivered
  // file) was gone from the editor, and the next re-cut from the clean rawFile
  // dropped it from the new deliverable too (silent data loss). `titlesBurned`
  // and `watermarkBurnedSnapshot` are the live-overlay guards that stop the
  // dashboard from double-drawing what is already baked in.
  'titles',
  'titlesBurned',
  'watermarkBurnedSnapshot',
  // [SPLIT-TRACKPLAN] Split Apply clears these in memory (renderer.js) so a
  // stale smart-track plan can't resurrect its old framing on the next
  // render, but they were never allowlisted, so the clear never survived a
  // restart. Persisting them lets that in-memory clear actually stick.
  'trackPlan',
  'cropAspect',
  'cropRect',
  'cropKF',
]);

function sessionRootForOutput(outputFile) {
  const dir = path.dirname(String(outputFile || ''));
  return SESSION_CLIP_SUBDIRS.has(path.basename(dir)) ? path.dirname(dir) : dir;
}

function persistClipPatch({ outputFile, clipIndex, patch } = {}) {
  if (process.env.SOCL_NATIVE_REPORTS === '1') {
    return require('../engine/platform.cjs').persistReport({ outputFile, clipIndex, patch });
  }
  if (!outputFile || !Number.isInteger(clipIndex) || clipIndex < 0) {
    return { updated: false, reason: 'invalid-target' };
  }
  // [DATA-DIR] data/report.json, or the root one of a pre-2.4.7 session.
  const reportPath = require('./session-files').reportPathFor(sessionRootForOutput(outputFile));
  if (!fs.existsSync(reportPath)) {
    return { updated: false, reason: 'report-missing', reportPath };
  }

  let tempPath = null;
  try {
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    if (!Array.isArray(report.clips) || !report.clips[clipIndex]) {
      return { updated: false, reason: 'clip-missing', reportPath };
    }
    const safePatch = {};
    for (const [key, value] of Object.entries(patch || {})) {
      if (!ALLOWED_CLIP_FIELDS.has(key) || value === undefined) continue;
      // Poster extraction is deliberately best-effort. A null/empty result
      // must not destroy the last candidate/final still that the UI can show.
      if (key === 'thumbnail' && !value) continue;
      safePatch[key] = value;
    }
    if (!Object.keys(safePatch).length) {
      return { updated: false, reason: 'empty-patch', reportPath };
    }

    // Shallow merge at the clip level is correct AS LONG AS callers send whole
    // objects for object-typed fields (splitCrop, cropRect, cropKF) rather than
    // partial patches — {...x, splitCrop:{splitY:70}} would silently drop
    // faceRect/gameRect/kf/file2. Every current caller does send the whole
    // object; this comment is the contract, enforce it rather than adding a
    // deep-merge that would mask a caller sending a genuinely incomplete patch.
    report.clips[clipIndex] = { ...report.clips[clipIndex], ...safePatch };
    tempPath = `${reportPath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tempPath, JSON.stringify(report, null, 2));
    fs.renameSync(tempPath, reportPath);
    tempPath = null;
    return { updated: true, reportPath };
  } catch (error) {
    return { updated: false, error: error?.message || String(error), reportPath };
  } finally {
    if (tempPath) {
      try { fs.unlinkSync(tempPath); } catch { /* best-effort temp cleanup */ }
    }
  }
}

module.exports = {
  sessionRootForOutput,
  persistClipPatch,
};
