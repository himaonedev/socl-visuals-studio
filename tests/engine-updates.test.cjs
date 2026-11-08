const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

test('engine-update RPC refreshes live binary paths and YouTube repair uses both installed paths', { timeout: 30000 }, async t => {
  const root = path.resolve(__dirname, '..');
  const tests = path.join(root, '.dev-tools/tests');
  fs.mkdirSync(tests, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(tests, 'updates-'));
  const fixture = `
    const Module=require('node:module');
    const fs=require('node:fs');
    const path=require('node:path');
    const root=${JSON.stringify(root)};
    const original=Module._load;
    let mock;
    Module._load=function(name,parent,isMain){
      if(name==='./bootstrap' && parent.filename.endsWith('engine-main.cjs')){
        if(!mock) {
          const bootstrap=original.call(this,name,parent,isMain);
          mock={...bootstrap,
            refreshYtdlp: async progress=>{ progress('yt-dlp fixture installed',1); return process.execPath; },
            refreshDeno: async progress=>{ progress('Deno fixture installed',1); return process.execPath; },
            refreshFfmpeg: async progress=>{ progress('FFmpeg fixture installed',1); return require(path.join(root,'node_modules/ffmpeg-static')); }
          };
        }
        return mock;
      }
      return original.call(this,name,parent,isMain);
    };
    require(path.join(root,'engine/server.cjs'));
  `;
  const child = spawn(process.execPath, ['-e', fixture], { cwd: root, env: { ...process.env, SOCL_APP_DATA: path.join(scratch, 'profile') }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = new Promise(resolve => child.once('close', resolve));
  const pending = new Map();
  const events = [];
  let id = 0, stderr = '';
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady=resolve; rejectReady=reject; });
  child.stderr.on('data', data => { stderr += data; });
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', line => {
    const message = JSON.parse(line);
    if (message.kind === 'ready') resolveReady();
    if (message.kind === 'fatal') rejectReady(new Error(message.error));
    if (message.kind === 'event') events.push(message);
    if (message.kind === 'response') {
      const item=pending.get(message.id);
      if(item) { pending.delete(message.id); message.error ? item.reject(new Error(message.error)) : item.resolve(message.result); }
    }
  });
  child.once('exit', code => { if(code) rejectReady(new Error(stderr)); });
  t.after(async () => {
    child.stdin.end();
    const timer=setTimeout(()=>child.kill(),3000);
    await closed; clearTimeout(timer);
  });
  function invoke(channel,...args) {
    return new Promise((resolve,reject)=>{ const key=++id; pending.set(key,{resolve,reject}); child.stdin.write(JSON.stringify({id:key,channel,args})+'\n'); });
  }
  await ready;
  assert.equal((await invoke('get-bin-paths')).ytdlp, null);
  assert.equal((await invoke('engines:update','ytdlp')).ok, true);
  assert.equal((await invoke('get-bin-paths')).ytdlp, process.execPath);
  const repaired=await invoke('engines:fixYoutube');
  assert.deepEqual(repaired,{ytdlp:true,deno:true});
  assert.equal((await invoke('get-bin-paths')).deno, process.execPath);
  const ffmpeg=await invoke('engines:update','ffmpeg');
  assert.equal(ffmpeg.ok, true);
  assert.ok(ffmpeg.version);
  assert.equal((await invoke('get-bin-paths')).ffmpeg, require('ffmpeg-static'));
  assert.equal((await invoke('engines:update','unknown')).ok,false);
  assert.ok(events.some(event=>event.channel==='engines-progress' && event.data.id==='deno'));
});
