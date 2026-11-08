const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const media = require('../src/media-lifecycle');
const { buildAss } = require('../src/pipeline-inverse-v1').__test;
const source = ts.createSourceFile('renderer.js', fs.readFileSync(require.resolve('../src/renderer.js'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
function fn(name) {
  let found;
  function walk(n) { if (ts.isFunctionDeclaration(n) && n.name?.text === name) found = n.getText(source); else ts.forEachChild(n, walk); }
  walk(source); assert.ok(found, name); return found;
}

test('SOCL box and animation selections replace a hidden kinetic preset and repaint immediately', () => {
  const saved = [], calls = [];
  const context = { state: { cfg: { subtitleFont: 'Anton', subtitleFontSize: 90 } },
    exitProxy: () => calls.push('clean'), applyCE: () => calls.push('paint'), tickCE: () => calls.push('cue'), tickTitleLayer: () => calls.push('titles'),
    saveCfg: value => saved.push(value) };
  vm.runInNewContext(fn('selectSoclCaptionControls'), context);
  for (const patch of [{ subtitleBoxColor: '#f0fe00' }, { subtitleAnim: 'type' }, { subtitleAnim: 'rise' }]) {
    context.state.cfg.captionKinetic = 'cc_tinju_kuning'; context._ceKinCap = { id: '__kcap' }; context._lastCECue = 'stale';
    context.selectSoclCaptionControls(patch);
    assert.equal(context.state.cfg.captionKinetic, '');
    assert.equal(context._ceKinCap, null);
    assert.equal(context.state.cfg.subtitleFont, 'Anton');
    assert.equal(saved.at(-1).captionKinetic, '');
    assert.equal(context._lastCECue, '');
  }
  assert.deepEqual(calls, Array(3).fill(['clean', 'paint', 'cue', 'titles']).flat());
});

test('fresh clips recover captions and box tokens before Edit is ever opened', () => {
  const clip = { words: [{ text: 'Hello', start: .1, end: .5 }, { text: 'world', start: .5, end: 1 }] };
  const context = { state: { cfg: { subtitleWordsPerChunk: 1 } }, window: {}, autoChunkKin: () => false, console: { log() {} } };
  vm.runInNewContext(fn('ensureCueWords') + fn('ensureTokens') + fn('prepareClipCaptionPreview'), context);
  context.prepareClipCaptionPreview(clip);
  assert.equal(clip.cueWords.length, 2);
  assert.equal(clip.cueWords[0].tokens[0].text, 'Hello');
  assert.equal(clip.cueWords[1].start, .5);
  assert.equal(context.prepareClipCaptionPreview(clip), clip.cueWords);
});

test('baked titles do not suppress a separate live kinetic subtitle', () => {
  const layer = {}, kin = { id: '__kcap', text: 'Visible subtitle' }, painted = [];
  const context = { document: { getElementById: () => layer }, kinBlendLayerFor: () => null, kinSubtract: () => false,
    state: { clips: [{ titles: [{ id: 'baked-title' }] }], activeClip: 0, previewTitlesBurned: true, previewSubsBurned: false, cfg: {} },
    _dashKinCap: kin, els: { preview: { currentTime: 1, paused: true }, stage: { style: {}, clientHeight: 500, clientWidth: 300 } },
    paintTitleLayer: (_layer, titles) => painted.push(titles) };
  vm.runInNewContext(fn('tickDashTitles') + ';tickDashTitles();', context);
  assert.equal(painted.length, 1);
  assert.equal(painted[0].length, 1);
  assert.equal(painted[0][0].id, '__kcap');
});

test('first-render ASS has the same box and animation without editor-created tokens', () => {
  const bare = { start: 0, end: 1, text: 'TEST' };
  const tokens = { ...bare, tokens: [{ text: 'TEST' }] };
  const render = (cue, anim, kinetic = '') => buildAss([cue], 90, 'bw', 1000, 540, anim, false, [], 'face', 'Anton', { boxColor: '#f0fe00', rotation: -17 }, [], kinetic);
  for (const anim of ['none', 'rise', 'type']) {
    const initial = render(bare, anim, 'cc_tinju_kuning');
    assert.equal(initial, render(tokens, anim));
    assert.ok(initial.includes('\\p1'));
  }
  assert.notEqual(render(bare, 'none'), render(bare, 'type'));
});

test('initial paused video uses its rendered poster and does not skip the opening audio', () => {
  const video = { currentTime: 0, pause() {}, removeAttribute() {}, load() {} };
  const context = { MediaLifecycle: media, toFileURL: path => 'media:' + path };
  vm.runInNewContext(fn('setRenderedPreviewSource'), context);
  context.setRenderedPreviewSource(video, { file: 'rendered.mp4', thumbnail: 'rendered-captions.jpg' });
  assert.equal(video.poster, 'media:rendered-captions.jpg');
  assert.equal(video.src, 'media:rendered.mp4');
  assert.equal(video.currentTime, 0);
  context.setRenderedPreviewSource(video, { file: 'next.mp4' });
  assert.equal(video.poster, '');
});
