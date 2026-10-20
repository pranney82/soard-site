/**
 * Live facts for the admin's automations map (functions/api/automations-admin.js):
 * switches and last-run times come through, secrets never do, and one broken
 * source never blanks the others.
 * Run: node --test tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { gatherFacts } from '../functions/api/automations-admin.js';

const SECRETS = ['STREAMKEY-abc123', 'PASSPHRASE-xyz', 'VAPID-PRIVATE-999', 'hooks-token-777', 'whsec-555', 'SLACKURL-1'];

const CONFIG = {
  liveInput: { uid: 'in1', enabled: true, rtmps: { url: 'rtmps://live', streamKey: SECRETS[0] }, srt: { passphrase: SECRETS[1] } },
  outputs: { facebook: { uid: 'o1', url: 'rtmps://fb', keyMask: 'FB…1', enabled: true } },
  facebook: { mode: 'api' },
  reels: { enabled: false },
  reminders: { enabled: false, hoursBefore: [], sms: false, push: false },
  kitLive: { enabled: true },
  messages: { enabled: true },
  vapid: { publicKey: 'pub', privateJwk: { d: SECRETS[2] } },
  alerts: { emails: ['ops@example.com'] },
};
const HEALTH = {
  lastTick: { at: '2026-10-17T01:34:40.440Z', source: 'hub:alarm' },
  lastDailyAt: '2026-10-16T01:52:54.955Z',
  hub: { ok: true }, stream: { ok: true }, facebook: { ok: true },
  webhook: { lastReceivedAt: '2026-10-14T21:06:47.729Z', lastEvent: 'live_input.disconnected' },
  replayCheckAt: '2026-10-14T21:08:04.789Z',
  monitor: { at: '2026-10-14T21:06:54.761Z' },
};
const INVITES = { enabled: true, organizer: 'organizer@example.com', lastSweep: { at: '2026-10-17T01:19:01.012Z', checked: 20, changed: 0, errors: 0 } };
const ARCHIVE = { checkedAt: '2026-10-17T00:58:23.422Z', archived: { a: { uid: 'u1', needsKid: true }, b: { uid: 'u2', attachedTo: 'dex' } } };

async function makeDb({ withConfig = true } = {}) {
  const DB = await createD1({ schemaSql: [
    'CREATE TABLE site_config (key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)',
    'CREATE TABLE reveal_invites (job_id TEXT PRIMARY KEY)',
    'CREATE TABLE kids (slug TEXT PRIMARY KEY, data TEXT)',
    'CREATE TABLE broadcast_reminders (id INTEGER PRIMARY KEY, email TEXT)',
    'CREATE TABLE broadcast_sends (id INTEGER PRIMARY KEY, broadcast_id TEXT, kind TEXT, channel TEXT, recipients INTEGER, sent INTEGER, failed INTEGER, error TEXT, created_at TEXT)',
  ] });
  const put = (key, data, at) => DB.prepare('INSERT INTO site_config (key, data, updated_at) VALUES (?, ?, ?)').bind(key, JSON.stringify(data), at).run();
  if (withConfig) await put('broadcast-config', CONFIG, '2026-10-14T21:23:51.175Z');
  await put('broadcast-health', HEALTH, '2026-10-17T01:34:40.440Z');
  await put('reveal-invites', INVITES, '2026-10-17T01:19:02.667Z');
  await put('reveal-invites-guest-check', 1760664242667, '2026-10-17T01:19:02.667Z');
  await put('fb-archive', ARCHIVE, '2026-10-17T00:58:23.422Z');
  await put('reveals', [], '2026-10-17T01:19:00.989Z');
  await DB.prepare('INSERT INTO reveal_invites (job_id) VALUES (?), (?)').bind('j1', 'j2').run();
  await DB.prepare('INSERT INTO broadcast_reminders (email) VALUES (?)').bind('fan@example.com').run();
  await DB.prepare('INSERT INTO broadcast_sends (broadcast_id, kind, channel, recipients, sent, failed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind('b1', 'live', 'kit', 1, 1, 0, '2026-10-14T21:00:00Z').run();
  return DB;
}

const hub = (status) => ({ idFromName: () => 'id', get: () => ({ fetch: async () => Response.json(status) }) });
const JT = {
  organization: {
    workflows: { nodes: [{ id: 'w-on', name: 'Reveal task → invites', isActive: true }, { id: 'w-off', name: 'Old', isActive: false }] },
    webhooks: { nodes: [{ id: 'h1', url: `https://hooks.zapier.com/hooks/standard/1/${SECRETS[3]}/`, eventTypes: ['accountCreated'] }, { id: 'h2', url: `https://datax.to/api/webhooks/jobtread/X?t=${SECRETS[4]}`, eventTypes: ['jobCreated'] }] },
  },
};
// Answers each query with just the part of JT it asked for
const jtFetch = (body = JT, status = 200) => async (url, init) => {
  if (status !== 200) return new Response(JSON.stringify(body), { status });
  const asked = Object.keys(JSON.parse(init.body).query.organization).find((k) => k !== '$');
  return new Response(JSON.stringify({ organization: { [asked]: body.organization[asked] } }), { status });
};
const ENV = (DB, extra = {}) => ({
  DB, FILES: {}, AI: {}, LIVE_HUB: hub({ ok: true, clients: 2, watchers: 0, lastTick: { at: '2026-10-17T01:34:40Z' } }),
  RESEND_API_KEY: 're_x', KIT_API_KEY: 'kit', GOOGLE_CALENDAR_KEY: '{}', JOBTREAD_GRANT_KEY: 'grant', FB_PAGE_ID: '1', FB_PAGE_TOKEN: 't',
  CF_ACCOUNT_ID: 'a', CF_STREAM_TOKEN: 's', CF_IMAGES_TOKEN: 'i', CF_PAGES_DEPLOY_HOOK: 'https://hook', GITHUB_TOKEN: 'g',
  CF_ACCESS_TEAM_DOMAIN: 'team', CF_ACCESS_AUD: 'aud', CC_CLIENT_ID: 'cc', TURNSTILE_SECRET_KEY: 'ts', ...extra,
});

test('switches, timestamps and JobTread state come through', async () => {
  const f = await gatherFacts(ENV(await makeDb()), { fetchImpl: jtFetch(), now: Date.parse('2026-10-17T02:00:00Z') });
  assert.equal(f.checkedAt, '2026-10-17T02:00:00.000Z');
  assert.deepEqual(f.broadcast.outputs, { facebook: true, youtube: null, instagram: null });
  assert.equal(f.broadcast.reels, false);
  assert.deepEqual(f.broadcast.reminders, { enabled: false, sms: false, push: false });
  assert.equal(f.broadcast.kitLive, true);
  assert.equal(f.broadcast.vapid, true);
  assert.equal(f.health.lastTickAt, '2026-10-17T01:34:40.440Z');
  assert.equal(f.invites.enabled, true);
  assert.equal(f.invites.checked, 20);
  assert.equal(f.invites.rows, 2);
  assert.equal(f.invites.lastGuestCheckAt, '2026-10-17T01:19:02.667Z', 'the guest check row\'s updated_at is when it last ran');
  assert.equal(f.fbArchive.needsKid, 1);
  assert.equal(f.reveals.cachedAt, '2026-10-17T01:19:00.989Z');
  assert.deepEqual(f.sends.live.kit, { last: '2026-10-14T21:00:00Z', sent: 1, failed: 0 });
  assert.equal(f.reminders.subscribers, 1);
  assert.equal(f.hub.current, true);
  assert.deepEqual(f.jobtread.workflows['w-off'], { name: 'Old', active: false });
  assert.equal(f.jobtread.webhooks.h1.where, 'hooks.zapier.com/hooks/standard');
  assert.equal(f.env.slack, false);
  assert.equal(f.env.twilio, false);
  assert.equal(f.env.constantContact, true);
});

test('never returns a secret, a webhook token or an email address', async () => {
  const f = await gatherFacts(ENV(await makeDb(), { SLACK_WEBHOOK_URL: SECRETS[5] }), { fetchImpl: jtFetch() });
  const text = JSON.stringify(f);
  for (const s of SECRETS) assert.ok(!text.includes(s), `leaked ${s}`);
  assert.ok(!text.includes('@example.com'), 'leaked an email address');
  assert.equal(f.env.slack, true);
});

test('an old hub without viewer counting is flagged', async () => {
  const f = await gatherFacts(ENV(await makeDb(), { LIVE_HUB: hub({ ok: true, clients: 1, lastTick: null }) }), { fetchImpl: jtFetch() });
  assert.equal(f.hub.current, false);
  assert.equal(f.hub.ok, true);
});

test('one broken source leaves the rest standing', async () => {
  const f = await gatherFacts(ENV(await makeDb({ withConfig: false }), { LIVE_HUB: undefined }), { fetchImpl: jtFetch({ errors: ['nope'] }, 500) });
  assert.equal(f.broadcast, null);
  assert.equal(f.hub.ok, false);
  assert.match(f.jobtread.error, /500/);
  assert.equal(f.invites.enabled, true);
  assert.equal(f.health.lastDailyAt, '2026-10-16T01:52:54.955Z');
});

test('a grant that can read workflows but not webhooks still reports the workflows', async () => {
  const fetchImpl = async (url, init) => {
    const asked = Object.keys(JSON.parse(init.body).query.organization).find((k) => k !== '$');
    if (asked === 'webhooks') return new Response(JSON.stringify({ errors: ['forbidden'] }), { status: 403 });
    return new Response(JSON.stringify({ organization: { workflows: JT.organization.workflows } }));
  };
  const f = await gatherFacts(ENV(await makeDb()), { fetchImpl });
  assert.equal(f.jobtread.workflows['w-on'].active, true);
  assert.equal(f.jobtread.webhooks, undefined);
});

test('a rescued replay attached by hand in the kid editor no longer counts as waiting', async () => {
  const DB = await makeDb();
  await DB.prepare('INSERT INTO kids (slug, data) VALUES (?, ?)').bind('junializ', JSON.stringify({ name: 'Junailiz', revealVideoUrl: 'https://watch.cloudflarestream.com/u1' })).run();
  const f = await gatherFacts(ENV(DB), { fetchImpl: jtFetch() });
  assert.equal(f.fbArchive.needsKid, 0);
  assert.equal(f.fbArchive.archived, 2);
});

test('reveal checks and the date sync report their switch, last run and last activity, never error text', async () => {
  const DB = await makeDb();
  // Before the first sync the reveal_sync table doesn't exist yet
  let f = await gatherFacts(ENV(DB), { fetchImpl: jtFetch() });
  assert.deepEqual(f.revealChecks, { enabled: false, lastRunAt: null, checked: null, posted: null, repaired: null, errors: null, lastErrorAt: null, syncedAt: null, syncedJobs: null });

  await DB.prepare('INSERT INTO site_config (key, data, updated_at) VALUES (?, ?, ?)').bind('reveal-nudges', JSON.stringify({
    enabled: true,
    lastRun: { day: '2026-10-19', at: '2026-10-19T12:00:03.000Z', checked: 9, posted: 2, repaired: 1, errors: 0 },
    lastError: { at: '2026-10-16T12:00:00.000Z', error: 'JobTread returned 503: secret-ish detail' },
  }), '2026-10-19T12:00:04Z').run();
  await DB.prepare('CREATE TABLE reveal_sync (job_id TEXT PRIMARY KEY, updated_at TEXT)').run();
  await DB.prepare('INSERT INTO reveal_sync (job_id, updated_at) VALUES (?, ?), (?, ?)').bind('j1', '2026-10-18T15:00:00Z', 'j2', '2026-10-19T09:30:00Z').run();
  f = await gatherFacts(ENV(DB), { fetchImpl: jtFetch() });
  assert.deepEqual(f.revealChecks, {
    enabled: true, lastRunAt: '2026-10-19T12:00:03.000Z', checked: 9, posted: 2, repaired: 1, errors: 0,
    lastErrorAt: '2026-10-16T12:00:00.000Z', syncedAt: '2026-10-19T09:30:00Z', syncedJobs: 2,
  });
  assert.ok(!JSON.stringify(f).includes('secret-ish'));
});

test('kid status from JobTread reports its last sweep, last run and the profiles it hid', async () => {
  const DB = await makeDb();
  // Before the first sync the kid_status_state table doesn't exist yet
  let f = await gatherFacts(ENV(DB), { fetchImpl: jtFetch() });
  assert.deepEqual(f.kidStatus, { lastSweepAt: null, lastRunAt: null, changed: null, deployPending: false, lastAutoDeployAt: null, hidden: 0 });

  await DB.prepare('CREATE TABLE kid_status_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)').run();
  await DB.prepare("INSERT INTO kid_status_state (key, value) VALUES ('state', ?)").bind(JSON.stringify({
    lastSweepAt: '2026-10-20T15:00:00.000Z', lastRun: { at: '2026-10-20T15:05:00.000Z', scope: 'job', changed: 1 },
    lastAutoDeployAt: '2026-10-20T15:00:01.000Z', deployPending: true, alerted: { kendall: '2026-10-20T15:00:00.000Z' },
  })).run();
  await DB.prepare('INSERT INTO kids (slug, data) VALUES (?, ?), (?, ?)')
    .bind('kendall', JSON.stringify({ name: 'Kendall', publishStatus: 'draft', hiddenBy: 'jobtread' }), 'bo', JSON.stringify({ name: 'Bo', publishStatus: 'draft' })).run();
  f = await gatherFacts(ENV(DB), { fetchImpl: jtFetch() });
  assert.deepEqual(f.kidStatus, {
    lastSweepAt: '2026-10-20T15:00:00.000Z', lastRunAt: '2026-10-20T15:05:00.000Z', changed: 1,
    deployPending: true, lastAutoDeployAt: '2026-10-20T15:00:01.000Z', hidden: 1,
  });
  assert.ok(!JSON.stringify(f).includes('kendall'), 'who was alerted stays out');
});
