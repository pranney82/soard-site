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
  assert.equal(smsSafe('“Go” — it’s… → done'), '"Go" - it\'s... -> done');
});

test('the hello text says who added the number and how to stop', () => {
  assert.match(alertHelloText({ by: 'Linzi' }), /^SOARD: Linzi added you to the live reveal alert texts\..*Reply STOP to opt out, HELP for help\.$/);
  assert.match(alertHelloText(), /^SOARD: You're on the live reveal alert texts\./);
  assert.deepEqual(alertPhones({ alerts: { phones: ['(404) 555-0123', '+14045550123', 'nope', '+44 7700 900123'] } }), ['+14045550123']);
});

test('the go / no-go as one line: all green, or the names of what is open', () => {
  const item = (status, label) => ({ status, label });
  assert.equal(textLine({ counts: { ok: 3 }, items: [item('ok', 'a'), item('ok', 'b'), item('ok', 'c'), item('off', 'Instagram')] }), 'All green: 3 of 3 checks pass.');
  assert.equal(textLine({ counts: { ok: 1 }, items: [item('ok', 'a'), item('fail', 'No live input'), item('warn', 'Facebook token expires soon'), item('unknown', 'YouTube')] }),
    'Fix: No live input. Notes: Facebook token expires soon; YouTube.');
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
    assert.equal(sent[0], 'SOARD: Reveal audio is silent\nFix: Check the mic.\nhttps://sunshineonaranneyday.com/admin/');
    await alertAdmins(env, config, { title: 'Go: Sam', text: 'SOARD: custom words' });
    assert.equal(sent[1], 'SOARD: custom words', 'a string is the text itself');
    assert.equal((await alertAdmins(env, { alerts: { phones: [] } }, { title: 'x', text: true })).text, null, 'nobody on the list');
  } finally {
    globalThis.fetch = real;
  }
});
