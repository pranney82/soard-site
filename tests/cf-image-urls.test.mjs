/**
 * One photo at one width has one URL (src/utils/cf-image.ts): without a height
 * nothing is cropped, so fit=cover and gravity are left off, and a kid's hero
 * and the same photo in their gallery are the same download.
 * Run: node --test tests/cf-image-urls.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';

const code = buildSync({ entryPoints: ['src/utils/cf-image.ts'], bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent' }).outputFiles[0].text;
const { cfSrcset, cfUrl, cfRaw, resizeOnly, CF_BASE } = await import(`data:text/javascript,${encodeURIComponent(code)}`);

const id = 'kids/example/hero-photo';

test('a width-only resize has one URL, whatever crop options came with it', () => {
  const hero = cfSrcset(id, [600, 1200], { fit: 'cover', gravity: 'face' });
  const gallery = cfSrcset(id, [600, 1200]);
  assert.equal(hero, gallery);
  assert.equal(hero, `${CF_BASE}/${id}/w=600,q=85,metadata=none 600w, ${CF_BASE}/${id}/w=1200,q=85,metadata=none 1200w`);
  assert.equal(cfRaw(id, 'w=1200,fit=cover,gravity=face,q=85,metadata=none'), `${CF_BASE}/${id}/w=1200,q=85,metadata=none`);
  assert.equal(cfUrl(id, { w: 900, fit: 'cover', gravity: 'face' }), `${CF_BASE}/${id}/w=900,q=85,metadata=none`);
});

test('a crop keeps its fit and gravity', () => {
  assert.equal(cfUrl(id, { w: 400, h: 460, fit: 'cover', gravity: 'face' }), `${CF_BASE}/${id}/w=400,h=460,fit=cover,gravity=face,q=85,metadata=none`);
  assert.match(cfSrcset(id, [180], { fit: 'cover', gravity: 'face', aspectRatio: 1.15 }), /w=180,h=207,fit=cover,gravity=face,q=85/);
  assert.equal(resizeOnly('w=260,h=347,fit=cover,gravity=face,q=70'), 'w=260,h=347,fit=cover,gravity=face,q=70');
});

test('other fits are not touched', () => {
  assert.equal(resizeOnly('w=600,fit=contain,q=80'), 'w=600,fit=contain,q=80');
  assert.equal(cfUrl(id, { w: 600, fit: 'scale-down' }), `${CF_BASE}/${id}/w=600,fit=scale-down,q=85,metadata=none`);
});
