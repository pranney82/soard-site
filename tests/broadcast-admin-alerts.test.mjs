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

beforeEach(async () => {
  mail = [];
  env = { DB: await createD1({ schemaFiles: ['scripts/schema.sql'] }), RESEND_API_KEY: 're_test' };
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
    if (url === 'https://api.resend.com/emails/batch') { const body = JSON.parse(init.body); mail.push(...body); return json({ data: body.map((_, i) => ({ id: `em${i}` })) }); }
    if (url === 'https://api.resend.com/emails') { const body = JSON.parse(init.body); mail.push(body); return json({ id: 'em' }); }
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
