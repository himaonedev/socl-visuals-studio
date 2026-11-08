const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
require('./legacy-typescript.cjs').buildLegacyTypeScript();
function writePrepared(file, content) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  if (fs.existsSync(file) && fs.readFileSync(file).equals(bytes)) return;
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, bytes);
  fs.renameSync(temporary, file);
}
const legacy = path.join(root, 'public/legacy');
fs.mkdirSync(legacy, { recursive: true });
fs.mkdirSync(path.join(root, 'frontend'), { recursive: true });
const html = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
const scripts = [...html.matchAll(/<script\s+src="([^"]+)"\s*><\/script>/g)].map(match => match[1]);
const allowed = new Set(['preload.js', ...scripts]);
for (const name of fs.readdirSync(legacy)) {
  if (name.endsWith('.js') && !allowed.has(name)) fs.unlinkSync(path.join(legacy, name));
}
let body = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html)[1]
  .replace(/<script\b[\s\S]*?<\/script>/gi, '')
  .replace(/<span\b[^>]*id="licenseBadge"[^>]*>[\s\S]*?<\/span>/i, '')
  .replace(/<!-- License -->\s*<section\b[^>]*id="sv_secLicense"[\s\S]*?<\/section>/i, '')
  .replace(/<(button|a)\b[^>]*(?:data-section|data-target|href)="(?:#)?sv_secLicense"[^>]*>[\s\S]*?<\/\1>/gi, '');
writePrepared(path.join(root, 'frontend/legacy.html'), body);
for (const entry of fs.readdirSync(path.join(root, 'src'), { withFileTypes: true })) {
  if (entry.isFile() && entry.name !== 'renderer.js' && (/\.css$/.test(entry.name) || scripts.includes(entry.name))) {
    writePrepared(path.join(legacy, entry.name), fs.readFileSync(path.join(root, 'src', entry.name)));
  }
}
fs.cpSync(path.join(root, 'assets'), path.join(root, 'public/assets'), {
  recursive: true,
  filter: (source, destination) => {
    if (fs.statSync(source).isDirectory()) return true;
    // Parallel preparations must not repeatedly overwrite the same font/image.
    try { return !fs.readFileSync(source).equals(fs.readFileSync(destination)); }
    catch (error) { if (error.code === 'ENOENT') return true; throw error; }
  },
});
const rendererPath = path.join(legacy, 'renderer.js');
const renderer = fs.readFileSync(path.join(root, 'src/renderer.js'), 'utf8');
const sf = ts.createSourceFile('renderer.js', renderer, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const edits = [];
function walk(n) {
  if (ts.isFunctionDeclaration(n) && n.name?.text === 'toFileURL') {
    edits.push([n.getStart(sf), n.end, 'function toFileURL(p) { return window.__soclMediaUrl(p); }']); return;
  }
  if ((ts.isFunctionDeclaration(n) && n.name?.text === 'refreshLicenseBadge') ||
      (ts.isExpressionStatement(n) && /^(refreshLicenseBadge|refreshLicense)\(/.test(n.expression.getText(sf))) ||
      (ts.isVariableStatement(n) && n.declarationList.declarations.some(d => ts.isIdentifier(d.name) && ['refreshLicense', 'shortId', 'shortMachine'].includes(d.name.text))) ||
      (ts.isExpressionStatement(n) && /^\$id\('sv_lic(Purchase|Refresh)'\)\.addEventListener/.test(n.expression.getText(sf)))) {
    edits.push([n.getStart(sf), n.end, '']); return;
  }
  ts.forEachChild(n, walk);
}
walk(sf);
let cleaned = renderer;
for (const [first, last, replacement] of edits.sort((a, b) => b[0] - a[0])) cleaned = cleaned.slice(0, first) + replacement + cleaned.slice(last);
writePrepared(rendererPath, cleaned);
const preload = fs.readFileSync(path.join(root, 'src/preload.js'), 'utf8');
writePrepared(path.join(legacy, 'preload.js'), preload);
writePrepared(path.join(root, 'frontend/legacy-scripts.json'), JSON.stringify(['preload.js', ...scripts], null, 2));
console.log(`Prepared ${scripts.length} UI scripts with Tauri preload; removed license UI and handlers.`);
