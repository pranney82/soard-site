/**
 * Reveals → Settings → Alerts: someone newly added to the alert emails gets a
 * hello right away (proof alerts reach them, so there's no "Send test alert"
 * button). Saving again, or saving other settings, sends nothing.
 * Run: node --test tests/
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import * as admin from '../functions/api/broadcast-admin.js';

const realFetch = globalThis.fetch;
let env;
let mail;
let texts;

beforeEach(async () => {
  mail = [];
  texts = [];
  env = { DB: await createD1({ schemaFiles: ['scripts/schema.sql'] }), RESEND_API_KEY: 're_test' };
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
    if (url === 'https://api.resend.com/emails/batch') { const body = JSON.parse(init.body); mail.push(...body); return json({ data: body.map((_, i) => ({ id: `em${i}` })) }); }
    if (url === 'https://api.resend.com/emails') { const body = JSON.parse(init.body); mail.push(body); return json({ id: 'em' }); }
    if (url.startsWith('https://api.twilio.com/')) {
      const to = init.body.get('To');
      if (to === '+14045550666') return json({ code: 21610, message: 'Attempt to send to unsubscribed recipient' }, 400);
      texts.push({ to, body: init.body.get('Body') });
      return json({ sid: 'SM1' }, 201);
    }
    throw new Error(`no fake for ${url}`);
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

const save = async (config) => (await admin.onRequestPost({ env, request: new Request('https://x/api/broadcast-admin', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'setConfig', config }) }), data: { userEmail: 'linzi@soardcharity.com' } })).json();

test('a new alert address gets one hello; the rest of the list and later saves get nothing', async () => {
  const first = await save({ alerts: { emails: ['peter@soardcharity.com'] } });
  assert.equal(first.success, true);
  assert.deepEqual(first.welcomed, ['peter@soardcharity.com']);
  assert.equal(mail.length, 1);
  assert.deepEqual([mail[0].to].flat(), ['peter@soardcharity.com']);
  assert.equal(mail[0].subject, 'You’ll get live reveal alerts at this address');
  assert.match(mail[0].html, /Linzi added this address to the alert list/);
  assert.match(mail[0].html, /admin\/#broadcast\/settings/);
  assert.ok(!/—/.test(mail[0].html + mail[0].text), 'no em dashes');

  const again = await save({ alerts: { emails: ['Peter@soardcharity.com', 'ops@soardcharity.com'] } });
  assert.deepEqual(again.welcomed, ['ops@soardcharity.com'], 'only the new one (case doesn’t make it new)');
  assert.equal(mail.length, 2);
  assert.deepEqual([mail[1].to].flat(), ['ops@soardcharity.com']);

  const other = await save({ replayHours: 48 });
  assert.deepEqual(other.welcomed, []);
  assert.equal(mail.length, 2, 'other settings send nothing');
});

test('without email set up, saving still works and says nobody was welcomed', async () => {
  delete env.RESEND_API_KEY;
  const r = await save({ alerts: { emails: ['peter@soardcharity.com'] } });
  assert.equal(r.success, true);
  assert.deepEqual(r.welcomed, []);
  assert.equal(mail.length, 0);
});

// ─── Alert texts: staff numbers only ────────────────────────────────

const TWILIO = { TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 'tok', TWILIO_MESSAGING_SERVICE_SID: 'MG1' };

test('a new staff number gets one hello text; saving again or other settings texts nobody', async () => {
  Object.assign(env, TWILIO);
  const first = await save({ alerts: { phones: ['(404) 555-0123'] } });
  assert.equal(first.success, true);
  assert.deepEqual(first.config.alerts.phones, ['+14045550123'], 'stored as a +1 number');
  assert.deepEqual(first.texted, { sent: 1, failed: 0, error: null });
  assert.equal(texts.length, 1);
  assert.equal(texts[0].to, '+14045550123');
  assert.match(texts[0].body, /^SOARD: Linzi added you to the live reveal alert texts\..*Reply STOP to opt out, HELP for help\.$/);
  assert.ok(/^[\x20-\x7E]+$/.test(texts[0].body) && texts[0].body.length <= 306, 'one plain text, no emoji');

  const again = await save({ alerts: { phones: ['404-555-0123', '+1 678 555 0199'] } });
  assert.deepEqual(again.config.alerts.phones, ['+14045550123', '+16785550199']);
  assert.equal(texts.length, 2, 'only the new number');
  assert.equal(texts[1].to, '+16785550199');
  assert.equal((await save({ replayHours: 48 })).texted, null);
  assert.equal(texts.length, 2);
});

test('a number that isn’t a US or Canadian mobile is refused, and nothing is saved', async () => {
  Object.assign(env, TWILIO);
  const r = await save({ alerts: { phones: ['(404) 555-0123', '+44 7700 900123'] } });
  assert.equal(r.success, false);
  assert.match(r.error, /\+44 7700 900123 isn't a US or Canadian mobile number/);
  assert.equal(texts.length, 0);
});

test('without Twilio the numbers save, and the admin is told no hello went out', async () => {
  const r = await save({ alerts: { phones: ['(404) 555-0123'] } });
  assert.equal(r.success, true);
  assert.deepEqual(r.config.alerts.phones, ['+14045550123']);
  assert.equal(r.texted.sent, 0);
  assert.match(r.texted.error, /Twilio isn’t connected/);
});

test('a number that replied STOP is remembered, and the public text switch can’t be turned on', async () => {
  Object.assign(env, TWILIO);
  const r = await save({ alerts: { phones: ['(404) 555-0666'] }, reminders: { enabled: true, sms: true } });
  assert.equal(r.texted.failed, 1);
  assert.equal(r.config.reminders.sms, undefined, 'there is no public text switch');
  const rec = JSON.parse((await env.DB.prepare("SELECT data FROM site_config WHERE key = 'alert-texts'").first()).data);
  assert.ok(rec.stopped['+14045550666']);
  assert.equal(rec.last.failed, 1);
});
