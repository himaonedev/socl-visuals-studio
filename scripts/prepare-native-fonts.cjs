// Build-time font metadata. The installed Rust backend reads data, never JS.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const fonts = path.join(root, 'assets/fonts');
const metrics = require('../src/font-metrics');
const normalize = name => String(name || '').replace(/\s+/g, ' ').trim().toLowerCase();
const faces = {};
const digest = crypto.createHash('sha256');
for (const name of fs.readdirSync(fonts)) {
  if (!/\.(ttf|otf)$/i.test(name)) continue;
  const bytes = fs.readFileSync(path.join(fonts, name));
  digest.update(name); digest.update(bytes);
  const face = metrics.__parseFace(bytes);
  if (!face) continue;
  const entry = { ratio: face.ratio, inkCenterEm: face.inkCenterEm, inkAscEm: face.inkAscEm, inkDescEm: face.inkDescEm, baselineOffsetEm: face.baselineOffsetEm };
  for (const alias of face.names) {
    const key = normalize(alias);
    if (!key) continue;
    faces[`${key}|${face.bold ? 'b' : ''}|${face.italic ? 'i' : ''}`] ??= entry;
    faces[key] ??= entry;
  }
}
const source = ts.createSourceFile('pipeline.js', fs.readFileSync(path.join(root, 'src/pipeline-inverse-v1.js'), 'utf8'), ts.ScriptTarget.Latest, true);
let styleText, trackingText;
function visit(node) {
  if (ts.isVariableDeclaration(node)) {
    if (node.name.getText(source) === 'SUB_STYLES') styleText = node.initializer.getText(source);
    if (node.name.getText(source) === 'TRACK_EM') trackingText = node.initializer.getText(source);
  }
  ts.forEachChild(node, visit);
}
visit(source);
if (!styleText || !trackingText) throw new Error('SOCL subtitle style metadata missing');
const styles = vm.runInNewContext('(' + styleText + ')', { TRACK_EM: vm.runInNewContext(trackingText) });
const dest = path.join(root, 'src-tauri/assets/socl-font-metrics.json');
const data = { sourceDigest: digest.digest('hex'), faces, styles };
const serialized = JSON.stringify(data, null, 2) + '\n';
if (!fs.existsSync(dest) || fs.readFileSync(dest, 'utf8') !== serialized) fs.writeFileSync(dest, serialized);
console.log(`Prepared Rust font metadata: ${Object.keys(faces).length} aliases, ${Object.keys(styles).length} styles`);
if (process.argv.includes('--fixtures')) {
  const request = Object.keys(styles).flatMap(style => [{ style }, { style, fn: 'TimesNewRomanMTStd-BoldCond' }]);
  request.push({ style: 'unknown' }, { style: 'bw', fn: 'Missing Font' }, { style: 'bw', fn: '  Open   Sauce Two ExtraBold ' });
  const expected = {};
  for (const item of request) {
    const spec = styles[item.style] || {};
    const requested = item.fn || '';
    const face = requested || spec.font || 'Open Sauce Two ExtraBold';
    const bold = !!spec.bold;
    const ink = metrics.fontInkExtentEm(face, fonts, bold, false) || metrics.fontInkExtentEm(face, fonts, false, false);
    const scale = metrics.fontEmScale(face, fonts, bold, false);
    expected[item.style + '|' + requested] = ink && ink.baselineEm != null && Number.isFinite(scale) && scale > 0 ? {
      face, emScale: scale, baselineEm: ink.baselineEm, capEm: ink.ascEm, descEm: ink.descEm,
      inkCenterEm: metrics.fontInkCenterEm(face, fonts, bold, false),
    } : null;
  }
  fs.writeFileSync(path.join(root, 'src-tauri/fixtures/socl-font-metrics.json'), JSON.stringify({ request, expected }, null, 2) + '\n');
}
