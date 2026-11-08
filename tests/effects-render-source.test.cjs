const { test } = require('node:test');
const assert = require('node:assert/strict');
const { renderSourceFor } = require('../src/render-source.js');
test('caption renders keep the Effects plate instead of recutting the original master', () => {
  assert.deepEqual(renderSourceFor({ effectsBaked: true, srcVideo: 'master.mp4' }, 'landscape'), { srcVideo: null, clipFormat: 'landscape' });
  assert.equal(renderSourceFor({ srcVideo: 'master.mp4' }, 'face').srcVideo, 'master.mp4');
  assert.equal(renderSourceFor({ splitCrop: {}, srcVideo: 'master.mp4' }, 'landscape').clipFormat, 'face');
});
