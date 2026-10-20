/**
 * People (Team & Board): the record rules (public/admin/team-shared.js,
 * functions/api/_team.js), one-request reordering (functions/api/reorder-content.js)
 * and changing a web address (functions/api/rename-content.js).
 * Run: node --test tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { reorder } from '../functions/api/reorder-content.js';
import { rename, imageIdOf } from '../functions/api/rename-content.js';
import { personStatus, onActiveBoard, personName } from '../functions/api/_team.js';
import {
  normalizePerson, comparePeople, isListed, photoTransform, photoLqip, photoPixels, photoQuality,
  normalizeLinkedIn, seatTitle, validCrop, SEATS, servedYears, boardTitleLine,
  DEFAULT_COMMITTEES, committeeList, committeeMembers, sortCommittees, cleanCommittee, sameCommittee,
} from '../public/admin/team-shared.js';

const HASH = 'ROYFuPmfN2vPS6mt5sCkZQ';
const img = (id) => `https://imagedelivery.net/${HASH}/${id}/public`;

async function db(people) {
  const DB = await createD1({ schemaFiles: ['scripts/schema.sql'] });
  for (const p of people) {
    await DB.prepare('INSERT INTO team (slug, name, "group", order_num, data) VALUES (?, ?, ?, ?, ?)')
      .bind(p.slug, p.name, p.group, p.order ?? 0, JSON.stringify(p)).run();
  }
  return DB;
}
const rowOf = async (DB, slug) => {
  const r = await DB.prepare('SELECT * FROM team WHERE slug = ?').bind(slug).first();
  return r ? { ...r, data: JSON.parse(r.data) } : null;
};
const audits = async (DB) => (await DB.prepare('SELECT action, entity_slug, changes FROM audit_log ORDER BY id').all()).results;

// ── Record rules ──

test('older records: "In memoriam" in the name, "Co-Founder" and seats in the title', () => {
  const brent = normalizePerson({ name: 'In memoriam, Brent Aronson', title: 'Board Member 2024-2025', group: 'board' });
  assert.equal(brent.name, 'Brent Aronson');
  assert.equal(brent.status, 'memorial');
  assert.equal(brent.seat, '');
  assert.equal(normalizePerson({ name: 'Holly', title: 'Co-Founder/President', group: 'team' }).role, 'founder');
  assert.equal(normalizePerson({ name: 'Tom', title: 'Warehouse Manager', group: 'team' }).role, 'staff');
  assert.equal(normalizePerson({ name: 'Scott', title: 'Board Chair', group: 'board' }).seat, 'chair');
  assert.equal(normalizePerson({ name: 'V', title: 'Vice Chair', group: 'board' }).seat, 'vice-chair');
  assert.equal(normalizePerson({ name: 'T', title: 'Treasurer', group: 'board' }).seat, 'treasurer');
});

test('explicit fields win over the text, and a member seat stays a member', () => {
  assert.equal(normalizePerson({ name: 'Holly', title: 'Founder & President', group: 'team', role: 'founder' }).role, 'founder',
    'renaming the title no longer drops a founder from the founders row');
  assert.equal(normalizePerson({ name: 'Ex', title: 'Co-Founder', group: 'team', role: 'staff' }).role, 'staff');
  assert.equal(normalizePerson({ name: 'S', title: 'Board Chair', group: 'board', seat: '' }).seat, '');
  assert.equal(normalizePerson({ name: 'In memoriam, B', title: 'x', group: 'board', status: 'active' }).status, 'active');
  assert.equal(normalizePerson({ name: 'A', title: 'x', group: 'team', role: 'bogus' }).role, 'staff');
});

test('older records: years kept in the title become since/until, and the card shows them for a memorial', () => {
  const brent = normalizePerson({ name: 'In memoriam, Brent Aronson', title: 'Board Member 2024-2025', group: 'board' });
  assert.deepEqual([brent.name, brent.title, brent.since, brent.until, brent.status], ['Brent Aronson', 'Board Member', 2024, 2025, 'memorial']);
  assert.equal(boardTitleLine(brent), 'Board Member, 2024–2025');
  const a = normalizePerson({ name: 'A', title: 'Board Member (2019–2023)', group: 'board', status: 'alumni' });
  assert.deepEqual([a.title, a.since, a.until, servedYears(a)], ['Board Member', 2019, 2023, '2019–2023']);
  const b = normalizePerson({ name: 'B', title: 'Board Member 2018 to present', group: 'board' });
  assert.deepEqual([b.title, b.since, b.until], ['Board Member', 2018, undefined]);
  assert.equal(boardTitleLine(b), 'Board Member', 'an active member\'s card shows no years');
  // Explicit years win, and a title that is only years, or has a lone year, stays as written
  assert.equal(normalizePerson({ name: 'C', title: 'Board Member 2024-2025', group: 'board', since: 2020 }).title, 'Board Member 2024-2025');
  assert.equal(normalizePerson({ name: 'D', title: 'Class of 2024', group: 'team' }).title, 'Class of 2024');
  assert.equal(normalizePerson({ name: 'E', title: '2019-2020', group: 'board' }).title, '2019-2020');
  assert.equal(boardTitleLine(normalizePerson({ name: 'F', title: 'Board Chair', group: 'board', status: 'memorial', since: 2010, until: 2020 })), 'Board Chair, 2010–2020');
});

test('drafts and alumni stay off the page; memorials stay on', () => {
  assert.equal(isListed(normalizePerson({ name: 'A', title: 'x', group: 'team', publishStatus: 'draft' })), false);
  assert.equal(isListed(normalizePerson({ name: 'A', title: 'x', group: 'team', status: 'alumni' })), false);
  assert.equal(isListed(normalizePerson({ name: 'In memoriam, B', title: 'x', group: 'board' })), true);
});

test('order: founders, staff, honorary crew; officers, members, then memorials', () => {
  const team = [
    { name: 'Greg', title: 'Chief Greeter', group: 'team', role: 'honorary', order: 0 },
    { name: 'Tom', title: 'Warehouse', group: 'team', order: 2 },
    { name: 'Holly', title: 'Co-Founder/President', group: 'team', order: 5 },
    { name: 'Linzi', title: 'Ops', group: 'team', order: 1 },
  ].map(normalizePerson).sort(comparePeople).map((p) => p.name);
  assert.deepEqual(team, ['Holly', 'Linzi', 'Tom', 'Greg']);
  const board = [
    { name: 'In memoriam, Brent', title: 'Board Member', group: 'board', order: 0 },
    { name: 'Mary', title: 'Board Member', group: 'board', order: 1 },
    { name: 'Tess', title: 'x', group: 'board', seat: 'treasurer', order: 9 },
    { name: 'Scott', title: 'Board Chair', group: 'board', order: 5 },
  ].map(normalizePerson).sort(comparePeople).map((p) => p.name);
  assert.deepEqual(board, ['Scott', 'Tess', 'Mary', 'Brent']);
  assert.equal(seatTitle('vice-chair'), 'Board Vice Chair');
  assert.equal(seatTitle(''), 'Board Member');
});

test('Past Chair: a seat after the other officers, ahead of the members', () => {
  assert.deepEqual(SEATS.map((s) => s.id), ['chair', 'vice-chair', 'treasurer', 'secretary', 'past-chair']);
  assert.equal(seatTitle('past-chair'), 'Past Board Chair');
  for (const title of ['Past Board Chair', 'Immediate Past Chair', 'Past President', 'Past Chair 2019-2024']) {
    assert.equal(normalizePerson({ name: 'P', title, group: 'board' }).seat, 'past-chair', title);
  }
  assert.equal(normalizePerson({ name: 'S', title: 'Board Chair', group: 'board' }).seat, 'chair', 'the chair is still the chair');
  assert.equal(normalizePerson({ name: 'P', title: 'Past Board Chair', group: 'board', seat: '' }).seat, '', 'an explicit member seat wins');
  const board = [
    { name: 'Mary', title: 'Board Member', group: 'board', order: 0 },
    { name: 'Pat', title: 'Past Board Chair', group: 'board', seat: 'past-chair', order: 1 },
    { name: 'Traci', title: 'Board Secretary', group: 'board', seat: 'secretary', order: 2 },
    { name: 'In memoriam, Brent', title: 'Past Board Chair', group: 'board', order: 3 },
    { name: 'Scott', title: 'Board Chair', group: 'board', seat: 'chair', order: 4 },
  ].map(normalizePerson).sort(comparePeople).map((p) => p.name);
  assert.deepEqual(board, ['Scott', 'Traci', 'Pat', 'Mary', 'Brent'], 'memorials stay last, whatever their seat');
});

test('committees: one list, A to Z, each name once; assigned names never drop off', () => {
  assert.deepEqual(committeeList(undefined), DEFAULT_COMMITTEES, 'the starter list before the first save');
  assert.deepEqual(committeeList(null), ['Finance', 'Gala', 'Golf Tournament', 'Governance']);
  assert.deepEqual(committeeList([]), [], 'a saved empty list stays empty');
  const people = [
    { name: 'A', group: 'board', committees: ['Marketing', 'finance'] },
    { name: 'B', group: 'board', committees: ['Gala'] },
    { name: 'C', group: 'team', committees: ['Ignored'] },
  ];
  assert.deepEqual(committeeList(['Finance', 'Gala'], people), ['Finance', 'Gala', 'Marketing'],
    'board records add their names; the saved spelling wins; team records are ignored');
  assert.deepEqual(sortCommittees(['  golf  tournament ', 'Audit', 'audit', '', ' , ']), ['Audit', 'golf tournament']);
  assert.equal(cleanCommittee(' Events,  & Outreach ;'), 'Events, & Outreach');
  assert.ok(sameCommittee('Finance', ' finance '));
  assert.deepEqual(committeeMembers('FINANCE', people).map((p) => p.name), ['A']);
});

test('photo URLs: face-centered by default, an exact crop when set, cutouts on the circle color', () => {
  assert.equal(photoTransform({ photo: 'team/a/1' }, 200), 'w=200,h=200,fit=cover,gravity=face,q=85,metadata=none',
    'unchanged from the page before crops existed');
  const cropped = { photo: 'team/a/1', photoSize: [2000, 1000], photoCrop: { x: 0.25, y: 0.1, size: 0.4 } };
  assert.deepEqual(validCrop(cropped), { left: 500, top: 100, side: 800, W: 2000, H: 1000 });
  assert.equal(photoTransform(cropped, 200), 'trim=100;700;100;500,w=200,h=200,fit=cover,q=85,metadata=none');
  assert.equal(photoTransform({ ...cropped, photoCutout: true }, 140),
    'trim=100;700;100;500,w=140,h=140,fit=cover,segment=foreground,background=%23F5F4F0,q=85,metadata=none');
  assert.equal(photoTransform({ ...cropped, photoCrop: { x: 0.9, y: 0, size: 0.4 } }, 200), 'w=200,h=200,fit=cover,gravity=face,q=85,metadata=none',
    'a crop that runs off the photo is ignored');
  assert.match(photoLqip({ photo: 'team/a/1' }), /\/team\/a\/1\/w=30,q=30,blur=20$/);
  assert.equal(photoPixels(cropped), 800);
  assert.equal(photoPixels({}, [535, 535]), 535);
  assert.deepEqual([photoQuality(900), photoQuality(535), photoQuality(300), photoQuality(null)], ['good', 'ok', 'blurry', null]);
});

test('LinkedIn: short forms become the profile URL; other sites are refused', () => {
  assert.equal(normalizeLinkedIn('linkedin.com/in/jane-doe/'), 'https://www.linkedin.com/in/jane-doe');
  assert.equal(normalizeLinkedIn('https://www.linkedin.com/in/jane?trk=x'), 'https://www.linkedin.com/in/jane');
  assert.equal(normalizeLinkedIn(''), '');
  assert.equal(normalizeLinkedIn('https://evil.com/in/jane'), null);
  assert.equal(normalizeLinkedIn('https://linkedin.com/feed'), null);
});

test('server status: alumni and memorials are off the board; the old prefix still counts', () => {
  assert.equal(personStatus({ name: 'In memoriam, B' }), 'memorial');
  assert.equal(personStatus({ name: 'B', status: 'alumni' }), 'alumni');
  assert.equal(personName({ name: 'In memoriam: Brent Aronson' }), 'Brent Aronson');
  assert.equal(onActiveBoard({ name: 'S', group: 'board' }), true);
  assert.equal(onActiveBoard({ name: 'S', group: 'board', publishStatus: 'draft' }), true);
  assert.equal(onActiveBoard({ name: 'S', group: 'board', status: 'alumni' }), false);
  assert.equal(onActiveBoard({ name: 'H', group: 'team' }), false);
});

// ── Reorder ──

test('reorder writes only the people who moved, in one request, and logs each', async () => {
  const DB = await db([
    { slug: 'a', name: 'A', group: 'board', order: 0, title: 'Board Member', bio: 'keep me' },
    { slug: 'b', name: 'B', group: 'board', order: 1, title: 'Board Member' },
    { slug: 'c', name: 'C', group: 'board', order: 2, title: 'Board Member' },
  ]);
  const r = await reorder({ DB }, { collection: 'team', items: [{ slug: 'b', order: 0 }, { slug: 'a', order: 1 }, { slug: 'c', order: 2 }] }, 'p@x.com');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.changed, ['b', 'a']);
  assert.equal(Object.keys(r.body.shas).length, 2);
  const a = await rowOf(DB, 'a');
  assert.equal(a.data.order, 1);
  assert.equal(a.order_num, 1, 'the indexed column follows');
  assert.equal(a.data.bio, 'keep me', 'everything but the order is left as saved');
  const log = await audits(DB);
  assert.deepEqual(log.map((l) => [l.action, l.entity_slug]), [['updated', 'b'], ['updated', 'a']]);
  assert.deepEqual(JSON.parse(log[0].changes), [{ field: 'order', from: 1, to: 0 }]);
});

test('reorder refuses bad input, unknown lists and people deleted meanwhile', async () => {
  const DB = await db([{ slug: 'a', name: 'A', group: 'team', order: 0, title: 'x' }]);
  assert.equal((await reorder({ DB }, { collection: 'press', items: [{ slug: 'a', order: 0 }] })).status, 403);
  assert.equal((await reorder({ DB }, { collection: 'team', items: [] })).status, 400);
  assert.equal((await reorder({ DB }, { collection: 'team', items: [{ slug: 'a', order: 1.5 }] })).status, 400);
  assert.equal((await reorder({ DB }, { collection: 'team', items: [{ slug: 'a', order: 0 }, { slug: 'a', order: 1 }] })).status, 400);
  const gone = await reorder({ DB }, { collection: 'team', items: [{ slug: 'a', order: 0 }, { slug: 'zed', order: 1 }] });
  assert.equal(gone.status, 409);
  assert.match(gone.body.error, /zed/);
});

// ── Rename ──

function fakeImages({ failUpload = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET' });
    if (String(url).endsWith('/blob')) return new Response(new Blob(['jpegbytes']), { status: 200 });
    if (init.method === 'POST') {
      if (failUpload) return Response.json({ success: false, errors: [{ message: 'quota' }] }, { status: 400 });
      const id = init.body.get('id');
      return Response.json({ success: true, result: { id, variants: [`https://imagedelivery.net/${HASH}/${id}/public`] } });
    }
    if (init.method === 'DELETE') return Response.json({ success: true });
    return new Response('nope', { status: 404 });
  };
  return { calls, fetchImpl };
}
const ENV = { CF_ACCOUNT_ID: 'acct', CF_IMAGES_TOKEN: 'tok' };

test('rename moves the record, the reveal email and the photo, and deletes the old photo', async () => {
  const DB = await db([{ slug: 'linzi-berkowitz', name: 'Linzi Lawsky', group: 'team', order: 2, title: 'Ops', photo: img('team/linzi-berkowitz/1788203476659'), photoSize: [2000, 2800] }]);
  await DB.prepare('CREATE TABLE IF NOT EXISTS reveal_board_emails (slug TEXT PRIMARY KEY, email TEXT, updated_at TEXT)').run();
  await DB.prepare('INSERT INTO reveal_board_emails (slug, email) VALUES (?, ?)').bind('linzi-berkowitz', 'l@x.com').run();
  const { calls, fetchImpl } = fakeImages();
  const r = await rename({ DB, ...ENV }, { collection: 'team', from: 'linzi-berkowitz', to: 'linzi-lawsky' }, 'p@x.com', fetchImpl);
  assert.equal(r.status, 200);
  assert.equal(r.body.photoMoved, true);
  assert.match(r.body.photo, /\/team\/linzi-lawsky\/\d+\/public$/);
  assert.equal(await rowOf(DB, 'linzi-berkowitz'), null);
  const moved = await rowOf(DB, 'linzi-lawsky');
  assert.equal(moved.data.slug, 'linzi-lawsky');
  assert.equal(moved.data.photo, r.body.photo);
  assert.deepEqual(moved.data.photoSize, [2000, 2800], 'the crop still fits: same picture');
  assert.equal(moved.order_num, 2);
  assert.equal((await DB.prepare('SELECT email FROM reveal_board_emails WHERE slug = ?').bind('linzi-lawsky').first())?.email, 'l@x.com');
  assert.ok(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/team/linzi-berkowitz/1788203476659')), 'old photo deleted');
  const log = await audits(DB);
  assert.equal(log.length, 1);
  assert.equal(log[0].entity_slug, 'linzi-lawsky');
  assert.deepEqual(JSON.parse(log[0].changes)[0], { field: 'slug', from: 'linzi-berkowitz', to: 'linzi-lawsky' });
});

test('rename keeps going when the photo can’t move, and says so', async () => {
  const DB = await db([{ slug: 'old-name', name: 'New Name', group: 'team', title: 'x', photo: img('team/old-name/1') }]);
  const { fetchImpl } = fakeImages({ failUpload: true });
  const r = await rename({ DB, ...ENV }, { collection: 'team', from: 'old-name', to: 'new-name' }, 'p', fetchImpl);
  assert.equal(r.status, 200);
  assert.equal(r.body.photoMoved, false);
  assert.match(r.body.note, /quota/);
  assert.equal((await rowOf(DB, 'new-name')).data.photo, img('team/old-name/1'));
});

test('rename refuses taken addresses, bad slugs and unknown lists; leaves other photos alone', async () => {
  const DB = await db([
    { slug: 'a-one', name: 'A', group: 'team', title: 'x', photo: img('team/shared-photo/1') },
    { slug: 'b-two', name: 'B', group: 'team', title: 'x' },
  ]);
  const { calls, fetchImpl } = fakeImages();
  assert.equal((await rename({ DB, ...ENV }, { collection: 'team', from: 'a-one', to: 'b-two' }, 'p', fetchImpl)).status, 409);
  assert.equal((await rename({ DB, ...ENV }, { collection: 'team', from: 'a-one', to: 'Bad Slug' }, 'p', fetchImpl)).status, 400);
  assert.equal((await rename({ DB, ...ENV }, { collection: 'kids', from: 'a-one', to: 'x' }, 'p', fetchImpl)).status, 403);
  assert.equal((await rename({ DB, ...ENV }, { collection: 'team', from: 'nobody', to: 'x-y' }, 'p', fetchImpl)).status, 404);
  const r = await rename({ DB, ...ENV }, { collection: 'team', from: 'a-one', to: 'a-uno' }, 'p', fetchImpl);
  assert.equal(r.status, 200);
  assert.equal(r.body.photoMoved, false, 'a photo filed under another name isn’t touched');
  assert.equal(r.body.note, null);
  assert.equal(calls.length, 0);
});

test('imageIdOf reads stored URLs, proxied URLs and bare IDs', () => {
  assert.equal(imageIdOf(img('team/a/123')), 'team/a/123');
  assert.equal(imageIdOf(`https://x.org/cdn-cgi/imagedelivery/${HASH}/team/a/w=200,h=200`), 'team/a');
  assert.equal(imageIdOf('team/a/9'), 'team/a/9');
  assert.equal(imageIdOf(''), '');
});

// ── Saving after a rename or delete elsewhere ──

test('a stale editor can’t bring back a renamed or deleted person', async () => {
  const { onRequestPost } = await import('../functions/api/save-content.js');
  const DB = await db([{ slug: 'new-name', name: 'Renamed', group: 'team', title: 'x' }]);
  const save = (body) => onRequestPost({
    env: { DB }, data: { userEmail: 'p@x.com' }, waitUntil() {},
    request: new Request('https://x/api/save-content', { method: 'POST', body: JSON.stringify(body) }),
  });
  const stale = await save({ path: 'src/content/team/old-name.json', content: JSON.stringify({ slug: 'old-name', name: 'Old', group: 'team', title: 'x' }), message: 'Update', sha: 'loaded-earlier' });
  assert.equal(stale.status, 409);
  assert.match((await stale.json()).error, /renamed or deleted/);
  assert.equal(await rowOf(DB, 'old-name'), null, 'nothing recreated');
  const fresh = await save({ path: 'src/content/team/brand-new.json', content: JSON.stringify({ slug: 'brand-new', name: 'New', group: 'team', title: 'x' }), message: 'Add' });
  assert.equal(fresh.status, 200, 'adding someone (no sha yet) still works');
});

// ── Profile pages ──

test('a profile page needs a bio and a place on the Leadership page', async () => {
  const { hasProfile, profilePath, bioParagraphs, portraitTransform } = await import('../public/admin/team-shared.js');
  const P = (d) => normalizePerson({ name: 'A B', title: 'x', group: 'board', ...d });
  assert.equal(hasProfile(P({ bio: 'Hello.' })), true);
  assert.equal(hasProfile(P({ bio: '   ' })), false, 'whitespace isn\'t a bio');
  assert.equal(hasProfile(P({ bio: 'Hello.', publishStatus: 'draft' })), false, 'a draft has no page');
  assert.equal(hasProfile(P({ bio: 'Hello.', status: 'alumni' })), false, 'alumni have no page');
  assert.equal(hasProfile(P({ bio: 'Hello.', status: 'memorial' })), true, 'a memorial keeps theirs');
  assert.equal(profilePath('scott-wierson'), '/about/leadership/scott-wierson/');
  assert.deepEqual(bioParagraphs('One\nline.\n\n  Two.  \n\n\n'), ['One line.', 'Two.']);
  assert.equal(portraitTransform({ photo: 'team/a/1' }, 640), 'w=640,h=800,fit=cover,gravity=face,q=82,metadata=none');
  // A square framing grows into 4:5 around the same center, inside the photo
  assert.equal(portraitTransform({ photo: 'team/a/1', photoSize: [1000, 1000], photoCrop: { x: 0.2, y: 0.2, size: 0.4 } }, 400),
    'trim=150;400;350;200,w=400,h=500,fit=cover,q=82,metadata=none');
  assert.equal(portraitTransform({ photo: 'team/a/1', photoSize: [1000, 600], photoCrop: { x: 0, y: 0, size: 0.6 } }, 400),
    'trim=0;460;0;60,w=400,h=500,fit=cover,q=82,metadata=none', 'too tall for the photo: the height fits, the width follows, still centered on the framing');
});
