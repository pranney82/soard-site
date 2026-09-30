/**
 * /api/stream-videos — the admin's Stream library browser
 * Run: node --test tests/
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';

const seen = [];
let mode = 'ok';
const realFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
  const url = typeof input === 'string' ? input : input.url;
  seen.push(url);
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  if (mode === 'lapsed') return json({ success: false, errors: [{ code: 10002, message: 'Authorization Failure' }] }, 403);
  const vids = Array.from({ length: 40 }, (_, i) => ({
    uid: `u${String(i).padStart(2, '0')}`, meta: { name: `Video ${i}` }, created: new Date(Date.UTC(2026, 8, 30 - i)).toISOString(),
    duration: 90, readyToStream: i !== 1, status: { state: i === 1 ? 'inprogress' : 'ready' }, thumbnail: `https://t/${i}.jpg`,
  }));
  vids.push({ uid: 'livenow', meta: { name: 'live' }, status: { state: 'live-inprogress' } });
  return json({ success: true, result: vids });
};

let env, ep;
const get = (qs = '') => ep.onRequestGet({ env, request: new Request(`https://x/api/stream-videos${qs}`) });

before(async () => {
  const DB = await createD1({ schemaFiles: ['scripts/schema.sql'] });
  await DB.prepare('INSERT INTO kids (slug, data, name, year) VALUES (?, ?, ?, ?)').bind('remi-and-nico', JSON.stringify({ name: 'Remi & Nico', streamVideoId: 'u03', revealVideoUrl: 'https://watch.cloudflarestream.com/u00' }), 'Remi & Nico', 2026).run();
  env = { DB, CF_ACCOUNT_ID: 'acct', CF_STREAM_TOKEN: 'tok' };
  ep = await import('../functions/api/stream-videos.js');
});
after(() => { globalThis.fetch = realFetch; });

test('lists a page of videos with usage, skips in-progress lives, pages by created date', async () => {
  const d = await (await get('?search=Remi')).json();
  assert.equal(d.success, true);
  assert.equal(d.videos.length, 36);
  assert.ok(!d.videos.some(v => v.uid === 'livenow'));
  assert.deepEqual(d.videos[0].usedBy, [{ type: 'kid', slug: 'remi-and-nico', name: 'Remi & Nico', field: 'reveal' }]);
  assert.deepEqual(d.videos[3].usedBy.map(u => u.field), ['video']);
  assert.equal(d.videos[1].ready, false);
  assert.equal(d.videos[0].watch, 'https://watch.cloudflarestream.com/u00');
  assert.equal(d.next, d.videos[35].created);
  assert.match(seen.at(-1), /search=Remi/);
  await get(`?before=${encodeURIComponent(d.next)}`);
  assert.match(seen.at(-1), /end=/);
});

test('a lapsed Stream subscription says so plainly', async () => {
  mode = 'lapsed';
  const res = await get();
  assert.equal(res.status, 500);
  assert.match((await res.json()).error, /not enabled on this account/);
  mode = 'ok';
});
