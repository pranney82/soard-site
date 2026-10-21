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
import { slackCard, personName, esc } from '../functions/api/_slack-cards.js';
import * as actions from '../functions/api/slack-actions.js';
import { renderSlack, slackButtons } from './lib/slack-render.mjs';
import { createHmac } from 'node:crypto';

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
  slack = { token: TOKEN, seq: 0, postError: null, blocksOk: true, hookDown: false, pageSize: 2, rateLimitOnce: false, scopes: new Set(['chat:write', 'chat:write.public', 'channels:read', 'groups:read']) };
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
      // Like Slack: each requested type needs its scope, and one missing refuses the whole call
      const need = [body.types.includes('public_channel') && 'channels:read', body.types.includes('private_channel') && 'groups:read'].filter((x) => x && !slack.scopes.has(x));
      if (need.length) return json({ ok: false, error: 'missing_scope', needed: need.join(','), provided: [...slack.scopes].join(',') });
      const listed = CHANNELS.filter((c) => (c.is_private ? body.types.includes('private_channel') : body.types.includes('public_channel')));
      const start = Number(body.cursor || 0);
      const page = listed.slice(start, start + slack.pageSize);
      const next = start + slack.pageSize < listed.length ? String(start + slack.pageSize) : '';
      return json({ ok: true, channels: page, response_metadata: { next_cursor: next } });
    }
    if (method === 'chat.postMessage') {
      if (slack.rateLimitOnce) { slack.rateLimitOnce = false; return new Response('', { status: 429, headers: { 'Retry-After': '1' } }); }
      if (slack.postError) return json({ ok: false, error: slack.postError });
      if (body.blocks && !slack.blocksOk) return json({ ok: false, error: 'invalid_blocks' });
      return json({ ok: true, channel: body.channel, ts: `${++slack.seq}.000100` });
    }
    if (method === 'chat.update') {
      if (slack.postError) return json({ ok: false, error: slack.postError });
      return json({ ok: true, channel: body.channel, ts: body.ts });
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

  assert.deepEqual(await notify.slackStatus({ DB: env.DB, SLACK_WEBHOOK_URL: HOOK }), { mode: 'webhook', webhook: true, ok: true, error: null, errorFor: null, team: null, bot: null, channel: { id: 'G0PRIVATE', name: 'board', private: false }, attention: null });
});

test('the channel list pages through Slack and comes back sorted', async () => {
  const r = await notify.slackChannels(env);
  assert.equal(r.ok, true);
  assert.deepEqual(r.channels.map((c) => c.name), ['board', 'general', 'website-alerts']);
  assert.equal(calls.filter((c) => c.url.endsWith('/conversations.list')).length, 2);
  assert.equal(r.channels.find((c) => c.name === 'board').private, true);
});

test('a missing Slack permission is named; without groups:read the public channels still list', async () => {
  slack.scopes.delete('groups:read');
  const partial = await notify.slackChannels(env);
  assert.equal(partial.ok, true);
  assert.equal(partial.missing, 'groups:read');
  assert.deepEqual(partial.channels.map((c) => c.name), ['general', 'website-alerts']);

  slack.scopes.delete('channels:read');
  const none = await notify.slackChannels(env);
  assert.equal(none.ok, false);
  assert.equal(none.error, 'missing_scope');
  assert.equal(none.needed, 'channels:read,groups:read', 'both named at once');
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
  assert.equal(hello.body.text, '🎉 Good news from the website will post here\nPeter picked this channel in the admin for the moments everyone celebrates: gifts, new applications, reveals going live and their replays.');
  assert.match(renderSlack(hello.body), /\nUntil a Needs attention channel is picked, alerts that need a hand post here too\./);
  assert.doesNotMatch(JSON.stringify(hello.body), /peter@test/, 'a name, not an address');
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

test('the admin channel list passes on which Slack permission is missing', async () => {
  slack.scopes.delete('groups:read');
  const partial = await adminPost({ action: 'slackChannels' });
  assert.equal(partial.success, true);
  assert.equal(partial.missing, 'groups:read');
  slack.scopes.delete('channels:read');
  const refused = await adminPost({ action: 'slackChannels' });
  assert.equal(refused.success, false);
  assert.equal(refused.slackError, 'missing_scope');
  assert.equal(refused.needed, 'channels:read,groups:read');
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
  assert.deepEqual(f.slack, { mode: 'bot', ok: true, error: null, team: 'SOARD', channel: 'website-alerts', attention: null, bot: 'soard_website' });
  await pickBoth();
  f = await gatherFacts(env, { fetchImpl: async () => new Response('{}', { status: 500 }) });
  assert.deepEqual([f.slack.channel, f.slack.attention], ['general', 'website-alerts'], 'both channels named');
  await pick();

  slack.token = 'xoxb-other';
  f = await gatherFacts(env, { fetchImpl: async () => new Response('{}', { status: 500 }) });
  assert.equal(f.slack.ok, false);
  assert.equal(f.slack.error, 'invalid_auth');

  f = await gatherFacts({ DB: env.DB }, { fetchImpl: async () => new Response('{}', { status: 500 }) });
  assert.equal(f.env.slack, false);
  assert.equal(f.slack.mode, null);
});


// ─── The card: one look for every post ───────────────────────────────

test('a card: icon headline, test marker, lead, a grid of facts, what to do, buttons, footer', () => {
  const c = slackCard({
    icon: '📝', title: 'New application: Avery, age 9', test: 'Test application · not a real family',
    lead: 'Accessible Bathroom · Cobb County · 2027 season',
    facts: [['Service area', 'Inside'], ['Language', null], ['Video', ''], { label: 'Photos', value: 4 }],
    fix: 'Nothing to do.',
    buttons: [{ label: 'Open the application', url: 'https://x.test/a' }, null, { label: 'Open in JobTread', url: 'https://jt.test/b' }],
    footer: ['From the website', 'Applications'],
  });
  assert.deepEqual(c.blocks.map((b) => b.type), ['header', 'context', 'section', 'section', 'section', 'actions', 'context']);
  assert.deepEqual(c.blocks[0].text, { type: 'plain_text', text: '📝 New application: Avery, age 9', emoji: true });
  assert.equal(renderSlack(c), [
    '📝 New application: Avery, age 9',
    '🧪 *Test application · not a real family*',
    'Accessible Bathroom · Cobb County · 2027 season',
    'Service area: Inside',
    'Photos: 4',
    '*What to do*\nNothing to do.',
    '[Open the application] [Open in JobTread]',
    'From the website  ·  Applications',
  ].join('\n'), 'empty facts are left out');
  const [main, other] = c.blocks.find((b) => b.type === 'actions').elements;
  assert.equal(main.style, 'primary', 'the first button is the main one');
  assert.equal(other.style, undefined);
  assert.notEqual(main.action_id, other.action_id);
  // The lock screen: headline and the lead's first line, marked as a test, never a URL
  assert.equal(c.text, '🧪 Test · 📝 New application: Avery, age 9\nAccessible Bathroom · Cobb County · 2027 season');
  // If Slack refuses the blocks, the text resend still carries every part
  for (const part of ['Service area: Inside', 'What to do: Nothing to do.', 'Open in JobTread: https://jt.test/b', 'From the website']) assert.ok(c.plain.includes(part), part);
});

test('a card never puts a URL in the notification, escapes what people typed, and stays inside Slack’s limits', () => {
  const c = slackCard({ icon: '⚠️', title: 'x'.repeat(200), lead: 'See https://evil.test/a?b=1 now <!channel> & more', buttons: Array.from({ length: 8 }, (_, i) => ({ label: `B${i}`, url: `https://x.test/${i}` })) });
  assert.doesNotMatch(c.text, /https?:/);
  assert.ok(c.blocks[0].text.text.length <= 150);
  assert.match(c.blocks[1].text.text, /&lt;!channel&gt; &amp; more/);
  assert.equal(c.blocks.find((b) => b.type === 'actions').elements.length, 5);
  assert.equal(esc('<a>&'), '&lt;a&gt;&amp;');
});

test('people are named, not addressed', () => {
  assert.equal(personName('peter@soardcharity.com'), 'Peter');
  assert.equal(personName('jane.doe-smith@x.org'), 'Jane Doe Smith');
  assert.equal(personName('info@soardcharity.com'), 'info@soardcharity.com', 'a shared inbox stays the address');
  assert.equal(personName(''), 'someone');
});

// ─── Threads, edits, and problems that clear ─────────────────────────

test('a reply goes in the thread (and the channel when asked); an edit uses chat.update', async () => {
  await pick();
  const first = await notify.slackAlert(env, 'First', null);
  assert.ok(first.ts);
  await notify.slackAlert(env, 'Reply', null, { thread: { channel: first.channel, ts: first.ts, broadcast: true } });
  const reply = posts().at(-1).body;
  assert.equal(reply.thread_ts, first.ts);
  assert.equal(reply.reply_broadcast, true);
  const edit = await notify.slackAlert(env, 'Edited', [{ type: 'section', text: { type: 'mrkdwn', text: 'Edited' } }], { update: { channel: first.channel, ts: first.ts } });
  assert.equal(edit.ok, true);
  const upd = calls.filter((c) => c.url.endsWith('/chat.update')).at(-1).body;
  assert.equal(upd.ts, first.ts);
  assert.equal(upd.channel, 'C0ALERTS1');
});

test('through the old webhook a reply is a new post and an edit is skipped', async () => {
  const hookEnv = { SLACK_WEBHOOK_URL: HOOK };
  assert.equal((await notify.slackAlert(hookEnv, 'Reply', null, { thread: { channel: 'C1', ts: '1.1' } })).via, 'webhook');
  assert.equal((await notify.slackAlert(hookEnv, 'Edit', null, { update: { channel: 'C1', ts: '1.1' } })).skipped, true);
  assert.equal(hookPosts().length, 1);
});

test('a problem is one thread: follow-ups reply under it, and clearing turns the first post ✅', async () => {
  await pick();
  const card = (t) => slackCard({ icon: '⚠️', title: t, lead: 'Something broke.' });
  const a = await notify.slackIssue(env, 'invite:42', card('Reveal invite problem: Max'), { title: 'Reveal invite problem: Max' });
  assert.equal(a.ok, true);
  assert.equal((await notify.slackOpenPost(env, 'invite:42')).ts, a.ts);

  await notify.slackIssue(env, 'invite:42', card('Reveal invite problem: Max'));
  const follow = posts().at(-1).body;
  assert.equal(follow.thread_ts, a.ts, 'a second post for the same problem replies under the first');
  assert.equal(follow.reply_broadcast, true, 'and still shows in the channel');

  const done = await notify.slackResolved(env, 'invite:42', slackCard({ icon: '✅', title: 'Invite fixed: Max' }), { summary: 'Max’s invite went out after all.' });
  assert.equal(done.ok, true);
  const edit = calls.filter((c) => c.url.endsWith('/chat.update')).at(-1).body;
  assert.equal(edit.ts, a.ts);
  assert.equal(renderSlack(edit), '✅ Resolved: Reveal invite problem: Max\nMax’s invite went out after all.');
  assert.equal(posts().at(-1).body.thread_ts, a.ts);
  assert.equal(await notify.slackOpenPost(env, 'invite:42'), null, 'forgotten once it cleared');
  assert.equal(await notify.slackResolved(env, 'invite:42', card('again')), null, 'nothing open: nothing to clear');

  await notify.slackIssue(env, 'invite:42', card('Reveal invite problem: Max'));
  assert.equal(posts().at(-1).body.thread_ts, undefined, 'the next time it breaks is a new post');
});

test('alertAdmins: the level picks the icon, the URL picks the button, "TEST · " marks a test, and issue/resolves thread', async () => {
  await pick();
  await notify.alertAdmins(env, {}, { level: 'error', title: 'TEST · Live broadcast health check failed', detail: '• Stream is down', url: 'https://sunshineonaranneyday.com/admin/#broadcast/control-room', issue: 'broadcast-health' });
  const first = posts().at(-1).body;
  assert.equal(renderSlack(first), '🚨 Live broadcast health check failed\n🧪 *Test reveal · not a real family*\n• Stream is down\n[Open the control room]');
  assert.equal(first.text, '🧪 Test · 🚨 Live broadcast health check failed\n• Stream is down');
  await notify.alertAdmins(env, {}, { level: 'info', title: 'Live broadcast health recovered', detail: 'All checks pass again.', resolves: 'broadcast-health' });
  const edit = calls.filter((c) => c.url.endsWith('/chat.update')).at(-1).body;
  assert.equal(renderSlack(edit), '✅ Resolved: Live broadcast health check failed\nLive broadcast health recovered. All checks pass again.');
  assert.match(renderSlack(posts().at(-1).body), /^✅ Live broadcast health recovered/);
  // A clear with nothing open still says so, as a plain post
  await notify.alertAdmins(env, {}, { level: 'info', title: 'The reveal has sound again', resolves: 'live:b1:silent' });
  assert.equal(posts().at(-1).body.thread_ts, undefined);
  await notify.alertAdmins(env, {}, { level: 'warn', title: 'Heads up', url: 'https://sunshineonaranneyday.com/live/' });
  assert.deepEqual(slackButtons(posts().at(-1).body), [{ label: 'Watch live', url: 'https://sunshineonaranneyday.com/live/' }]);
  assert.match(posts().at(-1).body.blocks[0].text.text, /^⚠️ Heads up/);
});

// ─── The button endpoint ─────────────────────────────────────────────

const click = (body, headers = {}) => new Request('https://x/api/slack-actions', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body });
const blockActions = `payload=${encodeURIComponent(JSON.stringify({ type: 'block_actions', actions: [{ action_id: 'open-0' }] }))}`;

test('button clicks get the empty 200 Slack wants, and the last one is kept', async () => {
  const r = await actions.onRequestPost({ env, request: click(blockActions) });
  assert.equal(r.status, 200);
  assert.equal(await r.text(), '');
  const row = await env.DB.prepare('SELECT data FROM site_config WHERE key = ?').bind(actions.SLACK_ACTIONS_KEY).first();
  assert.equal(JSON.parse(row.data).action, 'open-0');
  // Anything else is still a quiet 200, and isn't kept
  assert.equal((await actions.onRequestPost({ env: { ...env, DB: null }, request: click('hello') })).status, 200);
});

test('with SLACK_SIGNING_SECRET set, only Slack-signed clicks are answered', async () => {
  const secret = 'shh';
  const t = String(Math.floor(Date.now() / 1000));
  const sig = `v0=${createHmac('sha256', secret).update(`v0:${t}:${blockActions}`).digest('hex')}`;
  const signedEnv = { ...env, SLACK_SIGNING_SECRET: secret };
  assert.equal((await actions.onRequestPost({ env: signedEnv, request: click(blockActions, { 'X-Slack-Request-Timestamp': t, 'X-Slack-Signature': sig }) })).status, 200);
  assert.equal((await actions.onRequestPost({ env: signedEnv, request: click(blockActions, { 'X-Slack-Request-Timestamp': t, 'X-Slack-Signature': 'v0=00' }) })).status, 401);
  const old = String(Math.floor(Date.now() / 1000) - 600);
  const oldSig = `v0=${createHmac('sha256', secret).update(`v0:${old}:${blockActions}`).digest('hex')}`;
  assert.equal((await actions.onRequestPost({ env: signedEnv, request: click(blockActions, { 'X-Slack-Request-Timestamp': old, 'X-Slack-Signature': oldSig }) })).status, 401, 'a replayed click is refused');
});

// ─── Two channels: good news, and what needs a hand ──────────────────

const pickBoth = () => notify.writeSlackConfig(env.DB, { channel: { id: 'C0GENERAL', name: 'general', private: false }, attention: { id: 'C0ALERTS1', name: 'website-alerts', private: false } });

test('good news and alerts each go to their own channel; with one channel picked, both go there', async () => {
  await pick('C0GENERAL', 'general');
  await notify.slackAlert(env, 'A gift!', null, { kind: 'news' });
  await notify.slackAlert(env, 'Stuck');
  assert.deepEqual(posts().map((p) => p.body.channel), ['C0GENERAL', 'C0GENERAL'], 'one channel: everything there');
  await pickBoth();
  await notify.slackAlert(env, 'A gift!', null, { kind: 'news' });
  await notify.slackAlert(env, 'Stuck');
  await notify.alertAdmins(env, {}, { level: 'info', kind: 'news', icon: '📡', title: 'Live now: Max' });
  await notify.alertAdmins(env, {}, { level: 'warn', title: 'No countdown yet: Max' });
  assert.deepEqual(posts().slice(2).map((p) => p.body.channel), ['C0GENERAL', 'C0ALERTS1', 'C0GENERAL', 'C0ALERTS1']);
  assert.equal(notify.slackChannelFor({ channel: { id: 'A' } }, 'attention'), 'A');
  assert.equal(notify.slackChannelFor({}, 'news'), null);
});

test('@here only for an urgent problem, only in a Needs attention channel of its own, never for a test', async () => {
  await pick('C0GENERAL', 'general');
  await notify.alertAdmins(env, {}, { level: 'error', title: 'Reveal audio is silent', urgent: true });
  assert.doesNotMatch(JSON.stringify(posts().at(-1).body), /<!here>/, 'no @here in the channel everyone talks in');
  await pickBoth();
  await notify.alertAdmins(env, {}, { level: 'error', title: 'Reveal audio is silent', urgent: true });
  const loud = posts().at(-1).body;
  assert.equal(loud.channel, 'C0ALERTS1');
  assert.match(loud.text, /^<!here> 🚨 Reveal audio is silent/, 'phones buzz');
  assert.equal(loud.blocks[1].elements[0].text, '<!here> needs someone right now');
  await notify.alertAdmins(env, {}, { level: 'error', title: 'TEST · Reveal audio is silent', urgent: true });
  assert.doesNotMatch(JSON.stringify(posts().at(-1).body), /<!here>/, 'a rehearsal never pings anyone');
  await notify.alertAdmins(env, {}, { level: 'warn', title: 'Reveal audio is very quiet' });
  assert.doesNotMatch(JSON.stringify(posts().at(-1).body), /<!here>/);
  await notify.writeSlackConfig(env.DB, { channel: { id: 'C0GENERAL', name: 'general' }, attention: { id: 'C0GENERAL', name: 'general' } });
  await notify.alertAdmins(env, {}, { level: 'error', title: 'Reveal audio is silent', urgent: true });
  assert.doesNotMatch(JSON.stringify(posts().at(-1).body), /<!here>/, 'the same channel picked twice is still the shared one');
});

test('the admin picks each channel, says hello in it, can put alerts back with the good news, and tests both', async () => {
  await adminPost({ action: 'setSlackChannel', id: 'C0GENERAL' });
  const d = await adminPost({ action: 'setSlackChannel', id: 'C0ALERTS1', role: 'attention' });
  assert.equal(d.success, true);
  assert.deepEqual(d.slack.attention, { id: 'C0ALERTS1', name: 'website-alerts', private: false, member: false });
  assert.equal(d.slack.channel.name, 'general');
  const hello = posts().at(-1).body;
  assert.equal(hello.channel, 'C0ALERTS1');
  assert.match(hello.text, /^👋 Website alerts that need a hand will post here\nPeter picked this channel/);
  assert.match(renderSlack(hello), /Something failing during a live reveal pings whoever is active here, so phones buzz\./);
  assert.doesNotMatch(JSON.stringify(hello), /@here|@channel|<!here>|<!channel>/, 'a hello never pings: Slack reads even the plain words as a mention');

  const t = await adminPost({ action: 'testAlert' });
  assert.equal(t.success, true);
  assert.deepEqual(posts().slice(-2).map((p) => p.body.channel), ['C0ALERTS1', 'C0GENERAL'], 'one test in each channel');
  assert.match(renderSlack(posts().at(-1).body), /alerts that need a hand go to #website-alerts/);

  const back = await adminPost({ action: 'setSlackChannel', id: '', role: 'attention' });
  assert.equal(back.success, true);
  assert.equal(back.slack.attention, null);
  assert.equal((await notify.readSlackConfig(env.DB, { fresh: true })).attention, undefined);
  await notify.slackAlert(env, 'Stuck');
  assert.equal(posts().at(-1).body.channel, 'C0GENERAL');
  assert.equal((await adminPost({ action: 'setSlackChannel', id: '' })).success, false, 'the good-news channel can’t be left empty');
});

test('the health check checks both channels and says which one needs the fix', async () => {
  await notify.writeSlackConfig(env.DB, { channel: { id: 'C0GENERAL', name: 'general' }, attention: { id: 'G0PRIVATE', name: 'board' } });
  const st = await notify.slackStatus(env);
  assert.equal(st.ok, false);
  assert.equal(st.error, 'not_in_channel');
  assert.equal(st.errorFor, 'attention');
  assert.equal(st.channel.name, 'general');
  await pickBoth();
  assert.equal((await notify.slackStatus(env)).ok, true);
});

// ─── The one-time test run in Slack ──────────────────────────────────

const runPreview = async (preview, start = Date.now()) => {
  let r;
  let n = 0;
  do { r = await preview.maybeSlackPreview(env, { runs: ['attention'], now: start + (n++) * 60e3, gapMs: 0 }); } while (r && !r.done && n < 20);
  return r;
};

test('the test run: an intro, every alert as its own post, problems that really thread and turn ✅, a closing post, once', async () => {
  const preview = await import('../functions/api/_slack-preview.js');
  await pickBoth();
  const samples = preview.previewSamples();
  const first = await preview.maybeSlackPreview(env, { runs: ['attention'], now: Date.now(), gapMs: 0 });
  assert.deepEqual({ posted: first.posted, next: first.next, done: first.done }, { posted: 5, next: 5, done: false }, 'five a minute');
  const r = await runPreview(preview, Date.now() + 60e3);
  assert.equal(r.done, true);
  const all = calls.filter((c) => /chat\.(postMessage|update)$/.test(c.url)).map((c) => ({ method: c.url.split('/').pop(), ...c.body }));
  assert.ok(all.every((p) => p.channel === 'C0ALERTS1'), 'all in the Needs attention channel, never the one everyone talks in');
  const posts = all.filter((p) => p.method === 'chat.postMessage');
  const edits = all.filter((p) => p.method === 'chat.update');
  assert.equal(renderSlack(posts[0]).split('\n')[0], '🧪 Test run: every alert the website sends');
  assert.equal(renderSlack(posts.at(-1)).split('\n')[0], '✅ That’s the whole test run');
  assert.equal(posts.length + edits.length, samples.length + 2, 'the intro, each sample once, the closing post');
  const top = posts.filter((p) => !p.thread_ts);
  assert.equal(top.length, samples.filter((x) => x.act === 'post').length + 2, 'every alert is its own post, like the real ones');
  // The problems play out the way they really do
  const cap = (p) => p.blocks?.[0]?.elements?.[0]?.text || '';
  const stuck = top.find((p) => /^🧪 \*Test \d+ of \d+\* · Applications · Stuck, then fixes itself · real ones post here$/.test(cap(p)));
  const stuckTs = `${posts.indexOf(stuck) + 1}.000100`;
  assert.ok(edits.some((e) => e.ts === stuckTs && /✅ Resolved: Maya Lopez’s application was stuck/.test(renderSlack(e))), 'its first post edited into a short ✅');
  assert.ok(posts.some((p) => p.thread_ts === stuckTs && p.reply_broadcast === true), 'and said so in its thread, shown in the channel too');
  assert.ok(posts.filter((p) => p.thread_ts).length >= 4, 'reminders and resolutions reply in their own threads');
  // Where the real ones go
  assert.match(cap(top.find((p) => / · Gifts · Gift · /.test(cap(p)))), /real ones post in #general$/);
  // Nobody is pinged, and nothing is emailed or remembered
  assert.doesNotMatch(JSON.stringify(all), /@here|@channel|<!here>|<!channel>/, 'Slack reads even the plain words as a mention');
  assert.ok(JSON.stringify(all).includes('＠here'), 'the ping sample still shows the mention');
  assert.equal(calls.filter((c) => !c.url.startsWith('https://slack.com/')).length, 0, 'no email, nothing else');
  assert.doesNotMatch(JSON.stringify(all), /[\w.+-]+@[\w-]+\.[a-z]{2,}/i, 'no email address anywhere in it');
  assert.equal((await env.DB.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'slack_open_posts'").first())?.n ? (await env.DB.prepare('SELECT count(*) AS n FROM slack_open_posts').first()).n : 0, 0, 'no open problems remembered');
  assert.equal(await preview.maybeSlackPreview(env, { runs: ['attention'], now: Date.now() + 60 * 60e3, gapMs: 0 }), null, 'and never again');
});

test('the test run waits for a Needs attention channel of its own, overlapping heartbeats post nothing twice, and a refusal is retried', async () => {
  const preview = await import('../functions/api/_slack-preview.js');
  assert.equal(await preview.maybeSlackPreview(env, { runs: ['attention'], gapMs: 0 }), null, 'no channel picked yet');
  await pick();
  assert.equal(await preview.maybeSlackPreview(env, { runs: ['attention'], gapMs: 0 }), null, 'only the good-news channel: it waits');
  assert.equal(posts().length, 0);
  await pickBoth();
  slack.postError = 'not_in_channel';
  assert.equal((await preview.maybeSlackPreview(env, { runs: ['attention'], gapMs: 0 })).error, 'not_in_channel');
  slack.postError = null;
  const t0 = Date.now() + 120e3;
  assert.equal((await preview.maybeSlackPreview(env, { runs: ['attention'], now: t0, gapMs: 0 })).posted, 5);
  // A heartbeat that overlaps the one posting does nothing
  const row = await env.DB.prepare('SELECT data FROM site_config WHERE key = ?').bind(preview.SLACK_PREVIEW_KEY).first();
  const st = JSON.parse(row.data);
  await env.DB.prepare('UPDATE site_config SET data = ? WHERE key = ?').bind(JSON.stringify({ ...st, leaseUntil: t0 + 120e3 }), preview.SLACK_PREVIEW_KEY).run();
  assert.equal(await preview.maybeSlackPreview(env, { runs: ['attention'], now: t0 + 1000, gapMs: 0 }), null);
  const intros = posts().filter((p) => p.body.blocks?.[0]?.text?.text === '🧪 Test run: every alert the website sends');
  assert.equal(intros.length, 2, 'one refused by Slack, then the one that landed: never two in the channel');
});

test('the good-news test run: just the good-news alerts, as real posts in the good-news channel, once', async () => {
  const preview = await import('../functions/api/_slack-preview.js');
  await pickBoth();
  const want = preview.previewSamples().filter((x) => x.kind === 'news' && x.act === 'post' && x.group !== 'Setup');
  assert.equal(want.length, 12);
  let r;
  let n = 0;
  do { r = await preview.maybeSlackPreview(env, { runs: ['news'], now: Date.now() + (n++) * 60e3, gapMs: 0 }); } while (r && !r.done && n < 10);
  assert.equal(r.done, true);
  assert.equal(n, 3, 'five a minute');
  const sent = posts().map((p) => p.body);
  assert.equal(sent.length, 12, 'just the twelve: no intro, no closing');
  assert.ok(sent.every((p) => p.channel === 'C0GENERAL' && !p.thread_ts), 'each its own post in the good-news channel');
  assert.match(sent[0].blocks[0].elements[0].text, /^🧪 \*Test 1 of 12\* · Applications · New application · real ones post here$/);
  assert.ok(sent.some((p) => /💛 \$50\.00 gift from Jane Doe/.test(renderSlack(p))));
  assert.doesNotMatch(JSON.stringify(sent), /@here|@channel|<!here>|<!channel>|[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
  const row = JSON.parse((await env.DB.prepare('SELECT data FROM site_config WHERE key = ?').bind(preview.SLACK_PREVIEW_NEWS_KEY).first()).data);
  assert.equal(row.posts.length, 12, 'every post kept, so it can be read back');
  assert.equal(await preview.maybeSlackPreview(env, { runs: ['news'], gapMs: 0 }), null, 'and never again');
  // The full test run is its own, untouched
  assert.equal((await env.DB.prepare('SELECT data FROM site_config WHERE key = ?').bind(preview.SLACK_PREVIEW_KEY).first()), null);
});

test('both runs from one heartbeat: each to its own channel', async () => {
  const preview = await import('../functions/api/_slack-preview.js');
  await pickBoth();
  const r = await preview.maybeSlackPreview(env, { gapMs: 0 });
  assert.equal(r.attention.posted, 5);
  assert.equal(r.news.posted, 5);
  assert.deepEqual([...new Set(posts().map((p) => p.body.channel))].sort(), ['C0ALERTS1', 'C0GENERAL']);
});
