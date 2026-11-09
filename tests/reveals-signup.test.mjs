// /api/reveals tells the Coming up band whether its "Get every reveal by email" card is open:
// reminders on in Reveals → Settings and email able to go out, plus the notes it sends
import test from 'node:test';
import assert from 'node:assert/strict';
import { signupFacts } from '../functions/api/reveals.js';

const db = (config) => ({
  prepare: () => ({ bind: () => ({ first: async () => (config === undefined ? null : { data: JSON.stringify(config) }) }) }),
});
const env = (config, mail = true) => ({ DB: db(config), ...(mail ? { RESEND_API_KEY: 're_test' } : {}) });

test('open while reminders are on and email can go out, with the saved hours', async () => {
  assert.deepEqual(await signupFacts(env({ reminders: { enabled: true, hoursBefore: [24, 1] } })), { email: true, hours: [24, 1] });
  assert.deepEqual(await signupFacts(env({ reminders: { enabled: true, hoursBefore: [24] } })), { email: true, hours: [24] });
});

test('closed while reminders are off or email can’t go out', async () => {
  assert.equal((await signupFacts(env({ reminders: { enabled: false, hoursBefore: [24, 1] } }))).email, false);
  assert.equal((await signupFacts(env({ reminders: { enabled: true, hoursBefore: [24, 1] } }, false))).email, false);
});

test('never saved: the same default the /live/ page reads (/api/broadcast)', async () => {
  const { defaultConfig } = await import('../functions/api/_broadcast.js');
  const facts = await signupFacts(env(undefined));
  assert.equal(facts.email, defaultConfig().reminders.enabled);
  assert.deepEqual(facts.hours, defaultConfig().reminders.hoursBefore);
});

test('settings that can’t be read leave the card out (null), never the list', async () => {
  const broken = { DB: { prepare: () => { throw new Error('D1 down'); } }, RESEND_API_KEY: 're_test' };
  assert.equal(await signupFacts(broken), null);
});
