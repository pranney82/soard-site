/**
 * Monetary sponsors' people and who counts as one (functions/api/_sponsors.js):
 * contacts stay in D1, a JobTread person is matched to a sponsor by company,
 * Same as link, contact email or website domain, and Demo Day's matcher reads
 * the kids' sponsors (the copy ./_room-credits.js keeps). Who the sponsor is,
 * and putting them on the job: tests/room-credits.test.mjs. Run: node --test tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { cleanPeople, readContacts, saveContacts, partnerForEmail, fromSponsor, logosFirst, sponsorMatcher } from '../functions/api/_sponsors.js';
import { onRequestGet, onRequestPost } from '../functions/api/sponsors-admin.js';

const HASH = 'ROYFuPmfN2vPS6mt5sCkZQ';
const img = (id) => `https://imagedelivery.net/${HASH}/${id}/public`;

async function world({ kids = [], partners = [] } = {}) {
  const DB = await createD1({ schemaFiles: ['scripts/schema.sql'] });
  for (const k of kids) await DB.prepare('INSERT INTO kids (slug, name, year, status, data) VALUES (?, ?, ?, ?, ?)').bind(k.slug, k.name, k.year, k.status || 'needs-funding', JSON.stringify(k)).run();
  for (const p of partners) {
    await DB.prepare('INSERT INTO partners (slug, name, level, category, featured, data) VALUES (?, ?, ?, ?, ?, ?)').bind(p.slug, p.name, 'friend', 'funding', 0, JSON.stringify(p)).run();
  }
  return DB;
}
const kidOf = async (DB, slug) => JSON.parse((await DB.prepare('SELECT data FROM kids WHERE slug = ?').bind(slug).first()).data);
const ACME = { slug: 'acme-foundation', name: 'Acme Foundation', website: 'https://acmefdn.org', logo: img('partners/acme/1') };
const BRIGHT = { slug: 'bright-fund', name: 'Bright Fund', logo: img('partners/bright/1') };
const MAX = { slug: 'max', name: 'Max', year: 2026, sponsors: ['acme-foundation'] };
const env = (DB) => ({ DB, JOBTREAD_GRANT_KEY: 'k' });

test('contacts are tidied, deduped by email, and a bad email is refused', () => {
  assert.deepEqual(cleanPeople([{ name: '  Jo   Lee ', email: 'JO@AcmeFdn.org ', phone: '(404) 555-0100' }, { email: 'jo@acmefdn.org' }, { name: '', email: '' }]),
    [{ name: 'Jo Lee', email: 'jo@acmefdn.org', phone: '(404) 555-0100', title: '' }]);
  assert.throws(() => cleanPeople([{ name: 'X', email: 'not an email' }]), /isn’t an email/);
  assert.throws(() => cleanPeople(Array.from({ length: 6 }, (_, i) => ({ email: `p${i}@x.org` }))), /Up to 5/);
});

test('contacts live in D1 only, and an email finds its sponsor', async () => {
  const DB = await world({ partners: [ACME] });
  await saveContacts(DB, 'acme-foundation', [{ name: 'Jo Lee', email: 'jo@acmefdn.org' }], { by: 'staff@soardcharity.com' });
  assert.deepEqual(await readContacts(DB, ['acme-foundation']), { 'acme-foundation': [{ name: 'Jo Lee', email: 'jo@acmefdn.org', phone: '', title: '' }] });
  assert.equal(await partnerForEmail(DB, 'JO@acmefdn.org'), 'acme-foundation');
  assert.equal(await partnerForEmail(DB, 'someone@else.org'), null);
  assert.doesNotMatch((await DB.prepare('SELECT data FROM partners WHERE slug = ?').bind('acme-foundation').first()).data, /jo@/);
  await saveContacts(DB, 'acme-foundation', []);
  assert.deepEqual(await readContacts(DB), {});
});

test('a JobTread person is the sponsor by company, "Same as" link, contact email or website domain', () => {
  const p = (company, email) => ({ company, email });
  assert.ok(fromSponsor(p('ACME Foundation', 'x@gmail.com'), ACME));
  assert.ok(fromSponsor(p('Acme Fdn Inc', 'x@gmail.com'), ACME, { links: { acmefdn: 'acme-foundation' } }));
  assert.ok(fromSponsor(p(null, 'jo@gmail.com'), ACME, { contacts: [{ email: 'jo@gmail.com' }] }));
  assert.ok(fromSponsor(p(null, 'jo@mail.acmefdn.org'), ACME));
  assert.ok(!fromSponsor(p('Other Co', 'x@other.org'), ACME));
});

test('sponsor logos first: by image id or name, in the sponsors\' order', () => {
  const logos = [{ url: img('a'), name: 'A' }, { url: `https://sunshineonaranneyday.com/cdn-cgi/imagedelivery/${HASH}/partners/bright/1/w=400`, name: 'Bright' }];
  assert.deepEqual(logosFirst(logos, [ACME, BRIGHT]).map((l) => l.name), ['Acme Foundation', 'Bright', 'A']);
});

test('the endpoint: views, saves contacts (names only in the audit log) and refuses bad input', async () => {
  const DB = await world({ kids: [MAX], partners: [ACME] });
  const e = { DB };
  const get = (q) => onRequestGet({ env: e, request: new Request(`https://x/api/sponsors-admin?${q}`) }).then((r) => r.json());
  const post = (body) => onRequestPost({ env: e, data: { userEmail: 'staff@soardcharity.com' }, request: new Request('https://x/api/sponsors-admin', { method: 'POST', body: JSON.stringify(body) }) }).then((r) => r.json());
  const v = await get('kid=max');
  assert.deepEqual(v.pledges, {}, 'the kid view is the pledges now; who the sponsor is: /api/room-credits-admin');
  const saved = await post({ contacts: { partner: 'acme-foundation', people: [{ name: 'Jo Lee', email: 'jo@acmefdn.org', phone: '404 555 0100' }] } });
  assert.equal(saved.success, true);
  assert.equal(saved.contacts[0].phone, '404 555 0100');
  const audit = await DB.prepare("SELECT changes FROM audit_log WHERE entity_type = 'partner-contacts'").first();
  assert.doesNotMatch(audit.changes, /jo@|404/);
  assert.deepEqual((await get('partners=acme-foundation')).contacts['acme-foundation'].map((p) => p.name), ['Jo Lee']);
  assert.equal((await post({ contacts: { partner: 'nobody', people: [] } })).success, false);
  assert.equal((await post({ contacts: { partner: '../x', people: [] } })).error, 'Bad partner');
  assert.equal((await post({ sync: { kid: 'max', job: '22PZJHV29WFw' } })).error, 'Nothing to do', 'the old sponsor sync is gone');
  assert.equal((await get('kid=Max')).error, 'Bad kid');
});

test('Demo Day’s matcher: the kids’ sponsors as the website has them; no tables yet is nobody, any other failure stops the run', async () => {
  const DB = await world({ kids: [MAX], partners: [ACME] });
  const isSponsor = await sponsorMatcher(DB);
  assert.equal(isSponsor({ email: 'sam@acmefdn.org', company: null }, 'max'), true);
  assert.equal(isSponsor({ email: 'sam@other.org', company: 'Other' }, 'max'), false);
  assert.equal(isSponsor({ email: 'sam@acmefdn.org' }, 'someone-else'), false);
  const empty = await createD1({});
  assert.equal((await sponsorMatcher(empty))({ email: 'sam@acmefdn.org' }, 'max'), false, 'no Partners table yet: no sponsors');
  const broken = { prepare: (sql) => ({ all: async () => { throw new Error('D1_ERROR: network'); }, first: async () => { throw new Error('D1_ERROR: network'); }, run: async () => ({}), bind() { return this; } }) };
  await assert.rejects(() => sponsorMatcher(broken), /network/, 'a read that fails isn’t "no sponsors"');
});
