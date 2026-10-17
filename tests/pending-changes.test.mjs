/**
 * Publishing state (functions/api/pending-changes.js): which saves are live,
 * publishing in a running build, or waiting; and the Stream check the kid
 * Preview shares with the build (functions/api/stream-check.js).
 * Run: node --test tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeDeploys, summarizeChanges, toSqliteTimestamp, onRequestGet } from '../functions/api/pending-changes.js';
import { checkStreamUid } from '../functions/api/stream-check.js';

const build = (id, created, stage, status, ended = null) => ({
  id, environment: 'production', created_on: created, url: `https://${id}.soard-site.pages.dev`,
  latest_stage: { name: stage, status, ended_on: ended },
  deployment_trigger: { metadata: { commit_message: `build ${id}` } },
});

test('live is the newest successful build; a newer running build is active', () => {
  const s = summarizeDeploys([
    build('old', '2026-10-16T10:00:00Z', 'deploy', 'success', '2026-10-16T10:07:00Z'),
    build('run', '2026-10-16T12:00:00Z', 'build', 'active'),
    build('ok', '2026-10-16T11:00:00Z', 'deploy', 'success', '2026-10-16T11:09:00Z'),
  ]);
  assert.equal(s.live.id, 'ok');
  assert.equal(s.active.id, 'run');
  assert.equal(s.active.stage, 'build');
  assert.equal(s.failed, null);
  assert.equal(s.typicalSeconds, 540); // median of 7 and 9 minutes, upper middle
});

test('a queued build and a finished middle stage still count as running', () => {
  const s = summarizeDeploys([
    build('ok', '2026-10-16T11:00:00Z', 'deploy', 'success', '2026-10-16T11:08:00Z'),
    build('q', '2026-10-16T12:00:00Z', 'queued', 'idle'),
  ]);
  assert.equal(s.active.id, 'q');
  const t = summarizeDeploys([
    build('ok', '2026-10-16T11:00:00Z', 'deploy', 'success', '2026-10-16T11:08:00Z'),
    build('c', '2026-10-16T12:00:00Z', 'clone_repo', 'success'),
  ]);
  assert.equal(t.active.id, 'c');
});

test('the newest build failing is reported; an older failure under a newer run is not', () => {
  const s = summarizeDeploys([
    build('ok', '2026-10-16T11:00:00Z', 'deploy', 'success', '2026-10-16T11:08:00Z'),
    build('bad', '2026-10-16T12:00:00Z', 'build', 'failure'),
  ]);
  assert.equal(s.failed.id, 'bad');
  assert.equal(s.active, null);
  const t = summarizeDeploys([
    build('ok', '2026-10-16T11:00:00Z', 'deploy', 'success', '2026-10-16T11:08:00Z'),
    build('bad', '2026-10-16T12:00:00Z', 'build', 'failure'),
    build('retry', '2026-10-16T12:05:00Z', 'build', 'active'),
  ]);
  assert.equal(t.failed, null);
  assert.equal(t.active.id, 'retry');
});

test('preview builds are ignored, and no builds at all means nothing is live', () => {
  const s = summarizeDeploys([{ ...build('pr', '2026-10-16T12:00:00Z', 'deploy', 'success', '2026-10-16T12:05:00Z'), environment: 'preview' }]);
  assert.equal(s.live, null);
  assert.equal(summarizeDeploys([]).typicalSeconds, null);
});

test('changes: one per entity, publishing when saved before the running build started', () => {
  const rows = [
    { entity_type: 'kids', entity_slug: 'ava', entity_name: 'Ava', action: 'updated', user_email: 'a@x', created_at: '2026-10-16 12:30:00' },
    { entity_type: 'kids', entity_slug: 'ava', entity_name: 'Ava', action: 'created', user_email: 'b@x', created_at: '2026-10-16 11:30:00' },
    { entity_type: 'events', entity_slug: 'gala', entity_name: 'Gala', action: 'updated', user_email: 'a@x', created_at: '2026-10-16 11:45:00' },
  ];
  const out = summarizeChanges(rows, '2026-10-16T12:00:00.000Z');
  const ava = out.find((c) => c.slug === 'ava');
  const gala = out.find((c) => c.slug === 'gala');
  assert.equal(ava.action, 'updated');
  assert.equal(ava.edits, 2);
  assert.deepEqual(ava.users.sort(), ['a@x', 'b@x']);
  assert.equal(ava.state, 'waiting'); // its newest save came after the build started
  assert.equal(gala.state, 'publishing');
  assert.equal(gala.at, '2026-10-16T11:45:00Z');
  assert.ok(summarizeChanges(rows, null).every((c) => c.state === 'waiting'));
});

test('sqlite timestamps', () => {
  assert.equal(toSqliteTimestamp('2026-10-16T12:00:00.123Z'), '2026-10-16 12:00:00');
});

test('endpoint: since the live build, runtime-only activity left out, build state attached', async () => {
  let sql = null, binds = null;
  const DB = {
    prepare: (q) => ({
      first: async () => ({ user_email: 'peter@x', created_at: '2026-10-16 11:59:30' }),
      bind: (...b) => ({ all: async () => { sql = q; binds = b; return { results: [{ entity_type: 'kids', entity_slug: 'ava', entity_name: 'Ava', action: 'updated', user_email: 'a@x', created_at: '2026-10-16 12:30:00' }] }; } }),
    }),
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ success: true, result: [
    build('ok', '2026-10-16T11:00:00Z', 'deploy', 'success', '2026-10-16T11:08:00Z'),
    build('run', '2026-10-16T12:00:00Z', 'build', 'active'),
  ] }));
  try {
    const res = await onRequestGet({ env: { DB, CF_ACCOUNT_ID: 'a', CF_PAGES_TOKEN: 't', CF_PAGES_DEPLOY_HOOK: 'h' } });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.publish.tracking, true);
    assert.equal(body.publish.hook, true);
    assert.equal(body.publish.active.id, 'run');
    assert.equal(body.publish.active.by, 'peter@x'); // clicked 30s before the build started
    assert.equal(body.since, '2026-10-16T11:00:00Z');
    assert.equal(binds.at(-1), '2026-10-16 11:00:00');
    assert.ok(binds.includes('live-status') && binds.includes('email-broadcast'));
    assert.match(sql, /entity_type NOT IN/);
    assert.equal(body.changes[0].state, 'waiting');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('endpoint without the Pages API falls back to the last Publish click', async () => {
  let binds = null;
  const DB = {
    prepare: () => ({
      first: async () => ({ user_email: 'peter@x', created_at: '2026-10-16 11:59:30' }),
      bind: (...b) => ({ all: async () => { binds = b; return { results: [] }; } }),
    }),
  };
  const res = await onRequestGet({ env: { DB } });
  const body = await res.json();
  assert.equal(body.publish.tracking, false);
  assert.equal(body.publish.hook, false);
  assert.equal(binds.at(-1), '2026-10-16 11:59:30');
  assert.equal(body.lastDeployBy, 'peter@x');
  assert.equal(body.lastDeployAt, '2026-10-16T11:59:30Z');
});

test('stream check: playable, gone, unknown, and bad ids never fetched', async () => {
  const uid = 'a'.repeat(32);
  const seen = [];
  const reply = (status) => async (url) => { seen.push(url); return new Response('#EXTM3U', { status }); };
  assert.equal(await checkStreamUid(uid, reply(200)), 'playable');
  assert.match(seen[0], new RegExp(`/${uid}/manifest/video\\.m3u8$`));
  assert.equal(await checkStreamUid(uid, reply(404)), 'gone');
  assert.equal(await checkStreamUid(uid, reply(403)), 'gone');
  assert.equal(await checkStreamUid(uid, reply(503)), 'unknown');
  assert.equal(await checkStreamUid(uid, async () => { throw new Error('offline'); }), 'unknown');
  const before = seen.length;
  assert.equal(await checkStreamUid('not-a-uid', reply(200)), 'gone');
  assert.equal(seen.length, before);
});
