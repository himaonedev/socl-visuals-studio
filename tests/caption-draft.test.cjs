const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('frontend/legacy-src/renderer.ts', 'utf8');
test('caption draft changes stay local and closing restores the last Apply checkpoint', async () => {
  const start = source.indexOf('  let savedCfg = structuredClone(state.cfg);');
  const end = source.indexOf('  let proxyMode', start);
  const context = vm.createContext({ structuredClone, state: { cfg: { subtitleStyle: 'old', subtitleAnim: 'fade' } }, clip: { file: 'old.mp4', cueWords: [{ text: 'original' }] }, persistClippingSession() {} });
  vm.runInContext('let rollbackCaptionDraft;\n' + source.slice(start, end), context);
  await vm.runInContext("saveCfg({subtitleStyle:'new'})", context);
  vm.runInContext("clip.cueWords[0].text='draft'; rollbackCaptionDraft()", context);
  assert.equal(context.state.cfg.subtitleStyle, 'old');
  assert.equal(context.clip.cueWords[0].text, 'original');
  vm.runInContext("state.cfg.subtitleStyle='applied'; clip.file='applied.mp4'; savedCfg=structuredClone(state.cfg); savedClip=structuredClone(clip); state.cfg.subtitleStyle='unapplied'; rollbackCaptionDraft()", context);
  assert.equal(context.state.cfg.subtitleStyle, 'applied');
  assert.equal(context.clip.file, 'applied.mp4');
});
test('explicit Fade keeps an opacity animation between adjacent captions in preview and render', () => {
  assert.match(source, /fade: 'capFade \.26s ease-out both'/);
  const backend = fs.readFileSync('backend/src/pipeline-inverse-v1.ts', 'utf8');
  assert.ok(backend.includes("anim === 'fade' ? cueDialogue(c, ci) : applyCueContinuity"));
});
