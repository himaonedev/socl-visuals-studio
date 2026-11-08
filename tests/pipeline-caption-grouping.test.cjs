const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const source = fs.readFileSync('backend/src/pipeline-inverse-v1.ts', 'utf8');
const tree = ts.createSourceFile('pipeline.ts', source, ts.ScriptTarget.Latest, true);
const context = vm.createContext({ stripSpeakerMarkers: s => s, cleanCueText: s => s, KT: {} });
for (const name of ['wpcNum', 'wpcMode', 'dedupeAndSplitCues', 'chunkWordsToCues']) {
  const node = tree.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  vm.runInContext(node.getText(tree), context);
}
test('explicit counts override automatic preset grouping; Auto preserves preset grouping', () => {
  for (const preset of ['cap_quote', 'cap_fokus_oranye', 'cap_estetik', 'cap_sauce_mix', '']) {
    for (const n of [1, 2, 3, 4, 5]) {
      context.cfg = { captionKinetic: preset, subtitleWordsPerChunk: n };
      assert.equal(vm.runInContext('wpcMode(cfg)', context), n);
    }
  }
  context.cfg = { captionKinetic: 'cap_quote', subtitleWordsPerChunk: 'auto' };
  assert.equal(vm.runInContext('wpcMode(cfg)', context), 'mix4');
});
test('single-word transcript segments become three-word captions', () => {
  context.cues = ['satu', 'dua', 'tiga', 'empat', 'lima', 'enam'].map((text, i) => ({ text, start: i, end: i + .8 }));
  const result = vm.runInContext('chunkWordsToCues(dedupeAndSplitCues(cues, 1), 3)', context);
  assert.deepEqual(Array.from(result, c => c.text), ['satu dua tiga', 'empat lima enam']);
  assert.equal(result[0].start, 0);
  assert.equal(result[0].end, 2.8);
  assert.ok(source.includes('chunkWordsToCues(dedupeAndSplitCues(slice, 1), wpcMode(cfg))'));
});
