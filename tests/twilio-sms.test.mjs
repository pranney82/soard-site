import { test } from 'node:test';
import assert from 'node:assert/strict';
import { smsConfigured, sendSms } from '../functions/api/_broadcast-notify.js';
import { envFacts } from '../functions/api/automations-admin.js';

const BASE = { TWILIO_ACCOUNT_SID: 'AC123', TWILIO_FROM: '+18885550100' };
const KEY = { ...BASE, TWILIO_API_KEY_SID: 'SK456', TWILIO_API_KEY_SECRET: 'shh' };
const TOKEN = { ...BASE, TWILIO_AUTH_TOKEN: 'tok' };

test('texts are configured with a restricted API key or the auth token', () => {
  assert.equal(smsConfigured(KEY), true);
  assert.equal(smsConfigured(TOKEN), true);
  assert.equal(smsConfigured(BASE), false, 'no credentials');
  assert.equal(smsConfigured({ ...BASE, TWILIO_API_KEY_SID: 'SK456' }), false, 'key SID without its secret');
  assert.equal(smsConfigured({ TWILIO_API_KEY_SID: 'SK456', TWILIO_API_KEY_SECRET: 'shh', TWILIO_FROM: '+18885550100' }), false, 'the URL still needs the Account SID');
  assert.equal(smsConfigured({ ...KEY, TWILIO_FROM: '' }), false, 'no sender');
  assert.equal(envFacts(KEY).twilio, true);
  assert.equal(envFacts(TOKEN).twilio, true);
  assert.equal(envFacts(BASE).twilio, false);
});

async function capture(env) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return new Response('{}', { status: 201 }); };
  try {
    const out = await sendSms(env, { to: ['(404) 555-0123'], body: 'hi' });
    return { out, calls };
  } finally {
    globalThis.fetch = real;
  }
}

test('a restricted API key signs the request; the account SID stays in the URL', async () => {
  const { out, calls } = await capture({ ...KEY, TWILIO_AUTH_TOKEN: 'tok' });
  assert.equal(out.sent, 1);
  assert.equal(calls[0].url, 'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json');
  assert.equal(calls[0].init.headers.Authorization, 'Basic ' + btoa('SK456:shh'), 'the key wins over the auth token');
  assert.equal(calls[0].init.body.get('From'), '+18885550100');
});

test('the auth token still works on its own', async () => {
  const { out, calls } = await capture(TOKEN);
  assert.equal(out.sent, 1);
  assert.equal(calls[0].init.headers.Authorization, 'Basic ' + btoa('AC123:tok'));
});

test('texts only ever go to US and Canadian numbers', async () => {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push(init.body.get('To')); return new Response('{}', { status: 201 }); };
  try {
    const out = await sendSms(KEY, { to: ['+44 7700 900123', '+1 876 555 0123', '(888) 555-0100', '+1 (416) 555-0199'], body: 'hi' });
    assert.equal(out.sent, 1);
    assert.deepEqual(calls, ['+14165550199'], 'abroad, the Caribbean and toll-free numbers are never texted');
  } finally {
    globalThis.fetch = real;
  }
});

// ─── Staff alert texts ──────────────────────────────────────────────

import { alertText, alertHelloText, smsSafe, alertPhones, alertAdmins } from '../functions/api/_broadcast-notify.js';
import { textLine } from '../functions/api/_broadcast-preflight.js';

test('an alert text is the headline, the fix and the link, in plain characters within two segments', () => {
  assert.equal(
    alertText({ title: 'Reveal audio is silent', detail: 'No sound reaching the site.', fix: 'Check the mic: receiver plugged in.', url: 'https://sunshineonaranneyday.com/admin/' }),
    'SOARD: Reveal audio is silent\nFix: Check the mic: receiver plugged in.\nhttps://sunshineonaranneyday.com/admin/',
  );
  assert.equal(alertText({ title: 'Live now: Sam’s reveal', detail: 'First line.\nSecond line.' }), "SOARD: Live now: Sam's reveal\nFirst line.");
  const long = alertText({ title: '🚨 Reveal-day check found problems', detail: `• ${'x'.repeat(500)}`, url: 'https://sunshineonaranneyday.com/admin/' });
  assert.ok(long.length <= 306, long.length);
  assert.match(long, /^SOARD: Reveal-day check found problems\n- x+\.\.\.\nhttps:/);
  assert.ok(/^[\x20-\x7E\n]+$/.test(long));
  assert.equal(smsSafe('“Go” — it’s… → done'), '"Go" - it\'s... > done');
});

test('the hello text says who added the number and how to stop', () => {
  assert.match(alertHelloText({ by: 'Linzi' }), /^SOARD: Linzi added you to the live reveal alert texts\..*Reply STOP to opt out, HELP for help\.$/);
  assert.match(alertHelloText(), /^SOARD: You're on the live reveal alert texts\./);
  assert.deepEqual(alertPhones({ alerts: { phones: ['(404) 555-0123', '+14045550123', 'nope', '+44 7700 900123'] } }), ['+14045550123']);
});

test('the go / no-go as one line: all green, or the names of what is open', () => {
  const item = (status, label) => ({ status, label });
  assert.equal(textLine({ counts: { ok: 3 }, items: [item('ok', 'a'), item('ok', 'b'), item('ok', 'c'), item('off', 'Instagram')] }), 'All green: 3 of 3 checks pass.');
  assert.equal(textLine({ counts: { ok: 1 }, items: [item('ok', 'a'), { ...item('fail', 'No live input'), fix: 'Settings > Phones > Create it.' }, item('warn', 'Facebook token expires soon'), item('unknown', 'YouTube')] }),
    'Not ready: No live input. First: Settings > Phones > Create it.', 'a no-go says what isn’t ready and what to do first');
  assert.equal(textLine({ counts: { ok: 2 }, items: [item('ok', 'a'), item('ok', 'b'), item('warn', 'Facebook token expires soon.'), item('unknown', 'YouTube')] }),
    '2 of 4 pass. Check: Facebook token expires soon; YouTube.', 'a go with notes says what to look at');
});

test('alertAdmins texts the staff only when the alert asks', async () => {
  const sent = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => { if (String(url).startsWith('https://api.twilio.com/')) sent.push(init.body.get('Body')); return new Response('{}', { status: 201 }); };
  const env = { ...TOKEN };
  const config = { alerts: { phones: ['(404) 555-0123'] } };
  try {
    const quiet = await alertAdmins(env, config, { title: 'Reveal moved: Sam' });
    assert.equal(quiet.text, null);
    assert.equal(sent.length, 0, 'news without text: true is Slack and email only');
    const r = await alertAdmins(env, config, { level: 'error', title: 'Reveal audio is silent', fix: 'Check the mic.', url: 'https://sunshineonaranneyday.com/admin/', text: true });
    assert.equal(r.text.sent, 1);
    assert.equal(sent[0], 'SOARD ALERT: Reveal audio is silent\nFix: Check the mic.\nhttps://sunshineonaranneyday.com/admin/', 'a problem opens SOARD ALERT');
    await alertAdmins(env, config, { level: 'info', title: 'Reveal audio is back', detail: 'It lasted 0:40.', resolves: 'live:b:silent', text: true });
    assert.match(sent.at(-1), /^SOARD FIXED: Reveal audio is back\n/, 'clearing it opens SOARD FIXED');
    await alertAdmins(env, config, { title: 'Go: Sam', text: 'SOARD: custom words' });
    assert.equal(sent.at(-1), 'SOARD: custom words', 'a string is the text itself');
    assert.equal((await alertAdmins(env, { alerts: { phones: [] } }, { title: 'x', text: true })).text, null, 'nobody on the list');
  } finally {
    globalThis.fetch = real;
  }
});

// ─── Did it arrive? Twilio's delivery reports ───────────────────────

import { liveNowText, recordTextStatus, readAlertTexts, TEXT_STATUS_URL } from '../functions/api/_broadcast-notify.js';
import { goText } from '../functions/api/_broadcast-preflight.js';
import { onRequestPost as statusHook, twilioSignature } from '../functions/api/twilio-status.js';
import { createD1 } from './lib/d1-shim.mjs';

test('"Live now" promises only what is known, and the no-go reads as an alert', () => {
  assert.equal(liveNowText({ title: "Sam's room reveal", url: 'https://sunshineonaranneyday.com/live/sam/' }),
    'SOARD: Live now: Sam\'s room reveal\nChecking sound, picture, Facebook and YouTube. "All green" follows in about a minute.\nhttps://sunshineonaranneyday.com/live/sam/');
  const items = [{ status: 'ok', label: 'Stream' }, { status: 'fail', label: 'No live input for the phone', fix: 'Settings → Phones → Create the live input.' }];
  const text = goText({ ready: false, counts: { ok: 1, warn: 0, fail: 1, unknown: 0, off: 0 }, items }, { title: "Sam's room reveal", scheduledAt: '2026-10-28T20:00:00Z' }, { timezone: 'America/New_York' });
  assert.equal(text, "SOARD ALERT: No-go: Sam's room reveal at 4:00 PM\nNot ready: No live input for the phone. First: Settings > Phones > Create the live input.\nhttps://sunshineonaranneyday.com/admin/#broadcast/control-room");
});

test('every text asks Twilio for a delivery report when the auth token is set', async () => {
  const { calls } = await capture(TOKEN);
  assert.equal(calls[0].init.body.get('StatusCallback'), TEXT_STATUS_URL);
  const { calls: keyCalls } = await capture(KEY);
  assert.equal(keyCalls[0].init.body.get('StatusCallback'), null, 'without the auth token the report could not be checked, so none is asked for');
});

async function hookDb() {
  return createD1({ schemaSql: [
    'CREATE TABLE site_config (key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)',
    'CREATE TABLE rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0, reset_at INTEGER NOT NULL)',
  ] });
}

test('delivery reports: signed ones are kept per number; a miss tells staff once a day, never by text', async () => {
  const DB = await hookDb();
  await DB.prepare("INSERT INTO site_config (key, data, updated_at) VALUES ('broadcast-config', ?, 'x')").bind(JSON.stringify({ alerts: { emails: ['ops@example.com'], phones: ['+14045550123'] } })).run();
  const env = { DB, TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 'tok', TWILIO_MESSAGING_SERVICE_SID: 'MG1', RESEND_API_KEY: 're' };
  const out = { mail: [], texts: [] };
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://api.resend.com/')) { out.mail.push(JSON.parse(init.body)); return Response.json({ data: [{ id: 'e' }] }); }
    if (String(url).startsWith('https://api.twilio.com/')) { out.texts.push(init.body.get('Body')); return Response.json({}, { status: 201 }); }
    return Response.json({});
  };
  const hook = async (params, { sign = true } = {}) => {
    const body = new URLSearchParams(params).toString();
    const sig = sign ? await twilioSignature('tok', TEXT_STATUS_URL, params) : 'nope';
    const pending = [];
    const res = await statusHook({ env, waitUntil: (p) => pending.push(p), request: new Request(TEXT_STATUS_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': sig }, body }) });
    await Promise.all(pending);
    return res;
  };
  try {
    assert.equal((await hook({ MessageSid: 'SM1', MessageStatus: 'delivered', To: '+14045550123' }, { sign: false })).status, 403, 'unsigned is refused');
    assert.equal((await readAlertTexts(DB)).numbers['+14045550123'], undefined);
    assert.equal((await hook({ MessageSid: 'SM1', MessageStatus: 'sent', To: '+14045550123' })).status, 204);
    assert.equal((await readAlertTexts(DB)).numbers['+14045550123'], undefined, 'in-between reports are dropped');
    await hook({ MessageSid: 'SM1', MessageStatus: 'delivered', To: '+14045550123' });
    assert.equal((await readAlertTexts(DB)).numbers['+14045550123'].status, 'delivered');
    assert.equal(out.mail.length, 0, 'arriving tells nobody');

    await hook({ MessageSid: 'SM2', MessageStatus: 'undelivered', ErrorCode: '30007', To: '+14045550123' });
    const rec = (await readAlertTexts(DB)).numbers['+14045550123'];
    assert.deepEqual([rec.status, rec.code, rec.error], ['undelivered', 30007, 'the carrier filtered it as spam']);
    assert.equal(out.mail.length, 1, 'a miss tells staff');
    assert.match(out.mail[0][0]?.subject || out.mail[0].subject, /A staff text didn’t arrive: \(404\) 555-0123/);
    assert.equal(out.texts.length, 0, 'never by text: texting is what failed');
    await hook({ MessageSid: 'SM3', MessageStatus: 'failed', ErrorCode: '30003', To: '+14045550123' });
    assert.equal(out.mail.length, 1, 'once a day per number');
    assert.equal((await readAlertTexts(DB)).numbers['+14045550123'].error, 'the phone was off or out of service', 'the latest report still counts');
  } finally {
    globalThis.fetch = real;
  }
});

test('delivery reports for several numbers never overwrite each other', async () => {
  const DB = await hookDb();
  await Promise.all(['+14045550123', '+16785550199', '+17705550111'].map((to, i) => recordTextStatus(DB, { to, status: i ? 'delivered' : 'undelivered', code: i ? null : 30005 })));
  const n = (await readAlertTexts(DB)).numbers;
  assert.deepEqual(Object.keys(n).sort(), ['+14045550123', '+16785550199', '+17705550111']);
  assert.equal(n['+14045550123'].error, 'the number doesn’t exist');
  assert.equal(await recordTextStatus(DB, { to: '+14045550123', status: 'queued' }), null);
});
