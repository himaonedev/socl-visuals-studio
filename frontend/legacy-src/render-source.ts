// app/src/render-source.js
// Which input a caption burn reads, and on which canvas. Pure, kept out of
// renderer.js so node tests can cover it. Loaded BOTH by the Electron renderer
// (script tag → window.RenderSource) and by node tests (require). Never touches
// the DOM.
//
// [SPLIT-BAKED] Split Studio BAKES two sources into one file: the frame is
// already composited and the audio is already mixed — or muted per source, see
// [SPLIT-MUTE] in pipeline-inverse-v1.js. From that point on the baked file IS
// the clip, and everything downstream has to read it rather than reach back
// past it.
//
// It did not. Both caption-burn payloads (buildCePayload for the Caption
// Editor, and the gallery batch loop) handed renderClipEdit `srcVideo`
// unconditionally, and resolveEditInput PREFERS re-cutting from srcVideo —
// the original single-source master, a plate that predates the split. So
// burning captions on a split clip quietly re-cut that master and returned a
// normal-framed clip; the app shipped a confirm() dialog admitting it rather
// than fixing it. Withholding srcVideo is the whole mechanism: it puts
// renderClipEdit on its burn-onto-this-file path, which composes captions over
// the baked frame and stream-copies the audio the user chose.
(function (root) {
  'use strict';

  // renderSourceFor(clip, resolvedFormat) → { srcVideo, clipFormat }
  //
  // `resolvedFormat` is what the caller already worked out from the clip's
  // aspect and the project setting (renderer.js's formatForAspect). It is
  // passed in rather than recomputed here so there is still exactly one place
  // that maps an aspect to a format.
  function renderSourceFor(clip, resolvedFormat) {
    // `null` — not `delete` — is how a split gets cleared (plain Crop Studio
    // apply, and the apply-crop persist patch both write null), so this has to
    // read as a plain truthiness test, not `'splitCrop' in clip`.
    const baked = !!(clip && (clip.splitCrop || clip.effectsBaked));
    return {
      srcVideo: baked ? null : ((clip && clip.srcVideo) || null),
      // vfForSplitScreen emits short × long — a 9:16 frame, always, whatever
      // the project format says. Passing 'landscape' through would have libass
      // lay the captions out for a 1920×1080 PlayRes and stretch them onto a
      // 1080×1920 frame. cropAspect is nulled when a split is applied, but the
      // project-level fallback format is not, so pin it here.
      clipFormat: clip && clip.splitCrop ? 'face' : resolvedFormat,
    };
  }

  const api = { renderSourceFor };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RenderSource = api;
})(typeof self !== 'undefined' ? self : this);
