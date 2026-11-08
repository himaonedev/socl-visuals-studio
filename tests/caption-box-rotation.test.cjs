const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const box = require('../src/caption-box');
const { buildAss } = require('../src/pipeline-inverse-v1').__test;

const cue = { start: 0, end: 1, text: 'TEST', tokens: [{ text: 'TEST', start: 0, end: 1 }] };
function ass(rotation) {
  return buildAss([cue], 90, 'bw', 1000, 540, 'none', false, [], 'face', 'Anton', { boxColor: '#00FF00', rotation });
}
test('box rotation changes only the box, preserving straight text and the zero-angle output', () => {
  assert.equal(ass(undefined), ass(0));
  const text = body => body.split('\n').filter(line => line.startsWith('Dialogue: 1,'));
  assert.deepEqual(text(ass(0)), text(ass(20)));
  assert.notEqual(ass(0), ass(20));
  assert.equal(box.boxRotation(Infinity), 0);
  assert.equal(box.boxRotation(-80), -45);
  assert.equal(box.boxRotation(80), 45);
});

test('live preview rotates a separate background while retaining the word and its text motion', () => {
  const { JSDOM } = require('jsdom');
  const ts = require('typescript');
  const vm = require('node:vm');
  const dom = new JSDOM('<span id="word" style="transform:translateY(4px)">TEST</span>');
  const source = ts.createSourceFile('renderer.js', fs.readFileSync(path.resolve(__dirname, '../src/renderer.js'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const helper = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'applyBoxRotationPreview');
  assert.ok(helper);
  const context = vm.createContext({ document: dom.window.document, window: { CaptionBox: box } });
  vm.runInContext(helper.getText(source), context);
  const word = dom.window.document.getElementById('word');
  context.applyBoxRotationPreview(word, '#00ff00', 20);
  assert.equal(word.textContent, 'TEST');
  assert.equal(word.style.transform, 'translateY(4px)');
  assert.equal(word.style.getPropertyValue('--cap-box-angle'), '20deg');
  assert.equal(word.style.background, 'transparent');
  assert.ok(word.classList.contains('cap-box-rotated'));
  context.applyBoxRotationPreview(word, '#00ff00', 0);
  assert.ok(!word.classList.contains('cap-box-rotated'));
  assert.equal(word.style.transform, 'translateY(4px)');
  dom.window.close();
});

test('real ASS render rotates the highlight about its centre without shifting the word', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'socl-box-rotation-'));
  const width = 540, height = 960;
  function render(angle) {
    const file = path.join(scratch, `angle-${angle}.ass`);
    fs.writeFileSync(file, ass(angle));
    const escaped = file.replaceAll('\\', '/').replaceAll(':', '\\:').replaceAll("'", "\\'");
    const fonts = path.resolve(__dirname, '../assets/fonts').replaceAll('\\', '/').replaceAll(':', '\\:');
    const run = spawnSync(require('ffmpeg-static'), ['-v', 'error', '-f', 'lavfi', '-i', `color=c=black:s=${width}x${height}:d=1`, '-vf', `ass='${escaped}':fontsdir='${fonts}'`, '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { windowsHide: true, timeout: 20000, maxBuffer: 8 * 1024 * 1024 });
    assert.equal(run.status, 0, run.stderr?.toString());
    const pixels = run.stdout;
    let n = 0, sx = 0, sy = 0, xx = 0, yy = 0, xy = 0;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 3;
      if (pixels[p + 1] > 120 && pixels[p] < 80 && pixels[p + 2] < 80) {
        n++; sx += x; sy += y; xx += x*x; yy += y*y; xy += x*y;
      }
    }
    assert.ok(n > 100, 'highlight must be visible');
    return { x: sx/n, y: sy/n, covariance: xy/n - sx*sy/(n*n), variance: xx/n - sx*sx/(n*n) - yy/n + sy*sy/(n*n) };
  }
  try {
    const straight = render(0), rotated = render(20), left = render(-20);
    assert.ok(Math.abs(straight.x - rotated.x) < 2 && Math.abs(straight.y - rotated.y) < 2, JSON.stringify({ straight, rotated }));
    assert.ok(rotated.covariance > straight.covariance + 5, 'positive angle tilts clockwise, like CSS');
    assert.ok(left.covariance < straight.covariance - 5, 'negative angle tilts the other way');
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});
