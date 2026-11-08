const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');
const { spawn }: typeof import('node:child_process') = require('node:child_process');
const root = path.resolve(__dirname, '..');
const env: NodeJS.ProcessEnv = { ...process.env, CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS || '2' };

// Use Ninja when the Windows CMake tools provide it. Embedded debug info avoids
// the MSVC PDB server mismatch seen with the installed Visual Studio toolchain.
if (process.platform === 'win32') {
  const candidates = (env.PATH || '').split(path.delimiter).map(folder => path.join(folder, 'ninja.exe'));
  const programFiles = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  for (const version of ['18', '2022', '2026']) for (const edition of ['BuildTools', 'Community', 'Professional', 'Enterprise', 'Preview']) {
    candidates.push(path.join(programFiles, 'Microsoft Visual Studio', version, edition, 'Common7/IDE/CommonExtensions/Microsoft/CMake/Ninja/ninja.exe'));
  }
  const ninja = env.CMAKE_MAKE_PROGRAM || candidates.find(file => fs.existsSync(file));
  if (!env.CMAKE_GENERATOR && ninja) {
    env.CMAKE_GENERATOR = 'Ninja';
    env.CMAKE_MAKE_PROGRAM = ninja;
    env.PATH = path.dirname(ninja) + path.delimiter + env.PATH;
  }
  env.CMAKE_MSVC_DEBUG_INFORMATION_FORMAT ||= 'Embedded';
  env.CMAKE_POLICY_DEFAULT_CMP0141 ||= 'NEW';
  env.CMAKE_C_FLAGS_DEBUG ||= '/MDd /Z7 /Ob0 /Od /RTC1';
  env.CMAKE_CXX_FLAGS_DEBUG ||= '/MDd /Z7 /Ob0 /Od /RTC1';
  env.CMAKE_EXE_LINKER_FLAGS_DEBUG ||= '/INCREMENTAL:NO';
  // Archive only this project's generated Whisper cache if its generator changed.
  const target = path.resolve(env.CARGO_TARGET_DIR || path.join(root, 'src-tauri/target'));
  try {
    const projectReal = fs.realpathSync(root);
    const targetReal = fs.realpathSync(target);
    if (targetReal.startsWith(projectReal + path.sep) && process.argv.slice(2).some(arg => arg === 'dev' || arg === 'build')) {
      const builds = path.join(targetReal, 'debug/build');
      for (const name of fs.readdirSync(builds).filter(name => name.startsWith('whisper-rs-sys-'))) {
        const cache = path.resolve(builds, name, 'out/build');
        const file = path.join(cache, 'CMakeCache.txt');
        if (!fs.existsSync(file)) continue;
        const old = /^CMAKE_GENERATOR:INTERNAL=(.+)$/m.exec(fs.readFileSync(file, 'utf8'))?.[1].trim();
        if (old && env.CMAKE_GENERATOR && old !== env.CMAKE_GENERATOR) {
          const backup = cache + '-previous-' + Date.now();
          if (cache.startsWith(targetReal + path.sep) && backup.startsWith(targetReal + path.sep)) fs.renameSync(cache, backup);
        }
      }
    }
  } catch { /* A missing cache needs no migration. Cargo reports actual build failures. */ }
}
const cli = path.join(path.dirname(require.resolve('@tauri-apps/cli/package.json')), 'tauri.js');
const mode = require('./dev-mode.cjs').configureDevMode(process.argv.slice(2), env);
if (mode.watch === false) console.log('Dev stabil: auto-restart dan reload dimatikan. Restart manual untuk memuat perubahan kode.');
if (mode.watch === true) console.log('Dev otomatis: auto-restart Rust dan reload frontend aktif. Mode stabil: pnpm tauri dev --no-watch');
const child = spawn(process.execPath, [cli, ...mode.args], { cwd: root, env: mode.env, stdio: 'inherit', windowsHide: true });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));


