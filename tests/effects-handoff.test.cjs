const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('served legacy handoff includes clean video and changing timed captions', () => {
  const root = path.resolve(__dirname, '..');
  const source = fs.readFileSync(path.join(root, 'src/renderer.js'), 'utf8');
  const served = fs.readFileSync(path.join(root, 'public/legacy/renderer.js'), 'utf8');
  const marker = 'window.__soclCurrentClip = () =>';
  assert.ok(served.includes(marker));
  assert.equal(served.slice(served.lastIndexOf(marker)), source.slice(source.lastIndexOf(marker)), 'Regenerate the legacy UI before serving it');
  const context = {
    window: {}, state: { currentPreviewIdx: 0, activeClip: -1, clips: [{
      file: 'rendered.mp4', rawFile: 'raw.mp4', subsBurned: true,
      cueWords: [{ text: 'Pertama', start: 0, end: 2 }, { text: 'Berikutnya', start: 2, end: 4 }],
    }] }, ensureCueWords() {},
  };
  vm.runInNewContext(served.slice(served.lastIndexOf(marker)), context);
  const clip = context.window.__soclCurrentClip();
  assert.equal(clip.cleanPath, 'raw.mp4');
  const at = time => clip.captions.find(cue => cue.start <= time && time < cue.end)?.text;
  assert.equal(at(1), 'Pertama');
  assert.equal(at(3), 'Berikutnya');
});

test('applying Effects updates the original clip while preserving SOCL captions', async () => {
  const served = fs.readFileSync(path.resolve(__dirname, '../public/legacy/renderer.js'), 'utf8');
  const captions = [{ text: 'Tetap diedit di SOCL', start: 0, end: 2 }];
  const clip = { file: 'rendered.mp4', rawFile: 'raw.mp4', subsBurned: true, cueWords: captions };
  let preview;
  const context = { window: {}, state: { clips: [clip] }, renderGallery() {}, loadPreview(index) { preview = index; }, toast() {} };
  vm.runInNewContext(served.slice(served.lastIndexOf('window.__soclApplyEffects =')), context);
  await context.window.__soclApplyEffects({ originalPath: 'rendered.mp4', clipIndex: 0, path: 'effect.mp4' });
  assert.equal(clip.file, 'effect.mp4');
  assert.equal(clip.rawFile, 'effect.mp4');
  assert.equal(clip.subsBurned, false);
  assert.equal(clip.effectsBaked, true);
  assert.equal(clip.cueWords, captions);
  assert.equal(preview, 0);
  await assert.rejects(context.window.__soclApplyEffects({ originalPath: 'other.mp4', clipIndex: 0, path: 'wrong.mp4' }));
  assert.equal(clip.file, 'effect.mp4');
});

test('applying caption edits preserves the clean video and saves the editable project', async () => {
  const served = fs.readFileSync(path.resolve(__dirname, '../public/legacy/renderer.js'), 'utf8');
  const clip = { file: 'effect.mp4', rawFile: 'effect.mp4', effectsBaked: true };
  const context = { window: {}, state: { clips: [clip] }, renderGallery() {}, loadPreview() {}, toast() {} };
  vm.runInNewContext(served.slice(served.lastIndexOf('window.__soclApplyEffects =')), context);
  const captionProject = { name: 'Custom subtitle preset', tracks: [] };
  await context.window.__soclApplyEffects({ originalPath: 'effect.mp4', clipIndex: 0, path: 'captioned.mp4', cleanFile: 'effect.mp4', captionProject });
  assert.equal(clip.file, 'captioned.mp4');
  assert.equal(clip.rawFile, 'effect.mp4');
  assert.equal(clip.captionProject, captionProject);
  assert.equal(clip.subsBurned, true);
  assert.equal(clip.effectsBaked, true);
});

test('Effects finds the rendered clip even when the preview still points to an unfinished candidate', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../src/renderer.js'), 'utf8');
  const context = {window:{},state:{currentPreviewIdx:0,activeClip:-1,clips:[{candidateId:'waiting'},{file:'ready.mp4',rawFile:'raw.mp4'}]},ensureCueWords(){}};
  vm.runInNewContext(source.slice(source.lastIndexOf('window.__soclCurrentClip =')),context);
  assert.equal(context.window.__soclCurrentClip().path,'ready.mp4');
  assert.equal(context.window.__soclCurrentClip().clipIndex,1);
});
