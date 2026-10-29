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

test('the admin policy allows Plaid’s window for Bank balances, in both the enforced and the strict policy', () => {
  const block = readFileSync(`${ROOT}public/_headers`, 'utf8').split('/admin/*')[1].split('\n\n')[0];
  const plaid = readFileSync(`${ROOT}public/admin/board-banks.js`, 'utf8').match(/'(https:\/\/cdn\.plaid\.com)\/link\/v2\/stable\/link-initialize\.js'/);
  assert.ok(plaid, 'Bank balances loads Plaid’s script from Plaid');
  for (const name of ['Content-Security-Policy', 'Content-Security-Policy-Report-Only']) {
    const csp = (block.match(new RegExp(`^\\s+${name}: (.+)$`, 'm')) || [])[1] || '';
    const dir = (d) => (csp.match(new RegExp(`(?:^|; )${d} ([^;]+)`)) || [])[1]?.split(/\s+/) || [];
    assert.ok(dir('script-src').includes(plaid[1]), `${name}: script-src allows ${plaid[1]}`);
    assert.ok(dir('frame-src').includes(plaid[1]), `${name}: frame-src allows ${plaid[1]}`);
    assert.ok(dir('connect-src').includes('https://production.plaid.com'), `${name}: connect-src allows Plaid’s API`);
  }
});
