const test = require('node:test');
const assert = require('node:assert/strict');
const { configureDevMode, isLegacyUiSource } = require('../scripts/dev-mode.cjs');

test('desktop dev enables native restart and frontend reload by default', () => {
  const args=['dev'],environment={PATH:'unchanged'};
  const mode=configureDevMode(args,environment);
  assert.deepEqual(mode.args,['dev']);
  assert.equal(mode.env.SOCL_DEV_WATCH,'1');
  assert.equal(mode.watch,true);
  assert.deepEqual(args,['dev']);assert.deepEqual(environment,{PATH:'unchanged'});
});
test('explicit watch remains compatible, and no-watch takes precedence', () => {
  const enabled=configureDevMode(['dev','--watch','--features','example'],{});
  assert.deepEqual(enabled.args,['dev','--features','example']);
  assert.equal(enabled.env.SOCL_DEV_WATCH,'1');
  const disabled=configureDevMode(['dev','--watch','--no-watch'],{});
  assert.deepEqual(disabled.args,['dev','--no-watch']);
  assert.equal(disabled.env.SOCL_DEV_WATCH,'0');
});
test('build arguments and application arguments keep their original meaning', () => {
  assert.deepEqual(configureDevMode(['build','--release'],{}).args,['build','--release']);
  const mode=configureDevMode(['dev','--','--watch'],{});
  assert.deepEqual(mode.args,['dev','--','--watch']);
  assert.equal(mode.watch,true);
  const disabled=configureDevMode(['dev','--no-watch','--','--watch'],{});
  assert.deepEqual(disabled.args,['dev','--no-watch','--','--watch']);
  assert.equal(disabled.watch,false);
});
test('worker changes do not regenerate the legacy UI even in automatic editing mode', () => {
  const scripts=['preload.js','renderer.js','caption-extras.js'];
  assert.equal(isLegacyUiSource('renderer.js',scripts),true);
  assert.equal(isLegacyUiSource('styles.css',scripts),true);
  assert.equal(isLegacyUiSource('index.html',scripts),true);
  assert.equal(isLegacyUiSource('pipeline-inverse-v1.js',scripts),false);
  assert.equal(isLegacyUiSource('engine-main.cjs',scripts),false);
  assert.equal(isLegacyUiSource('secrets.bin',scripts),false);
});
