/**
 * The automatic design import (functions/api/_reveal-design-auto.js): what's next, what it adds, what it never
 * touches, and what staff are told. The browser's part is stood in for here (its drawing is checked for real by
 * scripts/test-reveal-design-auto.mjs).
 * Run: node --test tests/reveal-design-auto.test.mjs
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { nextWork, partsOf, revealsAhead, standing, runRevealDesigns, AUTO_KEY } from '../functions/api/_reveal-design-auto.js';

const NOW = Date.parse('2026-11-10T15:00:00Z');
const DAY = 24 * 3600e3;
const at = (days) => new Date(NOW + days * DAY).toISOString();

test('reveals ahead: confirmed, in the next 30 days, soonest first', () => {
  const list = revealsAhead([
    { slug: 'max', startsAt: at(10), confirmed: true },
    { slug: 'dylan-2026', startsAt: at(8), confirmed: true },
    { slug: 'colin', confirmed: false },
    { slug: 'later', startsAt: at(45), confirmed: true },
    { slug: 'gone', startsAt: at(-1), confirmed: true },
  ], NOW);
  assert.deepEqual(list.map((r) => r.slug), ['dylan-2026', 'max']);
});

test('what a profile has, and what is next: before photos first, then the drawings and board together', () => {
  const empty = { name: 'Max', plans: [], beforeAfterPhotos: [] };
  assert.deepEqual(partsOf(empty), { befores: false, 'as-built': false, proposed: false, board: false });
  const reveals = [{ slug: 'max', startsAt: at(10) }];
  assert.deepEqual(nextWork(reveals, { max: empty }, {}, NOW), { slug: 'max', name: 'Max', startsAt: at(10), work: 'befores', want: ['befores'] });
  // Brought in once: never again, even if staff took them out
  assert.deepEqual(nextWork(reveals, { max: empty }, { max: { done: { befores: NOW - DAY } } }, NOW).want, ['as-built', 'proposed', 'board']);
  // Looked for and found nothing: not again for 6 hours
  assert.equal(nextWork(reveals, { max: empty }, { max: { done: { befores: 1 }, tried: { 'as-built': NOW - 3600e3, proposed: NOW - 3600e3, board: NOW - 3600e3 } } }, NOW), null);
  assert.equal(nextWork(reveals, { max: empty }, { max: { done: { befores: 1 }, tried: { board: NOW - 7 * 3600e3 } } }, NOW).want.join(), 'as-built,proposed,board');
  // What staff put there counts: only the missing part is looked for
  const some = { name: 'Max', beforeAfterPhotos: [{ before: 'b', after: '' }], plans: [{ url: 'u1', type: 'as-built' }, { url: 'u2', type: 'proposed' }] };
  assert.deepEqual(nextWork(reveals, { max: some }, {}, NOW).want, ['board']);
  // A hidden profile, or a room already revealed, is left alone
  assert.equal(nextWork(reveals, { max: { ...empty, publishStatus: 'draft' } }, {}, NOW), null);
  assert.equal(nextWork(reveals, { max: { ...empty, status: 'completed' } }, {}, NOW), null);
});

test('standing: what is in, what is missing, which drawings wait on an address check', () => {
  const s = standing({ beforeAfterPhotos: [{ before: 'a' }, { before: 'b' }], plans: [{ url: 'x', type: 'as-built', addressCheck: 'wiped' }, { url: 'y', type: 'proposed' }] });
  assert.deepEqual(s.missing, ['a design board']);
  assert.equal(s.unchecked.length, 1);
  assert.equal(s.ready, false);
  assert.match(s.inParts.join(', '), /2 before photos, the as-built drawing, the proposed drawing/);
  assert.equal(standing({ beforeAfterPhotos: [{ before: 'a' }], plans: [{ url: 'x', type: 'as-built', addressCheck: 'wiped' }, { url: 'y', type: 'proposed', addressCheck: 'covered' }, { url: 'z', type: 'board' }] }).ready, true);
});

// ── A run, end to end, with JobTread, Cloudflare Images, Slack and the browser stood in for ──

let env;
const calls = { uploads: [], slack: [], emails: [] };
const fetchImpl = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.includes('/images/v1')) {
    const id = init.body.get('id');
    calls.uploads.push(id);
    return Response.json({ success: true, result: { id, variants: [`https://imagedelivery.net/HASH/${id}/public`] } });
  }
  if (url.startsWith('https://jt.test/')) return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': url.endsWith('.png') ? 'image/png' : url.endsWith('.pdf') ? 'application/pdf' : 'image/jpeg' } });
  throw new Error(`unexpected fetch ${url}`);
};
const origFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.startsWith('https://hooks.slack.test/')) { calls.slack.push(JSON.parse(init.body)); return new Response('ok'); }
  if (url.startsWith('https://api.resend.com/')) { calls.emails.push(JSON.parse(init.body)); return Response.json({ data: [] }); }
  return origFetch(input, init);
};

const SOURCES = {
  kid: { slug: 'max', name: 'Max' },
  job: { id: 'JOB1', name: 'Max Daniel (2026)' },
  address: { street: '12 Maple Ln', city: 'Roswell', zip: '30075', family: 'Daniel' },
  sheets: [],
  drawings: [
    { id: 'SOW', name: 'Max 2026_Scope of Work.pdf', type: 'application/pdf', url: 'https://jt.test/sow.pdf' },
    { id: 'SET', name: 'Max 2026_Plan Set_08172026.pdf', type: 'application/pdf', url: 'https://jt.test/set.pdf' },
    { id: 'BRD', name: 'Max 2026_Design Board.png', type: 'image/png', url: 'https://jt.test/board.png' },
  ],
  befores: Array.from({ length: 9 }, (_, i) => ({ id: `B${i}`, name: `CompanyCam ${i}.jpg`, type: 'image/jpeg', url: `https://jt.test/b${i}.jpg`, big: `https://jt.test/b${i}-big.jpg`, createdAt: `2026-08-0${i + 1}` })),
};
// The browser's answer for the plan set: page 2 existing (street found), page 3 proposed (street not found: a scan)
const drawn = [];
const fakeBrowser = {
  newPage: async () => ({
    setBypassCSP: async () => {}, goto: async () => {}, close: async () => {},
    evaluate: async (_fn, _b64, _d, _r, _base, opts) => {
      drawn.push(opts);
      const all = [{ n: 2, kind: 'as-built', title: '2 EXISTING LAYOUT', sheet: 'Max 2026_Plan Set_08172026.pdf (2)', street: true }, { n: 3, kind: 'proposed', title: 'DIMENTIONED PROPOSED LAYOUT', sheet: '', street: false }];
      return { pages: [], out: all.filter((o) => opts.want.includes(o.kind)).map((o) => ({ ...o, w: 2400, h: 1600, trimmed: true, wiped: 1, textLayer: true, png: btoa('png') })) };
    },
  }),
  close: async () => {},
};

before(async () => {
  const DB = await createD1({ schemaFiles: ['scripts/schema.sql'] });
  await DB.prepare('INSERT INTO kids (slug, data, name, year, status, updated_at) VALUES (?, ?, ?, ?, ?, ?)').bind('max', JSON.stringify({ name: 'Max', slug: 'max', status: 'in-progress', plans: [], beforeAfterPhotos: [] }), 'Max', 2026, 'in-progress', '2026-11-01T00:00:00Z').run();
  env = { DB, JOBTREAD_GRANT_KEY: 'k', CF_ACCOUNT_ID: 'acc', CF_IMAGES_TOKEN: 't', SLACK_WEBHOOK_URL: 'https://hooks.slack.test/x' };
});

const run = (now, extra = {}) => runRevealDesigns(env, { fetchImpl, now, upcoming: [{ slug: 'max', name: 'Max', startsAt: at(10), confirmed: true }], sources: async () => SOURCES, browser: fakeBrowser, keepBrowser: true, readAsset: async () => '', ...extra });
const kid = async () => JSON.parse((await env.DB.prepare('SELECT data FROM kids WHERE slug = ?').bind('max').first()).data);

test('a run brings in the before photos: six, spread across the visit, as JobTread’s big JPEGs, named as the editor names them', async () => {
  const r = await run(NOW);
  assert.equal(r.did.work, 'befores');
  const k = await kid();
  assert.equal(k.beforeAfterPhotos.length, 6);
  assert.deepEqual(k.beforeAfterPhotos.map((p) => p.source), ['jt:B0', 'jt:B2', 'jt:B3', 'jt:B5', 'jt:B6', 'jt:B8']);
  assert.ok(k.beforeAfterPhotos.every((p) => p.after === '' && /^https:\/\/imagedelivery\.net\/HASH\/kids\/max\/ba-before-\d+-companycam-\d\.jpg\/public$/.test(p.before)), k.beforeAfterPhotos[0].before);
  assert.equal(k.beforeAfterPhotos[0].beforeAlt, 'Max’s room before the makeover');
  // A version in the history and an audit line, by the import
  const v = await env.DB.prepare("SELECT COUNT(*) AS n FROM content_versions WHERE collection = 'kids' AND slug = 'max'").first().catch(() => ({ n: -1 }));
  assert.ok(v.n !== 0, 'a version was kept');
  // Slack: the design is in (news, no address waiting)
  assert.match(JSON.stringify(calls.slack.at(-1)), /Max’s design is in/);
});

test('ten minutes on, the next run brings the drawings and the board: a scope of work is never opened, a scan’s drawing waits on an address check', async () => {
  // Not before its 10 minutes
  assert.equal((await runRevealDesigns(env, { fetchImpl, now: NOW + 60e3, upcoming: [{ slug: 'max', startsAt: at(10), confirmed: true }], sources: async () => SOURCES, browser: fakeBrowser, keepBrowser: true, readAsset: async () => '' })).skipped, 'not yet');
  const r = await run(NOW + 11 * 60e3);
  assert.equal(r.did.work, 'drawings');
  assert.equal(drawn.length, 1, 'only the plan set was drawn, not the scope of work');
  const k = await kid();
  const byType = Object.fromEntries(k.plans.map((p) => [p.type, p]));
  assert.equal(byType['as-built'].addressCheck, 'wiped', 'the street was found and painted out');
  assert.equal(byType['as-built'].label, 'Existing layout', 'a sheet name that is a file name gives way to the title');
  assert.equal(byType['as-built'].source, 'jt:SET#2');
  assert.match(byType['as-built'].url, /\/kids\/max\/plan-\d+-existing-layout-notitle\.png\/public$/);
  assert.equal(byType.proposed.addressCheck, undefined, 'street not found: held off the reveal screen');
  assert.equal(byType.board.source, 'jt:BRD');
  assert.equal(byType.board.label, 'Design Board');
  assert.match(JSON.stringify(calls.slack.at(-1)), /didn’t show the street in its words/);
  // Nothing left to do
  assert.equal((await run(NOW + 22 * 60e3)).did, null);
});

test('what staff take out stays out, and what they save meanwhile is kept', async () => {
  const k = await kid();
  // Staff remove the board and the before photos
  const edited = { ...k, plans: k.plans.filter((p) => p.type !== 'board'), beforeAfterPhotos: [], heroSummary: 'edited by staff' };
  await env.DB.prepare('UPDATE kids SET data = ?, updated_at = ? WHERE slug = ?').bind(JSON.stringify(edited), new Date().toISOString(), 'max').run();
  const r = await run(NOW + 33 * 60e3);
  assert.equal(r.did, null, 'nothing brought back');
  const after = await kid();
  assert.equal(after.beforeAfterPhotos.length, 0);
  assert.equal(after.heroSummary, 'edited by staff');
});

test('3 days and 1 day out: one note each, ready or what is missing (to Needs attention, with the alert emails, when something is)', async () => {
  const before = calls.slack.length;
  const close = [{ slug: 'max', name: 'Max', startsAt: new Date(NOW + 40 * 60e3 + 2.5 * DAY).toISOString(), confirmed: true }];
  await runRevealDesigns(env, { fetchImpl, now: NOW + 44 * 60e3, upcoming: close, sources: async () => SOURCES, browser: fakeBrowser, keepBrowser: true, readAsset: async () => '' });
  const posts = calls.slack.slice(before).map((p) => JSON.stringify(p));
  assert.equal(posts.filter((p) => /isn’t ready for the reveal/.test(p)).length, 1);
  assert.match(posts.join(' '), /Missing: before photos, a design board/);
  assert.match(posts.join(' '), /still needs the address covered/);
  // Not again the next run
  const n = calls.slack.length;
  await runRevealDesigns(env, { fetchImpl, now: NOW + 55 * 60e3, upcoming: close, sources: async () => SOURCES, browser: fakeBrowser, keepBrowser: true, readAsset: async () => '' });
  assert.equal(calls.slack.filter((p) => /isn’t ready for the reveal/.test(JSON.stringify(p))).length, posts.filter((p) => /isn’t ready/.test(p)).length);
  assert.ok(calls.slack.length === n);
  const ledger = JSON.parse((await env.DB.prepare('SELECT data FROM site_config WHERE key = ?').bind(AUTO_KEY).first()).data);
  assert.equal(ledger.kids.max.told.d3, close[0].startsAt);
});
