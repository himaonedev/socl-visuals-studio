const { test } = require('node:test');
const assert = require('node:assert/strict');
const extras = require('../src/caption-extras.js');
const { buildAss, applyCueCase, shiftCues } = require('../src/pipeline-inverse-v1.js').__test;

test('unchanged SOCL captions are byte-identical without text additions', () => {
  const body = 'Dialogue: 1,0:00:00.00,0:00:01.00,Default,,0,0,0,,{\\pos(540,1400)\\fnAnton\\1c&HFFFFFF&}Hello';
  assert.equal(extras.applyAss(body,[{start:0,end:1,text:'Hello'}],{w:1080,h:1920}), body);
});

test('additional motion/flicker retains the original font, colour and box events', () => {
  const cues = [{start:0,end:1,text:'Style SOCL',textMotion:{motion:'rise',duration:.5,flicker:'blink',speed:2}}];
  const body = 'Dialogue: 1,0:00:00.00,0:00:01.00,Default,,0,0,0,,{\\an8\\pos(540,1400)\\fnAnton\\1c&HFFFFFF&\\bord3}Style SOCL';
  const output=extras.applyAss(body,cues,{w:1080,h:1920});
  assert.ok(output.includes('\\fnAnton\\1c&HFFFFFF&\\bord3'));
  assert.ok(output.includes('\\pos(540.00,1480.00)'));
  assert.ok(output.includes('\\alpha&Hff&'));
  assert.ok(output.split('\n').length <= 26);
});

test('native SOCL ASS generation retains its style definition and renders selected word marks', () => {
  const cue={start:0,end:1,text:'Style SOCL'};
  const base=buildAss([cue],64,'bw',1400,540,'none',false);
  const enhancedCues = applyCueCase(shiftCues([{...cue,textMotion:{motion:'scale',duration:.3,mark:{kind:'highlight',color:'#ffff00',opacity:.5,duration:.2,rects:[{x:500,y:1400,width:120,height:70}]}}}],100,2),'upper');
  const enhanced=buildAss(enhancedCues,64,'bw',1400,540,'none',false);
  assert.equal(enhanced.match(/^Style: Default.*$/m)[0],base.match(/^Style: Default.*$/m)[0]);
  assert.ok(enhanced.includes('STYLE SOCL'));
  assert.ok(enhanced.includes('\\p1'));
  assert.ok(enhanced.includes('\\1c&H00ffff&'));
});
