const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const manifestPath = path.join(root, 'backend/modules.json');

function buildBackend({ check = false, modules: selectedModules, label = 'Backend' } = {}) {
  const modules = selectedModules || JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const outputs = [];
  for (const item of modules) {
    const source = fs.readFileSync(path.join(root, item.source), 'utf8');
    const result = ts.transpileModule(source, {
      fileName: item.source, reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, alwaysStrict: false, ignoreDeprecations: '6.0', removeComments: false },
    });
    const errors = (result.diagnostics || []).filter(d => d.category === ts.DiagnosticCategory.Error);
    if (errors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(errors, {
      getCanonicalFileName: f => f, getCurrentDirectory: () => root, getNewLine: () => '\n',
    }));
    const output = '// Generated from ' + item.source + ' by scripts/backend.cjs. Edit the TypeScript source.\n' + result.outputText;
    const destination = path.join(root, item.output);
    outputs.push({ destination, output });
  }
  if (!check) for (const { destination, output } of outputs) {
    if (fs.existsSync(destination) && fs.readFileSync(destination, 'utf8') === output) continue;
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const temporary = destination + '.tmp-' + process.pid;
    fs.writeFileSync(temporary, output);
    fs.renameSync(temporary, destination);
  }
  console.log(`${label} TypeScript: ${modules.length} modules ${check ? 'syntax checked' : 'compiled'}.`);
}
module.exports = { buildBackend };
if (require.main === module) buildBackend({ check: process.argv.includes('--check') });
