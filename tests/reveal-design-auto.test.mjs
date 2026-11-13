/**
 * The automatic design import (functions/api/_reveal-design-auto.js): what's next, what it adds, what it never
 * touches, and what staff are told. Before photos (Peter, Nov 12 2026: once a reveal is confirmed, "put the before
 * pictures of the project in admin ... they should go into photos, not the before and after section"): every one on
 * the job, into Photos → Before photos, a batch a run, then the site's look at each (Peter, Nov 12 2026: "leave off
 * the ones you think arent good to publish"). The browser's part is stood in for here (its drawing is checked for
 * real by scripts/test-reveal-design-auto.mjs), and so is Workers AI (the look's own answers: tests/photo-screen.test.mjs).
 * Run: node --test tests/reveal-design-auto.test.mjs
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { nextWork, partsOf, revealsAhead, standing, runRevealDesigns, currentReveals, dueLooks, AUTO_KEY } from '../functions/api/_reveal-design-auto.js';
import { recordVersion } from '../functions/api/_content-history.js';

const NOW = Date.parse('2026-11-10T15:00:00Z');
const DAY = 24 * 3600e3;
const MIN = 60e3;
const at = (days) => new Date(NOW + days * DAY).toISOString();

test('reveals ahead: confirmed and not started, however far off, soonest first', () => {
  const list = revealsAhead([
    { slug: 'max', startsAt: at(10), confirmed: true },
    { slug: 'dylan-2026', startsAt: at(8), confirmed: true },
    { slug: 'colin', startsAt: at(5), confirmed: false },
    { slug: 'later', startsAt: at(45), confirmed: true },
    { slug: 'gone', startsAt: at(-1), confirmed: true },
  ], NOW);
  assert.deepEqual(list.map((r) => r.slug), ['dylan-2026', 'max', 'later']);
});

test('only a current job’s reveal counts: open, being built, never a TEST job or an earlier makeover’s', () => {
  const kids = [{ slug: 'max', name: 'Max', year: 2026 }, { slug: 'ava', name: 'Ava', year: 2026 }, { slug: 'kai', name: 'Kai', year: 2026 }, { slug: 'zoe', name: 'Zoe', year: 2026 }];
  const job = (id, name, status, { closedOn = null, startsAt = at(9) } = {}) => ({ id, name, closedOn, customFieldValues: { nodes: [
    { value: status, customField: { id: '22P52qfFub9b' } }, { value: startsAt, customField: { id: '22PgGhcE8jte' } }, { value: 'Yes 👍', customField: { id: '22PgGhWscUgE' } }] } });
  const list = currentReveals([
    job('max-test', 'TEST Max Sample (2026)', 'Build', { startsAt: at(2) }),
    job('max-real', 'Max Sample (2026)', 'Build'),
    job('ava-closed', 'Ava Lee (2026)', 'Build', { closedOn: '2026-10-01', startsAt: at(3) }),
    job('ava-warranty', 'Ava Lee (2026)', 'Warranty', { startsAt: at(4) }),
    job('ava-build', 'Ava Lee (2026)', 'Mobilization'),
    job('kai-done', 'Kai Park (2026)', 'Closed Done'),
    job('zoe-funding', 'Zoe Ray (2026)', 'Awaiting Funding'),
  ], kids, NOW);
  assert.deepEqual(list.map((r) => [r.slug, r.jobId]).sort(), [['ava', 'ava-build'], ['max', 'max-real']], 'Max’s real job (not the TEST one); Ava’s job being built (not the closed or warranty one); none for a done or unfunded job');
  assert.ok(list.every((r) => r.confirmed));
});

test('what is next: before photos first, then the drawings and board, for any profile not yet revealed, from the confirm on', () => {
  const empty = { name: 'Max', plans: [], beforePhotos: [], beforeAfterPhotos: [] };
  assert.deepEqual(partsOf(empty), { befores: false, 'as-built': false, proposed: false, board: false });
  const reveals = [{ slug: 'max', startsAt: at(10), jobId: 'JOB1' }];
  assert.deepEqual(nextWork(reveals, { max: empty }, {}, NOW), { slug: 'max', name: 'Max', startsAt: at(10), jobId: 'JOB1', work: 'befores', want: ['befores'] });
  // Some still to come: before photos again; all in: the drawings
  assert.equal(nextWork(reveals, { max: empty }, { max: { befores: { checked: NOW - MIN, owed: 4 } } }, NOW).work, 'befores');
  const checked = { befores: { checked: NOW - 3600e3, owed: 0 } };
  assert.deepEqual(nextWork(reveals, { max: empty }, { max: checked }, NOW).want, ['as-built', 'proposed', 'board']);
  // Looked at 6 hours ago: before photos again (one tagged Before since comes in)
  assert.equal(nextWork(reveals, { max: empty }, { max: { befores: { checked: NOW - 7 * 3600e3, owed: 0 } } }, NOW).work, 'befores');
  // One to try again: once it's due, not before
  assert.equal(nextWork(reveals, { max: empty }, { max: { befores: { checked: NOW - MIN, owed: 0, retryAt: NOW + MIN } } }, NOW).work, 'drawings');
  assert.equal(nextWork(reveals, { max: empty }, { max: { befores: { checked: NOW - MIN, owed: 0, retryAt: NOW - 1 } } }, NOW).work, 'befores');
  // A drawing part brought in once: never again; looked for and found nothing: not again for 6 hours
  assert.equal(nextWork(reveals, { max: empty }, { max: { ...checked, done: { 'as-built': 1, proposed: 1 }, tried: { board: NOW - 3600e3 } } }, NOW), null);
  assert.equal(nextWork(reveals, { max: empty }, { max: { ...checked, tried: { board: NOW - 7 * 3600e3, 'as-built': NOW, proposed: NOW } } }, NOW).want.join(), 'board');
  // What staff put there counts: only the missing part is looked for
  const some = { name: 'Max', beforePhotos: [{ url: 'b', looked: 'staff' }], plans: [{ url: 'u1', type: 'as-built' }, { url: 'u2', type: 'proposed' }] };
  assert.deepEqual(nextWork(reveals, { max: some }, { max: checked }, NOW).want, ['board']);
  // A before photo nobody has looked at is the run's own first step (nextLook), never a reveal's part
  const fresh = { ...some, beforePhotos: [{ url: 'b' }] };
  assert.equal(nextWork(reveals, { max: fresh }, { max: checked }, NOW).work, 'drawings');
  // When one is due a look: never looked at; after a failed look, half an hour, then 3 hours, then 12 (the next
  // failure keeps it off for good); resting after a service was down, not until its rest is over
  const due = (look) => dueLooks(fresh, look ? { b: look } : {}, NOW).length === 1;
  assert.deepEqual([due(null), due({ n: 1, at: NOW - 29 * MIN }), due({ n: 1, at: NOW - 30 * MIN }), due({ n: 3, at: NOW - 12 * 3600e3 })], [true, false, true, true]);
  assert.deepEqual([due({ outs: 2, wait: NOW + MIN }), due({ outs: 2, wait: NOW })], [false, true]);
  assert.deepEqual(dueLooks({ beforePhotos: [{ url: 'blob:x' }, { url: 'a', looked: 'site' }, { url: 'c' }] }, {}, NOW).map((p) => p.url), ['c'], 'never an unsaved upload or one looked at');
  // A hidden profile gets them too (they're for the admin first), and a reveal however far off
  const hidden = { ...empty, publishStatus: 'draft' };
  assert.equal(nextWork(reveals, { max: hidden }, {}, NOW).work, 'befores');
  assert.equal(nextWork(reveals, { max: hidden }, { max: checked }, NOW).work, 'drawings');
  const far = [{ slug: 'max', startsAt: at(40) }];
  assert.equal(nextWork(far, { max: empty }, {}, NOW).work, 'befores');
  assert.equal(nextWork(far, { max: empty }, { max: checked }, NOW).work, 'drawings');
  // A room already revealed is left alone
  assert.equal(nextWork(reveals, { max: { ...empty, status: 'completed' } }, {}, NOW), null);
});

test('standing: what is in, what is missing, which drawings wait on an address check', () => {
  const s = standing({ beforePhotos: [{ url: 'a', looked: 'site' }, { url: 'b', looked: 'staff' }], beforeAfterPhotos: [{ before: 'c' }], plans: [{ url: 'x', type: 'as-built', addressCheck: 'wiped' }, { url: 'y', type: 'proposed' }] });
  assert.deepEqual(s.missing, [], 'a design board isn’t needed: it never plays on the live page');
  assert.equal(s.unchecked.length, 1);
  assert.equal(s.ready, false, 'the proposed drawing’s address still waits on a look');
  assert.match(s.inParts.join(', '), /^2 before photos, the as-built drawing, the proposed drawing/);
  // A pair's before isn't a before photo of the reveal's
  assert.deepEqual(standing({ beforeAfterPhotos: [{ before: 'a' }], plans: [] }).missing[0], 'before photos');
  assert.equal(standing({ beforePhotos: [{ url: 'a', looked: 'site' }], plans: [{ url: 'x', type: 'as-built', addressCheck: 'wiped' }, { url: 'y', type: 'proposed', addressCheck: 'covered' }, { url: 'z', type: 'board' }] }).ready, true);
  // Before photos there, but none on the page: said as such
  assert.deepEqual(standing({ beforePhotos: [{ url: 'a', looked: 'site', offPage: true }, { url: 'b' }], plans: [] }).missing[0], 'before photos on the page (all 2 are kept off or not looked at yet)');
  assert.deepEqual(standing({ beforePhotos: [{ url: 'a', looked: 'staff', offPage: true }], plans: [] }).missing[0], 'before photos on the page (the one there is kept off or not looked at yet)');
});

// ── Runs, end to end, with JobTread, Cloudflare Images, Slack and the browser stood in for ──

let env;
const calls = { uploads: [], slack: [], emails: [], jt: [], looked: [], ai: [] };
const fetchImpl = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  // Cloudflare Images' resize for the look: its "picture" is its own address, so the model stand-in knows which it is
  if (url.startsWith('https://imagedelivery.net/')) {
    calls.looked.push(url);
    if (url.includes('-gone')) return new Response('not found', { status: 404 });
    return new Response(new TextEncoder().encode(url), { headers: { 'content-type': 'image/jpeg' } });
  }
  if (url.includes('/images/v1')) {
    const id = init.body.get('id');
    calls.uploads.push(id);
    return Response.json({ success: true, result: { id, variants: [`https://imagedelivery.net/HASH/${id}/public`] } });
  }
  // JobTread's API, for the schedule the page reads (getReveals, before a publish): no jobs of its own here (a test
  // about the schedule stands in its own)
  if (url.startsWith('https://api.jobtread.com/')) return Response.json({ organization: { jobs: { nextPage: null, nodes: [] } } });
  if (url.startsWith('https://jt.test/')) {
    calls.jt.push(url);
    // A file JobTread no longer has (the photo's own fault, counted); JobTread itself down is another test's
    if (url.includes('broken')) return new Response('nope', { status: 404 });
    return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': url.endsWith('.png') ? 'image/png' : url.endsWith('.pdf') ? 'application/pdf' : 'image/jpeg' } });
  }
  throw new Error(`unexpected fetch ${url}`);
};
const origFetch = globalThis.fetch;
// (A test's look at things the moment a note reaches Slack)
let onSlack = null;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.startsWith('https://hooks.slack.test/')) { const body = JSON.parse(init.body); calls.slack.push(body); if (onSlack) await onSlack(body); return new Response('ok'); }
  if (url.startsWith('https://api.resend.com/')) { calls.emails.push(JSON.parse(init.body)); return Response.json({ data: [] }); }
  return origFetch(input, init);
};

const photo = (id, extra = {}) => ({ id, name: `CompanyCam ${id}.jpg`, type: 'image/jpeg', url: `https://jt.test/${id}.jpg`, big: `https://jt.test/${id}-big.jpg`, createdAt: `2026-08-01T00:00:${id.slice(1).padStart(2, '0')}Z`, ...extra });
// Dylan's job: 20 before photos; B7 an iPhone photo JobTread has no JPEG of; B9's JPEG never loads
const DYLAN_BEFORES = Array.from({ length: 20 }, (_, i) => photo(`B${i}`,
  i === 7 ? { name: 'IMG_7.HEIC', type: 'image/heic', big: null, url: 'https://jt.test/B7.heic' } : i === 9 ? { big: 'https://jt.test/broken-B9.jpg' } : {}));
const SOURCES = {
  'dylan-2026': {
    kid: { slug: 'dylan-2026', name: 'Dylan' },
    job: { id: 'JOB1', name: 'Dylan Marchena (2026)' },
    address: { street: '12 Maple Ln', city: 'Roswell', zip: '30075', family: 'Marchena' },
    sheets: [],
    drawings: [
      { id: 'SOW', name: 'Dylan 2026_Scope of Work.pdf', type: 'application/pdf', url: 'https://jt.test/sow.pdf' },
      { id: 'SET', name: 'Dylan 2026_Plan Set_08172026.pdf', type: 'application/pdf', url: 'https://jt.test/set.pdf' },
      { id: 'BRD', name: 'Dylan 2026_Design Board.png', type: 'image/png', url: 'https://jt.test/board.png' },
    ],
    befores: DYLAN_BEFORES,
  },
  max: {
    kid: { slug: 'max', name: 'Max' }, job: { id: 'JOB2', name: 'Max Daniel (2026)' },
    address: { street: '', city: '', zip: '', family: 'Daniel' }, sheets: [], drawings: [],
    befores: ['M0', 'M1', 'M2', 'M3'].map((id) => photo(id)),
  },
};
const REVEALS = [
  { slug: 'dylan-2026', name: 'Dylan', startsAt: at(8), confirmed: true, jobId: 'JOB1' },
  { slug: 'max', name: 'Max', startsAt: at(40), confirmed: true, jobId: 'JOB2' },
];
// The browser's answer for the plan set: page 2 existing (street found), page 3 proposed (street not found: a scan)
const drawn = [];
const fakeBrowser = {
  newPage: async () => ({
    setBypassCSP: async () => {}, goto: async () => {}, close: async () => {},
    evaluate: async (_fn, _b64, _d, _r, _base, opts) => {
      drawn.push(opts);
      const all = [{ n: 2, kind: 'as-built', title: '2 EXISTING LAYOUT', sheet: 'Dylan 2026_Plan Set_08172026.pdf (2)', street: true }, { n: 3, kind: 'proposed', title: 'DIMENTIONED PROPOSED LAYOUT', sheet: '', street: false }];
      return { pages: [], out: all.filter((o) => opts.want.includes(o.kind)).map((o) => ({ ...o, w: 2400, h: 1600, trimmed: true, wiped: 1, textLayer: true, png: btoa('png') })) };
    },
  }),
  close: async () => {},
};
const putKid = (slug, data, status = 'in-progress') => env.DB.prepare('INSERT OR REPLACE INTO kids (slug, data, name, year, status, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
  .bind(slug, JSON.stringify({ slug, status, ...data }), data.name, 2026, status, '2026-11-01T00:00:00Z').run();

// Workers AI, standing in: what it sees in each picture (by the picture's address). Dylan's B3 has a person in it and
// B12 is of boxes; anything named look-fail gets no answer; the rest are fine
const NO = { person: false, peoplePictures: false, screen: false, private: false, outside: false, boxes: false, measuring: false, building: false, noRoom: false };
let sees = (picture) => (/companycam-b3\./.test(picture) ? { ...NO, person: true } : /companycam-b12\./.test(picture) ? { ...NO, boxes: true } : /look-fail/.test(picture) ? null : NO);
const AI = {
  run: async (model, input, opts) => {
    const picture = new TextDecoder().decode(Uint8Array.from(atob(input.messages[1].content[1].image_url.url.split(',')[1]), (c) => c.charCodeAt(0)));
    calls.ai.push({ model, feature: opts?.gateway?.metadata?.feature, picture });
    const a = await sees(picture);
    return { response: a || 'I can’t tell.' };
  },
};

before(async () => {
  const DB = await createD1({ schemaFiles: ['scripts/schema.sql'] });
  env = { DB, AI, JOBTREAD_GRANT_KEY: 'k', CF_ACCOUNT_ID: 'acc', CF_IMAGES_TOKEN: 't', SLACK_WEBHOOK_URL: 'https://hooks.slack.test/x' };
  await putKid('dylan-2026', { name: 'Dylan', plans: [], beforeAfterPhotos: [] });
  // Max: two before photos waiting in Before & after from before Nov 12 (one from JobTread, one a staff upload), and a whole pair
  await putKid('max', { name: 'Max', plans: [], beforeAfterPhotos: [
    { before: 'https://imagedelivery.net/HASH/kids/max/ba-before-1-companycam-m0.jpg/public', after: '', room: 'Bathroom', beforeAlt: 'Max’s room before the makeover', afterAlt: '', source: 'jt:M0' },
    { before: 'https://imagedelivery.net/HASH/kids/max/ba-before-2-staff.jpg/public', after: '', room: '', beforeAlt: '', afterAlt: '' },
    { before: 'https://imagedelivery.net/HASH/kids/max/ba-before-3-hall.jpg/public', after: 'https://imagedelivery.net/HASH/kids/max/ba-after-3-hall.jpg/public', room: 'Hall', beforeAlt: '', afterAlt: '' },
  ] });
  // A room revealed long ago whose pair still waits for its after: left as it is
  await putKid('old', { name: 'Old', plans: [], beforeAfterPhotos: [{ before: 'https://imagedelivery.net/HASH/kids/old/b.jpg/public', after: '' }] }, 'completed');
});

let clockAt = 0;
const run = (now, extra = {}) => runRevealDesigns(env, { fetchImpl, now, clock: () => clockAt, reveals: REVEALS, sources: async (slug) => SOURCES[slug], browser: fakeBrowser, keepBrowser: true, readAsset: async () => '', ...extra });
const kid = async (slug) => JSON.parse((await env.DB.prepare('SELECT data FROM kids WHERE slug = ?').bind(slug).first()).data);
const ledger = async () => JSON.parse((await env.DB.prepare('SELECT data FROM site_config WHERE key = ?').bind(AUTO_KEY).first()).data);
const claimRow = () => env.DB.prepare("SELECT data, updated_at FROM site_config WHERE key = 'reveal-design-auto-next'").first();

// Every other profile's before photos counted as looked at (staff's), so only `slug`'s are due the site's look (or none)
const onlyDue = async (slug = null) => {
  const { results } = await env.DB.prepare('SELECT slug, data FROM kids').all();
  for (const row of results) {
    if (row.slug === slug) continue;
    const k = JSON.parse(row.data);
    if (!(k.beforePhotos || []).some((p) => !p.looked)) continue;
    k.beforePhotos = k.beforePhotos.map((p) => (p.looked ? p : { ...p, looked: 'staff' }));
    await env.DB.prepare('UPDATE kids SET data = ? WHERE slug = ?').bind(JSON.stringify(k), row.slug).run();
  }
};

test('the first run moves before photos waiting in Before & after to Photos, once, and the site looks at them first (it needs nothing from JobTread); then the soonest reveal’s before photos: the six spread across the visit first, twelve a run, into Photos → Before photos', async () => {
  const r0 = await run(NOW);
  assert.deepEqual([r0.did.slug, r0.did.work, r0.did.looked], ['max', 'look', 2]);
  // Max's two waiting before photos moved, with their room, alt and JobTread file; the whole pair stays
  const m = await kid('max');
  assert.deepEqual(m.beforePhotos.map((p) => [p.room, p.source || null, p.looked]), [['Bathroom', 'jt:M0', 'site'], ['', null, 'site']]);
  assert.equal(m.beforePhotos[0].alt, 'Max’s room before the makeover');
  assert.deepEqual(m.beforeAfterPhotos.map((p) => p.room), ['Hall']);
  // A revealed room is never touched
  assert.equal((await kid('old')).beforeAfterPhotos.length, 1);
  assert.equal((await kid('old')).beforePhotos, undefined);
  const l = await ledger();
  assert.ok(l.movedBefores);
  assert.deepEqual(l.kids.max.befores.brought, ['M0']);
  assert.equal(Number((await claimRow()).data), NOW + MIN, 'the next run a minute on');

  // Dylan: twelve, the reveal screen's six spread across the visit first, never the HEIC JobTread has no JPEG of
  const r = await run(NOW + MIN);
  assert.equal(r.did.slug, 'dylan-2026');
  assert.equal(r.did.work, 'befores');
  const d = await kid('dylan-2026');
  assert.equal(d.beforePhotos.length, 12);
  assert.deepEqual(d.beforePhotos.slice(0, 6).map((p) => p.source), ['jt:B0', 'jt:B4', 'jt:B8', 'jt:B12', 'jt:B15', 'jt:B19']);
  assert.ok(!d.beforePhotos.some((p) => p.source === 'jt:B7' || p.source === 'jt:B9'));
  // (A random part in each address: one kept off is never found by guessing from one that's on the page)
  assert.ok(d.beforePhotos.every((p) => /^https:\/\/imagedelivery\.net\/HASH\/kids\/dylan-2026\/before-\d+-[0-9a-f]{32}-companycam-b\d+\.jpg\/public$/.test(p.url)), d.beforePhotos[0].url);
  assert.equal(new Set(d.beforePhotos.map((p) => p.url.split('-')[2])).size, 12, 'a different one each');
  assert.equal(d.beforePhotos[0].alt, 'Dylan’s room before the makeover');
  assert.deepEqual(d.beforeAfterPhotos, [], 'nothing in Before & after');
  assert.deepEqual(d.photos, undefined, 'nothing in the gallery');
  // JobTread's 2048px JPEG each time
  assert.ok(calls.jt.every((u) => /-big\.jpg$|broken/.test(u)), calls.jt.join());
  // Six still to come, and B9 (JobTread wouldn't give it) tried again in half an hour: the next run may start a minute after this one
  assert.equal(r.did.owed, 6);
  assert.equal(r.did.waiting, 1);
  assert.equal(Number((await claimRow()).data), NOW + 2 * MIN);
  // A version in the history, by the import; Slack waits until they're all in
  const v = await env.DB.prepare("SELECT COUNT(*) AS n FROM content_versions WHERE collection = 'kids' AND slug = 'dylan-2026'").first().catch(() => ({ n: -1 }));
  assert.ok(v.n !== 0, 'a version was kept');
  assert.equal(calls.slack.length, 0);
});

test('a minute on the site looks at those, then the rest come in and are looked at; one JobTread won’t give waits to be tried again; Slack hears once, with the design', async () => {
  assert.equal((await run(NOW + MIN + 30e3)).skipped, 'not yet', 'not while the last run may still be going');
  const r2 = await run(NOW + 2 * MIN);
  assert.deepEqual([r2.did.slug, r2.did.work, r2.did.looked], ['dylan-2026', 'look', 12]);
  assert.ok(calls.ai.every((c) => c.feature === 'before-photos'), 'through the gateway, as before-photos');
  assert.ok(calls.looked.every((u) => /\/w=1280,h=1280,fit=scale-down,q=85,format=jpeg$/.test(u)), 'Cloudflare’s resize, not the full picture');
  const r3 = await run(NOW + 3 * MIN);
  assert.equal(r3.did.work, 'befores');
  assert.equal(r3.did.owed, 0);
  assert.equal(r3.did.waiting, 1, 'B9 waits half an hour to be tried again');
  let d = await kid('dylan-2026');
  assert.equal(d.beforePhotos.length, 18, '20 less the HEIC and the one that won’t load');
  // In the order they were taken after the first six
  assert.deepEqual(d.beforePhotos.slice(6, 9).map((p) => p.source), ['jt:B1', 'jt:B2', 'jt:B3']);
  assert.equal(new Set(d.beforePhotos.map((p) => p.source)).size, 18, 'none twice');
  // The six new ones: nobody has looked at them yet, so none shows anywhere, and Slack waits
  assert.equal(d.beforePhotos.filter((p) => !p.looked).length, 6);
  assert.equal(calls.slack.length, 0);
  const r4 = await run(NOW + 4 * MIN);
  assert.deepEqual([r4.did.work, r4.did.looked, r2.did.on + r4.did.on, r2.did.off + r4.did.off], ['look', 6, 16, 2]);
  d = await kid('dylan-2026');
  const of = (src) => d.beforePhotos.find((p) => p.source === src);
  assert.deepEqual([of('jt:B0').looked, of('jt:B0').offPage], ['site', undefined]);
  assert.deepEqual([of('jt:B3').looked, of('jt:B3').offPage, of('jt:B3').offWhy], ['site', true, 'A person in it']);
  assert.equal(of('jt:B12').offWhy, 'Boxes or deliveries');
  const v = await env.DB.prepare("SELECT changes FROM audit_log WHERE entity_slug = 'dylan-2026' ORDER BY id DESC LIMIT 1").first().catch(() => null);
  if (v) assert.match(v.changes, /The site looked at 6 before photos/);
  assert.equal(calls.slack.length, 0, 'the note goes with the next run that reads JobTread');
  // A minute on: the drawings (the next part), and Slack hears of the before photos and of the design
  const r5 = await run(NOW + 5 * MIN);
  assert.equal(r5.did.work, 'drawings');
  assert.equal(drawn.length, 1, 'only the plan set was drawn, not the scope of work');
  d = await kid('dylan-2026');
  const byType = Object.fromEntries(d.plans.map((p) => [p.type, p]));
  assert.equal(byType['as-built'].addressCheck, 'wiped');
  assert.equal(byType['as-built'].label, 'Existing layout');
  assert.equal(byType.proposed.addressCheck, undefined, 'street not found: held off the reveal screen');
  assert.equal(byType.board.source, 'jt:BRD');
  const posts = calls.slack.map((p) => JSON.stringify(p));
  assert.equal(posts.length, 2);
  assert.ok(posts.some((p) => /Dylan’s design is in/.test(p)));
  const note = posts.find((p) => /before photos are in/.test(p));
  assert.match(note, /Dylan’s before photos are in/);
  assert.match(note, /18 before photos from JobTread/);
  assert.match(note, /Photos → Before photos/);
  assert.match(note, /After the site’s check: 16 on the page, 2 kept off \(a person in it, boxes or deliveries\)/);
  assert.match(note, /Open any one to switch it on the page if it’s fine to show/);
  assert.match(note, /The first 6 on the page play on the reveal screen/);
  assert.match(note, /1 more couldn’t be brought in yet; the site tries again later/);
  // All in and looked at, the design too: back to every 10 minutes
  assert.equal((await run(NOW + 6 * MIN + 3000)).skipped, 'not yet');
});

test('JobTread’s confirm wakes a run at once (unless one may still be going); then Max: the rest of his before photos go after the ones he has, are looked at, and his drawings are looked for', async () => {
  const t = NOW + 8 * MIN;
  const m1 = await run(t, { wake: true });
  assert.deepEqual([m1.did.slug, m1.did.work], ['max', 'befores']);
  const m = await kid('max');
  assert.deepEqual(m.beforePhotos.map((p) => p.source || null), ['jt:M0', null, 'jt:M1', 'jt:M2', 'jt:M3'], 'M0 was there already; the rest after, as taken');
  assert.equal((await run(t + 10e3, { wake: true })).skipped, 'not yet', 'a wake-up never overlaps a run');
  const look = await run(t + MIN, { wake: true });
  assert.deepEqual([look.did.slug, look.did.work, look.did.looked], ['max', 'look', 3]);
  assert.ok((await kid('max')).beforePhotos.every((p) => p.looked === 'site' && !p.offPage));
  // Max, 40 days out: his drawings are looked for at once (his job has none yet), and Slack hears of his before photos
  const m2 = await run(t + 2 * MIN, { wake: true });
  assert.deepEqual([m2.did.slug, m2.did.work, m2.did.missing.join()], ['max', 'drawings', 'as-built,proposed,board']);
  assert.match(JSON.stringify(calls.slack.at(-1)), /3 more before photos, 5 in all,/);
  assert.match(JSON.stringify(calls.slack.at(-1)), /After the site’s check: all are on the page/);
  assert.equal((await run(t + 3 * MIN, { wake: true })).did, null, 'nothing left to do');
});

test('what staff take out stays out, what is tagged Before later comes in at the end, and what they save meanwhile is kept', async () => {
  const d = await kid('dylan-2026');
  const edited = { ...d, beforePhotos: d.beforePhotos.filter((p) => p.source !== 'jt:B4'), heroSummary: 'edited by staff' };
  await env.DB.prepare('UPDATE kids SET data = ?, updated_at = ? WHERE slug = ?').bind(JSON.stringify(edited), new Date().toISOString(), 'dylan-2026').run();
  SOURCES['dylan-2026'].befores = [...DYLAN_BEFORES, photo('B20')];
  // Six hours on, Dylan's job is looked at again
  const r = await run(NOW + 7 * 3600e3);
  assert.equal(r.did.slug, 'dylan-2026');
  const after = await kid('dylan-2026');
  assert.equal(after.heroSummary, 'edited by staff');
  assert.ok(!after.beforePhotos.some((p) => p.source === 'jt:B4'), 'not brought back');
  assert.equal(after.beforePhotos.at(-1).source, 'jt:B20');
  assert.equal(after.beforePhotos.length, 18);
  assert.equal((await ledger()).kids['dylan-2026'].befores.failed.B9.n, 2, 'B9 was tried again, and failed again');
  // A minute on, the site looks at B20, and only B20; the run after, Slack hears of the one more
  const before = calls.ai.length;
  const look = await run(NOW + 7 * 3600e3 + MIN);
  assert.deepEqual([look.did.work, look.did.looked], ['look', 1]);
  assert.equal(calls.ai.length, before + 1);
  assert.equal((await kid('dylan-2026')).beforePhotos.at(-1).looked, 'site');
  await run(NOW + 7 * 3600e3 + 2 * MIN);
  assert.match(JSON.stringify(calls.slack.at(-1)), /1 more before photo, 18 in all,/);
});

test('a run stops at its time budget, and the rest come a minute later', async () => {
  await putKid('ava', { name: 'Ava', plans: [], beforePhotos: [] });
  SOURCES.ava = { ...SOURCES.max, kid: { slug: 'ava', name: 'Ava' }, job: { id: 'JOB3', name: 'Ava Lee (2026)' }, befores: ['A0', 'A1', 'A2'].map((id) => photo(id)) };
  const reveals = [{ slug: 'ava', name: 'Ava', startsAt: at(3), confirmed: true, jobId: 'JOB3' }];
  let ticks = 0;
  const t = NOW + 8 * 3600e3;
  // The clock passes the run's 20 seconds (from its start) after the first photo (its start, the time for the read, the
  // read, the first photo)
  const r = await run(t, { reveals, clock: () => (ticks++ < 4 ? 0 : 21_000) });
  assert.equal(r.did.added.befores, 1);
  assert.equal(r.did.owed, 2);
  assert.equal(Number((await claimRow()).data), t + MIN);
});

test('when JobTread can’t be read for a job: nothing is marked done, that kid rests (doubling) while the run goes on to the notes, Site → Automations hears why, and the next good run clears it', async () => {
  await onlyDue();
  await putKid('zoe', { name: 'Zoe', plans: [], beforePhotos: [] });
  const reveals = [{ slug: 'zoe', name: 'Zoe', startsAt: at(2), confirmed: true, jobId: 'JOB4' }];
  const t = NOW + 8.25 * 3600e3; // (its runs end by NOW + 9.5 h: the next test starts at 10)
  const slack = calls.slack.length;
  const refused = async () => { throw new Error('JobTread returned 503'); };
  const bad = await run(t, { reveals, sources: refused });
  assert.deepEqual(bad.did, { slug: 'zoe', work: 'befores', error: 'JobTread returned 503' });
  let l = await ledger();
  assert.equal(l.error.message, 'JobTread couldn’t be read for Zoe’s before photos (JobTread returned 503). Nothing was counted against them; the site tries again on its own.');
  assert.deepEqual([l.kids.zoe.befores.checked, l.kids.zoe.befores.restUntil, l.kids.zoe.befores.outRuns], [undefined, t + 15 * MIN, 1], 'not read, so not checked: it rests');
  assert.ok(l.kids['dylan-2026'].befores.brought.length > 10, 'everything else it knew is kept');
  assert.equal(calls.slack.length, slack + 1, 'the run went on to the 3-day note');
  // Resting: its drawings next (refused too: they rest half an hour), then twice as long for the photos
  const draw = await run(t + 11 * MIN, { reveals, sources: refused });
  assert.deepEqual([draw.did.work, draw.did.error], ['drawings', 'JobTread returned 503']);
  l = await ledger();
  assert.equal(l.kids.zoe.drawOuts, 1);
  assert.ok(Object.values(l.kids.zoe.tried).every((x) => x === t + 11 * MIN - 6 * 3600e3 + 30 * MIN), JSON.stringify(l.kids.zoe.tried));
  await run(t + 22 * MIN, { reveals, sources: refused });
  assert.deepEqual([(await ledger()).kids.zoe.befores.restUntil, (await ledger()).kids.zoe.befores.outRuns], [t + 52 * MIN, 2]);
  assert.equal((await run(t + 33 * MIN, { reveals, sources: refused })).did, null, 'both resting: nothing to do');
  SOURCES.zoe = { ...SOURCES.max, kid: { slug: 'zoe', name: 'Zoe' }, job: { id: 'JOB4', name: 'Zoe (2026)' }, befores: [photo('Z0')] };
  const good = await run(t + 53 * MIN, { reveals });
  assert.deepEqual([good.did.slug, good.did.work], ['zoe', 'befores']);
  l = await ledger();
  assert.match(l.error.message, /^JobTread couldn’t be read for Zoe’s design/, 'the design’s read is still said, until it goes');
  assert.deepEqual([l.kids.zoe.befores.restUntil, l.kids.zoe.befores.outRuns], [undefined, undefined]);
  assert.equal((await kid('zoe')).beforePhotos.length, 1);
  assert.equal((await run(t + 64 * MIN, { reveals })).did.work, 'look', '(Z0 looked at first)');
  const drew = await run(t + 75 * MIN, { reveals });
  assert.deepEqual([drew.did.work, drew.did.error], ['drawings', undefined]);
  l = await ledger();
  assert.deepEqual([l.error, l.kids.zoe.readProblems, l.kids.zoe.drawOuts], [undefined, undefined, undefined]);
});

test('3 days and 1 day out: one note each, ready or what is missing (to Needs attention, with the alert emails, when something is); never for a hidden profile', async () => {
  await onlyDue();
  await putKid('lia', { name: 'Lia', plans: [], beforePhotos: [{ url: 'https://imagedelivery.net/HASH/kids/lia/b.jpg/public', looked: 'staff' }] });
  await putKid('hid', { name: 'Hid', plans: [], beforePhotos: [], publishStatus: 'draft' });
  SOURCES.lia = { ...SOURCES.max, kid: { slug: 'lia', name: 'Lia' }, job: null, befores: [] };
  SOURCES.hid = { ...SOURCES.max, kid: { slug: 'hid', name: 'Hid' }, job: null, befores: [] };
  const t = NOW + 10 * 3600e3;
  const close = [{ slug: 'lia', name: 'Lia', startsAt: new Date(t + 2.5 * DAY).toISOString(), confirmed: true }, { slug: 'hid', name: 'Hid', startsAt: new Date(t + 2.5 * DAY).toISOString(), confirmed: true }];
  const before = calls.slack.length;
  await run(t, { reveals: close });
  const posts = calls.slack.slice(before).map((p) => JSON.stringify(p));
  assert.equal(posts.filter((p) => /Lia’s design isn’t ready for the reveal/.test(p)).length, 1);
  assert.match(posts.join(' '), /Missing: the existing drawing, the proposed drawing\./);
  assert.ok(!posts.some((p) => /Hid/.test(p)), 'nothing about a hidden profile');
  const n = calls.slack.length;
  await run(t + 11 * MIN, { reveals: close });
  assert.equal(calls.slack.length, n, 'not again');
  assert.equal((await ledger()).kids.lia.told.d3, close[0].startsAt);
});

test('a photo JobTread never gives is tried again over hours, then left out and said once', async () => {
  // Third try 3 hours after the second (7 h), fourth 12 hours after that: then it's left out
  await run(NOW + 12 * 3600e3);
  assert.equal((await ledger()).kids['dylan-2026'].befores.failed.B9.n, 3);
  const before = calls.slack.length;
  await run(NOW + 24 * 3600e3 + MIN);
  const l = await ledger();
  assert.equal(l.kids['dylan-2026'].befores.failed.B9.n, 4);
  assert.equal(l.kids['dylan-2026'].befores.retryAt, null, 'nothing left to try');
  const posts = calls.slack.slice(before).map((p) => JSON.stringify(p));
  assert.equal(posts.length, 1);
  assert.match(posts[0], /Dylan’s before photos: 1 photo left out/);
  assert.match(posts[0], /couldn’t be brought in after several tries \(CompanyCam B9\.jpg\)/);
  // Said once
  await run(NOW + 30 * 3600e3);
  assert.equal(calls.slack.length, before + 1);
});

test('one taken out after Bring in from JobTread added it never comes back: History remembers it', async () => {
  await onlyDue();
  await putKid('ivy', { name: 'Ivy', plans: [], beforePhotos: [] });
  // Staff brought I0 and I1 in with the button and saved, then took I1 out and saved again, before the site looked
  await recordVersion(env.DB, { collection: 'kids', slug: 'ivy', data: { name: 'Ivy', beforePhotos: [{ url: 'u0', source: 'jt:I0' }, { url: 'u1', source: 'jt:I1' }] }, userEmail: 'staff@soardcharity.com', now: new Date(NOW).toISOString() });
  await putKid('ivy', { name: 'Ivy', plans: [], beforePhotos: [{ url: 'https://imagedelivery.net/HASH/kids/ivy/u0/public', alt: '', room: '', source: 'jt:I0' }] });
  SOURCES.ivy = { ...SOURCES.max, kid: { slug: 'ivy', name: 'Ivy' }, job: { id: 'JOB5', name: 'Ivy (2026)' }, befores: ['I0', 'I1', 'I2'].map((id) => photo(id)) };
  await onlyDue();
  const r = await run(NOW + 31 * 3600e3, { reveals: [{ slug: 'ivy', name: 'Ivy', startsAt: at(4), confirmed: true, jobId: 'JOB5' }] });
  assert.equal(r.did.added.befores, 1);
  assert.deepEqual((await kid('ivy')).beforePhotos.map((p) => p.source), ['jt:I0', 'jt:I2']);
  assert.deepEqual([...(await ledger()).kids.ivy.befores.brought].sort(), ['I0', 'I1', 'I2']);
});

test('when Cloudflare Images refuses, the run stops, nothing counts against a photo, Automations says why, and they come later', async () => {
  await onlyDue();
  await putKid('kai', { name: 'Kai', plans: [], beforePhotos: [] });
  SOURCES.kai = { ...SOURCES.max, kid: { slug: 'kai', name: 'Kai' }, job: { id: 'JOB6', name: 'Kai (2026)' }, befores: ['K0', 'K1'].map((id) => photo(id)) };
  const reveals = [{ slug: 'kai', name: 'Kai', startsAt: at(4), confirmed: true, jobId: 'JOB6' }];
  const down = async (input, init) => ((typeof input === 'string' ? input : input.url).includes('/images/v1') ? Response.json({ success: false, errors: [{ message: 'Service Unavailable' }] }, { status: 503 }) : fetchImpl(input, init));
  const t = NOW + 32 * 3600e3;
  const r = await run(t, { reveals, fetchImpl: down });
  assert.equal(r.did.added.befores, 0);
  let l = await ledger();
  assert.deepEqual(l.kids.kai.befores.failed, { K0: { outs: 1 } }, 'nothing counted against a photo: the one it stopped at rests');
  assert.equal(l.kids.kai.befores.restUntil, t + 15 * MIN, 'Kai rests a quarter hour, so other work goes on meanwhile');
  assert.match(l.error.message, /Kai’s before photos are waiting: Cloudflare Images refused: Service Unavailable/);
  assert.equal(Number((await claimRow()).data), t + 10 * MIN, 'no minute-by-minute retries while Cloudflare is down');
  assert.notEqual((await run(t + 11 * MIN, { reveals })).did?.work, 'befores', 'still resting');
  const ok = await run(t + 22 * MIN, { reveals });
  assert.equal(ok.did.added.befores, 2);
  l = await ledger();
  assert.equal(l.error, undefined, 'a good run clears it');
});

test('a ledger that can’t be read is never written over with an empty one', async () => {
  const row = await env.DB.prepare('SELECT data FROM site_config WHERE key = ?').bind(AUTO_KEY).first();
  await env.DB.prepare('UPDATE site_config SET data = ? WHERE key = ?').bind('{not json', AUTO_KEY).run();
  const r = await run(NOW + 33 * 3600e3);
  assert.ok(r.error, 'the run stops');
  assert.equal((await env.DB.prepare('SELECT data FROM site_config WHERE key = ?').bind(AUTO_KEY).first()).data, '{not json', 'left exactly as it was');
  await env.DB.prepare('UPDATE site_config SET data = ? WHERE key = ?').bind(row.data, AUTO_KEY).run();
});

test('a confirmed kid’s page is published once their before photos are all in, not again for nothing, and again if the reveal is no longer confirmed', async () => {
  await onlyDue();
  const hooks = [];
  const was = globalThis.fetch;
  globalThis.fetch = async (input, init) => ((typeof input === 'string' ? input : input.url).startsWith('https://deploy.test/') ? (hooks.push(1), new Response('ok')) : was(input, init));
  try {
    const env2 = { ...env, CF_PAGES_DEPLOY_HOOK: 'https://deploy.test/hook' };
    // Only Nia's page is in play here: what earlier runs published for is forgotten
    const l0 = await ledger();
    for (const k of Object.values(l0.kids)) delete k.page;
    await env.DB.prepare('UPDATE site_config SET data = ? WHERE key = ?').bind(JSON.stringify(l0), AUTO_KEY).run();
    await putKid('nia', { name: 'Nia', plans: [], beforePhotos: [] });
    SOURCES.nia = { ...SOURCES.max, kid: { slug: 'nia', name: 'Nia' }, job: { id: 'JOB7', name: 'Nia (2026)' }, befores: ['N0', 'N1'].map((id) => photo(id)) };
    const reveals = [{ slug: 'nia', name: 'Nia', startsAt: at(5), confirmed: true, jobId: 'JOB7' }];
    const T = NOW + 40 * 3600e3;
    // JobTread, for the schedule the page reads (getReveals): Nia's job, confirmed or not
    let niaConfirmed = true;
    const jt = async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.startsWith('https://api.jobtread.com/')) return Response.json({ organization: { jobs: { nextPage: null, nodes: [{ id: 'JOB7', name: 'Nia Sample (2026)', customFieldValues: { nodes: [
        { value: at(5), customField: { id: '22PgGhcE8jte' } }, { value: niaConfirmed ? 'Yes 👍' : '', customField: { id: '22PgGhWscUgE' } }, { value: 'Build', customField: { id: '22P52qfFub9b' } }] } }] } } });
      return fetchImpl(input, init);
    };
    const go = (t, list) => runRevealDesigns(env2, { fetchImpl: jt, now: t, clock: () => 0, reveals: list, sources: async (slug) => SOURCES[slug], browser: fakeBrowser, keepBrowser: true, readAsset: async () => '' });
    const r = await go(T, reveals);
    assert.equal(r.did.added.befores, 2);
    assert.equal(hooks.length, 0, 'not until the site has looked at them');
    const looked = await go(T + MIN, reveals);
    assert.equal(looked.did.work, 'look');
    assert.equal(hooks.length, 0, 'the look needs nothing from JobTread: the publish comes with the next run');
    await go(T + 2 * MIN, reveals);
    assert.equal(hooks.length, 1, 'published, so Nia’s page shows them');
    assert.match((await ledger()).kids.nia.page, /\|2\|0$/);
    await go(T + 12 * MIN, reveals);
    assert.equal(hooks.length, 1, 'nothing new: not again');
    // A hidden profile's page isn't on the site: nothing to publish
    await putKid('hid2', { name: 'Hid', plans: [], beforePhotos: [{ url: 'https://imagedelivery.net/HASH/kids/hid2/b/public' }], publishStatus: 'draft' });
    await go(T + 22 * MIN, [...reveals, { slug: 'hid2', name: 'Hid', startsAt: at(6), confirmed: true, jobId: 'JOB8' }]);
    assert.equal(hooks.length, 1);
    // Off the list but the schedule still has it confirmed (its job moved out of the build, say): nothing to do
    await go(T + 33 * MIN, []);
    assert.equal(hooks.length, 1);
    assert.ok((await ledger()).kids.nia.page);
    // No longer confirmed: published again, without them
    niaConfirmed = false;
    await go(T + 44 * MIN, []);
    assert.equal(hooks.length, 2);
    assert.equal((await ledger()).kids.nia.page, undefined);
  } finally {
    globalThis.fetch = was;
  }
});

test('the reveal starting publishes nothing; a page is never published before the job is read', async () => {
  await onlyDue();
  const hooks = [];
  const was = globalThis.fetch;
  globalThis.fetch = async (input, init) => ((typeof input === 'string' ? input : input.url).startsWith('https://deploy.test/') ? (hooks.push(1), new Response('ok')) : was(input, init));
  try {
    const env2 = { ...env, CF_PAGES_DEPLOY_HOOK: 'https://deploy.test/hook' };
    const T = NOW + 60 * 3600e3;
    await putKid('oli', { name: 'Oli', plans: [], beforePhotos: [] });
    SOURCES.oli = { ...SOURCES.max, kid: { slug: 'oli', name: 'Oli' }, job: { id: 'JOB9', name: 'Oli (2026)' }, befores: ['O0'].map((id) => photo(id)) };
    const startsAt = new Date(T + 2 * 3600e3).toISOString();
    const go = (t, list) => runRevealDesigns(env2, { fetchImpl, now: t, clock: () => 0, reveals: list, sources: async (slug) => SOURCES[slug], browser: fakeBrowser, keepBrowser: true, readAsset: async () => '' });
    const oli = [{ slug: 'oli', name: 'Oli', startsAt, confirmed: true, jobId: 'JOB9' }];
    await go(T, oli);
    await go(T + MIN, oli);
    await go(T + 2 * MIN, oli);
    assert.equal(hooks.length, 1, 'published once Oli’s photos are in and looked at');
    // Two hours on, the reveal has started: off the list, and nothing is published
    await go(T + 2 * 3600e3 + MIN, []);
    assert.equal(hooks.length, 1, 'not as the reveal starts');
    assert.equal((await ledger()).kids.oli.page, undefined);
    // A kid moved over the one-time move (photos in, job never read): no publish until the job's been read
    await putKid('pia', { name: 'Pia', plans: [], beforePhotos: [{ url: 'https://imagedelivery.net/HASH/kids/pia/b/public', source: 'jt:P0' }] });
    const l = await ledger();
    l.kids.pia = { befores: { brought: ['P0'] } };
    await env.DB.prepare('UPDATE site_config SET data = ? WHERE key = ?').bind(JSON.stringify(l), AUTO_KEY).run();
    SOURCES.pia = { ...SOURCES.max, kid: { slug: 'pia', name: 'Pia' }, job: { id: 'JOB10', name: 'Pia (2026)' }, befores: ['P0', 'P1'].map((id) => photo(id)) };
    const before = hooks.length;
    const pia = [{ slug: 'pia', name: 'Pia', startsAt: at(9), confirmed: true, jobId: 'JOB10' }];
    await onlyDue();
    const r = await go(T + 3 * 3600e3, pia);
    assert.equal(r.did.work, 'befores', 'her job is read first');
    assert.equal(r.did.added.befores, 1);
    assert.equal(hooks.length, before, 'then the site looks at both');
    const l2 = await go(T + 3 * 3600e3 + MIN, pia);
    assert.deepEqual([l2.did.work, l2.did.looked], ['look', 1]);
    await go(T + 3 * 3600e3 + 2 * MIN, pia);
    assert.equal(hooks.length, before + 1, 'then published, with all of them');
  } finally {
    globalThis.fetch = was;
  }
});

test('a photo Cloudflare can’t read counts against that photo and the queue goes on; JobTread down counts against none', async () => {
  await onlyDue();
  await putKid('rex', { name: 'Rex', plans: [], beforePhotos: [] });
  SOURCES.rex = { ...SOURCES.max, kid: { slug: 'rex', name: 'Rex' }, job: { id: 'JOB11', name: 'Rex (2026)' }, befores: ['R0', 'R1', 'R2'].map((id) => photo(id)) };
  const reveals = [{ slug: 'rex', name: 'Rex', startsAt: at(9), confirmed: true, jobId: 'JOB11' }];
  // R1 is a picture Cloudflare can't read (a 400 for that photo)
  const bad = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/images/v1') && String(init.body.get('id')).includes('companycam-r1')) return Response.json({ success: false, errors: [{ code: 5400, message: 'Bad request: unable to decode the image' }] }, { status: 400 });
    return fetchImpl(input, init);
  };
  const T = NOW + 70 * 3600e3;
  const r = await runRevealDesigns(env, { fetchImpl: bad, now: T, clock: () => 0, reveals, sources: async (slug) => SOURCES[slug], browser: fakeBrowser, keepBrowser: true, readAsset: async () => '' });
  assert.equal(r.did.added.befores, 2, 'R0 and R2 came in past it');
  assert.equal((await ledger()).kids.rex.befores.failed.R1.n, 1);
  assert.equal(r.did.waiting, 1);
  // JobTread's files down (a 503 for every one): nothing counted, and Automations says so
  await onlyDue();
  await putKid('sam', { name: 'Sam', plans: [], beforePhotos: [] });
  SOURCES.sam = { ...SOURCES.max, kid: { slug: 'sam', name: 'Sam' }, job: { id: 'JOB12', name: 'Sam (2026)' }, befores: ['S0', 'S1'].map((id) => photo(id)) };
  const down = async (input, init) => ((typeof input === 'string' ? input : input.url).startsWith('https://jt.test/') ? new Response('busy', { status: 503 }) : fetchImpl(input, init));
  const r2 = await runRevealDesigns(env, { fetchImpl: down, now: T + 11 * MIN, clock: () => 0, reveals: [{ slug: 'sam', name: 'Sam', startsAt: at(9), confirmed: true, jobId: 'JOB12' }], sources: async (slug) => SOURCES[slug], browser: fakeBrowser, keepBrowser: true, readAsset: async () => '' });
  assert.equal(r2.did.added.befores, 0);
  const l = await ledger();
  assert.deepEqual(l.kids.sam.befores.failed, { S0: { outs: 1 } }, 'nothing counted against a photo: the one it stopped at rests');
  assert.deepEqual([l.kids.sam.befores.owed, l.kids.sam.befores.waiting], [1, 1], 'the one it stopped at waits for another try; the other is still owed');
  assert.match(l.error.message, /Sam’s before photos are waiting: JobTread’s files answered 503/);
});

test('the same photo twice on a job (taken at the same second) comes in once', async () => {
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS photo_stages (file_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, name TEXT, kind TEXT, taken TEXT, camera INTEGER, stage TEXT, why TEXT, reads INTEGER NOT NULL DEFAULT 0, decided_at TEXT, written_at TEXT)').run();
  for (const [id, taken] of [['T0', '2026-02-04 12:36:44'], ['T1', '2026-02-04 12:36:47'], ['T2', '2026-02-04 12:36:44'], ['T3', null]]) {
    await env.DB.prepare('INSERT INTO photo_stages (file_id, job_id, taken) VALUES (?, ?, ?)').bind(id, 'JOB13', taken).run();
  }
  await putKid('tia', { name: 'Tia', plans: [], beforePhotos: [] });
  SOURCES.tia = { ...SOURCES.max, kid: { slug: 'tia', name: 'Tia' }, job: { id: 'JOB13', name: 'Tia (2026)' }, befores: ['T0', 'T1', 'T2', 'T3'].map((id) => photo(id)) };
  const r = await run(NOW + 80 * 3600e3, { reveals: [{ slug: 'tia', name: 'Tia', startsAt: at(9), confirmed: true, jobId: 'JOB13' }] });
  assert.equal(r.did.added.befores, 3);
  assert.deepEqual((await kid('tia')).beforePhotos.map((p) => p.source).sort(), ['jt:T0', 'jt:T1', 'jt:T3'], 'T2 is T0 again; T3 has no time, so it’s its own');
  assert.equal(r.did.owed, 0);
});

// ── The site's look at each before photo (Peter, Nov 12 2026: "leave off the ones you think arent good to publish? is
// there a way to keep a photo from publishing?") ──

const pic = (slug, name) => `https://imagedelivery.net/HASH/kids/${slug}/${name}/public`;
// A reveal whose job has been read: only the look (or the drawings) is left
const readJob = async (slug, t) => {
  const l = await ledger();
  l.kids[slug] = { befores: { checked: t, owed: 0 }, done: { 'as-built': t, proposed: t, board: t } };
  await env.DB.prepare('UPDATE site_config SET data = ? WHERE key = ?').bind(JSON.stringify(l), AUTO_KEY).run();
};

test('staff’s own say is never changed: one they switched while the site looked keeps theirs', async () => {
  await onlyDue();
  await putKid('uma', { name: 'Uma', plans: [], beforePhotos: ['u0', 'u1', 'u2'].map((n) => ({ url: pic('uma', n), alt: '', room: '' })) });
  const T = NOW + 90 * 3600e3;
  await readJob('uma', T);
  const was = sees;
  // Staff save u1 kept off while the site is looking
  sees = async (picture) => {
    if (picture.includes('/uma/u1/')) {
      const k = await kid('uma');
      k.beforePhotos[1] = { ...k.beforePhotos[1], looked: 'staff', offPage: true };
      await env.DB.prepare('UPDATE kids SET data = ? WHERE slug = ?').bind(JSON.stringify(k), 'uma').run();
    }
    return NO;
  };
  try {
    const r = await run(T, { reveals: [{ slug: 'uma', name: 'Uma', startsAt: at(9), confirmed: true, jobId: 'JOB14' }] });
    assert.equal(r.did.work, 'look');
    assert.deepEqual((await kid('uma')).beforePhotos.map((p) => [p.looked, !!p.offPage]), [['site', false], ['staff', true], ['site', false]]);
  } finally { sees = was; }
});

test('Workers AI at its spending cap: nothing counted, the looks rest, Automations says so, and the page isn’t held for them', async () => {
  await onlyDue();
  await putKid('vic', { name: 'Vic', plans: [], beforePhotos: [{ url: pic('vic', 'staff'), alt: '', room: '', looked: 'staff' }, { url: pic('vic', 'v1'), alt: '', room: '' }, { url: pic('vic', 'v2'), alt: '', room: '' }] });
  const T = NOW + 91 * 3600e3;
  await readJob('vic', T);
  const reveals = [{ slug: 'vic', name: 'Vic', startsAt: at(9), confirmed: true, jobId: 'JOB15' }];
  const was = sees;
  sees = () => { throw new Error("2045: Spend limit exceeded: rule 'site-day' (cost limit 5 per 86400s, sliding)"); };
  try {
    const r = await run(T, { reveals });
    assert.equal(r.did.work, 'look');
    assert.equal(r.did.looked, 0);
    const l = await ledger();
    assert.equal(l.lookRest, T + 15 * MIN);
    assert.deepEqual(l.kids.vic.befores.looks, {}, 'nothing counted against a photo');
    assert.match(l.lookError.message, /Vic’s before photos are waiting to be looked at\. Waiting: Workers AI reached its spending cap/);
    assert.equal(Number((await claimRow()).data), T + 10 * MIN, 'no minute-by-minute tries at a cap');
  } finally { sees = was; }
  // Resting: the next run does other work, and the page goes out with the one staff put on, not held for the cap
  const resting = await run(T + 11 * MIN, { reveals });
  assert.notEqual(resting.did?.work, 'look');
  assert.match((await ledger()).kids.vic.page, /\|1\|0$/, 'the page goes out with the one staff put on, not held for the cap');
  const back = await run(T + 22 * MIN, { reveals });
  assert.deepEqual([back.did.work, back.did.looked], ['look', 2]);
  assert.equal((await ledger()).lookError, undefined);
  await run(T + 23 * MIN, { reveals });
  assert.match((await ledger()).kids.vic.page, /\|3\|0$/, 'and published again with them, the run after');
});

test('a photo the model can’t answer for, or Cloudflare no longer has, is tried again over a day, off the page meanwhile, then kept off as couldn’t be checked, and Slack says so; Cloudflare down counts against none and holds nothing up', async () => {
  await onlyDue();
  await putKid('wes', { name: 'Wes', plans: [], beforePhotos: [] });
  SOURCES.wes = { ...SOURCES.max, kid: { slug: 'wes', name: 'Wes' }, job: { id: 'JOB16', name: 'Wes (2026)' }, befores: ['W0', 'W1', 'W2'].map((id) => photo(id)) };
  const reveals = [{ slug: 'wes', name: 'Wes', startsAt: at(9), confirmed: true, jobId: 'JOB16' }];
  const T = NOW + 100 * 3600e3;
  const was = sees;
  // W1: the model's answer never reads; W2: a person in it
  sees = (picture) => (/companycam-w1\./.test(picture) ? null : /companycam-w2\./.test(picture) ? { ...NO, person: true } : NO);
  try {
    await run(T, { reveals });
    const before = calls.slack.length;
    // Cloudflare Images down for the look: nothing counted, each rests a quarter hour, Automations says so, no note yet
    const down = async (input, init) => ((typeof input === 'string' ? input : input.url).startsWith('https://imagedelivery.net/') ? new Response('busy', { status: 503 }) : fetchImpl(input, init));
    const r = await run(T + MIN + 1000, { reveals, fetchImpl: down });
    assert.equal(r.did.work, 'look');
    let l = await ledger();
    assert.ok(Object.values(l.kids.wes.befores.looks).every((x) => !x.outs && !x.n && x.wait === T + MIN + 1000 + 30 * MIN), `the service’s trouble counts against none, not even a rest, and they wait out the look’s rest and a quarter hour (other photos first): ${JSON.stringify(l.kids.wes.befores.looks)}`);
    assert.match(l.lookError.message, /Wes’ before photos are waiting to be looked at: Cloudflare Images answered 503/);
    assert.equal(l.lookRest, T + MIN + 1000 + 15 * MIN, 'every picture refused: the service’s trouble, so the whole look rests');
    assert.equal(calls.slack.length, before, 'no note while none has really been looked at');
    // Resting: the run's other work goes on meanwhile
    assert.equal((await run(T + 12 * MIN, { reveals })).did.work, 'drawings');
    const r2 = await run(T + 32 * MIN, { reveals });
    assert.deepEqual([r2.did.work, r2.did.looked, r2.did.on, r2.did.off, r2.did.failed], ['look', 2, 1, 1, 1]);
    l = await ledger();
    assert.equal(l.lookError, undefined, 'an answer that won’t read is that photo’s, not the run’s');
    assert.equal(l.lookOuts, undefined, 'and a look that got through ends the rest’s doubling');
    const w1 = (await kid('wes')).beforePhotos.find((p) => p.source === 'jt:W1');
    assert.equal(w1.looked, undefined, 'off the page');
    assert.deepEqual([l.kids.wes.befores.looks[w1.url].n, l.kids.wes.befores.looks[w1.url].outs], [1, undefined]);
    // The note goes with the run after (it reads JobTread)
    await run(T + 33 * MIN, { reveals });
    let post = JSON.stringify(calls.slack.slice(before));
    assert.equal(calls.slack.length, before + 1);
    assert.match(post, /Wes’ before photos are in: 1 on the page, look over the rest/);
    assert.match(post, /After the site’s check \(2 of 3 looked at\): 1 on the page, 1 kept off \(a person in it\)/);
    assert.match(post, /1 photo couldn’t be looked at, so it stays off the page while the site tries again over the next day/);
    // Tried again half an hour on, then 3 hours, then 12 (the job's own 6-hourly look at JobTread may come first)
    for (const [t, n] of [[T + 54 * MIN, 2], [T + 4 * 3600e3 + 30 * MIN, 3]]) {
      for (let i = 0, a = t; i < 3 && (await run(a, { reveals })).did?.work !== 'look'; i++, a += 11 * MIN);
      assert.equal((await ledger()).kids.wes.befores.looks[w1.url].n, n);
    }
    let gave = null;
    for (let i = 0, a = T + 17 * 3600e3; i < 3 && !gave; i++, a += 11 * MIN) { const x = await run(a, { reveals }); if (x.did?.work === 'look') gave = { ...x, at: a }; }
    assert.equal(gave.did.gaveUp, 1);
    assert.equal((await ledger()).lookError, undefined, 'given up on and kept off (Slack says so): not trouble of the run’s');
    const w1b = (await kid('wes')).beforePhotos.find((p) => p.source === 'jt:W1');
    assert.deepEqual([w1b.looked, w1b.offPage, w1b.offWhy], ['site', true, 'Couldn’t be checked'], 'kept off for good, with why, for staff to switch on');
    assert.equal((await ledger()).kids.wes.befores.looks[w1.url], undefined);
    await run(gave.at + MIN, { reveals });
    post = JSON.stringify(calls.slack.at(-1));
    assert.equal(calls.slack.length, before + 2);
    assert.match(post, /Wes’ before photos: 1 photo couldn’t be checked/);
    assert.match(post, /The site couldn’t check 1 photo after a day of tries, so it’s kept off the page/);
    assert.notEqual((await run(T + 40 * 3600e3, { reveals })).did?.work, 'look', 'nothing left to look at');
    assert.equal(calls.slack.length, before + 2, 'said once');
  } finally { sees = was; }
  // A picture Cloudflare no longer has is that photo's own: counted, and the run goes on
  await putKid('yan', { name: 'Yan', plans: [], beforePhotos: [{ url: pic('yan', 'y0-gone'), alt: '', room: '' }, { url: pic('yan', 'y1'), alt: '', room: '' }] });
  const T2 = NOW + 150 * 3600e3;
  await readJob('yan', T2);
  const r3 = await run(T2, { reveals: [{ slug: 'yan', name: 'Yan', startsAt: at(9), confirmed: true, jobId: 'JOB17' }] });
  assert.deepEqual([r3.did.looked, r3.did.failed], [1, 1]);
  assert.equal((await ledger()).kids.yan.befores.looks[pic('yan', 'y0-gone')].n, 1);
});

test('one picture that never loads holds up nothing: it rests, other kids’ work goes on, and after a while it counts as a failed look', async () => {
  await onlyDue();
  await putKid('ann', { name: 'Ann', plans: [], beforePhotos: [{ url: pic('ann', 'a0-stuck'), alt: '', room: '' }] });
  await putKid('bea', { name: 'Bea', plans: [], beforePhotos: [] });
  SOURCES.bea = { ...SOURCES.max, kid: { slug: 'bea', name: 'Bea' }, job: { id: 'JOB19', name: 'Bea (2026)' }, befores: [photo('E0')] };
  const T = NOW + 160 * 3600e3;
  await readJob('ann', T);
  const reveals = [{ slug: 'ann', name: 'Ann', startsAt: at(8), confirmed: true, jobId: 'JOB18' }, { slug: 'bea', name: 'Bea', startsAt: at(9), confirmed: true, jobId: 'JOB19' }];
  // Cloudflare's resizer chokes on this one picture, every time (a 503 for it alone)
  const stuck = async (input, init) => ((typeof input === 'string' ? input : input.url).includes('a0-stuck') ? new Response('busy', { status: 503 }) : fetchImpl(input, init));
  const work = [];
  for (let i = 0, t = T; i < 6; i++, t += 11 * MIN) { const r = await run(t, { reveals, fetchImpl: stuck }); work.push(`${r.did?.slug}:${r.did?.work}`); }
  assert.ok(work.includes('bea:befores'), `Bea’s photos come in meanwhile: ${work.join(' ')}`);
  // (Tried again each quarter hour over the hour: three rests, nothing counted)
  const lk = () => ledger().then((l) => l.kids.ann.befores.looks[pic('ann', 'a0-stuck')]);
  assert.deepEqual([(await lk()).outs, (await lk()).n], [3, undefined]);
  // Eight rests in a row are one failed look
  const l = await ledger();
  l.kids.ann.befores.looks[pic('ann', 'a0-stuck')] = { outs: 7, wait: 0 };
  await env.DB.prepare('UPDATE site_config SET data = ? WHERE key = ?').bind(JSON.stringify(l), AUTO_KEY).run();
  for (let i = 0, t = T + 2 * 3600e3; i < 3 && (await run(t, { reveals, fetchImpl: stuck })).did?.work !== 'look'; i++, t += 11 * MIN);
  assert.deepEqual([(await lk()).n, (await lk()).outs], [1, undefined]);
  // A picture its address refuses (a 403: no token goes with it) is that photo's own, counted at once, while others load
  await putKid('cal', { name: 'Cal', plans: [], beforePhotos: [{ url: pic('cal', 'c0-locked'), alt: '', room: '' }, { url: pic('cal', 'c1'), alt: '', room: '' }] });
  await readJob('cal', T + 3 * 3600e3);
  await onlyDue('cal');
  const locked = async (input, init) => ((typeof input === 'string' ? input : input.url).includes('c0-locked') ? new Response('no', { status: 403 }) : fetchImpl(input, init));
  const r = await run(T + 3 * 3600e3, { reveals: [{ slug: 'cal', name: 'Cal', startsAt: at(7), confirmed: true, jobId: 'JOB20' }], fetchImpl: locked });
  assert.deepEqual([r.did.work, r.did.failed, r.did.looked], ['look', 1, 1]);
  assert.equal((await ledger()).kids.cal.befores.looks[pic('cal', 'c0-locked')].n, 1);
});

test('one JobTread file that never loads holds up nothing either: the rest of that kid’s photos, and other kids’, come in', async () => {
  await putKid('dee', { name: 'Dee', plans: [], beforePhotos: [] });
  await putKid('eli', { name: 'Eli', plans: [], beforePhotos: [] });
  SOURCES.dee = { ...SOURCES.max, kid: { slug: 'dee', name: 'Dee' }, job: { id: 'JOB21', name: 'Dee (2026)' }, befores: ['D0', 'D1', 'D2'].map((id) => photo(id)) };
  SOURCES.eli = { ...SOURCES.max, kid: { slug: 'eli', name: 'Eli' }, job: { id: 'JOB22', name: 'Eli (2026)' }, befores: [photo('L0')] };
  const T = NOW + 170 * 3600e3;
  const reveals = [{ slug: 'dee', name: 'Dee', startsAt: new Date(T + 5 * DAY).toISOString(), confirmed: true, jobId: 'JOB21' }, { slug: 'eli', name: 'Eli', startsAt: new Date(T + 6 * DAY).toISOString(), confirmed: true, jobId: 'JOB22' }];
  // D0's file: JobTread's server errors on it, every time
  const bad = async (input, init) => ((typeof input === 'string' ? input : input.url).includes('/D0-big') ? new Response('oops', { status: 502 }) : fetchImpl(input, init));
  for (let i = 0, t = T; i < 8; i++, t += 16 * MIN) await run(t, { reveals, fetchImpl: bad });
  assert.deepEqual((await kid('dee')).beforePhotos.map((p) => p.source).sort(), ['jt:D1', 'jt:D2'], 'Dee’s others came in past it');
  assert.deepEqual((await kid('eli')).beforePhotos.map((p) => p.source), ['jt:L0'], 'and Eli’s, after Dee');
  assert.ok((await ledger()).kids.dee.befores.failed.D0.outs >= 1 && !(await ledger()).kids.dee.befores.failed.D0.n, 'D0 rests, uncounted, for now');
  // A file JobTread refuses outright (403) is that photo's own: counted, and tried again later
  SOURCES.dee.befores = [...SOURCES.dee.befores, photo('D3')];
  const refuse = async (input, init) => ((typeof input === 'string' ? input : input.url).includes('/D3-big') ? new Response('no', { status: 403 }) : bad(input, init));
  for (let i = 0, t = T + 7 * 3600e3; i < 3; i++, t += 16 * MIN) await run(t, { reveals, fetchImpl: refuse });
  assert.equal((await ledger()).kids.dee.befores.failed.D3.n, 1);
});

test('once the reveals have nothing to do, every other profile’s before photos nobody has looked at are looked at too', async () => {
  // (Brought in with Bring in from JobTread on a kid with no confirmed reveal, say)
  await putKid('zed', { name: 'Zed', plans: [], beforePhotos: [{ url: pic('zed', 'z0'), alt: '', room: '' }] }, 'completed');
  let t = NOW + 200 * 3600e3;
  for (let i = 0; i < 30; i++, t += 11 * MIN) {
    const r = await run(t, { reveals: [] });
    if (!r.did) break;
    assert.equal(r.did.work, 'look');
  }
  const { results } = await env.DB.prepare('SELECT slug, data FROM kids').all();
  const waiting = results.flatMap((row) => (JSON.parse(row.data).beforePhotos || []).filter((p) => !p.looked && !/-gone|companycam-w1\./.test(p.url)).map((p) => `${row.slug}: ${p.url}`));
  assert.deepEqual(waiting, [], 'every one looked at (but the two the site gave up on or can’t get)');
  assert.equal((await kid('zed')).beforePhotos[0].looked, 'site', 'a revealed room’s too');
});

test('one JobTread file that keeps failing never holds the page or the note: they go out with the rest, and it waits for another try', async () => {
  const hooks = [];
  const was = globalThis.fetch;
  globalThis.fetch = async (input, init) => ((typeof input === 'string' ? input : input.url).startsWith('https://deploy.test/') ? (hooks.push(1), new Response('ok')) : was(input, init));
  try {
    const env2 = { ...env, CF_PAGES_DEPLOY_HOOK: 'https://deploy.test/hook' };
    await putKid('fay', { name: 'Fay', plans: [], beforePhotos: [] });
    SOURCES.fay = { ...SOURCES.max, kid: { slug: 'fay', name: 'Fay' }, job: { id: 'JOB23', name: 'Fay (2026)' }, befores: ['F0', 'F1', 'F2'].map((id) => photo(id)) };
    const T = NOW + 220 * 3600e3;
    const reveals = [{ slug: 'fay', name: 'Fay', startsAt: new Date(T + 4 * DAY).toISOString(), confirmed: true, jobId: 'JOB23' }];
    const bad = async (input, init) => ((typeof input === 'string' ? input : input.url).includes('/F0-big') ? new Response('oops', { status: 502 }) : fetchImpl(input, init));
    const go = (t) => runRevealDesigns(env2, { fetchImpl: bad, now: t, clock: () => 0, reveals, sources: async (slug) => SOURCES[slug], browser: fakeBrowser, keepBrowser: true, readAsset: async () => '' });
    const before = calls.slack.length;
    // Within the hour: the others in and looked at, the page published and Slack told, F0 waiting
    for (let i = 0, t = T; i < 6; i++, t += 16 * MIN) await go(t);
    assert.deepEqual((await kid('fay')).beforePhotos.map((p) => [p.source, p.looked]).sort(), [['jt:F1', 'site'], ['jt:F2', 'site']]);
    const l = await ledger();
    assert.deepEqual([l.kids.fay.befores.owed, l.kids.fay.befores.waiting], [0, 1]);
    assert.ok(hooks.length >= 1, 'published, not held for F0');
    assert.match(JSON.stringify(calls.slack.slice(before)), /Fay’s before photos are in.*1 more couldn’t be brought in yet/);
  } finally {
    globalThis.fetch = was;
  }
});

test('a JobTread file that hangs is cut off at its own limit, not the run’s: it rests and counts like any outage, and the rest come in', async () => {
  await onlyDue();
  await putKid('gus', { name: 'Gus', plans: [], beforePhotos: [] });
  SOURCES.gus = { ...SOURCES.max, kid: { slug: 'gus', name: 'Gus' }, job: { id: 'JOB24', name: 'Gus (2026)' }, befores: ['G0', 'G1', 'G2'].map((id) => photo(id)) };
  const T = NOW + 230 * 3600e3;
  const reveals = [{ slug: 'gus', name: 'Gus', startsAt: new Date(T + 4 * DAY).toISOString(), confirmed: true, jobId: 'JOB24' }];
  // G0's download never answers: its own 5-second limit cuts it off (the fetch is told so)
  const seen = [];
  const hang = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/G0-big')) { seen.push(init?.signal ? 'limited' : 'unlimited'); throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); }
    return fetchImpl(input, init);
  };
  const r = await run(T, { reveals, fetchImpl: hang });
  assert.deepEqual(seen, ['limited']);
  const l = await ledger();
  assert.equal(l.kids.gus.befores.failed.G0.outs, 1, 'it rests, uncounted');
  assert.ok(l.kids.gus.befores.restUntil > T);
  assert.match(l.error.message, /Gus’ before photos are waiting: JobTread’s files couldn’t be reached/);
  // Next time it goes last: the others come in past it
  await run(T + 16 * MIN, { reveals, fetchImpl: hang });
  assert.deepEqual((await kid('gus')).beforePhotos.map((p) => p.source).sort(), ['jt:G1', 'jt:G2']);
  assert.equal(r.did.work, 'befores');
});

test('a plan set isn’t started without the time to draw it, and that isn’t a try: looked for again in half an hour', async () => {
  await onlyDue();
  await putKid('hal', { name: 'Hal', plans: [], beforePhotos: [{ url: pic('hal', 'h0'), alt: '', room: '', looked: 'staff' }] });
  SOURCES.hal = { ...SOURCES['dylan-2026'], kid: { slug: 'hal', name: 'Hal' }, job: { id: 'JOB25', name: 'Hal (2026)' }, befores: [] };
  const T = NOW + 240 * 3600e3;
  const reveals = [{ slug: 'hal', name: 'Hal', startsAt: new Date(T + 4 * DAY).toISOString(), confirmed: true, jobId: 'JOB25' }];
  await readJob('hal', T);
  const l0 = await ledger();
  delete l0.kids.hal.done;
  await env.DB.prepare('UPDATE site_config SET data = ? WHERE key = ?').bind(JSON.stringify(l0), AUTO_KEY).run();
  const drawnBefore = drawn.length;
  // The run's clock: its start, then 15 s gone by the time the drawings would begin
  let n = 0;
  const r = await run(T, { reveals, clock: () => (n++ === 0 ? 0 : 15_000) });
  assert.equal(r.did.work, 'drawings');
  assert.equal(drawn.length, drawnBefore, 'no plan set started with 5 s left');
  // No time to look at all is no try: looked for again in half an hour, not 6 hours
  assert.equal((await ledger()).kids.hal.tried['as-built'], T - 6 * 3600e3 + 30 * MIN);
});

test('reading JobTread taking the run’s time leaves none for the photos: the kid rests (nothing counted), Automations says so, and the others get their turn', async () => {
  await onlyDue();
  await putKid('ida', { name: 'Ida', plans: [], beforePhotos: [] });
  await putKid('jon', { name: 'Jon', plans: [], beforePhotos: [] });
  SOURCES.ida = { ...SOURCES.max, kid: { slug: 'ida', name: 'Ida' }, job: { id: 'JOB26', name: 'Ida (2026)' }, befores: [photo('I5')] };
  SOURCES.jon = { ...SOURCES.max, kid: { slug: 'jon', name: 'Jon' }, job: { id: 'JOB27', name: 'Jon (2026)' }, befores: [photo('J0')] };
  const T = NOW + 250 * 3600e3;
  const reveals = [{ slug: 'ida', name: 'Ida', startsAt: new Date(T + 3 * DAY).toISOString(), confirmed: true, jobId: 'JOB26' }, { slug: 'jon', name: 'Jon', startsAt: new Date(T + 4 * DAY).toISOString(), confirmed: true, jobId: 'JOB27' }];
  // JobTread's reads take 15 of the run's 20 seconds
  let slow = 0;
  const r = await run(T, { reveals, clock: () => slow, sources: async (slug) => { slow = 15_000; return SOURCES[slug]; } });
  assert.deepEqual([r.did.slug, r.did.work, r.did.added.befores, r.did.owed], ['ida', 'befores', 0, 1]);
  const l = await ledger();
  assert.deepEqual(l.kids.ida.befores.failed, {}, 'nothing counted');
  assert.ok(l.kids.ida.befores.restUntil > T, 'Ida rests');
  assert.match(l.error.message, /Ida’s before photos are waiting: reading JobTread took the run’s time/);
  assert.equal(Number((await claimRow()).data), T + 10 * MIN, 'not every minute');
  // With time again: not Ida's photos while she rests (her other work meanwhile), then hers, and Jon's in turn
  const work = [];
  for (let i = 0, t = T + 11 * MIN; i < 7; i++, t += 11 * MIN) { const x = await run(t, { reveals }); work.push(`${x.did?.slug}:${x.did?.work}`); }
  assert.notEqual(work[0], 'ida:befores', work.join(' '));
  assert.deepEqual([(await kid('ida')).beforePhotos.length, (await kid('jon')).beforePhotos.length], [1, 1], work.join(' '));
});

test('Workers AI down: the whole look rests (a quarter hour, twice that each time, to 2 hours), so the other kids’ work, the notes and the publish go on meanwhile; nothing is counted; it all resumes when Workers AI is back', async () => {
  await onlyDue();
  await putKid('ru', { name: 'Ru', plans: [], beforePhotos: Array.from({ length: 12 }, (_, i) => ({ url: pic('ru', `r${i}`), alt: '', room: '' })) }, 'completed');
  await putKid('zuri', { name: 'Zuri', plans: [], beforePhotos: [] });
  SOURCES.zuri = { ...SOURCES.max, kid: { slug: 'zuri', name: 'Zuri' }, job: { id: 'JOB30', name: 'Zuri (2026)' }, befores: [photo('Z0')] };
  const T = NOW + 300 * 3600e3;
  const reveals = [{ slug: 'zuri', name: 'Zuri', startsAt: new Date(T + 2 * DAY).toISOString(), confirmed: true, jobId: 'JOB30' }];
  const slack = calls.slack.length;
  const was = sees;
  sees = () => { throw new Error('InferenceUpstreamError 503'); };
  const work = [];
  try {
    // A run every 11 minutes for two hours
    for (let i = 0, t = T; i < 12; i++, t += 11 * MIN) { const r = await run(t, { reveals }); work.push(r.did ? `${r.did.slug}:${r.did.work}` : '-'); }
    // (Each look's photos wait out the rest and a quarter hour: the next look tries others)
    assert.deepEqual(work, ['ru:look', 'zuri:befores', 'zuri:look', 'zuri:drawings', '-', 'ru:look', '-', '-', '-', '-', '-', 'zuri:look'], 'a look at 0, 22, 55 and 121 minutes: 15, 30, then 60 minutes’ rest');
    const l = await ledger();
    assert.deepEqual([l.lookOuts, l.lookRest], [4, T + 121 * MIN + 120 * MIN], 'resting 2 hours now, at most');
    assert.equal((await kid('zuri')).beforePhotos.length, 1, 'Zuri’s before photo came in meanwhile');
    assert.ok(calls.slack.length > slack, 'and the 3-day note went');
    assert.ok([...Object.values(l.kids.ru.befores?.looks || {}), ...Object.values(l.kids.zuri.befores.looks)].every((x) => !x.n && !x.outs), 'nothing counted against a photo, not even a rest');
    assert.match(l.lookError.message, /Zuri’s before photos are waiting to be looked at: Workers AI didn’t answer/);
    assert.equal(l.error, undefined, 'JobTread was fine all along');
  } finally { sees = was; }
  // Workers AI back: the look comes once the rest is over (Ru's first: Zuri's one waits a quarter hour past it), and
  // the rest's doubling ends
  const back = await run(T + 242 * MIN, { reveals });
  assert.deepEqual([back.did.slug, back.did.work, back.did.looked], ['ru', 'look', 12]);
  let l = await ledger();
  assert.deepEqual([l.lookOuts, l.lookError, l.lastDown], [undefined, undefined, undefined]);
  const z = await run(T + 257 * MIN, { reveals });
  assert.deepEqual([z.did.slug, z.did.work, z.did.looked], ['zuri', 'look', 1]);
});

test('the look’s trouble and JobTread’s are kept apart: neither kind of run clears what the other said', async () => {
  await onlyDue();
  await putKid('kim', { name: 'Kim', plans: [], beforePhotos: [{ url: pic('kim', 'k0'), alt: '', room: '' }] });
  SOURCES.kim = { ...SOURCES.max, kid: { slug: 'kim', name: 'Kim' }, job: { id: 'JOB31', name: 'Kim (2026)' }, befores: [] };
  const T = NOW + 320 * 3600e3;
  const reveals = [{ slug: 'kim', name: 'Kim', startsAt: new Date(T + 6 * DAY).toISOString(), confirmed: true, jobId: 'JOB31' }];
  const was = sees;
  sees = () => { throw new Error('3040: Capacity temporarily exceeded'); };
  try {
    assert.equal((await run(T, { reveals })).did.work, 'look');
  } finally { sees = was; }
  // Resting: JobTread refuses Kim's job too
  const r = await run(T + 11 * MIN, { reveals, sources: async () => { throw new Error('JobTread returned 413'); } });
  assert.equal(r.did.error, 'JobTread returned 413');
  let l = await ledger();
  assert.match(l.lookError.message, /Kim’s before photos are waiting to be looked at: Workers AI didn’t answer/, 'a JobTread run doesn’t clear the look’s');
  assert.match(l.error.message, /JobTread couldn’t be read for Kim’s before photos \(JobTread returned 413\)/);
  // Workers AI back: the look clears its own, and leaves JobTread's
  assert.equal((await run(T + 22 * MIN, { reveals })).did.work, 'look');
  l = await ledger();
  assert.equal(l.lookError, undefined);
  assert.match(l.error.message, /JobTread returned 413/, 'a look doesn’t clear JobTread’s');
  // JobTread back: its own cleared
  assert.equal((await run(T + 33 * MIN, { reveals })).did.work, 'befores');
  assert.equal((await ledger()).error, undefined);
});

test('drawings are done by the run’s deadline: a plan set the time runs out on, before its drawing or its uploads, is no real try, looked for again in half an hour, then an hour', async () => {
  await onlyDue();
  await putKid('kit', { name: 'Kit', plans: [], beforePhotos: [{ url: pic('kit', 'k0'), alt: '', room: '', looked: 'staff' }] });
  SOURCES.kit = { ...SOURCES['dylan-2026'], kid: { slug: 'kit', name: 'Kit' }, job: { id: 'JOB32', name: 'Kit (2026)' }, befores: [] };
  const T = NOW + 340 * 3600e3;
  const reveals = [{ slug: 'kit', name: 'Kit', startsAt: new Date(T + 9 * DAY).toISOString(), confirmed: true, jobId: 'JOB32' }];
  await readJob('kit', T);
  const l0 = await ledger();
  delete l0.kids.kit.done;
  await env.DB.prepare('UPDATE site_config SET data = ? WHERE key = ?').bind(JSON.stringify(l0), AUTO_KEY).run();
  // The plan set's download takes the run to 18.5 s: too little left to draw it by 21 s (its time runs on into the
  // notes', to 24 s, less 3 s for the uploads)
  let tick = 0;
  const slowSet = async (input, init) => { const u = typeof input === 'string' ? input : input.url; if (u.endsWith('/set.pdf')) tick = 18_500; return fetchImpl(input, init); };
  const drawnBefore = drawn.length;
  const r = await run(T, { reveals, clock: () => tick, fetchImpl: slowSet });
  assert.equal(r.did.work, 'drawings');
  assert.equal(drawn.length, drawnBefore, 'not drawn');
  assert.deepEqual(r.did.added.plans, ['board'], 'the design board (a picture, no drawing) came in with the time left');
  let l = await ledger();
  assert.deepEqual([l.kids.kit.tried['as-built'], l.kids.kit.tried.proposed, l.kids.kit.drawOuts], [T - 6 * 3600e3 + 30 * MIN, T - 6 * 3600e3 + 30 * MIN, 1]);
  // Drawn, but out of time for the uploads: nothing up, looked for again in an hour now
  tick = 0;
  // (Saved while drawing, as a try that may not finish: looked for again in an hour, not 6, if Cloudflare stops it)
  let whileDrawing = null;
  const lateBrowser = { newPage: async () => { const pg = await fakeBrowser.newPage(); return { ...pg, evaluate: async (...a) => { whileDrawing = (await ledger()).kids.kit.tried['as-built']; const out = await pg.evaluate(...a); tick = 23_500; return out; } }; }, close: async () => {} };
  const uploads = calls.uploads.length;
  const r2 = await run(T + 31 * MIN, { reveals, clock: () => tick, browser: lateBrowser });
  assert.equal(drawn.length, drawnBefore + 1, 'drawn');
  assert.deepEqual([r2.did.added.plans, calls.uploads.length], [[], uploads], 'none uploaded past the deadline');
  assert.equal(whileDrawing, T + 31 * MIN - 6 * 3600e3 + 60 * MIN, 'saved as an unfinished try before it began');
  l = await ledger();
  assert.deepEqual([l.kids.kit.tried['as-built'], l.kids.kit.drawOuts], [T + 31 * MIN - 6 * 3600e3 + 60 * MIN, 2]);
  // With the time: both in, and the doubling ends
  tick = 0;
  const r3 = await run(T + 92 * MIN, { reveals, clock: () => tick });
  assert.deepEqual(r3.did.added.plans.sort(), ['as-built', 'proposed']);
  assert.equal((await ledger()).kids.kit.drawOuts, undefined);
});

test('the notes and the publish after a run’s work get only the time left: none started without it (each comes next run, once), and a note is saved as told before it’s posted', async () => {
  await onlyDue();
  await putKid('lux', { name: 'Lux', plans: [], beforePhotos: [{ url: pic('lux', 'l0'), alt: '', room: '', looked: 'staff' }] });
  SOURCES.lux = { ...SOURCES.max, kid: { slug: 'lux', name: 'Lux' }, job: { id: 'JOB33', name: 'Lux (2026)' }, befores: [] };
  const T = NOW + 360 * 3600e3;
  const reveals = [{ slug: 'lux', name: 'Lux', startsAt: new Date(T + 2 * DAY).toISOString(), confirmed: true, jobId: 'JOB33' }];
  // JobTread's read takes the run to 25 s: 1.5 s left of the 28 the notes and the publish have
  let tick = 0;
  const slack = calls.slack.length;
  const r = await run(T, { reveals, clock: () => tick, sources: async (slug) => { tick = 25_000; return SOURCES[slug]; } });
  assert.equal(r.did.work, 'befores');
  let l = await ledger();
  assert.deepEqual([l.kids.lux.told, l.kids.lux.page, calls.slack.length], [undefined, undefined, slack], 'no note, no publish, nothing marked');
  // The next run, with time: the 3-day note, saved as told before it's posted, and the page
  tick = 0;
  const seen = [];
  onSlack = async (body) => { if (/Lux/.test(JSON.stringify(body))) seen.push((await ledger()).kids.lux.told?.d3); };
  try {
    await run(T + 11 * MIN, { reveals, clock: () => tick });
  } finally { onSlack = null; }
  assert.deepEqual(seen, [reveals[0].startsAt], 'posted once, already saved as told');
  l = await ledger();
  assert.match(l.kids.lux.page, /\|1\|0$/, 'published');
  await run(T + 22 * MIN, { reveals, clock: () => tick });
  assert.equal(calls.slack.filter((b) => /Lux/.test(JSON.stringify(b))).length, 1, 'said once');
});

test('a JobTread read that hangs is cut off at the run’s time, and the kid is saved as resting before the read, so a run Cloudflare stops mid-read never picks the same kid every run after', async () => {
  await onlyDue();
  await putKid('al', { name: 'Al', plans: [], beforePhotos: [] });
  await putKid('bo', { name: 'Bo', plans: [], beforePhotos: [] });
  SOURCES.al = { ...SOURCES.max, kid: { slug: 'al', name: 'Al' }, job: { id: 'JOB40', name: 'Al (2026)' }, befores: [photo('Q0')] };
  SOURCES.bo = { ...SOURCES.max, kid: { slug: 'bo', name: 'Bo' }, job: { id: 'JOB41', name: 'Bo (2026)' }, befores: [photo('Q1')] };
  const T = NOW + 380 * 3600e3;
  const reveals = [{ slug: 'al', name: 'Al', startsAt: new Date(T + 2 * DAY).toISOString(), confirmed: true, jobId: 'JOB40' }, { slug: 'bo', name: 'Bo', startsAt: new Date(T + 3 * DAY).toISOString(), confirmed: true, jobId: 'JOB41' }];
  // Al's job never answers; by the time it's asked, 50 ms of the run's 20 s are left
  // (The run's start and the check that there's time to read: then 50 ms of the run's 20 s are left)
  const late = () => { let k = 0; return () => (k++ < 2 ? 0 : 19_950); };
  let during = null;
  const sources = async (slug) => { if (slug !== 'al') return SOURCES[slug]; during ??= (await ledger()).kids.al?.befores; return new Promise(() => {}); };
  const r = await run(T, { reveals, clock: late(), sources });
  assert.deepEqual([r.did.slug, r.did.error], ['al', 'reading JobTread took too long']);
  assert.deepEqual([during.outRuns, during.restUntil], [1, T + 15 * MIN], 'saved as resting before the read even began');
  const l = await ledger();
  assert.deepEqual([l.kids.al.befores.outRuns, l.kids.al.befores.restUntil, l.kids.al.befores.checked], [1, T + 15 * MIN, undefined]);
  assert.match(l.error.message, /JobTread couldn’t be read for Al’s before photos \(reading JobTread took too long\)/);
  // Al's drawings next (they hang too, and rest), then Al's photos again (twice as long now), then Bo's turn
  const work = [];
  for (const [t, clock] of [[T + 11 * MIN, late()], [T + 22 * MIN, late()], [T + 33 * MIN, undefined]]) {
    const x = await run(t, { reveals, sources, ...(clock ? { clock } : {}) });
    work.push(`${x.did?.slug}:${x.did?.work}${x.did?.error ? '!' : ''}`);
  }
  assert.deepEqual(work, ['al:drawings!', 'al:befores!', 'bo:befores']);
  assert.equal((await kid('bo')).beforePhotos.length, 1);
  assert.match((await ledger()).error.message, /Al’s/, 'Al’s job still said while it won’t read');
});

test('a JobTread file whose body stops coming partway is JobTread’s trouble, not the photo’s: it rests, uncounted', async () => {
  await onlyDue();
  await putKid('cy', { name: 'Cy', plans: [], beforePhotos: [] });
  SOURCES.cy = { ...SOURCES.max, kid: { slug: 'cy', name: 'Cy' }, job: { id: 'JOB42', name: 'Cy (2026)' }, befores: [photo('C0')] };
  const T = NOW + 400 * 3600e3;
  const reveals = [{ slug: 'cy', name: 'Cy', startsAt: new Date(T + 5 * DAY).toISOString(), confirmed: true, jobId: 'JOB42' }];
  // The headers come, then the body stops (its time limit, say)
  const cut = async (input, init) => ((typeof input === 'string' ? input : input.url).includes('/C0-big')
    ? new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1, 2])); c.error(new DOMException('The operation was aborted due to timeout', 'TimeoutError')); } }), { headers: { 'content-type': 'image/jpeg' } })
    : fetchImpl(input, init));
  await run(T, { reveals, fetchImpl: cut });
  const b = (await ledger()).kids.cy.befores;
  assert.deepEqual([b.failed.C0.outs, b.failed.C0.n], [1, undefined]);
  assert.match((await ledger()).error.message, /Cy’s before photos are waiting: JobTread’s files stopped sending it/);
});

test('never published with an old copy of the schedule: JobTread down at the publish deploys and marks nothing, and it goes out the run after', async () => {
  await onlyDue();
  const hooks = [];
  const was = globalThis.fetch;
  globalThis.fetch = async (input, init) => ((typeof input === 'string' ? input : input.url).startsWith('https://deploy.test/') ? (hooks.push(1), new Response('ok')) : was(input, init));
  try {
    const env2 = { ...env, CF_PAGES_DEPLOY_HOOK: 'https://deploy.test/hook' };
    await putKid('pia', { name: 'Pia', plans: [], beforePhotos: [{ url: pic('pia', 'p0'), alt: '', room: '', looked: 'staff' }] });
    const T = NOW + 410 * 3600e3;
    await readJob('pia', T);
    const reveals = [{ slug: 'pia', name: 'Pia', startsAt: new Date(T + 5 * DAY).toISOString(), confirmed: true, jobId: 'JOB43' }];
    let down = true;
    const jt = async (input, init) => ((typeof input === 'string' ? input : input.url).startsWith('https://api.jobtread.com/') && down ? new Response('busy', { status: 503 }) : fetchImpl(input, init));
    const go = (t) => runRevealDesigns(env2, { fetchImpl: jt, now: t, clock: () => 0, reveals, sources: async (slug) => SOURCES[slug], browser: fakeBrowser, keepBrowser: true, readAsset: async () => '' });
    await go(T);
    assert.deepEqual([hooks.length, (await ledger()).kids.pia.page], [0, undefined], 'not with the old copy');
    down = false;
    await go(T + 11 * MIN);
    assert.equal(hooks.length, 1);
    assert.match((await ledger()).kids.pia.page, /\|1\|0$/);
  } finally { globalThis.fetch = was; }
});

test('Workers AI failing on some photos: looks and JobTread’s work take turns, and the ones it failed on count against nothing', async () => {
  await onlyDue();
  await putKid('pat', { name: 'Pat', plans: [], beforePhotos: Array.from({ length: 6 }, (_, i) => ({ url: pic('pat', `pt${i}`), alt: '', room: '' })) }, 'completed');
  await putKid('quin', { name: 'Quin', plans: [], beforePhotos: [] });
  SOURCES.quin = { ...SOURCES.max, kid: { slug: 'quin', name: 'Quin' }, job: { id: 'JOB44', name: 'Quin (2026)' }, befores: [photo('U0')] };
  const T = NOW + 420 * 3600e3;
  const reveals = [{ slug: 'quin', name: 'Quin', startsAt: new Date(T + 2 * DAY).toISOString(), confirmed: true, jobId: 'JOB44' }];
  const was = sees;
  // Two of every three of Pat's: Workers AI errors (two photos at once: the service's)
  sees = (picture) => { if (/pat\/pt[1245]\//.test(picture)) throw new Error('InferenceUpstreamError 503'); return NO; };
  try {
    const first = await run(T, { reveals });
    assert.deepEqual([first.did.slug, first.did.work, first.did.looked], ['pat', 'look', 1], 'the first three side by side: one looked at, two Workers AI failed on');
    let l = await ledger();
    assert.equal(l.yieldLook, true, 'the next run is the rest’s');
    assert.ok(Object.values(l.kids.pat.befores.looks).every((x) => !x.outs && !x.n), JSON.stringify(l.kids.pat.befores.looks));
    const second = await run(T + 11 * MIN, { reveals });
    assert.deepEqual([second.did.slug, second.did.work], ['quin', 'befores'], 'JobTread’s turn');
    l = await ledger();
    assert.equal(l.yieldLook, undefined);
    assert.equal((await run(T + 22 * MIN, { reveals })).did.work, 'look', 'then a look again');
  } finally { sees = was; }
});

test('the looks go to reveals still ahead before a reveal that has passed', async () => {
  await onlyDue();
  await putKid('ola', { name: 'Ola', plans: [], beforePhotos: [{ url: pic('ola', 'o0'), alt: '', room: '' }] }, 'completed');
  await putKid('ned', { name: 'Ned', plans: [], beforePhotos: [{ url: pic('ned', 'n0'), alt: '', room: '' }] });
  const T = NOW + 430 * 3600e3;
  const l0 = await ledger();
  l0.kids.ola = { reveal: { startsAt: new Date(T - DAY).toISOString() } };
  l0.kids.ned = { reveal: { startsAt: new Date(T + 3 * DAY).toISOString() } };
  await env.DB.prepare('UPDATE site_config SET data = ? WHERE key = ?').bind(JSON.stringify(l0), AUTO_KEY).run();
  const r = await run(T, { reveals: [] });
  assert.deepEqual([r.did.slug, r.did.work], ['ned', 'look']);
});

test('the look’s trouble stops being said once nothing anywhere waits on a look (staff decided them, say), not while one only rests', async () => {
  await onlyDue();
  const T = NOW + 440 * 3600e3;
  const l0 = await ledger();
  l0.lookError = { message: 'Kim’s before photos are waiting to be looked at: Workers AI didn’t answer.', at: new Date(T - DAY).toISOString() };
  // One still waiting, resting after a picture that wouldn't load
  await putKid('rho', { name: 'Rho', plans: [], beforePhotos: [{ url: pic('rho', 'r0'), alt: '', room: '' }] });
  l0.kids.rho = { befores: { looks: { [pic('rho', 'r0')]: { outs: 1, wait: T + 10 * MIN } } } };
  await env.DB.prepare('UPDATE site_config SET data = ? WHERE key = ?').bind(JSON.stringify(l0), AUTO_KEY).run();
  await run(T, { reveals: [] });
  assert.ok((await ledger()).lookError, 'still said while one waits');
  // Staff switch it on themselves
  await onlyDue();
  await run(T + 11 * MIN, { reveals: [] });
  assert.equal((await ledger()).lookError, undefined);
});

test('one photo Workers AI turns away is that photo’s once Workers AI is answering others (counted, with its words); while it answers none, nothing is counted: it may be the site’s setup', async () => {
  await onlyDue();
  await putKid('ari', { name: 'Ari', plans: [], beforePhotos: [{ url: pic('ari', 'a0-odd'), alt: '', room: '' }] });
  await putKid('ben', { name: 'Ben', plans: [], beforePhotos: ['b0', 'b1', 'b2'].map((n) => ({ url: pic('ben', n), alt: '', room: '' })) });
  const T = NOW + 450 * 3600e3;
  const l0 = await ledger();
  l0.kids.ari = { reveal: { startsAt: new Date(T + 2 * DAY).toISOString() } };
  l0.kids.ben = { reveal: { startsAt: new Date(T + 3 * DAY).toISOString() } };
  delete l0.lastDown;
  // (Workers AI answered a photo five minutes ago: not enough to blame this one, the setup may have just broken)
  l0.lastAnswered = T - 5 * MIN;
  await env.DB.prepare('UPDATE site_config SET data = ? WHERE key = ?').bind(JSON.stringify(l0), AUTO_KEY).run();
  const odd = pic('ari', 'a0-odd');
  const was = sees;
  // The site's setup broken: Workers AI turns every picture away (the check on a photo already looked at, too)
  sees = () => { throw new Error('5007: No such model'); };
  try {
    const first = await run(T, { reveals: [] });
    assert.deepEqual([first.did.slug, first.did.work, first.did.failed], ['ari', 'look', 0]);
    let l = await ledger();
    assert.ok(!l.kids.ari.befores.looks[odd].n, 'nothing counted while Workers AI answers no photo (one answered just before doesn’t count)');
    assert.match(l.lookError.message, /Workers AI turned it away: 5007: No such model/, 'Site → Automations says what Workers AI said');
    // Fixed, but for Ari's one picture: Ben's next (Ari's waits out the rest and a quarter hour), answered
    sees = (picture) => { if (/a0-odd/.test(picture)) throw new Error('3010: Invalid or incomplete input for the model'); return NO; };
    assert.equal((await run(T + 11 * MIN, { reveals: [] })).did, null, 'the look rests');
    const second = await run(T + 22 * MIN, { reveals: [] });
    assert.deepEqual([second.did.slug, second.did.looked], ['ben', 3]);
    // Ari's again, turned away again: Workers AI answers others, so it's that picture's, counted with its words
    const third = await run(T + 33 * MIN, { reveals: [] });
    assert.deepEqual([third.did.slug, third.did.failed], ['ari', 1]);
    l = await ledger();
    assert.equal(l.kids.ari.befores.looks[odd].n, 1);
    assert.match(l.lookError.message, /3010: Invalid or incomplete input/);
    // Workers AI too slow or busy on that one alone, again and again, with nothing else in trouble: still only its own
    sees = (picture) => { if (/a0-odd/.test(picture)) throw new Error('3040: Capacity temporarily exceeded'); return NO; };
    l.kids.ari.befores.looks[odd] = {};
    delete l.lastDown;
    await env.DB.prepare('UPDATE site_config SET data = ? WHERE key = ?').bind(JSON.stringify(l), AUTO_KEY).run();
    await run(T + 44 * MIN, { reveals: [] });
    l = await ledger();
    assert.deepEqual([l.kids.ari.befores.looks[odd].outs, l.lookRest > T + 44 * MIN], [1, false], 'one picture alone: it rests, and counts in the end; nothing else waits');
  } finally { sees = was; }
});

test('two pictures Workers AI always fails on together look like an outage, but once it answers other photos since, they count, and are given up in the end', async () => {
  await onlyDue();
  await putKid('gil', { name: 'Gil', plans: [], beforePhotos: ['g0-bad', 'g1-bad'].map((n) => ({ url: pic('gil', n), alt: '', room: '' })) });
  await putKid('hoa', { name: 'Hoa', plans: [], beforePhotos: [] });
  const T = NOW + 455 * 3600e3;
  const l0 = await ledger();
  l0.kids.gil = { reveal: { startsAt: new Date(T + 2 * DAY).toISOString() } };
  delete l0.lastDown;
  delete l0.lookRest;
  delete l0.lookOuts;
  await env.DB.prepare('UPDATE site_config SET data = ? WHERE key = ?').bind(JSON.stringify(l0), AUTO_KEY).run();
  const was = sees;
  sees = (picture) => { if (/-bad\//.test(picture)) throw new Error('3043: Internal server error'); return NO; };
  try {
    let n = 0;
    // Runs every 11 minutes; a new photo on Hoa's profile now and then, which Workers AI answers
    for (let t = T, k = 0; t < T + 3 * DAY && !(await ledger()).kids.gil.befores?.looks?.[pic('gil', 'g0-bad')]?.n; t += 11 * MIN, k++) {
      if (k % 6 === 0) { const h = await kid('hoa'); h.beforePhotos = [...(h.beforePhotos || []), { url: pic('hoa', `h${k}`), alt: '', room: '' }]; await env.DB.prepare('UPDATE kids SET data = ? WHERE slug = ?').bind(JSON.stringify(h), 'hoa').run(); }
      await run(t, { reveals: [] });
      n++;
    }
    const looks = (await ledger()).kids.gil.befores.looks;
    assert.ok(looks[pic('gil', 'g0-bad')]?.n >= 1 && looks[pic('gil', 'g1-bad')]?.n >= 1, `counted at last, after ${n} runs: ${JSON.stringify(looks)}`);
    assert.ok(n < 60, `within hours, not days (${n} runs)`);
  } finally { sees = was; }
});

test('a run that skips the look to take its turn uses it up even when JobTread then can’t be read', async () => {
  await onlyDue();
  await putKid('cal2', { name: 'Cal', plans: [], beforePhotos: [{ url: pic('cal2', 'c0'), alt: '', room: '' }] });
  const T = NOW + 460 * 3600e3;
  const l0 = await ledger();
  l0.yieldLook = true;
  await env.DB.prepare('UPDATE site_config SET data = ? WHERE key = ?').bind(JSON.stringify(l0), AUTO_KEY).run();
  const down = async (input, init) => ((typeof input === 'string' ? input : input.url).startsWith('https://api.jobtread.com/') ? new Response('bad gateway', { status: 502 }) : fetchImpl(input, init));
  const r = await runRevealDesigns(env, { fetchImpl: down, now: T, clock: () => 0, sources: async (slug) => SOURCES[slug], browser: fakeBrowser, keepBrowser: true, readAsset: async () => '' });
  assert.ok(r.error, 'JobTread’s reveals couldn’t be read');
  let l = await ledger();
  assert.equal(l.yieldLook, undefined, 'its turn without a look is used up');
  const next = await runRevealDesigns(env, { fetchImpl: down, now: T + 11 * MIN, clock: () => 0, sources: async (slug) => SOURCES[slug], browser: fakeBrowser, keepBrowser: true, readAsset: async () => '' });
  assert.deepEqual([next.did?.slug, next.did?.work], ['cal2', 'look'], 'so the next run looks, JobTread or not');
});

test('a drawings read that failed stops being said once the drawings are on the profile (added by hand), and a revealed room’s once it’s revealed', async () => {
  await onlyDue();
  await putKid('dot', { name: 'Dot', plans: [], beforePhotos: [{ url: pic('dot', 'd0'), alt: '', room: '', looked: 'staff' }] });
  SOURCES.dot = { ...SOURCES['dylan-2026'], kid: { slug: 'dot', name: 'Dot' }, job: { id: 'JOB45', name: 'Dot (2026)' }, befores: [] };
  const T = NOW + 470 * 3600e3;
  const reveals = [{ slug: 'dot', name: 'Dot', startsAt: new Date(T + 9 * DAY).toISOString(), confirmed: true, jobId: 'JOB45' }];
  await readJob('dot', T);
  const l0 = await ledger();
  delete l0.kids.dot.done;
  await env.DB.prepare('UPDATE site_config SET data = ? WHERE key = ?').bind(JSON.stringify(l0), AUTO_KEY).run();
  const r = await run(T, { reveals, sources: async () => { throw new Error('JobTread returned 500'); } });
  assert.deepEqual([r.did.work, r.did.error], ['drawings', 'JobTread returned 500']);
  assert.match((await ledger()).error.message, /Dot’s design/);
  // Staff add the plans themselves
  const k = await kid('dot');
  k.plans = [{ url: pic('dot', 'asbuilt'), type: 'as-built', label: 'Existing', addressCheck: 'checked' }, { url: pic('dot', 'proposed'), type: 'proposed', label: 'Proposed', addressCheck: 'checked' }, { url: pic('dot', 'board'), type: 'board', label: 'Board' }];
  await env.DB.prepare('UPDATE kids SET data = ? WHERE slug = ?').bind(JSON.stringify(k), 'dot').run();
  await run(T + 11 * MIN, { reveals });
  const l = await ledger();
  assert.deepEqual([l.error, l.kids.dot.readProblems], [undefined, undefined]);
});

test('a "design is in" note there was no time left for is said the run after, once', async () => {
  await onlyDue();
  await putKid('eve', { name: 'Eve', plans: [], beforePhotos: [{ url: pic('eve', 'e0'), alt: '', room: '', looked: 'staff' }] });
  SOURCES.eve = { ...SOURCES['dylan-2026'], kid: { slug: 'eve', name: 'Eve' }, job: { id: 'JOB46', name: 'Eve (2026)' }, befores: [] };
  const T = NOW + 480 * 3600e3;
  const reveals = [{ slug: 'eve', name: 'Eve', startsAt: new Date(T + 9 * DAY).toISOString(), confirmed: true, jobId: 'JOB46' }];
  await readJob('eve', T);
  const l0 = await ledger();
  delete l0.kids.eve.done;
  await env.DB.prepare('UPDATE site_config SET data = ? WHERE key = ?').bind(JSON.stringify(l0), AUTO_KEY).run();
  // The first drawing's upload ends at 24.2 s: drawn and saved, with no time left for the note (2.3 s of the 26.5)
  let tick = 0;
  const slowUpload = async (input, init) => { if ((typeof input === 'string' ? input : input.url).includes('/images/v1')) tick = 24_200; return fetchImpl(input, init); };
  const slack = calls.slack.length;
  const r = await run(T, { reveals, clock: () => tick, fetchImpl: slowUpload });
  assert.ok(r.did.added.plans.length >= 1, JSON.stringify(r.did));
  assert.equal(calls.slack.filter((b) => /Eve’s design is in/.test(JSON.stringify(b))).length, 0, 'no time for it then');
  assert.deepEqual((await ledger()).kids.eve.filledNote, r.did.added.plans);
  tick = 0;
  await run(T + 11 * MIN, { reveals, clock: () => tick });
  await run(T + 22 * MIN, { reveals, clock: () => tick });
  assert.equal(calls.slack.slice(slack).filter((b) => /Eve’s design is in/.test(JSON.stringify(b))).length, 1, 'said the run after, once');
  assert.equal((await ledger()).kids.eve.filledNote, undefined);
});

test('a lone photo Workers AI turns away, with no other photo to go by: Workers AI is asked about one already looked at, and if it answers, the photo’s refusal counts', async () => {
  await onlyDue();
  await putKid('jo', { name: 'Jo', plans: [], beforePhotos: [{ url: pic('jo', 'j0-ok'), alt: '', room: '', looked: 'site' }, { url: pic('jo', 'j1-odd'), alt: '', room: '' }] });
  const T = NOW + 490 * 3600e3;
  const l0 = await ledger();
  delete l0.lastDown;
  delete l0.lastAnswered;
  delete l0.lookRest;
  await env.DB.prepare('UPDATE site_config SET data = ? WHERE key = ?').bind(JSON.stringify(l0), AUTO_KEY).run();
  const was = sees;
  const asked = [];
  sees = (picture) => { asked.push(picture); if (/j1-odd/.test(picture)) throw new Error('3010: Invalid or incomplete input for the model'); return NO; };
  try {
    const r = await run(T, { reveals: [] });
    assert.deepEqual([r.did.slug, r.did.failed], ['jo', 1]);
    const l = await ledger();
    assert.equal(l.kids.jo.befores.looks[pic('jo', 'j1-odd')].n, 1, 'counted: Workers AI answered the check');
    assert.equal(l.lastAnswered, T);
    assert.ok(asked.some((x) => /-ok\//.test(x) || /j0-ok|\/(?!jo\/j1)/.test(x)), 'a photo already looked at was the check');
    assert.equal((await kid('jo')).beforePhotos[0].looked, 'site', 'the check changes nothing on it');
  } finally { sees = was; }
});

test('JobTread’s reveals read a few minutes ago aren’t read again (the run’s time goes on the photos), unless a confirm woke the run', async () => {
  await onlyDue();
  const T = NOW + 500 * 3600e3;
  let reads = 0;
  const jt = async (input, init) => { if ((typeof input === 'string' ? input : input.url).startsWith('https://api.jobtread.com/')) reads++; return fetchImpl(input, init); };
  const go = (t, extra = {}) => runRevealDesigns(env, { fetchImpl: jt, now: t, clock: () => 0, sources: async (slug) => SOURCES[slug], browser: fakeBrowser, keepBrowser: true, readAsset: async () => '', force: true, ...extra });
  await go(T);
  const first = reads;
  assert.ok(first >= 1);
  await go(T + MIN);
  assert.equal(reads, first, 'a minute on: not read again');
  await go(T + 2 * MIN, { wake: true });
  assert.ok(reads > first, 'a confirm’s wake reads them fresh');
  const after = reads;
  await go(T + 8 * MIN);
  assert.ok(reads > after, 'and past five minutes, read again');
  // A confirm's wake that can't start (a run is still going) still makes what was read before it old
  const before = reads;
  await env.DB.prepare("UPDATE site_config SET data = ?, updated_at = ? WHERE key = 'reveal-design-auto-next'").bind(String(T + 30 * MIN), new Date(T + 9 * MIN).toISOString()).run();
  const woke = await runRevealDesigns(env, { fetchImpl: jt, now: T + 9 * MIN + 10e3, clock: () => 0, wake: true, sources: async (slug) => SOURCES[slug], browser: fakeBrowser, keepBrowser: true, readAsset: async () => '' });
  assert.equal(woke.skipped, 'not yet', 'a run is still going');
  await go(T + 10 * MIN);
  assert.ok(reads > before, 'the next run reads them fresh');
});
