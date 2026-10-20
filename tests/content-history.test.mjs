/**
 * Version history for content records (functions/api/_content-history.js,
 * functions/api/content-history.js): kids and team share one table.
 * Run: node --test tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { recordVersion, recordDeletion, listVersions, getVersion, listDeleted, moveVersions, changedFields } from '../functions/api/_content-history.js';
import { onRequestGet } from '../functions/api/content-history.js';
import { onRequestPost as saveContent } from '../functions/api/save-content.js';

const db = () => createD1({ schemaFiles: ['scripts/schema.sql'] });
const at = (m) => `2026-10-19T12:${String(m).padStart(2, '0')}:00.000Z`;

test('the first save also keeps what was there before; later saves keep what they wrote', async () => {
  const DB = await db();
  await recordVersion(DB, { collection: 'kids', slug: 'ava', data: { name: 'Ava', bio: 'v1' }, previous: { name: 'Ava', bio: 'v0' }, userEmail: 'a@x.org', now: at(1) });
  await recordVersion(DB, { collection: 'kids', slug: 'ava', data: { name: 'Ava', bio: 'v2', sortOrder: 3 }, previous: { name: 'Ava', bio: 'v1' }, userEmail: 'b@x.org', now: at(2) });
  const v = await listVersions(DB, 'kids', 'ava');
  assert.deepEqual(v.map((x) => [x.by, x.changed, x.action]), [['b@x.org', ['bio'], 'save'], ['a@x.org', ['bio'], 'save'], [null, null, 'save']]);
  assert.equal(v[2].at, '2026-10-19T12:00:59.000Z', 'the version from before history began sits a second before the first save');
  assert.deepEqual(await getVersion(DB, 'kids', 'ava', v[2].id), { name: 'Ava', bio: 'v0' });
  assert.equal(await getVersion(DB, 'kids', 'ava', 9999), null);
  // Collections don't mix
  assert.deepEqual(await listVersions(DB, 'team', 'ava'), []);
});

test('the newest 50 per item are kept', async () => {
  const DB = await db();
  for (let i = 0; i < 55; i++) await recordVersion(DB, { collection: 'team', slug: 'sam', data: { n: i }, now: at(i % 60) });
  await recordVersion(DB, { collection: 'kids', slug: 'sam', data: { n: 'kid' }, now: at(1) });
  const v = await listVersions(DB, 'team', 'sam');
  assert.equal(v.length, 50);
  assert.deepEqual(await getVersion(DB, 'team', 'sam', v[0].id), { n: 54 });
  assert.equal((await listVersions(DB, 'kids', 'sam')).length, 1, 'pruning one collection leaves the other alone');
});

test('a deleted kid is listed until it comes back, then the history follows a new address', async () => {
  const DB = await db();
  await DB.prepare('INSERT INTO kids (slug, name, data) VALUES (?, ?, ?)').bind('liv', 'Liv', '{}').run();
  await recordVersion(DB, { collection: 'kids', slug: 'max', data: { name: 'Max', year: 2020, heroImage: 'kids/max/1' }, now: at(1) });
  await recordDeletion(DB, { collection: 'kids', slug: 'max', data: { name: 'Max', year: 2020, heroImage: 'kids/max/1' }, userEmail: 'a@x.org', now: at(2) });
  await recordDeletion(DB, { collection: 'kids', slug: 'liv', data: { name: 'Liv' }, now: at(3) });
  const del = await listDeleted(DB, 'kids');
  assert.deepEqual(del.map((d) => [d.slug, d.name, d.year, d.image, d.by]), [['max', 'Max', 2020, 'kids/max/1', 'a@x.org']], 'Liv is back in the table, so she isn’t listed');
  assert.equal((await listVersions(DB, 'kids', 'max'))[0].action, 'delete');
  // Saved again: no longer deleted
  await DB.prepare('INSERT INTO kids (slug, name, data) VALUES (?, ?, ?)').bind('max', 'Max', '{}').run();
  await recordVersion(DB, { collection: 'kids', slug: 'max', data: { name: 'Max' }, now: at(4) });
  assert.deepEqual(await listDeleted(DB, 'kids'), []);
  await moveVersions(DB, 'kids', 'max', 'maxwell');
  assert.equal((await listVersions(DB, 'kids', 'maxwell')).length, 3);
  assert.deepEqual(await listVersions(DB, 'kids', 'max'), []);
});

test('changed fields leave out list positions and derived counts', () => {
  assert.deepEqual(changedFields({ a: 1, order: 1, sortOrder: 2, photoCount: 3 }, { a: 2, order: 5, sortOrder: 9, photoCount: 4, b: [] }), ['a', 'b']);
  assert.deepEqual(changedFields(null, { a: 1 }), []);
});

test('the endpoint: versions, one version, deleted items, bad input', async () => {
  const DB = await db();
  await recordVersion(DB, { collection: 'kids', slug: 'ava', data: { name: 'Ava' }, now: at(1) });
  const call = async (q) => { const r = await onRequestGet({ request: new Request(`https://x/api/content-history?${q}`), env: { DB } }); return { status: r.status, body: await r.json(), cache: r.headers.get('cache-control') }; };
  const list = await call('collection=kids&slug=ava');
  assert.equal(list.body.versions.length, 1);
  assert.equal(list.cache, 'no-store');
  assert.deepEqual((await call(`collection=kids&slug=ava&id=${list.body.versions[0].id}`)).body.data, { name: 'Ava' });
  assert.deepEqual(await call('collection=kids&slug=ava&id=999').then((r) => [r.status, r.body.error]), [404, 'That version is gone']);
  assert.equal((await call('collection=events&slug=ava')).status, 400);
  assert.equal((await call('collection=kids&slug=../x')).status, 400);
  assert.deepEqual((await call('collection=kids&deleted=1')).body, { success: true, deleted: [] });
});

test('save-content keeps a version of each site document, and history serves it', async () => {
  const DB = await createD1({ schemaFiles: ['scripts/schema.sql'] });
  await DB.exec('CREATE TABLE IF NOT EXISTS site_config (key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)');
  await DB.prepare("INSERT INTO site_config (key, data) VALUES ('faq', ?)").bind(JSON.stringify({ categories: [], items: [] })).run();
  const save = async (content) => {
    const request = new Request('https://admin.test/api/save-content', { method: 'POST', body: JSON.stringify({ path: 'src/content/site/faq.json', content: JSON.stringify(content), message: 'Site Config: FAQ' }), headers: { 'content-type': 'application/json' } });
    return saveContent({ env: { DB }, request, data: { userEmail: 'peter@soardcharity.com' }, waitUntil: () => {} });
  };
  assert.equal((await save({ categories: [{ id: 'about', label: 'About' }], items: [] })).status, 200);
  assert.equal((await save({ categories: [{ id: 'about', label: 'About SOARD' }], items: [] })).status, 200);
  const get = async (q) => (await onRequestGet({ env: { DB }, request: new Request(`https://admin.test/api/content-history?${q}`) })).json();
  const list = await get('collection=site&slug=faq');
  assert.equal(list.success, true);
  assert.equal(list.versions.length, 3, 'two saves, and what was there before the first');
  assert.deepEqual(list.versions[0].changed, ['categories']);
  assert.equal(list.versions[0].by, 'peter@soardcharity.com');
  const old = await get(`collection=site&slug=faq&id=${list.versions[1].id}`);
  assert.equal(old.data.categories[0].label, 'About');
  assert.equal((await get('collection=nope&slug=faq')).success, false);
});
