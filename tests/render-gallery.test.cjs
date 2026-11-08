const { test } = require('node:test');
const assert = require('node:assert/strict');
const live = require('../src/live-preview-state.js');

test('keeps the previous rendered gallery until the replacement render finishes', () => {
  const old = [{ candidateId: 'old', file: 'previous.mp4', thumbnail: 'previous.jpg' }];
  let state = live.beginRun({ clips: old, activeClip: 0, currentPreviewIdx: 0 });
  assert.equal(state.clips, old);
  state = live.setCandidates(state, [{ candidateId: 'new' }]);
  state = live.setCandidateState(state, { candidateId: 'new', state: 'rendering' });
  assert.equal(state.clips, old);
  state = live.completeClip(state, { candidateId: 'new', file: 'replacement.mp4' });
  assert.equal(state.clips, old);
  state = live.finishRun(state, true);
  assert.equal(state.clips[0].file, 'replacement.mp4');
  assert.equal(state.currentPreviewIdx, -1);
  assert.equal(state.retainPreviousClips, false);
});

test('failed replacement keeps the old result, while a first run still displays live candidates', () => {
  const old = [{ candidateId: 'old', file: 'previous.mp4' }];
  let state = live.beginRun({ clips: old, activeClip: 0, currentPreviewIdx: 0 });
  state = live.completeClip(state, { candidateId: 'new', file: 'partial.mp4' });
  state = live.finishRun(state, false);
  assert.equal(state.clips, old);
  assert.deepEqual(state.pendingClips, []);
  let first = live.beginRun({ clips: [] });
  first = live.setCandidates(first, [{ candidateId: 'first' }]);
  assert.equal(first.clips.length, 1);
  first = live.completeClip(first, { candidateId: 'first', file: 'first.mp4' });
  assert.equal(first.clips[0].file, 'first.mp4');
});

test('reload restores the previous clip and staged render without storing configuration secrets', () => {
  let state=live.beginRun({clips:[{file:'old.mp4'}],currentPreviewIdx:0,activeClip:0,cfg:{apiKey:'must-not-be-stored'}});
  state=live.setSourcePreview(state,{file:'master.mp4'});
  state=live.completeClip(state,{candidateId:'new',file:'new.mp4'});
  const text=live.snapshot({...state,running:true});
  assert.equal(text.includes('must-not-be-stored'),false);
  const restored=live.restoreSnapshot(text);
  assert.equal(restored.clips[0].file,'old.mp4');
  assert.equal(restored.sourcePreview.file,'master.mp4');
  assert.equal(restored.pendingClips[0].file,'new.mp4');
  assert.equal(restored.running,true);
  assert.equal(live.finishRun(restored,true).clips[0].file,'new.mp4');
  assert.equal(live.restoreSnapshot('invalid'),null);
});
