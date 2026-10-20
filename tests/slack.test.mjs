/**
 * Slack: the site's Slack app (SLACK_BOT_TOKEN, channel picked in the admin)
 * and the old incoming webhook as a fallback. The picker, the health check
 * and every post go through _broadcast-notify.js.
 * Run: node --test tests/
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import * as notify from '../functions/api/_broadcast-notify.js';
import * as admin from '../functions/api/broadcast-admin.js';
import { gatherFacts } from '../functions/api/automations-admin.js';

const realFetch = globalThis.fetch;
const TOKEN = 'xoxb-test';
const HOOK = 'https://hooks.slack.test/T0/B0/x';
let slack; // the fake Slack workspace
let calls;
let env;

const CHANNELS = [
  { id: 'C0ALERTS1', name: 'website-alerts', is_private: false, is_member: false },
  { id: 'C0GENERAL', name: 'general', is_private: false, is_member: true },
  { id: 'G0PRIVATE', name: 'board', is_private: true, is_member: false },
];

beforeEach(async () => {
  calls = [];
  slack = { token: TOKEN, postError: null, blocksOk: true, hookDown: false, pageSize: 2, rateLimitOnce: false };
  env = { DB: await createD1({ schemaFiles: ['scripts/schema.sql'] }), SLACK_BOT_TOKEN: TOKEN };
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const type = init.headers?.['Content-Type'] || '';
    const body = !init.body ? {} : type.startsWith('application/json') ? JSON.parse(init.body) : Object.fromEntries(new URLSearchParams(init.body));
    calls.push({ url, type, body, auth: init.headers?.Authorization || null });
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
    if (url === HOOK) return slack.hookDown ? new Response('no_service', { status: 404 }) : new Response('ok');
    if (!url.startsWith('https://slack.com/api/')) throw new Error(`no fake for ${url}`);
    if (init.headers?.Authorization !== `Bearer ${slack.token}`) return json({ ok: false, error: 'invalid_auth' });
    const method = url.slice('https://slack.com/api/'.length);
    if (method === 'auth.test') return json({ ok: true, team: 'SOARD', user: 'soard_website' });
    if (method === 'conversations.info') {
      const c = CHANNELS.find((x) => x.id === body.channel);
      return json(c ? { ok: true, channel: c } : { ok: false, error: 'channel_not_found' });
    }
    if (method === 'conversations.list') {
      const start = Number(body.cursor || 0);
      const page = CHANNELS.slice(start, start + slack.pageSize);
      const next = start + slack.pageSize < CHANNELS.length ? String(start + slack.pageSize) : '';
      return json({ ok: true, channels: page, response_metadata: { next_cursor: next } });
    }
    if (method === 'chat.postMessage') {
      if (slack.rateLimitOnce) { slack.rateLimitOnce = false; return new Response('', { status: 429, headers: { 'Retry-After': '1' } }); }
      if (slack.postError) return json({ ok: false, error: slack.postError });
      if (body.blocks && !slack.blocksOk) return json({ ok: false, error: 'invalid_blocks' });
      return json({ ok: true, channel: body.channel, ts: '1.2' });
    }
    return json({ ok: false, error: 'unknown_method' });
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

const posts = () => calls.filter((c) => c.url.endsWith('/chat.postMessage'));
const hookPosts = () => calls.filter((c) => c.url === HOOK);
const pick = (id = 'C0ALERTS1', name = 'website-alerts') => notify.writeSlackConfig(env.DB, { channel: { id, name, private: false } });
const adminPost = async (body) => (await admin.onRequestPost({ env, request: new Request('https://x/api/broadcast-admin', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), data: { userEmail: 'peter@test' } })).json();

// ─── Posting ─────────────────────────────────────────────────────────

test('with the app connected, alerts post to the picked channel with the bot token', async () => {
  await pick();
  const r = await notify.slackAlert(env, '🟢 Hello', [{ type: 'section', text: { type: 'mrkdwn', text: 'Hello' } }]);
  assert.equal(r.ok, true);
  assert.equal(r.via, 'bot');
  assert.equal(r.channel, 'C0ALERTS1');
  const [p] = posts();
  assert.equal(p.auth, `Bearer ${TOKEN}`);
  assert.match(p.type, /^application\/json/);
  assert.equal(p.body.channel, 'C0ALERTS1');
  assert.equal(p.body.text, '🟢 Hello');
  assert.equal(p.body.blocks.length, 1);
  assert.equal(p.body.unfurl_links, false);
});

test('rejected blocks are resent as plain text; a 429 is retried once', async () => {
  await pick();
  slack.blocksOk = false;
  const r = await notify.slackAlert(env, 'Plain please', [{ type: 'bogus' }]);
  assert.equal(r.ok, true);
  assert.equal(r.plain, true);
  assert.equal(posts().length, 2);
  assert.equal(posts()[1].body.blocks, undefined);

  calls = [];
  slack.rateLimitOnce = true;
  const again = await notify.slackAlert(env, 'Busy');
  assert.equal(again.ok, true);
  assert.equal(posts().length, 2, 'one retry after the 429');
});

test('if the app can’t post, alerts still land through the webhook, and the bot error is kept', async () => {
  await pick();
  env.SLACK_WEBHOOK_URL = HOOK;
  slack.postError = 'not_in_channel';
  const r = await notify.slackAlert(env, 'Still gets through');
  assert.equal(r.ok, true);
  assert.equal(r.via, 'webhook');
  assert.equal(r.botError, 'not_in_channel');
  assert.equal(hookPosts().length, 1);

  slack.hookDown = true;
  const both = await notify.slackAlert(env, 'Nothing works');
  assert.equal(both.ok, false);
  assert.match(both.error, /not_in_channel; webhook: no_service/);
});

test('a named channel needs the app and never falls back to the alerts webhook', async () => {
  env.SLACK_WEBHOOK_URL = HOOK;
  const r = await notify.slackAlert(env, 'Gift!', null, { channel: 'C0GENERAL' });
  assert.equal(r.via, 'bot');
  assert.equal(posts()[0].body.channel, 'C0GENERAL');

  slack.postError = 'channel_not_found';
  const failed = await notify.slackAlert(env, 'Gift!', null, { channel: 'C0NOPE' });
  assert.equal(failed.ok, false);
  assert.equal(hookPosts().length, 0);

  delete env.SLACK_BOT_TOKEN;
  const skipped = await notify.slackAlert(env, 'Gift!', null, { channel: 'C0GENERAL' });
  assert.equal(skipped.skipped, true);
  assert.match(skipped.error, /needs SLACK_BOT_TOKEN/);
});

test('nothing to post to is a skip, not a failure: no token and no webhook, or a token with no channel picked', async () => {
  const noChannel = await notify.slackAlert(env, 'Where to?');
  assert.equal(noChannel.skipped, true);
  assert.match(noChannel.error, /No Slack channel picked/);
  assert.equal(calls.length, 0);

  const bare = await notify.slackAlert({}, 'Nobody');
  assert.equal(bare.skipped, true);
  assert.equal(notify.slackConfigured({}), false);
  assert.equal(notify.slackConfigured({ SLACK_BOT_TOKEN: 'x' }), true);
});

test('a webhook-only env (no D1, no token) posts exactly as before', async () => {
  const r = await notify.slackAlert({ SLACK_WEBHOOK_URL: HOOK }, 'Old style');
  assert.equal(r.ok, true);
  assert.equal(r.via, 'webhook');
  assert.equal(hookPosts().length, 1);
});

// ─── Health check and channel list ───────────────────────────────────

test('the health check names the workspace, the bot and the channel, and spots each problem', async () => {
  let st = await notify.slackStatus(env);
  assert.equal(st.mode, 'bot');
  assert.equal(st.error, 'no_channel');
  assert.equal(st.team, 'SOARD');

  await pick();
  st = await notify.slackStatus(env);
  assert.equal(st.ok, true);
  assert.deepEqual(st.channel, { id: 'C0ALERTS1', name: 'website-alerts', private: false, member: false });
  assert.equal(st.bot, 'soard_website');
  const info = calls.find((c) => c.url.endsWith('/conversations.info'));
  assert.equal(info.type, 'application/x-www-form-urlencoded', 'Slack read methods get form fields');
  assert.equal(info.body.channel, 'C0ALERTS1');

  await pick('G0PRIVATE', 'board');
  assert.equal((await notify.slackStatus(env)).error, 'not_in_channel');

  slack.token = 'xoxb-rotated';
  assert.equal((await notify.slackStatus(env)).error, 'invalid_auth');

  assert.deepEqual(await notify.slackStatus({ DB: env.DB, SLACK_WEBHOOK_URL: HOOK }), { mode: 'webhook', webhook: true, ok: true, error: null, team: null, bot: null, channel: { id: 'G0PRIVATE', name: 'board', private: false } });
});

test('the channel list pages through Slack and comes back sorted', async () => {
  const r = await notify.slackChannels(env);
  assert.equal(r.ok, true);
  assert.deepEqual(r.channels.map((c) => c.name), ['board', 'general', 'website-alerts']);
  assert.equal(calls.filter((c) => c.url.endsWith('/conversations.list')).length, 2);
  assert.equal(r.channels.find((c) => c.name === 'board').private, true);
});

// ─── The admin picker ────────────────────────────────────────────────

test('picking a channel in the admin saves it and says hello there', async () => {
  const list = await adminPost({ action: 'slackChannels' });
  assert.equal(list.success, true);
  assert.equal(list.channels.length, 3);

  const d = await adminPost({ action: 'setSlackChannel', id: 'C0ALERTS1' });
  assert.equal(d.success, true);
  assert.deepEqual(d.channel, { id: 'C0ALERTS1', name: 'website-alerts', private: false });
  assert.equal(d.posted, true);
  assert.equal(d.slack.ok, true);
  const hello = posts().at(-1);
  assert.equal(hello.body.channel, 'C0ALERTS1');
  assert.match(hello.body.text, /will post its alerts here \(picked by peter@test\)/);
  assert.equal((await notify.readSlackConfig(env.DB, { fresh: true })).channel.name, 'website-alerts');
  assert.equal((await notify.readSlackConfig(env.DB, { fresh: true })).updatedBy, 'peter@test');

  // Every later alert follows the pick
  await notify.slackAlert(env, 'After the pick');
  assert.equal(posts().at(-1).body.channel, 'C0ALERTS1');
});

test('the picker refuses junk ids and unknown channels, and says when the app is not connected', async () => {
  assert.equal((await adminPost({ action: 'setSlackChannel', id: 'nope' })).success, false);
  const gone = await adminPost({ action: 'setSlackChannel', id: 'C0MISSING' });
  assert.match(gone.error, /channel_not_found/);
  delete env.SLACK_BOT_TOKEN;
  assert.match((await adminPost({ action: 'slackChannels' })).error, /SLACK_BOT_TOKEN/);
  const st = await adminPost({ action: 'slackStatus' });
  assert.equal(st.slack.mode, null);
});

test('a private channel the app is not in is saved, and the reason the hello failed is shown', async () => {
  slack.postError = 'not_in_channel';
  const d = await adminPost({ action: 'setSlackChannel', id: 'G0PRIVATE' });
  assert.equal(d.success, true);
  assert.equal(d.posted, false);
  assert.equal(d.postError, 'not_in_channel');
  assert.equal(d.slack.error, 'not_in_channel');
});

// ─── Automations ─────────────────────────────────────────────────────

test('Automations reports the live Slack connection: mode, channel, workspace or the error', async () => {
  await pick();
  let f = await gatherFacts(env, { fetchImpl: async () => new Response('{}', { status: 500 }) });
  assert.equal(f.env.slack, true);
  assert.deepEqual(f.slack, { mode: 'bot', ok: true, error: null, team: 'SOARD', channel: 'website-alerts', bot: 'soard_website' });

  slack.token = 'xoxb-other';
  f = await gatherFacts(env, { fetchImpl: async () => new Response('{}', { status: 500 }) });
  assert.equal(f.slack.ok, false);
  assert.equal(f.slack.error, 'invalid_auth');

  f = await gatherFacts({ DB: env.DB }, { fetchImpl: async () => new Response('{}', { status: 500 }) });
  assert.equal(f.env.slack, false);
  assert.equal(f.slack.mode, null);
});
