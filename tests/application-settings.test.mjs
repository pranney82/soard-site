/**
 * Admin → Applications → Settings: open/closed, season, closed message, outside
 * form, and the open/close schedule (`application` in the site settings row).
 * functions/api/_applications.js + the routes in functions/api/applications-admin.js
 * Run: node --test tests/
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import {
  pickApplication, cleanApplicationSettings, saveApplicationSettings, applicationSettingsHistory,
  runApplicationSchedule, applyApplicationSchedule, maybeSweepApplications,
} from '../functions/api/_applications.js';
import * as adminApi from '../functions/api/applications-admin.js';
import { RUNTIME_TYPES } from '../functions/api/pending-changes.js';

const NOW = Date.parse('2026-10-20T18:00:00Z');
const HOUR = 3600e3;
const OTHER = { social: { tiktok: 'https://www.tiktok.com/@x' }, trustBadges: [{ name: 'Candid' }] };
let DB;
let env;

beforeEach(async () => {
  DB = await createD1();
  await DB.exec('CREATE TABLE IF NOT EXISTS site_config (key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)');
  await DB.exec('CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_email TEXT, action TEXT, entity_type TEXT, entity_slug TEXT, entity_name TEXT, changes TEXT, path TEXT, git_status TEXT, created_at TEXT)');
  await DB.prepare("INSERT INTO site_config (key, data) VALUES ('settings', ?)").bind(JSON.stringify({ ...OTHER, application: { open: false, year: '2027', formUrl: '', closedMessage: '' } })).run();
  env = { DB };
});
const stored = async () => JSON.parse((await DB.prepare("SELECT data FROM site_config WHERE key = 'settings'").first()).data);

test('pickApplication fills every field and keeps the season in range', () => {
  assert.deepEqual(pickApplication({ open: true, year: '2027' }, NOW), { open: true, year: '2027', closedMessage: '', formUrl: '', opensAt: '', closesAt: '', maxApplications: 0, warnAt: 0, fullMessage: '' });
  assert.equal(pickApplication({ year: '1999' }, NOW).year, '2027', 'out of range → next year');
  assert.equal(pickApplication({ open: 'true' }, NOW).open, false, 'only true opens');
});

test('cleaning: links, times, and what a time means in each state', () => {
  const bad = cleanApplicationSettings({ formUrl: 'example.com' }, { now: NOW });
  assert.equal(bad.errors[0].field, 'formUrl');
  const past = cleanApplicationSettings({ opensAt: new Date(NOW - HOUR).toISOString() }, { now: NOW });
  assert.equal(past.errors[0].field, 'opensAt', 'a new open time has to be in the future');
  const kept = cleanApplicationSettings({ opensAt: new Date(NOW - HOUR).toISOString(), closedMessage: 'x' }, { now: NOW, previous: { opensAt: new Date(NOW - HOUR).toISOString() } });
  assert.equal(kept.errors.length, 0, 'an unchanged time that just passed does not block other edits');
  const order = cleanApplicationSettings({ opensAt: new Date(NOW + 2 * HOUR).toISOString(), closesAt: new Date(NOW + HOUR).toISOString() }, { now: NOW });
  assert.equal(order.errors[0].field, 'closesAt', 'closing has to come after opening');
  const open = cleanApplicationSettings({ open: true, opensAt: new Date(NOW + HOUR).toISOString(), closesAt: new Date(NOW + 9 * HOUR).toISOString() }, { now: NOW });
  assert.equal(open.settings.opensAt, '', 'already open: no open time');
  assert.ok(open.settings.closesAt, 'a close time stays');
  const closed = cleanApplicationSettings({ open: false, closesAt: new Date(NOW + HOUR).toISOString() }, { now: NOW });
  assert.equal(closed.settings.closesAt, '', 'closed with nothing scheduled to open: a close time means nothing');
  assert.equal(cleanApplicationSettings({ closedMessage: '  Back   in\nJanuary. ' }, { now: NOW }).settings.closedMessage, 'Back in January.');
});

test('saving writes only `application`, logs each field, and keeps the rest of the settings', async () => {
  const out = await saveApplicationSettings(env, { open: true, year: '2028' }, { user: 'peter@soardcharity.com', now: NOW });
  assert.deepEqual(out.changes.map(c => c.field), ['application.open', 'application.year']);
  const s = await stored();
  assert.equal(s.application.open, true);
  assert.equal(s.application.year, '2028');
  assert.deepEqual(s.social, OTHER.social);
  assert.deepEqual(s.trustBadges, OTHER.trustBadges);
  const log = await DB.prepare('SELECT * FROM audit_log').all();
  assert.equal(log.results.length, 1);
  assert.equal(log.results[0].entity_type, 'application-settings', 'its own type: read live, so never waiting for Publish');
  assert.equal(log.results[0].entity_name, 'Applications opened');
  const again = await saveApplicationSettings(env, { open: true }, { now: NOW });
  assert.equal(again.changes.length, 0, 'no change, nothing written');
  assert.equal((await DB.prepare('SELECT COUNT(*) AS n FROM audit_log').first()).n, 1);
});

test('a change made since the editor loaded comes back as a conflict', async () => {
  const base = pickApplication((await stored()).application, NOW);
  await saveApplicationSettings(env, { closedMessage: 'Theirs' }, { now: NOW });
  const out = await saveApplicationSettings(env, { closedMessage: 'Mine' }, { base, now: NOW });
  assert.equal(out.conflict.closedMessage, 'Theirs');
  assert.equal((await stored()).application.closedMessage, 'Theirs', 'nothing overwritten');
});

test('history lists only these fields, newest first, with who', async () => {
  await saveApplicationSettings(env, { open: true }, { user: 'peter@soardcharity.com', now: NOW });
  await DB.prepare("INSERT INTO audit_log (user_email, action, entity_type, entity_slug, changes, created_at) VALUES ('x', 'updated', 'settings', 'settings', ?, datetime('now'))").bind(JSON.stringify([{ field: 'social', from: '{…}', to: '{…}' }])).run();
  await saveApplicationSettings(env, { open: false }, { user: 'jen@soardcharity.com', now: NOW });
  const h = await applicationSettingsHistory(DB);
  assert.deepEqual(h.map(e => e.by), ['jen@soardcharity.com', 'peter@soardcharity.com']);
  assert.equal(h[0].changes[0].field, 'application.open');
  assert.match(h[0].at, /Z$/);
});

test('the schedule opens, then closes, on the heartbeat sweep', async () => {
  const opensAt = new Date(NOW + HOUR).toISOString();
  const closesAt = new Date(NOW + 5 * HOUR).toISOString();
  await saveApplicationSettings(env, { opensAt, closesAt }, { now: NOW });
  assert.equal(await runApplicationSchedule(env, { now: NOW + HOUR - 1000 }), null, 'not yet');
  await maybeSweepApplications(env, { now: NOW + HOUR + 1000, fetchImpl: async () => new Response('{}') });
  let s = (await stored()).application;
  assert.equal(s.open, true, 'opened by the sweep');
  assert.equal(s.opensAt, '', 'the open time is used up');
  assert.equal(s.closesAt, closesAt, 'the close time stays');
  assert.equal(await runApplicationSchedule(env, { now: NOW + 5 * HOUR + 1000 }), 'closed');
  s = (await stored()).application;
  assert.equal(s.open, false);
  assert.equal(s.closesAt, '');
  assert.equal(s.openChangedBy, 'schedule', 'the stored stamp says the schedule did it');
  assert.equal(s.openChangedAt, new Date(NOW + 5 * HOUR + 1000).toISOString());
  const by = (await DB.prepare("SELECT user_email FROM audit_log ORDER BY id").all()).results.map(r => r.user_email);
  assert.deepEqual(by.slice(-2), ['schedule', 'schedule']);
});

test('applyApplicationSchedule: flags, and nothing thrown', async () => {
  await saveApplicationSettings(env, { opensAt: new Date(NOW + HOUR).toISOString() }, { now: NOW });
  assert.deepEqual(await applyApplicationSchedule(env, { now: NOW }), { opened: false, closed: false });
  assert.deepEqual(await applyApplicationSchedule(env, { now: NOW + 2 * HOUR }), { opened: true, closed: false });
  assert.deepEqual(await applyApplicationSchedule({ DB: { prepare() { throw new Error('down'); } } }, { now: NOW }), { opened: false, closed: false });
});

test('a manual open stamps who and when', async () => {
  await saveApplicationSettings(env, { open: true }, { user: 'peter@soardcharity.com', now: NOW });
  const s = (await stored()).application;
  assert.equal(s.openChangedBy, 'peter@soardcharity.com');
  assert.equal(s.openChangedAt, new Date(NOW).toISOString());
  await saveApplicationSettings(env, { closedMessage: 'x' }, { user: 'jen@soardcharity.com', now: NOW + HOUR });
  assert.equal((await stored()).application.openChangedBy, 'peter@soardcharity.com', 'other edits leave the stamp');
});

test('the admin routes: GET settings, POST save, 409 conflict, 422 errors', async () => {
  const call = async (method, query = '', body) => {
    const request = new Request(`https://admin.test/api/applications-admin${query}`, { method, body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json' } });
    const ctx = { env, request, data: { userEmail: 'peter@soardcharity.com' } };
    const res = method === 'POST' ? await adminApi.onRequestPost(ctx) : await adminApi.onRequestGet(ctx);
    return { status: res.status, json: await res.json() };
  };
  const got = await call('GET', '?settings=1');
  assert.equal(got.json.settings.open, false);
  assert.deepEqual(got.json.history, []);
  const saved = await call('POST', '', { settings: { open: true }, base: got.json.settings });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.settings.open, true);
  assert.equal(saved.json.history[0].by, 'peter@soardcharity.com');
  const stale = await call('POST', '', { settings: { open: false }, base: got.json.settings });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.conflict.open, true);
  const bad = await call('POST', '', { settings: { formUrl: 'nope' } });
  assert.equal(bad.status, 422);
  assert.equal(bad.json.errors[0].field, 'formUrl');
});

test('Publish to site never waits on these (the pages read them live)', () => {
  assert.ok(RUNTIME_TYPES.includes('application-settings'));
});
