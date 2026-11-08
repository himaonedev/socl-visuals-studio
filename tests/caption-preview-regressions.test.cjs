const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const media = require('../src/media-lifecycle.js');
const live = require('../src/live-preview-state.js');
const source = ts.createSourceFile('renderer.js',fs.readFileSync(require.resolve('../src/renderer.js'),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
function functionText(name) {
  let result;
  function walk(node) { if (ts.isFunctionDeclaration(node) && node.name?.text===name) result=node.getText(source); else ts.forEachChild(node,walk); }
  walk(source); assert.ok(result, name); return result;
}
class Video extends EventTarget {
  constructor() { super(); this.currentTime=34;this.duration=80;this.paused=true;this.readyState=0;this.attrs={};this.events=[]; }
  set src(value) { this.events.push(['src',value,this.crossOrigin]);this.attrs.src=value; }
  get src() { return this.attrs.src || ''; }
  getAttribute(key) { return this.attrs[key] || null; }
  removeAttribute(key) { delete this.attrs[key]; }
  load() { this.currentTime=0; }
  pause() { this.paused=true; }
  play() { this.paused=false;return Promise.resolve(); }
}

test('filmstrip opts into CORS before loading and does not miss fast decoded frames', async () => {
  const video=new Video();
  video.load=()=>{video.readyState=2;video.dispatchEvent(new Event('loadeddata'));};
  await media.loadCanvasVideo(video,'http://localhost/scoped/video.mp4',100);
  assert.deepEqual(video.events,[['src','http://localhost/scoped/video.mp4','anonymous']]);
  Object.defineProperty(video,'currentTime',{get:()=>12,set:()=>video.dispatchEvent(new Event('seeked'))});
  await media.seekFrame(video,20,100);
});

test('style repaint cannot draw live captions over a burned proxy or loading source', () => {
  for (const flags of [{proxyMode:true,cleanSourceLoading:false},{proxyMode:false,cleanSourceLoading:true}]) {
    const context={...flags,ov:{style:{visibility:'visible'}},stageH(){throw new Error('must not paint live captions');}};
    vm.runInNewContext(functionText('applyCE')+';applyCE();',context);
    assert.equal(context.ov.style.visibility,'hidden');
  }
});

test('leaving the burned proxy restores the clean video at the same playhead before painting captions', () => {
  const video=new Video();let painted=0;
  const context={proxyMode:true,cleanSourceLoading:false,clip:{file:'burned.mp4',rawFile:'raw.mp4',subsBurned:true},vid:video,ov:{style:{}},MediaLifecycle:media,toFileURL:p=>p,_lastCECue:'old',applyCE:()=>painted++,tickCE:()=>painted++};
  vm.runInNewContext(functionText('exitProxy')+';exitProxy();',context);
  assert.equal(context.cleanSourceLoading,true);assert.equal(painted,0);
  assert.equal(video.src,'raw.mp4');
  video.dispatchEvent(new Event('loadedmetadata'));
  assert.equal(video.currentTime,34);assert.equal(context.cleanSourceLoading,false);assert.equal(painted,2);
});

test('first render can show source footage before a finished clip or thumbnail exists', () => {
  const video=new Video();let revealed=false;
  const state=live.setCandidates(live.setSourcePreview(live.beginRun({clips:[]}),{file:'master.mp4'}),[{srcVideo:'master.mp4',start:12}]);
  assert.equal(state.sourcePreview.file,'master.mp4');
  const context={state,els:{preview:video,captionTx:{},captionOv:{style:{}},sceneTag:{}},MediaLifecycle:media,toFileURL:p=>p,hidePosterPreview(){revealed=true;}};
  vm.runInNewContext(functionText('showPosterPreview')+`;showPosterPreview({srcVideo:'master.mp4',start:12},'Rendering');`,context);
  video.dispatchEvent(new Event('loadedmetadata'));
  assert.equal(video.src,'master.mp4');assert.equal(video.currentTime,12);assert.equal(revealed,true);
});

test('selecting an ordinary SOCL style replaces the active comic template and clears its stale layer', () => {
  const calls=[],saved=[];
  const context={state:{cfg:{subtitleStyle:'bw',captionKinetic:'cc_komik_kuning',subtitleFont:'Anton',subtitleFontSize:115}},
    _ceKinCap:{id:'__kcap'},_lastCECue:'previous',exitProxy:()=>calls.push('clean'),applyCE:()=>calls.push('style'),tickCE:()=>calls.push('cue'),tickTitleLayer:()=>calls.push('layers'),saveCfg:patch=>saved.push(patch),commitHist:()=>calls.push('undo')};
  vm.runInNewContext(functionText('selectCaptionStyle')+`;selectCaptionStyle('bw_neon_green');`,context);
  assert.equal(context.state.cfg.subtitleStyle,'bw_neon_green');
  assert.equal(context.state.cfg.captionKinetic,'');
  assert.equal(context.state.cfg.subtitleFont,'Anton');
  assert.equal(context.state.cfg.subtitleFontSize,115);
  assert.equal(context._ceKinCap,null);
  assert.equal(saved[0].captionKinetic,'');
  assert.deepEqual(calls,['clean','style','cue','layers','undo']);
  assert.match(fs.readFileSync(require.resolve('../src/renderer.js'),'utf8'),/CFG_HIST_FIELDS = \[[^\]]*'captionKinetic'/);
});

test('opening and leaving Effects keeps the clipping list and restores its paused playhead', () => {
  const video=new Video(),clips=[{file:'ready.mp4'}];
  let restoredIndex=-1;
  const context={window:{__soclCurrentClip:()=>({path:'ready.mp4',clipIndex:0})},effectsClippingBookmark:null,
    LivePreviewState:live,state:{clips},els:{preview:video},renderGallery(){},loadPreview(index){restoredIndex=index;video.load();},toast(){throw new Error('unexpected toast');}};
  vm.runInNewContext(functionText('prepareClippingForEffects')+';'+functionText('resumeClippingAfterEffects')+';prepareClippingForEffects();resumeClippingAfterEffects();',context);
  video.dispatchEvent(new Event('loadedmetadata'));
  assert.equal(context.state.clips,clips);
  assert.equal(context.state.clips[0].file,'ready.mp4');
  assert.equal(restoredIndex,0);
  assert.equal(video.currentTime,34);
  assert.equal(video.paused,true);
});

test('returning from Effects restores the clipping snapshot if its list was reset to zero', () => {
  const video=new Video(),values=new Map();let rendered=0;
  const context={window:{__soclCurrentClip:()=>({path:'downloaded-and-clipped.mp4',clipIndex:0})},effectsClippingBookmark:null,LivePreviewState:live,
    sessionStorage:{setItem:(key,value)=>values.set(key,value),getItem:key=>values.get(key),removeItem:key=>values.delete(key)},
    state:{clips:[{file:'downloaded-and-clipped.mp4',rawFile:'clean.mp4',title:'Klip tersimpan'}],activeClip:0,currentPreviewIdx:0},els:{preview:video},
    renderGallery(){rendered=context.state.clips.length;},loadPreview(){video.load();},toast(){}};
  vm.runInNewContext(functionText('prepareClippingForEffects')+';'+functionText('resumeClippingAfterEffects')+';prepareClippingForEffects();',context);
  context.state.clips=[];
  // Also simulate losing the in-memory bookmark during a frontend refresh.
  context.effectsClippingBookmark=null;
  vm.runInNewContext('resumeClippingAfterEffects();',context);
  video.dispatchEvent(new Event('loadedmetadata'));
  assert.equal(rendered,1);
  assert.equal(context.state.clips[0].file,'downloaded-and-clipped.mp4');
  assert.equal(context.state.clips[0].rawFile,'clean.mp4');
  assert.equal(video.currentTime,34);
});
