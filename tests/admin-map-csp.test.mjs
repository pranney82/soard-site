/**
 * The admin's Content-Security-Policy (public/_headers, /admin/*) must allow
 * the map tiles the Applicants map loads (public/admin/applicants.js), or the
 * map draws its boundary and pins on a blank gray page.
 * Run: node --test tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname;

test('the admin policy allows the Applicants map tiles', () => {
  const headers = readFileSync(`${ROOT}public/_headers`, 'utf8');
  const csp = (headers.split('/admin/*')[1].match(/^\s+Content-Security-Policy: (.+)$/m) || [])[1] || '';
  const imgSrc = (csp.match(/img-src ([^;]+)/) || [])[1]?.split(/\s+/) || [];
  const tiles = readFileSync(`${ROOT}public/admin/applicants.js`, 'utf8').match(/L\.tileLayer\('(https:\/\/[^/']+)\//);
  assert.ok(tiles, 'the map has a tile layer');
  assert.ok(imgSrc.includes(tiles[1]), `img-src allows ${tiles[1]} (has: ${imgSrc.join(' ')})`);
});
