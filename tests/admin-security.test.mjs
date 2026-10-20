/**
 * The admin API's two guards: record names that can't leave their collection
 * (functions/api/_collections.js parsePath, used by save, read and delete),
 * and changes that must come from the admin itself, not another website
 * riding a signed-in admin's Access cookie (functions/api/_origin-guard.js,
 * run by _middleware.js).
 * Run: node --test tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePath, isSafeName } from '../functions/api/_collections.js';
import { crossSiteChange } from '../functions/api/_origin-guard.js';
import { onRequest } from '../functions/api/_middleware.js';

test('record names stay inside their collection', () => {
  assert.deepEqual(parsePath('src/content/partners/bell.json'), { type: 'collection', table: 'partners', slug: 'bell', prefix: 'src/content/partners/' });
  assert.deepEqual(parsePath('src/content/site/partner-logo-dismissed.json'), { type: 'site', key: 'partner-logo-dismissed' });
  assert.equal(parsePath('src/content/kids/adrian-2025.json').slug, 'adrian-2025');
  assert.equal(parsePath('src/content/press/2024.11.04-wsb.json').slug, '2024.11.04-wsb', 'single dots between parts are fine');
  for (const bad of ['src/content/kids/../../functions/api/x.json', 'src/content/kids/a/b.json', 'src/content/site/../kids/x.json',
    'src/content/kids/..json', 'src/content/kids/.hidden.json', 'src/content/kids/a..b.json', 'src/content/kids/.json', 'src/content/kids/a b.json', 'src/content/kids/a%2f.json']) {
    assert.equal(parsePath(bad), null, bad);
  }
  assert.equal(parsePath(null), null);
  assert.equal(isSafeName('x'.repeat(201)), false);
});

const req = (method, headers = {}, url = 'https://sunshineonaranneyday.com/api/save-content') => new Request(url, { method, headers });

test('a change from another website is refused; the admin, scripts and reads aren’t', () => {
  const allowed = ['https://sunshineonaranneyday.com', 'https://soard.cloudflareaccess.com'];
  assert.match(crossSiteChange(req('POST', { Origin: 'https://evil.example' }), allowed), /evil/);
  assert.match(crossSiteChange(req('DELETE', { Origin: 'https://sunshineonaranneyday.com.evil.example' }), allowed), /evil/);
  assert.ok(crossSiteChange(req('POST', { Origin: 'null' }), allowed), 'a sandboxed page sends Origin: null');
  assert.ok(crossSiteChange(req('POST', { 'Sec-Fetch-Site': 'cross-site' }), allowed), 'no Origin, but the browser says cross-site');
  assert.equal(crossSiteChange(req('POST', { Origin: 'https://sunshineonaranneyday.com' }), allowed), null);
  assert.equal(crossSiteChange(req('POST', { Origin: 'https://abc123.soard-site.pages.dev' }, 'https://abc123.soard-site.pages.dev/api/save-content'), allowed), null, 'a preview deployment is its own origin');
  assert.equal(crossSiteChange(req('POST', { Origin: 'http://localhost:8788' }), allowed), null);
  assert.equal(crossSiteChange(req('POST', { 'Sec-Fetch-Site': 'same-origin' }), allowed), null);
  assert.equal(crossSiteChange(req('POST'), allowed), null, 'a script with no browser headers goes on to the Access check');
  assert.equal(crossSiteChange(req('GET', { Origin: 'https://evil.example' }), allowed), null, 'reads are untouched');
});

test('the middleware refuses a cross-site change before anything else, and leaves public routes alone', async () => {
  const ctx = (path, method, headers) => ({ request: new Request(`https://sunshineonaranneyday.com${path}`, { method, headers }), env: {}, data: {}, next: async () => new Response('next') });
  const evil = await onRequest(ctx('/api/partners-batch', 'POST', { Origin: 'https://evil.example', 'Content-Type': 'text/plain' }));
  assert.equal(evil.status, 403);
  assert.match((await evil.json()).error, /must come from the admin/);
  // Same origin passes the guard (then fails closed here, with no Access settings in this test)
  assert.equal((await onRequest(ctx('/api/partners-batch', 'POST', { Origin: 'https://sunshineonaranneyday.com' }))).status, 503);
  // The public newsletter form still takes posts from anywhere
  assert.equal(await (await onRequest(ctx('/api/newsletter', 'POST', { Origin: 'https://evil.example' }))).text(), 'next');
});
