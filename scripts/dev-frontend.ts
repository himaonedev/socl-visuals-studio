require('./prepare-runtime.cjs');
require('./backend.cjs').buildBackend();
require('./prepare-native-fonts.cjs');
require('./prepare-ui.cjs');
const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');
const { spawnSync }: typeof import('node:child_process') = require('node:child_process');
const { isLegacyUiSource } = require('./dev-mode.cjs');
// Vite deliberately ignores legacy sources: serve their transformed copies,
// and regenerate those copies before asking the browser to reload.
import('vite').then(async vite => {
  const server = await vite.createServer();
  await server.listen();
  if (process.env.SOCL_DEV_WATCH === '0') return;
  const scripts: string[] = require('../frontend/legacy-scripts.json');
  const modules: Array<{ source: string; output: string }> = require('../frontend/legacy-modules.json');
  const generated = new Set(modules.map(item => path.basename(item.output)));
  const uiSources = new Set(modules.map(item => item.source.replaceAll('\\', '/')));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const refresh = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const result = spawnSync(process.execPath, [path.join(__dirname, 'prepare-ui.cjs')], { stdio: 'inherit' });
      if (result.status === 0) {
        server.moduleGraph.invalidateAll();
        server.ws.send({ type: 'full-reload' });
      }
      else console.error('Legacy UI preparation failed; fix the error before reloading.');
    }, 200);
  };
  const watcher = fs.watch(path.resolve(__dirname, '../src'), (_event, name) => {
    if (!name || generated.has(String(name)) || !isLegacyUiSource(String(name), scripts)) return;
    refresh();
  });
  const sourceWatchers = ['frontend/legacy-src', 'backend'].map(folder => fs.watch(path.resolve(__dirname, '..', folder), { recursive: true }, (_event, name) => {
    if (name && uiSources.has(`${folder}/${String(name).replaceAll('\\', '/')}`)) refresh();
  }));
  server.httpServer?.once('close', () => { clearTimeout(timer); watcher.close(); sourceWatchers.forEach(item => item.close()); });
}).catch(error => { console.error(error); process.exit(1); });
