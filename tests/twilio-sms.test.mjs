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
