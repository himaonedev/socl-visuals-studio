const { spawnSync } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
for (const mode of ['0', '1']) {
  const source = `import assert from 'node:assert/strict';
    import { loadConfigFromFile } from 'vite';
    const loaded=await loadConfigFromFile({command:'serve',mode:'development'},'vite.config.mts');
    const watch=process.env.SOCL_DEV_WATCH==='1';
    assert.equal(loaded.config.server.hmr,watch);
    if(watch) assert.ok(loaded.config.server.watch); else assert.equal(loaded.config.server.watch,null);`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: root, env: { ...process.env, SOCL_DEV_WATCH: mode }, stdio: 'inherit', windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log('Vite verified: default dev enables HMR/watching; --no-watch disables automatic editing.');
