const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const live = require('../src/live-preview-state');
const media = require('../src/media-lifecycle');
const source = ts.createSourceFile('renderer.js', fs.readFileSync(require.resolve('../src/renderer.js'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
function extract(name, handler = false) {
  let text;
  function walk(node) {
    if (!handler && ts.isFunctionDeclaration(node) && node.name?.text === name) text = node.getText(source);
    else if (handler && ts.isCallExpression(node) && node.expression.getText(source) === 'window.socl.' + name) text = node.arguments[0].getText(source);
    else ts.forEachChild(node, walk);
  }
  walk(source); assert.ok(text, name); return text;
}
function setup() {
  const video = { src: 'url:source.mp4', currentTime: 3100, duration: 4114, getAttribute() { return this.src; } };
  const loaded = [];
  const context = {
    state: { clips: [{ candidateId: 'first', srcVideo: 'source.mp4', state: 'rendering' }], currentPreviewIdx: 0, activeClip: 0, cfg: {}, stepPct: [], running: true },
    els: { preview: video, statusLine: {}, pipePct: {}, progressFill: { style: {} }, runBtn: { dataset: {} } },
    LivePreviewState: live, wmMod: { resolveBurnedWmSnapshot: () => ({}) }, renderGallery() {}, toFileURL: p => 'url:' + p,
    PIPELINE_STEPS: [['Render']], prog: { set() {}, stop() {} }, renderSteps() {}, toast() {},
    showPosterPreview() { video.src = 'url:source.mp4'; }, console,
  };
  context.loadPreview = (index) => {
    loaded.push(index); const clip = context.state.clips[index];
    video.src = 'url:' + clip.file; video.currentTime = 0; video.duration = 51;
    context.state.currentPreviewIdx = index;
    context.state.previewSubsBurned = !!clip.subsBurned;
    context.state.previewTitlesBurned = !!clip.titlesBurned;
  };
  vm.createContext(context);
  vm.runInContext(extract('syncCompletedClipPreview'), context);
  for (const name of ['onClip', 'onDone', 'onSourcePreview', 'onClipState']) vm.runInContext(`var ${name} = ${extract(name, true)};`, context);
  return { context, video, loaded };
}
const complete = () => ({ candidateId: 'first', file: 'final-caption-hook-broll.mp4', subsBurned: true, titlesBurned: true, brollBurned: true });

test('clip completion replaces the long source even though the selected gallery object already has a file', () => {
  const { context, video, loaded } = setup();
  context.onClip(complete());
  assert.deepEqual(loaded, [0]);
  assert.equal(video.src, 'url:final-caption-hook-broll.mp4');
  assert.equal(video.duration, 51); assert.equal(video.currentTime, 0);
  assert.equal(context.state.previewSubsBurned, true);
  assert.equal(context.state.previewTitlesBurned, true);
  assert.equal(context.state.clips[0].brollBurned, true);
});

test('pipeline completion repairs a stale source preview despite a valid current clip index', () => {
  const { context, video, loaded } = setup();
  context.state.clips = live.completeClip(context.state, complete()).clips;
  context.onDone({ clips: context.state.clips });
  assert.deepEqual(loaded, [0]);
  assert.equal(video.src, 'url:final-caption-hook-broll.mp4');
  assert.equal(context.state.running, false);
});

test('late source/progress events cannot overwrite a completed clip or rewind its playback', () => {
  const { context, video, loaded } = setup();
  context.onClip(complete()); video.currentTime = 7;
  context.onSourcePreview({ file: 'source.mp4' });
  context.onClipState({ candidateId: 'first', state: 'rendering' });
  context.onDone({ clips: context.state.clips });
  assert.equal(video.src, 'url:final-caption-hook-broll.mp4');
  assert.equal(video.currentTime, 7);
  assert.equal(context.state.clips[0].state, 'ready');
  assert.deepEqual(loaded, [0]);
});

test('another completed clip does not interrupt playback of the chosen result', () => {
  const { context, video, loaded } = setup();
  context.onClip(complete()); video.currentTime = 9;
  context.onClip({ candidateId: 'other', file: 'other.mp4', subsBurned: true });
  assert.equal(video.src, 'url:final-caption-hook-broll.mp4');
  assert.equal(video.currentTime, 9);
  assert.deepEqual(loaded, [0]);
});

test('a cancelled source metadata callback cannot seek the finished clip to a source timestamp', () => {
  class Video extends EventTarget {
    currentTime = 0; readyState = 0; src = '';
    getAttribute() { return this.src; }
    removeAttribute() { this.src = ''; }
    pause() {} load() {}
  }
  const video = new Video();
  const context = { state: { sourcePreview: { file: 'source.mp4' } }, els: { preview: video, captionTx: {}, captionOv: { style: {} }, sceneTag: {} }, MediaLifecycle: media, toFileURL: p => 'url:' + p, hidePosterPreview() {} };
  vm.runInNewContext(extract('showPosterPreview') + ";showPosterPreview({srcVideo:'source.mp4',start:3100},'Rendering');", context);
  media.setMediaSource(video, 'url:final.mp4');
  video.dispatchEvent(new Event('loadedmetadata'));
  assert.equal(video.currentTime, 0);
});
