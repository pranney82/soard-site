/**
 * Monetary sponsors (functions/api/_sponsors.js, _jt-access.js): the website
 * is the source of truth. Job access comes first (the sponsor's contacts go
 * on the open job, quietly, as Monetary Sponsor until roles follow levels; a
 * sponsor taken off loses it), then JobTread's Monetary Sponsor field mirrors
 * the sponsors with someone on the job. The 10-minute sweep takes in
 * Monetary Sponsor users added in JobTread. Contacts stay in
 * D1. Run: node --test tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import {
  cleanPeople, readContacts, saveContacts, partnerForEmail, fromSponsor, sponsorView, mirrorText, logosFirst, syncKidSponsor, grantForPartner,
  syncSponsors, maybeSyncSponsors,
} from '../functions/api/_sponsors.js';
import { _resetRoleCache } from '../functions/api/_jt-access.js';
import { FIELD_MONETARY_SPONSOR } from '../functions/api/_demo-invites.js';
import { onRequestGet, onRequestPost } from '../functions/api/sponsors-admin.js';

const ROLES = { 'Monetary Sponsor': 'r-sponsor', Vendor: 'r-vendor', 'Makeover Family': 'r-family' };
const HASH = 'ROYFuPmfN2vPS6mt5sCkZQ';
const img = (id) => `https://imagedelivery.net/${HASH}/${id}/public`;

/** A small JobTread: open jobs with a Monetary Sponsor field and who has access, plus SOARD's memberships */
function fakeJT({ jobs, members = [] }) {
  const calls = [];
  let n = 0;
  const people = new Map(members.map((m) => [m.email, { id: m.id || `m${++n}`, email: m.email, name: m.name, role: m.role || null, account: m.account || null, createdAt: '2025-01-01T00:00:00Z', internal: !!m.internal }]));
  const asMembership = (m) => ({ id: m.id, createdAt: m.createdAt, isInternal: m.internal, role: m.role ? { id: ROLES[m.role], name: m.role } : null, account: m.account ? { name: m.account } : null, user: { name: m.name, emailAddress: m.email } });
  const jobOut = (j) => ({
    id: j.id, name: j.name, closedOn: j.closedOn || null,
    customFieldValues: { nodes: j.field ? [{ value: j.field }] : [] },
    aces: { nodes: j.access.map((e) => ({ id: `ace-${j.id}-${e}`, membership: asMembership(people.get(e)) })) },
  });
  const fetchImpl = async (url, init) => {
    const q = JSON.parse(init.body).query;
    calls.push(q);
    const reply = (body) => ({ ok: true, json: async () => body, text: async () => JSON.stringify(body) });
    if (q.job) {
      const j = jobs.find((x) => x.id === q.job.$.id);
      return reply({ job: j ? jobOut(j) : null });
    }
    if (q.organization?.jobs) return reply({ organization: { jobs: { nextPage: null, nodes: jobs.filter((j) => !j.closedOn).map((j) => ({ id: j.id, name: j.name, closedOn: null })) } } });
    if (q.organization?.roles) return reply({ organization: { roles: { nodes: Object.entries(ROLES).map(([name, id]) => ({ id, name })) } } });
    if (q.organization?.memberships) {
      const email = q.organization.memberships.$.where[2];
      const m = people.get(email);
      return reply({ organization: { memberships: { nodes: m ? [asMembership(m)] : [] } } });
    }
    if (q.createAce) {
      const { assignee, targetId, notify } = q.createAce.$;
      assert.equal(notify, false, 'JobTread never emails sponsors');
      let m = assignee.membershipId ? [...people.values()].find((x) => x.id === assignee.membershipId) : null;
      if (!m) {
        m = { id: `m${++n}`, email: assignee.emailAddress, name: assignee.name, role: null, account: null, createdAt: new Date().toISOString(), internal: false };
        people.set(m.email, m);
      }
      jobs.find((x) => x.id === targetId).access.push(m.email);
      return reply({ createAce: { createdAce: { id: `ace${n}`, membership: asMembership(m) } } });
    }
    if (q.deleteAce) {
      for (const j of jobs) j.access = j.access.filter((e) => `ace-${j.id}-${e}` !== q.deleteAce.$.id);
      return reply({});
    }
    if (q.updateMembership) {
      const m = [...people.values()].find((x) => x.id === q.updateMembership.$.id);
      m.role = Object.keys(ROLES).find((k) => ROLES[k] === q.updateMembership.$.roleId);
      return reply({});
    }
    if (q.updateJob) {
      jobs.find((x) => x.id === q.updateJob.$.id).field = q.updateJob.$.customFieldValues[FIELD_MONETARY_SPONSOR];
      return reply({});
    }
    throw new Error(`unexpected query ${JSON.stringify(q).slice(0, 120)}`);
  };
  const kinds = () => calls.map((q) => Object.keys(q).find((k) => k !== '$'));
  return { fetchImpl, calls, people, jobs, kinds };
}

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

test('the field mirrors the sponsors with someone on the job as a partner, then Monetary Sponsor users by Partner or JobTread name; blank with nobody', () => {
  const person = (name, email, role, company = null) => ({ name, email, role, company });
  const job = (people) => ({ id: 'j1', name: 'Max (2026)', closedOn: null, field: '', people, access: people.map((x) => ({ email: x.email, role: x.role })) });
  const all = [ACME, BRIGHT];
  assert.equal(mirrorText(job([]), [ACME], all), '');
  assert.equal(mirrorText(job([person('Sam', 'sam@acmefdn.org', 'Vendor')]), [ACME], all), 'Acme Foundation', 'the sponsor’s person, as a Vendor (or its level)');
  assert.equal(mirrorText(job([person('Sam', 'sam@acmefdn.org', 'Champion')]), [ACME], all), 'Acme Foundation');
  assert.equal(mirrorText(job([person('Pat', 'pat@acmefdn.org', 'Photographer')]), [ACME], all), '', 'a photographer isn’t the sponsor');
  assert.equal(mirrorText(job([person('Vic', 'vic@othervendor.example', 'Vendor', 'Other Vendor')]), [ACME], all), '', 'nor is another company’s vendor');
  assert.equal(mirrorText(job([person('Kim', 'kim@x.org', 'Monetary Sponsor', 'Bright Fund'), person('Jo', 'jo@acmefdn.org', 'Monetary Sponsor')]), [ACME], all), 'Acme Foundation & Bright Fund');
  assert.equal(mirrorText(job([person('Lu', 'lu@zeta.org', 'Monetary Sponsor', 'Zeta Trust')]), [], all), 'Zeta Trust');
  const v = sponsorView({ ...job([person('Jo', 'jo@acmefdn.org', 'Monetary Sponsor', 'Acme Foundation'), person('Sam', 'sam@acmefdn.org', 'Vendor'), person('Pat', 'pat@acmefdn.org', 'Photographer'), person('Kim', 'kim@x.org', 'Monetary Sponsor', 'Bright Fund')]), field: 'Acme Foundation & Bright Fund' },
    [ACME], { 'acme-foundation': [{ name: 'Lee', email: 'lee@acmefdn.org' }] }, {}, all);
  assert.equal(v.job.fieldOk, true);
  assert.deepEqual([v.sponsors[0].onJob.map((x) => x.name), v.sponsors[0].otherRole.map((x) => x.name), v.sponsors[0].missing.map((x) => x.name)], [['Jo', 'Sam'], ['Pat'], ['Lee']]);
  assert.deepEqual(v.others.map((x) => [x.name, x.partner?.slug]), [['Kim', 'bright-fund']]);
});

test('a kid save gives the contact Sponsor access first, then the field mirrors it', async () => {
  _resetRoleCache();
  const DB = await world({ kids: [MAX], partners: [ACME] });
  await saveContacts(DB, 'acme-foundation', [{ name: 'Jo Lee', email: 'jo@acmefdn.org' }, { name: 'No Email' }]);
  const jt = fakeJT({ jobs: [{ id: 'job1', name: 'Max (2026)', field: '', access: [] }] });
  const r = await syncKidSponsor(env(DB), { slug: 'max', jobId: 'job1' }, { by: 'staff@soardcharity.com', fetchImpl: jt.fetchImpl });
  const k = jt.kinds();
  assert.ok(k.indexOf('createAce') < k.indexOf('updateJob'), `access first, then the field (${k.join(', ')})`);
  assert.deepEqual(r.granted.map((g) => [g.email, g.role]), [['jo@acmefdn.org', 'Monetary Sponsor']]);
  assert.equal(jt.people.get('jo@acmefdn.org').role, 'Monetary Sponsor');
  assert.deepEqual(r.wrote, { from: '', to: 'Acme Foundation' });
  assert.equal(jt.jobs[0].field, 'Acme Foundation');
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.sponsors[0].onJob.map((x) => x.email), ['jo@acmefdn.org']);
  assert.ok(!('aceId' in r.sponsors[0].onJob[0]), 'JobTread ids stay on the server');
  assert.equal(r.jobtread.fieldOk, true);
  const before = jt.calls.length;
  const again = await syncKidSponsor(env(DB), { slug: 'max', jobId: 'job1' }, { fetchImpl: jt.fetchImpl });
  assert.equal(again.wrote, null);
  assert.ok(!jt.calls.slice(before).some((q) => q.createAce || q.updateJob || q.updateMembership || q.deleteAce), 'in step: nothing written');
});

test('no access yet: the field stays blank, even if it named the sponsor', async () => {
  _resetRoleCache();
  const DB = await world({ kids: [MAX], partners: [ACME] });
  const jt = fakeJT({ jobs: [{ id: 'job1', name: 'Max (2026)', field: 'Acme Foundation', access: [] }] });
  const r = await syncKidSponsor(env(DB), { slug: 'max', jobId: 'job1' }, { fetchImpl: jt.fetchImpl });
  assert.deepEqual(r.wrote, { from: 'Acme Foundation', to: '' });
  assert.equal(r.jobtread.mirror, '');
});

test('someone already a Vendor is added by membership and keeps the role (the roles sweep moves it), and counts as the sponsor’s', async () => {
  _resetRoleCache();
  const DB = await world({ kids: [MAX], partners: [ACME] });
  await saveContacts(DB, 'acme-foundation', [{ name: 'Sam', email: 'sam@acmefdn.org' }]);
  const jt = fakeJT({ jobs: [{ id: 'job1', name: 'Max (2026)', field: '', access: [] }], members: [{ id: 'm-sam', email: 'sam@acmefdn.org', name: 'Sam', role: 'Vendor' }] });
  const r = await syncKidSponsor(env(DB), { slug: 'max', jobId: 'job1' }, { fetchImpl: jt.fetchImpl });
  assert.deepEqual(r.granted.map((g) => [g.email, g.role, g.kept]), [['sam@acmefdn.org', 'Vendor', true]]);
  assert.equal(jt.calls.find((q) => q.createAce).createAce.$.assignee.membershipId, 'm-sam');
  assert.ok(!jt.calls.some((q) => q.updateMembership));
  assert.deepEqual(r.wrote, { from: '', to: 'Acme Foundation' });
  assert.deepEqual(r.sponsors[0].onJob.map((x) => x.email), ['sam@acmefdn.org']);
});

test('a sponsor with no contacts takes its Sponsor users from the job; a closed job is mirrored but never given access', async () => {
  _resetRoleCache();
  const DB = await world({ kids: [{ ...MAX, sponsors: ['acme-foundation', 'bright-fund'] }], partners: [ACME, BRIGHT] });
  await saveContacts(DB, 'bright-fund', [{ name: 'Kim', email: 'kim@bright.org' }]);
  const jt = fakeJT({ jobs: [{ id: 'job1', name: 'Max (2026)', field: 'Acme', closedOn: '2026-05-01', access: ['jo@acmefdn.org'] }],
    members: [{ email: 'jo@acmefdn.org', name: 'Jo Lee', role: 'Monetary Sponsor', account: 'Acme Foundation' }] });
  const r = await syncKidSponsor(env(DB), { slug: 'max', jobId: 'job1' }, { fetchImpl: jt.fetchImpl });
  assert.deepEqual(r.filled, [{ slug: 'acme-foundation', name: 'Acme Foundation', people: 1 }]);
  assert.deepEqual((await readContacts(DB))['acme-foundation'].map((p) => p.email), ['jo@acmefdn.org']);
  assert.equal(jt.jobs[0].field, 'Acme Foundation', 'only who has access: Bright Fund isn’t on the job');
  assert.ok(!jt.calls.some((q) => q.createAce));
});

test('taking a sponsor off removes their Sponsor access, then clears the field; a name typed in JobTread is left alone', async () => {
  _resetRoleCache();
  const DB = await world({ kids: [{ ...MAX, sponsors: [] }, { slug: 'zoe', name: 'Zoe', year: 2026, sponsors: [] }], partners: [ACME] });
  await saveContacts(DB, 'acme-foundation', [{ name: 'Jo', email: 'jo@acmefdn.org' }]);
  const jt = fakeJT({ jobs: [
    { id: 'job1', name: 'Max (2026)', field: 'Acme Foundation', access: ['jo@acmefdn.org', 'mom@family.org'] },
    { id: 'job2', name: 'Zoe (2026)', field: 'Somebody typed this', access: [] },
  ], members: [{ email: 'jo@acmefdn.org', name: 'Jo', role: 'Monetary Sponsor' }, { email: 'mom@family.org', name: 'Mom', role: 'Makeover Family' }] });
  const r = await syncKidSponsor(env(DB), { slug: 'max', jobId: 'job1', previous: ['acme-foundation'] }, { fetchImpl: jt.fetchImpl });
  assert.deepEqual(r.removed.map((x) => x.email), ['jo@acmefdn.org']);
  assert.deepEqual(jt.jobs[0].access, ['mom@family.org'], 'the family stays');
  assert.deepEqual(r.wrote, { from: 'Acme Foundation', to: '' });
  const k = jt.kinds();
  assert.ok(k.indexOf('deleteAce') < k.indexOf('updateJob'), 'access first, then the field');
  const r2 = await syncKidSponsor(env(DB), { slug: 'zoe', jobId: 'job2' }, { fetchImpl: jt.fetchImpl });
  assert.equal(r2.wrote, null);
  assert.equal(jt.jobs[1].field, 'Somebody typed this');
});

test('a job that isn\'t the kid\'s is refused', async () => {
  const DB = await world({ kids: [MAX], partners: [ACME] });
  const jt = fakeJT({ jobs: [{ id: 'job9', name: 'Zoe (2026)', field: '', access: [] }] });
  await assert.rejects(syncKidSponsor(env(DB), { slug: 'max', jobId: 'job9' }, { fetchImpl: jt.fetchImpl }), /isn’t Max’s/);
  assert.ok(!jt.calls.some((q) => q.updateJob || q.createAce));
});

test('contacts saved later reach every open job that sponsor pays for, and its field follows', async () => {
  _resetRoleCache();
  const DB = await world({ kids: [MAX, { slug: 'zoe', name: 'Zoe', year: 2026, sponsors: ['acme-foundation'] }, { slug: 'ann', name: 'Ann', year: 2026, sponsors: ['bright-fund'] }], partners: [ACME, BRIGHT] });
  const jt = fakeJT({ jobs: [
    { id: 'job1', name: 'Max (2026)', field: '', access: [] },
    { id: 'job2', name: 'Zoe (2026)', field: '', access: [] },
    { id: 'job3', name: 'Ann (2026)', field: '', access: [] },
  ] });
  for (const [slug, jobId] of [['max', 'job1'], ['zoe', 'job2'], ['ann', 'job3']]) await syncKidSponsor(env(DB), { slug, jobId }, { fetchImpl: jt.fetchImpl });
  await saveContacts(DB, 'acme-foundation', [{ name: 'Jo', email: 'jo@acmefdn.org' }]);
  const r = await grantForPartner(env(DB), 'acme-foundation', { fetchImpl: jt.fetchImpl });
  assert.deepEqual(r.granted.map((g) => g.record).sort(), ['max', 'zoe']);
  assert.deepEqual(jt.jobs.map((j) => [j.access, j.field]), [[['jo@acmefdn.org'], 'Acme Foundation'], [['jo@acmefdn.org'], 'Acme Foundation'], [[], '']]);
});

test('the sweep takes in a Sponsor added in JobTread: the kid\'s sponsor, their contact, their logo first, the field', async () => {
  _resetRoleCache();
  const DB = await world({ kids: [{ ...MAX, sponsors: [], partnerLogos: [{ url: img('partners/other/1'), name: 'Other' }, { url: img('partners/acme/1'), name: 'Acme Foundation' }] }], partners: [ACME] });
  const jt = fakeJT({ jobs: [{ id: 'job1', name: 'Max (2026)', field: '', access: ['dana@acmefdn.org'] }], members: [{ email: 'dana@acmefdn.org', name: 'Dana Reed', role: 'Monetary Sponsor' }] });
  const out = await syncSponsors(env(DB), { fetchImpl: jt.fetchImpl });
  assert.deepEqual(out.map((x) => [x.slug, x.adopted.map((a) => a.slug)]), [['max', ['acme-foundation']]]);
  const kid = await kidOf(DB, 'max');
  assert.deepEqual(kid.sponsors, ['acme-foundation']);
  assert.deepEqual(kid.partnerLogos.map((l) => l.name), ['Acme Foundation', 'Other'], 'their logo moves up, not twice');
  assert.deepEqual((await readContacts(DB))['acme-foundation'].map((p) => p.email), ['dana@acmefdn.org']);
  assert.equal(jt.jobs[0].field, 'Acme Foundation');
  const hist = await DB.prepare("SELECT user_email FROM audit_log WHERE entity_type = 'kids'").first();
  assert.equal(hist?.user_email, 'JobTread (automatic)', 'saved like an admin save, by the sync');
});

test('the sweep takes in a field naming a Partner; a sponsor staff took off never comes back', async () => {
  _resetRoleCache();
  const DB = await world({ kids: [{ ...MAX, sponsors: [] }, { slug: 'zoe', name: 'Zoe', year: 2026, sponsors: [] }], partners: [ACME, BRIGHT] });
  const jt = fakeJT({ jobs: [
    { id: 'job1', name: 'Max (2026)', field: 'Bright Fund', access: [] },
    { id: 'job2', name: 'Zoe (2026)', field: '', access: [] },
  ], members: [{ email: 'jo@acmefdn.org', name: 'Jo', role: 'Monetary Sponsor', account: 'Acme Foundation' }] });
  // Zoe had Acme, staff took them off (and Jo with them); then someone gives Jo the job again in JobTread
  await syncKidSponsor(env(DB), { slug: 'zoe', jobId: 'job2', previous: ['acme-foundation'] }, { fetchImpl: jt.fetchImpl });
  jt.jobs[1].access.push('jo@acmefdn.org');
  await syncSponsors(env(DB), { fetchImpl: jt.fetchImpl });
  assert.deepEqual((await kidOf(DB, 'max')).sponsors, ['bright-fund'], 'the typed name was a Partner: Max’s sponsor now');
  assert.equal(jt.jobs[0].field, '', 'and with nobody from them on the job, the field mirrors that');
  assert.deepEqual((await kidOf(DB, 'zoe')).sponsors, [], 'taken off by staff: not taken back in');
  assert.equal(jt.jobs[1].field, 'Acme Foundation', 'the field still mirrors who has access');
});

test('the sweep runs at most every 10 minutes and never throws', async () => {
  _resetRoleCache();
  const DB = await world({ kids: [MAX], partners: [ACME] });
  const jt = fakeJT({ jobs: [{ id: 'job1', name: 'Max (2026)', field: '', access: [] }] });
  const t = Date.parse('2026-10-28T12:00:00Z');
  assert.ok(Array.isArray(await maybeSyncSponsors(env(DB), { fetchImpl: jt.fetchImpl, now: t })));
  assert.equal(await maybeSyncSponsors(env(DB), { fetchImpl: jt.fetchImpl, now: t + 5 * 60 * 1000 }), null);
  const broken = async () => { throw new Error('JobTread is down'); };
  assert.equal(await maybeSyncSponsors(env(DB), { fetchImpl: broken, now: t + 11 * 60 * 1000 }), null);
  assert.equal(await maybeSyncSponsors({ DB }, { fetchImpl: jt.fetchImpl }), null, 'no JobTread key: nothing');
});

test('sponsor logos first: by image id or name, in the sponsors\' order', () => {
  const logos = [{ url: img('a'), name: 'A' }, { url: `https://sunshineonaranneyday.com/cdn-cgi/imagedelivery/${HASH}/partners/bright/1/w=400`, name: 'Bright' }];
  assert.deepEqual(logosFirst(logos, [ACME, BRIGHT]).map((l) => l.name), ['Acme Foundation', 'Bright', 'A']);
});

test('the endpoint: views, saves contacts (names only in the audit log) and refuses bad input', async () => {
  _resetRoleCache();
  const DB = await world({ kids: [MAX], partners: [ACME] });
  const e = { DB };
  const get = (q) => onRequestGet({ env: e, request: new Request(`https://x/api/sponsors-admin?${q}`) }).then((r) => r.json());
  const post = (body) => onRequestPost({ env: e, data: { userEmail: 'staff@soardcharity.com' }, request: new Request('https://x/api/sponsors-admin', { method: 'POST', body: JSON.stringify(body) }) }).then((r) => r.json());
  const v = await get('kid=max');
  assert.deepEqual(v.sponsors, [{ slug: 'acme-foundation', name: 'Acme Foundation', contacts: [] }]);
  assert.equal(v.jobtread, null);
  assert.equal((await get('kid=max&job=22PZJHV29WFw')).jobtreadError, 'JobTread isn’t connected here');
  const saved = await post({ contacts: { partner: 'acme-foundation', people: [{ name: 'Jo Lee', email: 'jo@acmefdn.org', phone: '404 555 0100' }] } });
  assert.equal(saved.success, true);
  assert.equal(saved.contacts[0].phone, '404 555 0100');
  const audit = await DB.prepare("SELECT changes FROM audit_log WHERE entity_type = 'partner-contacts'").first();
  assert.doesNotMatch(audit.changes, /jo@|404/);
  assert.deepEqual((await get('partners=acme-foundation')).contacts['acme-foundation'].map((p) => p.name), ['Jo Lee']);
  assert.equal((await post({ contacts: { partner: 'nobody', people: [] } })).success, false);
  assert.equal((await post({ contacts: { partner: '../x', people: [] } })).error, 'Bad partner');
  assert.equal((await post({ sync: { kid: 'max', job: 'bad id!' } })).error, 'Bad sync');
  assert.equal((await get('kid=Max')).error, 'Bad kid or job');
});
