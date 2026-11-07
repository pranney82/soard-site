/**
 * /api/application-open: what the banner on every page reads, and all it may read.
 * functions/api/application-open.js
 * Run: node --test tests/application-open.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { onRequestGet } from '../functions/api/application-open.js';
import { createD1 } from './lib/d1-shim.mjs';
import { fakeApplicantWorld } from './lib/fake-applicant-world.mjs';
import { ensureSchema, saveApplicationSettings, runApplicationSchedule, enforceApplicationCap } from '../functions/api/_applications.js';

const year = String(new Date().getUTCFullYear() + 1);
const dbWith = (application) => ({
  prepare: () => ({ first: async () => ({ data: JSON.stringify({ application }) }) }),
});
const ask = async (env) => {
  const res = await onRequestGet({ env, request: new Request('https://example.org/api/application-open?x=1'), waitUntil() {} });
  return { res, body: await res.json() };
};

test('open follows the same switch as the Apply page, with that season', async () => {
  const { body } = await ask({ DB: dbWith({ open: true, year }) });
  assert.deepEqual(body, { open: true, year });
});

test('closed says closed, and only a real true counts as open', async () => {
  assert.equal((await ask({ DB: dbWith({ open: false, year }) })).body.open, false);
  assert.equal((await ask({ DB: dbWith({ open: 'true', year }) })).body.open, false);
  assert.equal((await ask({ DB: dbWith({}) })).body.open, false);
});

test('nothing else in the settings leaves', async () => {
  const { body } = await ask({ DB: dbWith({ open: true, year, formUrl: 'https://example.org/form', closedMessage: 'Closed', maxApplications: 40 }) });
  assert.deepEqual(Object.keys(body).sort(), ['open', 'year']);
});

test('no database, or a broken one, reads as closed rather than failing a page', async () => {
  assert.equal((await ask({})).body.open, false);
  const broken = { prepare: () => ({ first: async () => { throw new Error('down'); } }) };
  const { res, body } = await ask({ DB: broken });
  assert.equal(res.status, 200);
  assert.equal(body.open, false);
});

test('it can be cached: every page asks', async () => {
  const { res } = await ask({ DB: dbWith({ open: true, year }) });
  assert.match(res.headers.get('Cache-Control'), /public/);
  assert.match(res.headers.get('Cache-Control'), /s-maxage=30/);
});

test('anyone can read it, nobody can post to it', () => {
  const src = readFileSync('functions/api/_middleware.js', 'utf8');
  const list = src.match(/const PUBLIC_GET_ROUTES = \[(.*?)\]/s)[1];
  assert.ok(list.includes("'/api/application-open'"));
});

// ── Every way the application closes takes the banner with it ───────
// All three turn off the one switch this reads, on a real database.

async function realWorld(application) {
  const w = fakeApplicantWorld();
  const DB = await createD1();
  await DB.exec('CREATE TABLE IF NOT EXISTS site_config (key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)');
  await DB.exec('CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_email TEXT, action TEXT, entity_type TEXT, entity_slug TEXT, entity_name TEXT, changes TEXT, path TEXT, git_status TEXT, created_at TEXT)');
  await ensureSchema(DB);
  await DB.prepare("INSERT INTO site_config (key, data) VALUES ('settings', ?)").bind(JSON.stringify({ application })).run();
  return { w, env: { ...w.env, DB } };
}

test('closed by hand: the banner reads closed', async () => {
  const { env } = await realWorld({ open: true, year });
  assert.equal((await ask(env)).body.open, true);
  await saveApplicationSettings(env, { open: false }, { user: 'staff@example.org' });
  assert.equal((await ask(env)).body.open, false);
});

test('closed at the close date set in Settings: the banner reads closed', async () => {
  const now = Date.now();
  const { env } = await realWorld({ open: true, year, closesAt: new Date(now + 3600e3).toISOString() });
  assert.equal(await runApplicationSchedule(env, { now: now + 3600e3 - 1000 }), null, 'not yet');
  assert.equal((await ask(env)).body.open, true);
  assert.equal(await runApplicationSchedule(env, { now: now + 3600e3 + 1000 }), 'closed');
  assert.equal((await ask(env)).body.open, false);
});

test('closed at the application limit: the banner reads closed', async () => {
  const realFetch = globalThis.fetch;
  const { w, env } = await realWorld({ open: true, year, maxApplications: 2 });
  globalThis.fetch = w.fetchImpl;
  try {
    for (const i of [1, 2]) {
      const at = new Date(Date.now() - i * 3600e3).toISOString();
      await env.DB.prepare(`INSERT INTO applications (id, year, is_test, status, submitted_at, updated_at) VALUES (?, ?, 0, 'done', ?, ?)`)
        .bind(`app-open${i}-abcdef`, year, at, at).run();
    }
    assert.equal((await ask(env)).body.open, true);
    await enforceApplicationCap(env, { now: Date.now() });
    assert.equal((await ask(env)).body.open, false);
  } finally {
    globalThis.fetch = realFetch;
  }
});
