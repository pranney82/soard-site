/**
 * Room credits end to end (functions/api/_room-credits.js) against a small fake
 * JobTread: Clareece's picks in Designed By and Monetary Sponsor reach the
 * website on the second look; a pick of a company not on the room puts it on
 * once; an unpick is the credit only; a company a person took off goes back on
 * when picked after that, and stays off when taken off after; the site's own writes are one change on what JobTread has now; launch
 * changes no invite; the admin door writes JobTread. Run: node --test tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { syncCredits, maybeSyncCredits, setCredit, settleHeld, creditsView, setNotCompany, grantForSponsor, readJobRows, addBack, pageOf, SECOND_LOOK_MS } from '../functions/api/_room-credits.js';
import { roomCreditsFacts } from '../functions/api/automations-admin.js';
import { recordVersion } from '../functions/api/_content-history.js';
import { onRequestPost as creditsPost } from '../functions/api/room-credits-admin.js';
import { FIELD_MONETARY_SPONSOR } from '../functions/api/_demo-invites.js';
import { setLink } from '../functions/api/_kid-partners.js';
import { saveContacts, sponsorMatcher } from '../functions/api/_sponsors.js';
import { ensureSchema as ensureVendorSchema } from '../functions/api/_vendor-access.js';
import { _resetRoleCache } from '../functions/api/_jt-access.js';
import { nameKey } from '../public/admin/partners-shared.js';

const HASH = 'ROYFuPmfN2vPS6mt5sCkZQ';
const img = (id) => `https://imagedelivery.net/${HASH}/${id}/public`;
const DESIGNED = 'f-designed';
const T0 = Date.UTC(2026, 10, 10, 15, 0);
const MIN = 60 * 1000;

const CROSBY = { slug: 'crosby-design-group', name: 'Crosby Design Group', logo: img('partners/crosby-design-group/1'), website: 'https://crosbydesigngroup.com', category: ['design'], level: 'signature' };
const MEANS = { slug: 'means-interiors', name: 'Means Interiors', logo: '', website: 'https://meansinteriors.com', category: ['design'], level: 'friend' };
const CARLOS = { slug: 'jimmy-helen-carlos', name: 'Jimmy & Helen Carlos', logo: img('partners/carlos/1'), website: '', category: ['funding'], level: 'champion' };
const ROBINS = { slug: 'brian-robins-family-foundation', name: 'Brian Robins Family Foundation', logo: img('partners/robins/1'), website: 'https://robins.org', category: ['funding'], level: 'champion' };

/** JobTread, small: job fields with choices, jobs with values and access, memberships, roles */
function fakeJT({ jobs, fields = null, members = [] }) {
  const calls = [];
  let n = 0;
  const F = fields || [
    { id: FIELD_MONETARY_SPONSOR, name: 'Monetary Sponsor', type: 'option', options: ['Beazer', 'Helen & Jimmy Carlos', 'SOARF'], maxValuesAllowed: null },
  ];
  const people = new Map(members.map((m) => [m.email, { id: m.id || `m${++n}`, ...m }]));
  const membership = (m) => ({ id: m.id, createdAt: '2025-01-01T00:00:00Z', isInternal: !!m.internal, role: m.role ? { id: `r-${m.role}`, name: m.role } : null, account: m.account || null, user: { name: m.name || null, emailAddress: m.email } });
  const values = (j, ids) => Object.entries(j.values || {}).filter(([id]) => !ids || ids.includes(id)).flatMap(([id, list]) => list.map((v) => ({ value: v, customField: { id } })));
  const aces = (j) => ({ nextPage: null, nodes: (j.access || []).map((e) => ({ id: `ace-${j.id}-${e}`, membership: membership(people.get(e)) })) });
  const job = (id) => jobs.find((x) => x.id === id);
  const fetchImpl = async (url, init) => {
    const q = JSON.parse(init.body).query;
    delete q.$;
    calls.push(q);
    const reply = (body) => ({ ok: true, json: async () => body, text: async () => JSON.stringify(body) });
    if (jt.down) return { ok: false, status: 503, text: async () => 'down', json: async () => ({}) };
    // fetchAccess: j0, j1… aliased jobs
    if (Object.keys(q).every((k) => /^j\d+$/.test(k))) return reply(Object.fromEntries(Object.entries(q).map(([k, v]) => [k, { id: v.$.id, aces: aces(job(v.$.id)) }])));
    if (q.organization?.customFields) return reply({ organization: { customFields: { nodes: F.map((f) => ({ ...f })) } } });
    // As JobTread does: a dropdown is made with at least one choice
    if (q.createCustomField && q.createCustomField.$.type === 'option' && !(q.createCustomField.$.options || []).length) return { ok: false, status: 400, text: async () => 'The array with length 0 at "createCustomField"."$"."options" must be at least length 1', json: async () => ({}) };
    if (q.createCustomField) { const f = { id: DESIGNED, name: q.createCustomField.$.name, type: 'option', options: q.createCustomField.$.options || [], maxValuesAllowed: null }; F.push(f); return reply({ createCustomField: { createdCustomField: { id: f.id } } }); }
    if (q.customField) { const f = F.find((x) => x.id === q.customField.$.id); return reply({ customField: f ? { ...f } : null }); }
    if (q.updateCustomField) { F.find((x) => x.id === q.updateCustomField.$.id).options = [...q.updateCustomField.$.options]; return reply({}); }
    if (q.organization?.jobs) {
      const ids = q.organization.jobs.nodes.customFieldValues.$.where[2];
      const size = q.organization.jobs.nodes.customFieldValues.$.size;
      return reply({ organization: { jobs: { nextPage: null, nodes: jobs.map((j) => ({ id: j.id, name: j.name, closedOn: j.closedOn || null, createdAt: j.createdAt || '2025-01-01T00:00:00Z', customFieldValues: { nodes: values(j, ids).slice(0, size) } })) } } });
    }
    if (q.job) {
      const j = job(q.job.$.id);
      if (!j) return reply({ job: null });
      const ids = q.job.customFieldValues?.$?.where?.[2];
      return reply({ job: { id: j.id, closedOn: j.closedOn || null, createdAt: j.createdAt || '2025-01-01T00:00:00Z', customFieldValues: { nodes: values(j, ids) }, aces: aces(j) } });
    }
    if (q.updateJob) {
      const j = job(q.updateJob.$.id);
      for (const [id, list] of Object.entries(q.updateJob.$.customFieldValues)) {
        assert.ok(Array.isArray(list), 'several-choice values are written as a list');
        const f = F.find((x) => x.id === id);
        for (const v of list) assert.ok(f.options.includes(v), `“${v}” is a choice before a job holds it`);
        j.values = { ...j.values, [id]: [...list] };
      }
      return reply({});
    }
    if (q.organization?.roles) return reply({ organization: { roles: { nodes: ['Friend', 'Champion', 'Signature', 'Builder', 'Trade Partner'].map((r) => ({ id: `r-${r}`, name: r })) } } });
    if (q.organization?.memberships) { const m = people.get(q.organization.memberships.$.where[2]); return reply({ organization: { memberships: { nodes: m ? [membership(m)] : [] } } }); }
    if (q.createAce) {
      const { assignee, targetId, notify } = q.createAce.$;
      assert.equal(notify, false, 'JobTread never emails anyone the site puts on a job');
      let m = assignee.membershipId ? [...people.values()].find((x) => x.id === assignee.membershipId) : null;
      if (!m) { m = { id: `m${++n}`, email: assignee.emailAddress, name: assignee.name }; people.set(m.email, m); }
      job(targetId).access.push(m.email);
      return reply({ createAce: { createdAce: { id: `ace${n}`, membership: { ...membership(m), createdAt: new Date(T0).toISOString() } } } });
    }
    if (q.updateMembership) { const m = [...people.values()].find((x) => x.id === q.updateMembership.$.id); m.role = q.updateMembership.$.roleId.replace(/^r-/, ''); return reply({}); }
    throw new Error(`unexpected query ${JSON.stringify(q).slice(0, 160)}`);
  };
  const jt = { fetchImpl, calls, jobs, fields: F, people, down: false, writes: () => calls.filter((q) => q.updateJob).length };
  return jt;
}

async function world({ kids = [], partners = [CROSBY, MEANS, CARLOS, ROBINS], jobs = [], members = [], fields = null } = {}) {
  _resetRoleCache();
  const DB = await createD1({ schemaFiles: ['scripts/schema.sql'] });
  for (const k of kids) await DB.prepare('INSERT INTO kids (slug, name, year, status, data) VALUES (?, ?, ?, ?, ?)').bind(k.slug, k.name, k.year, k.status || 'in-progress', JSON.stringify({ partnerLogos: [], ...k })).run();
  for (const p of partners) await DB.prepare('INSERT INTO partners (slug, name, level, category, featured, data) VALUES (?, ?, ?, ?, ?, ?)').bind(p.slug, p.name, p.level, 'design', 0, JSON.stringify(p)).run();
  const jt = fakeJT({ jobs, members, fields });
  const env = { DB, JOBTREAD_GRANT_KEY: 'k' };
  const put = [];
  const deps = {
    // What "Add to job" does is tested with the vendor sync (tests/vendor-access.test.mjs); here it's noted, and the person goes on
    pageLogosOn: async (e, { slug, logos }) => {
      const row = await DB.prepare('SELECT data FROM kids WHERE slug = ?').bind(slug).first();
      const d = JSON.parse(row.data);
      d.partnerLogos = [...logos.map(({ url, name }) => ({ url, name })), ...(d.partnerLogos || [])];
      await DB.prepare('UPDATE kids SET data = ? WHERE slug = ?').bind(JSON.stringify(d), slug).run();
      put.push({ logo: logos[0].name, slug });
      return {};
    },
    addToJob: async (e, { record, logos }) => { put.push({ job: logos[0].name, record }); return { added: [`${logos[0].name} main contact`], waiting: [] }; },
    roleMode: async () => ({ partner: (p) => (p.level === 'signature' ? 'Signature' : p.level === 'champion' ? 'Champion' : 'Friend'), sponsor: (p) => (p.level === 'champion' ? 'Champion' : 'Friend'), trade: 'Trade Partner' }),
  };
  let at = T0;
  const run = async (step = SECOND_LOOK_MS) => { at += step; return syncCredits(env, { fetchImpl: jt.fetchImpl, now: at, deps }); };
  const set = (body) => { at += MIN; return setCredit(env, body, 'clareece@soardcharity.com', { fetchImpl: jt.fetchImpl, now: at, deps }); };
  const kid = async (slug) => JSON.parse((await DB.prepare('SELECT data FROM kids WHERE slug = ?').bind(slug).first()).data);
  return { DB, jt, env, run, set, kid, put, deps, now: () => at, later: (ms) => { at += ms; } };
}
const AXEL = { slug: 'axel', name: 'Axel Puente Arnao', year: 2026 };
const axelJob = (values = {}, more = {}) => ({ id: 'j-axel', name: 'Axel Puente Arnao (2026)', values, access: [], ...more });

test('launch: Designed By is made, the dropdowns get Partners’ names, and every job’s values are the starting point: nobody is put on', async () => {
  const w = await world({ kids: [AXEL], jobs: [axelJob({ [FIELD_MONETARY_SPONSOR]: ['SOARF'] })] });
  const r = await w.run();
  assert.deepEqual(r.problems, []);
  assert.ok(w.jt.fields.find((f) => f.id === DESIGNED && f.name === 'Designed By'), 'Designed By made');
  assert.deepEqual(w.jt.fields.find((f) => f.id === DESIGNED).options, ['Crosby Design Group', 'Means Interiors']);
  assert.deepEqual(w.jt.fields.find((f) => f.id === FIELD_MONETARY_SPONSOR).options, ['Beazer', 'Brian Robins Family Foundation', 'Helen & Jimmy Carlos', 'Jimmy & Helen Carlos', 'SOARF'], 'added, A to Z, nothing a person put there dropped');
  assert.deepEqual(w.put, [], 'nobody put on at launch');
  assert.deepEqual(r.unknown.map((u) => u.value), ['SOARF'], 'a name that isn’t a company in Partners is listed');
  assert.deepEqual((await w.kid('axel')).sponsors || [], []);
});

test('a pick in JobTread counts on the second look: the copy, and the company put on the room once', async () => {
  const w = await world({ kids: [AXEL], jobs: [axelJob()] });
  await w.run();
  w.jt.jobs[0].values[DESIGNED] = ['Crosby Design Group'];
  const one = await w.run(MIN);
  assert.deepEqual(one.changed, [], 'first look: waits');
  assert.deepEqual((await w.kid('axel')).designers || [], []);
  const two = await w.run(SECOND_LOOK_MS);
  assert.deepEqual(two.changed.map((c) => c.added.map((x) => x.p)), [['crosby-design-group']]);
  assert.deepEqual((await w.kid('axel')).designers, ['crosby-design-group']);
  assert.deepEqual(w.put, [{ logo: 'Crosby Design Group', slug: 'axel' }, { job: 'Crosby Design Group', record: 'axel' }], 'logo on the page, then Add to job');
  assert.deepEqual((await w.kid('axel')).partnerLogos.map((l) => l.name), ['Crosby Design Group'], 'the logo the pick put on is still on the page after the copy is saved');
  await w.run();
  assert.equal(w.put.length, 2, 'once');
});

test('a slip fixed before the second look does nothing', async () => {
  const w = await world({ kids: [AXEL], jobs: [axelJob()] });
  await w.run();
  w.jt.jobs[0].values[DESIGNED] = ['Crosby Design Group'];
  await w.run(MIN);
  w.jt.jobs[0].values[DESIGNED] = ['Means Interiors'];
  await w.run(SECOND_LOOK_MS);
  assert.deepEqual(w.put, [], 'Crosby never went on');
  await w.run(SECOND_LOOK_MS);
  assert.deepEqual((await w.kid('axel')).designers, ['means-interiors']);
});

test('a pick of a company already on the room puts nobody on; an unpick is the credit only', async () => {
  const w = await world({ kids: [{ ...AXEL, partnerLogos: [{ url: CROSBY.logo, name: CROSBY.name }] }], jobs: [axelJob()] });
  await w.run();
  w.jt.jobs[0].values[DESIGNED] = ['Crosby Design Group'];
  await w.run(MIN); await w.run();
  assert.deepEqual(w.put, []);
  assert.deepEqual((await w.kid('axel')).designers, ['crosby-design-group']);
  w.jt.jobs[0].values[DESIGNED] = [];
  await w.run(MIN); await w.run();
  const k = await w.kid('axel');
  assert.deepEqual(k.designers, []);
  assert.equal(k.partnerLogos.length, 1, 'the logo stays: being on the room is its own control');
});

/** A person took this company off Axel's job (Take off this job, the X on its logo, or in JobTread), at this time */
const takenOffAt = async (w, slug, name, ms) => {
  await ensureVendorSchema(w.DB);
  await w.DB.prepare("INSERT OR REPLACE INTO vendor_job_seen (job_id, who, record, name, partner, off, updated_at) VALUES ('j-axel', ?, 'axel', ?, ?, 'site', ?)").bind(`p:${slug}`, name, slug, new Date(ms).toISOString()).run();
};

test('a company a person took off before Clareece’s pick goes back on: the pick is a person saying so', async () => {
  const w = await world({ kids: [AXEL], jobs: [axelJob()] });
  await takenOffAt(w, 'crosby-design-group', 'Crosby Design Group', T0);
  await w.run();
  w.jt.jobs[0].values[DESIGNED] = ['Crosby Design Group'];
  await w.run(MIN); await w.run();
  assert.deepEqual(w.put, [{ logo: 'Crosby Design Group', slug: 'axel' }, { job: 'Crosby Design Group', record: 'axel' }], 'its logo, then Add to job, which brings back who came off');
  assert.deepEqual((await w.kid('axel')).designers, ['crosby-design-group']);
});

test('a company taken off after Clareece may have picked it stays off; the credit still counts, shown with a way back', async () => {
  const w = await world({ kids: [AXEL], jobs: [axelJob()] });
  await w.run();
  // Taken off after the read before her pick was first seen: it can't be told which came first, so the take-off stands
  w.later(30 * 1000);
  await takenOffAt(w, 'crosby-design-group', 'Crosby Design Group', w.now());
  w.jt.jobs[0].values[DESIGNED] = ['Crosby Design Group'];
  await w.run(MIN); await w.run();
  assert.deepEqual(w.put, []);
  assert.deepEqual((await w.kid('axel')).designers, ['crosby-design-group']);
  const v = await creditsView(w.env, { record: 'axel', fetchImpl: w.jt.fetchImpl });
  assert.equal(v.room.kinds.designed.credits[0].onRoom, false, 'shown as credited, not on the room (its job read now)');
  w.jt.down = true;
  const v2 = await creditsView(w.env, { record: 'axel', fetchImpl: w.jt.fetchImpl });
  assert.equal(v2.room.kinds.designed.credits[0].onRoom, null, 'JobTread down: not said either way');
});

test('a finished room (closed job): the credit only, nobody put on anything', async () => {
  const w = await world({ kids: [AXEL], jobs: [axelJob({}, { closedOn: '2026-01-01' })] });
  await w.run();
  w.jt.jobs[0].values[DESIGNED] = ['Crosby Design Group'];
  await w.run(MIN); await w.run();
  assert.deepEqual((await w.kid('axel')).designers, ['crosby-design-group']);
  assert.deepEqual(w.put, []);
});

test('a monetary sponsor picked that isn’t on the room: its contacts each go on once, in its level; one a person then takes off in JobTread stays off', async () => {
  const w = await world({ kids: [AXEL], jobs: [axelJob()] });
  await saveContacts(w.DB, 'jimmy-helen-carlos', [{ name: 'Jimmy', email: 'jimmy@carlos.org' }, { name: 'Helen', email: 'helen@carlos.org' }]);
  await w.run();
  w.jt.jobs[0].values[FIELD_MONETARY_SPONSOR] = ['Jimmy & Helen Carlos'];
  await w.run(MIN); await w.run();
  assert.deepEqual(w.jt.jobs[0].access, ['jimmy@carlos.org', 'helen@carlos.org']);
  assert.equal(w.jt.people.get('helen@carlos.org').role, 'Champion');
  assert.ok(w.put.some((x) => x.logo === CARLOS.name), 'and its logo on the page');
  w.jt.jobs[0].access = ['jimmy@carlos.org'];
  await saveContacts(w.DB, 'jimmy-helen-carlos', [{ name: 'Jimmy', email: 'jimmy@carlos.org' }, { name: 'Helen', email: 'helen@carlos.org' }, { name: 'Ana', email: 'ana@carlos.org' }]);
  const g = await grantForSponsor(w.env, 'jimmy-helen-carlos', { emails: ['ana@carlos.org'], fetchImpl: w.jt.fetchImpl, now: w.now(), deps: w.deps });
  assert.deepEqual(g.granted.map((x) => x.name), ['Ana'], 'only the new contact; Helen, taken off by a person, stays off');
  assert.deepEqual(w.jt.jobs[0].access, ['jimmy@carlos.org', 'ana@carlos.org']);
});

test('no logo in Partners: the main contact goes on in its level, and the logo sync asks for one', async () => {
  const w = await world({ kids: [AXEL], jobs: [axelJob()] });
  await saveContacts(w.DB, 'means-interiors', [{ name: 'Angela Means', email: 'angela@meansinteriors.com' }]);
  await w.run();
  w.jt.jobs[0].values[DESIGNED] = ['Means Interiors'];
  await w.run(MIN); await w.run();
  assert.deepEqual(w.jt.jobs[0].access, ['angela@meansinteriors.com']);
  assert.equal(w.jt.people.get('angela@meansinteriors.com').role, 'Friend', 'its level, never Trade Partner');
});

test('the admin door: a pick writes JobTread at once (one change on what it has now), and a pick she made meanwhile still counts', async () => {
  const w = await world({ kids: [AXEL], jobs: [axelJob()] });
  await w.run();
  w.jt.jobs[0].values[DESIGNED] = ['Means Interiors'];
  await w.run(MIN); // Clareece's pick, waiting on its second look
  const r = await w.set({ record: 'axel', kind: 'designed', partner: 'crosby-design-group', on: true });
  assert.deepEqual(w.jt.jobs[0].values[DESIGNED], ['Means Interiors', 'Crosby Design Group'], 'her pick kept in JobTread');
  assert.deepEqual(r.credits, ['crosby-design-group'], 'the copy has the admin’s pick now');
  assert.ok(w.put.some((p) => p.job === 'Crosby Design Group'), 'put on at once: a person pressed it');
  await w.run(); await w.run();
  assert.deepEqual((await w.kid('axel')).designers, ['crosby-design-group', 'means-interiors'], 'hers still reaches the website, after the credits it already had');
  await w.set({ record: 'axel', kind: 'designed', partner: 'crosby-design-group', on: false });
  assert.deepEqual(w.jt.jobs[0].values[DESIGNED], ['Means Interiors']);
  assert.deepEqual((await w.kid('axel')).designers, ['means-interiors']);
});

test('the admin door for a room with no job: the record only', async () => {
  const w = await world({ kids: [{ slug: 'lexy', name: 'Lexy', year: 2018, status: 'completed' }], jobs: [] });
  const r = await w.set({ record: 'lexy', kind: 'designed', partner: 'crosby-design-group', on: true });
  assert.equal(r.job, null);
  assert.deepEqual((await w.kid('lexy')).designers, ['crosby-design-group']);
  assert.deepEqual(w.put, []);
  assert.equal(w.jt.writes(), 0);
});

test('a room that had credits before its job brings them into the job, putting nobody on', async () => {
  const w = await world({ kids: [{ ...AXEL, designers: ['crosby-design-group'] }], jobs: [] });
  await w.run();
  w.jt.jobs.push(axelJob());
  await w.run();
  assert.deepEqual(w.jt.jobs[0].values[DESIGNED], ['Crosby Design Group']);
  assert.deepEqual(w.put, []);
  assert.deepEqual((await w.kid('axel')).designers, ['crosby-design-group']);
});

const aces = (jt) => jt.calls.filter((q) => q.createAce).length;
/** A room's put-ons still to finish, without when each was picked */
const retryOf = async (w, key) => ((await readJobRows(w.DB)).get(key)?.retry || []).map(({ s, r }) => ({ s, r }));

test('launch: the website’s sponsors go into JobTread; JobTread naming one the website didn’t have is held for a person', async () => {
  const w = await world({
    kids: [{ ...AXEL, sponsors: ['jimmy-helen-carlos'] }, { slug: 'lizzie', name: 'Lizzie Francis', year: 2026 }],
    jobs: [axelJob({ [FIELD_MONETARY_SPONSOR]: [] }), { id: 'j-liz', name: 'Lizzie Francis (2026)', values: { [FIELD_MONETARY_SPONSOR]: ['Brian Robins Family Foundation'] }, access: [] }],
    fields: [{ id: FIELD_MONETARY_SPONSOR, name: 'Monetary Sponsor', type: 'option', options: ['Brian Robins Family Foundation'], maxValuesAllowed: null }],
  });
  await saveContacts(w.DB, 'jimmy-helen-carlos', [{ name: 'Jimmy', email: 'jimmy@carlos.org' }]);
  await saveContacts(w.DB, 'brian-robins-family-foundation', [{ name: 'Brian', email: 'brian@robins.org' }]);
  const r = await w.run();
  assert.deepEqual(w.jt.jobs[0].values[FIELD_MONETARY_SPONSOR], ['Jimmy & Helen Carlos'], 'the website’s sponsor written in');
  assert.deepEqual(r.held.map((h) => [h.record, h.jobtread]), [['lizzie', ['brian-robins-family-foundation']]]);
  assert.deepEqual((await w.kid('lizzie')).sponsors || [], [], 'the copy keeps the website’s answer until a person says');
  assert.deepEqual(w.put, []);
  await settleHeld(w.env, { record: 'lizzie', kind: 'sponsored', use: 'jobtread' }, 'staff@soardcharity.com', { fetchImpl: w.jt.fetchImpl, now: w.now() });
  assert.deepEqual((await w.kid('lizzie')).sponsors, ['brian-robins-family-foundation']);
  assert.deepEqual(w.put, [], 'settling puts nobody on');
  await w.run(); await w.run();
  assert.equal(aces(w.jt), 0, 'and nobody is given access to any job: no invite starts from launch or settling');
});

test('a name she picked after launch, settled with Same as, is knowing more, not a pick: credited, nobody put on', async () => {
  const fields = [{ id: FIELD_MONETARY_SPONSOR, name: 'Monetary Sponsor', type: 'option', options: ['Carlos Fund'], maxValuesAllowed: null }];
  const w = await world({ kids: [AXEL], jobs: [axelJob({ [FIELD_MONETARY_SPONSOR]: [] })], fields });
  await w.run();
  w.jt.jobs[0].values[FIELD_MONETARY_SPONSOR] = ['Carlos Fund'];
  await w.run(MIN); await w.run();
  assert.deepEqual((await creditsView(w.env)).unknown.map((u) => u.value), ['Carlos Fund']);
  await saveContacts(w.DB, 'jimmy-helen-carlos', [{ name: 'Jimmy', email: 'jimmy@carlos.org' }]);
  await setLink(w.DB, { company: nameKey('Carlos Fund'), partner: 'jimmy-helen-carlos' });
  await w.run(); await w.run();
  assert.deepEqual((await w.kid('axel')).sponsors, ['jimmy-helen-carlos']);
  assert.deepEqual(w.put, []);
  assert.equal(aces(w.jt), 0, 'nobody given access');
  assert.deepEqual((await creditsView(w.env)).unknown, []);
});

test('a name the job had from before launch, later said to be a company the page didn’t have, is a question, not a credit', async () => {
  const fields = [{ id: FIELD_MONETARY_SPONSOR, name: 'Monetary Sponsor', type: 'option', options: ['Carlos Fund', 'Means Interiors'], maxValuesAllowed: null }];
  const w = await world({ kids: [{ ...AXEL, sponsors: ['means-interiors'] }], jobs: [axelJob({ [FIELD_MONETARY_SPONSOR]: ['Carlos Fund', 'Means Interiors'] })], fields });
  await w.run();
  await setLink(w.DB, { company: nameKey('Carlos Fund'), partner: 'jimmy-helen-carlos' });
  await w.run(); await w.run();
  assert.deepEqual((await w.kid('axel')).sponsors, ['means-interiors'], 'the page keeps its answer');
  const v = await creditsView(w.env);
  assert.deepEqual(v.held.map((h) => [h.record, h.jobtread.map((x) => x.slug), h.website.map((x) => x.slug)]), [['axel', ['jimmy-helen-carlos'], ['means-interiors']]], 'asked, as launch asks');
  await settleHeld(w.env, { record: 'axel', kind: 'sponsored', use: 'jobtread' }, 'staff', { fetchImpl: w.jt.fetchImpl, now: w.now() });
  assert.deepEqual((await w.kid('axel')).sponsors, ['means-interiors', 'jimmy-helen-carlos'], 'a person said JobTread’s');
  assert.deepEqual(w.put, []);
});

test('Not a company: never asked about again', async () => {
  const w = await world({ kids: [AXEL], jobs: [axelJob({ [FIELD_MONETARY_SPONSOR]: ['SOARF'] })] });
  await w.run();
  await setNotCompany(w.DB, 'SOARF');
  const v = await creditsView(w.env, { record: 'axel' });
  assert.deepEqual(v.room.kinds.sponsored.unknown, []);
  assert.deepEqual(v.room.kinds.sponsored.others, ['SOARF']);
});

test('a partner renamed in Partners: the new name is a choice first, then the job says it; nothing is put on', async () => {
  const w = await world({ kids: [AXEL], jobs: [axelJob({ [DESIGNED]: [] })] });
  await w.run();
  w.jt.jobs[0].values[DESIGNED] = ['Crosby Design Group'];
  await w.run(MIN); await w.run();
  const before = w.put.length;
  await w.DB.prepare('UPDATE partners SET data = ? WHERE slug = ?').bind(JSON.stringify({ ...CROSBY, name: 'Crosby Design' }), CROSBY.slug).run();
  await w.run();
  assert.deepEqual(w.jt.jobs[0].values[DESIGNED], ['Crosby Design']);
  assert.ok(w.jt.fields.find((f) => f.id === DESIGNED).options.includes('Crosby Design'));
  assert.ok(w.jt.fields.find((f) => f.id === DESIGNED).options.includes('Crosby Design Group'), 'the old choice stays: some job anywhere may hold it');
  assert.equal(w.put.length, before);
  assert.deepEqual((await w.kid('axel')).designers, ['crosby-design-group']);
});

test('JobTread down, or a value list that may be cut short: nothing changes', async () => {
  const w = await world({ kids: [{ ...AXEL, designers: ['crosby-design-group'] }], jobs: [axelJob({ [DESIGNED]: ['Crosby Design Group'] })] });
  await w.run();
  w.jt.down = true;
  const r = await w.run();
  assert.ok(r.problems.length);
  w.jt.down = false;
  w.jt.jobs[0].values[DESIGNED] = Array.from({ length: 40 }, (_, i) => `Name ${i}`);
  await w.run(); await w.run();
  assert.deepEqual((await w.kid('axel')).designers, ['crosby-design-group'], 'a full list isn’t read');
});

test('an admin pick JobTread doesn’t take: owed, not failed; the page says it now, the next run writes it and puts them on, once', async () => {
  const w = await world({ kids: [AXEL], jobs: [axelJob()] });
  await w.run();
  const real = w.jt.fetchImpl;
  w.jt.fetchImpl = async (u, init) => (JSON.parse(init.body).query.updateJob ? { ok: false, status: 500, text: async () => 'boom', json: async () => ({}) } : real(u, init));
  const r = await setCredit(w.env, { record: 'axel', kind: 'designed', partner: 'crosby-design-group', on: true }, 'x', { fetchImpl: w.jt.fetchImpl, now: w.now() + MIN, deps: w.deps });
  assert.ok(r.owed, 'the admin is told JobTread follows');
  assert.deepEqual(r.credits, ['crosby-design-group'], 'the page says it now');
  assert.ok((await readJobRows(w.DB)).get('axel designed').pending, 'owed');
  assert.deepEqual(w.put, [], 'nobody put on until JobTread has it');
  w.jt.fetchImpl = real;
  await w.run();
  assert.deepEqual(w.jt.jobs[0].values[DESIGNED], ['Crosby Design Group']);
  assert.equal((await readJobRows(w.DB)).get('axel designed').pending, null);
  assert.deepEqual(w.put.map((x) => x.logo || x.job), ['Crosby Design Group', 'Crosby Design Group'], 'the person’s pick, put on');
  await w.run(); await w.run();
  assert.equal(w.put.length, 2, 'once; the site’s own write isn’t read as another pick');
});

test('a company both designer and sponsor; and the view lists rooms by partner with the part', async () => {
  const w = await world({ kids: [{ ...AXEL, partnerLogos: [{ url: CROSBY.logo, name: CROSBY.name }] }], jobs: [axelJob()],
    fields: [{ id: FIELD_MONETARY_SPONSOR, name: 'Monetary Sponsor', type: 'option', options: ['Crosby Design Group'], maxValuesAllowed: null }] });
  await w.run();
  w.jt.jobs[0].values[DESIGNED] = ['Crosby Design Group'];
  w.jt.jobs[0].values[FIELD_MONETARY_SPONSOR] = ['Crosby Design Group'];
  await w.run(MIN); await w.run();
  const v = await creditsView(w.env);
  assert.deepEqual(v.byPartner['crosby-design-group'].map((x) => x.kind).sort(), ['designed', 'sponsored']);
});

test('a sponsor already on the room: the pick puts nobody on (so an Undo of it takes nobody off)', async () => {
  const w = await world({ kids: [{ ...AXEL, partnerLogos: [{ url: CARLOS.logo, name: CARLOS.name }] }], jobs: [axelJob()] });
  await saveContacts(w.DB, 'jimmy-helen-carlos', [{ name: 'Jimmy', email: 'jimmy@carlos.org' }]);
  await w.run();
  const r = await w.set({ record: 'axel', kind: 'sponsored', partner: 'jimmy-helen-carlos', on: true });
  assert.deepEqual(r.put, { logo: false, people: [], waiting: false, off: false });
  assert.deepEqual(w.jt.jobs[0].access, []);
});

test('Undo of taking a credit off: the credit only (put: false), never a company that wasn’t on the room', async () => {
  const w = await world({ kids: [AXEL], jobs: [axelJob()] });
  await w.run();
  await saveContacts(w.DB, 'crosby-design-group', [{ name: 'Ella', email: 'ella@crosbydesigngroup.com' }]);
  await w.set({ record: 'axel', kind: 'designed', partner: 'crosby-design-group', on: true, put: false });
  assert.deepEqual((await w.kid('axel')).designers, ['crosby-design-group']);
  assert.deepEqual(w.jt.jobs[0].values[DESIGNED], ['Crosby Design Group']);
  assert.deepEqual(w.put, [], 'nobody put on');
  assert.equal(aces(w.jt), 0, 'nobody given access');
});

test('Add them back: a person puts a credited company back on now, even one a person took off', async () => {
  const w = await world({ kids: [{ ...AXEL, designers: ['crosby-design-group'] }], jobs: [axelJob({ [DESIGNED]: ['Crosby Design Group'] })] });
  await ensureVendorSchema(w.DB);
  await w.DB.prepare("INSERT INTO vendor_job_seen (job_id, who, record, name, partner, off, updated_at) VALUES ('j-axel', 'p:crosby-design-group', 'axel', 'Crosby Design Group', 'crosby-design-group', 'site', ?)").bind(new Date(T0).toISOString()).run();
  await w.run();
  const r = await addBack(w.env, { record: 'axel', kind: 'designed', partner: 'crosby-design-group' }, 'staff@soardcharity.com', { fetchImpl: w.jt.fetchImpl, now: w.now(), deps: w.deps });
  assert.equal(r.put.logo, true);
  assert.deepEqual(w.put.map((x) => x.logo || x.job), ['Crosby Design Group', 'Crosby Design Group'], 'logo on the page, then Add to job (which puts back whoever came off)');
  assert.ok(r.sha && r.page.partnerLogos.length === 1, 'the page’s new version comes back');
});

test('a failed put-on is tried again next run while it’s still credited', async () => {
  const w = await world({ kids: [AXEL], jobs: [axelJob()] });
  await w.run();
  let fail = true;
  const real = w.deps.addToJob;
  w.deps.addToJob = async (...a) => { if (fail) throw new Error('JobTread is down'); return real(...a); };
  w.jt.jobs[0].values[DESIGNED] = ['Crosby Design Group'];
  await w.run(MIN);
  const r = await w.run();
  assert.ok(r.problems.some((x) => /tried again next run/.test(x)));
  assert.deepEqual(await retryOf(w, 'axel designed'), [{ s: 'crosby-design-group', r: true }], 'past “already on?” (the logo went on), so it’s finished next run');
  assert.equal((await readJobRows(w.DB)).get('axel designed').retry[0].at, new Date(T0 + SECOND_LOOK_MS).toISOString(), 'with when it was picked (by at the earliest: the read before it was seen)');
  fail = false;
  await w.run();
  assert.ok(w.put.some((x) => x.job === 'Crosby Design Group'), 'put on the next run');
  assert.deepEqual((await readJobRows(w.DB)).get('axel designed').retry, []);
});

test('launch: a write that fails halfway keeps the question for a person, and the write is owed until it lands', async () => {
  const w = await world({
    kids: [{ ...AXEL, sponsors: ['jimmy-helen-carlos'] }],
    jobs: [axelJob({ [FIELD_MONETARY_SPONSOR]: ['Brian Robins Family Foundation'] })],
    fields: [{ id: FIELD_MONETARY_SPONSOR, name: 'Monetary Sponsor', type: 'option', options: ['Brian Robins Family Foundation'], maxValuesAllowed: null }],
  });
  const real = w.jt.fetchImpl;
  w.jt.fetchImpl = async (u, init) => (JSON.parse(init.body).query.updateJob ? { ok: false, status: 500, text: async () => 'boom', json: async () => ({}) } : real(u, init));
  const one = await w.run();
  assert.ok(one.problems.length);
  const row = (await readJobRows(w.DB)).get('axel sponsored');
  assert.deepEqual(row.held?.jobtread, ['brian-robins-family-foundation'], 'the question is kept');
  assert.deepEqual(row.pending?.add, ['Jimmy & Helen Carlos'], 'the website’s sponsor is owed to JobTread');
  w.jt.fetchImpl = real;
  await w.run();
  assert.deepEqual(w.jt.jobs[0].values[FIELD_MONETARY_SPONSOR], ['Brian Robins Family Foundation', 'Jimmy & Helen Carlos'], 'written when JobTread takes it');
  assert.equal((await readJobRows(w.DB)).get('axel sponsored').pending, null);
  assert.deepEqual((await w.kid('axel')).sponsors, ['jimmy-helen-carlos'], 'the copy still has the website’s answer: a person settles the rest');
  assert.ok((await readJobRows(w.DB)).get('axel sponsored').held, 'still asked');
});

test('the endpoint answers with the page’s new version only to an editor that wasn’t already behind', async () => {
  const w = await world({ kids: [AXEL], jobs: [axelJob()] });
  await w.run();
  const post = (body) => creditsPost({ env: w.env, data: { userEmail: 'staff@soardcharity.com' }, request: new Request('https://x/api/room-credits-admin', { method: 'POST', body: JSON.stringify(body) }) }).then((r) => r.json());
  // Real JobTread isn't reachable from the endpoint here: a kid with no job writes its own record
  await w.DB.prepare('DELETE FROM room_credit_jobs').run();
  const fresh = (await pageOf(w.DB, 'axel')).sha;
  // Someone else saves the page (the status follows JobTread) after this editor opened it
  await w.DB.prepare('UPDATE kids SET data = ? WHERE slug = ?').bind(JSON.stringify({ ...(await w.kid('axel')), status: 'needs-funding' }), 'axel').run();
  const now = (await pageOf(w.DB, 'axel')).sha;
  assert.notEqual(fresh, now);
  const behind = await post({ set: { record: 'axel', kind: 'designed', partner: 'means-interiors', on: true, sha: fresh } });
  assert.equal(behind.success, true);
  assert.equal(behind.behind, true, 'the page changed since that editor opened it');
  assert.equal(behind.sha, null, 'so it gets no new version: its Save will say someone else changed the page');
  const current = await post({ set: { record: 'axel', kind: 'designed', partner: 'crosby-design-group', on: true, sha: (await pageOf(w.DB, 'axel')).sha } });
  assert.equal(current.behind, false);
  assert.equal(current.sha, (await pageOf(w.DB, 'axel')).sha, 'an editor that was current gets the new version');
  assert.deepEqual(current.page.designers, ['means-interiors', 'crosby-design-group']);
  assert.notEqual(now, current.sha);
  assert.equal((await post({ set: { record: 'axel', kind: 'nope', partner: 'x', on: true } })).error, 'Bad credit');
  assert.equal((await post({ addBack: { record: '../x', kind: 'designed', partner: 'x' } })).error, 'Bad credit');
});

// ── From the second review: each was a real failure before its fix ──

test('an admin pick before the sweep’s first look keeps the website’s credits (the first look runs there)', async () => {
  const w = await world({ kids: [{ ...AXEL, sponsors: ['jimmy-helen-carlos'], jobtreadJobId: 'j-axel' }], jobs: [axelJob({ [FIELD_MONETARY_SPONSOR]: [] })] });
  const r = await w.set({ record: 'axel', kind: 'sponsored', partner: 'brian-robins-family-foundation', on: true });
  assert.deepEqual(r.credits.sort(), ['brian-robins-family-foundation', 'jimmy-helen-carlos']);
  assert.deepEqual(w.jt.jobs[0].values[FIELD_MONETARY_SPONSOR], ['Jimmy & Helen Carlos', 'Brian Robins Family Foundation']);
  await w.run(); await w.run();
  assert.deepEqual((await w.kid('axel')).sponsors.sort(), ['brian-robins-family-foundation', 'jimmy-helen-carlos'], 'still both after the sweeps');
});

test('Designed By deleted in JobTread: the run stops and says so, and no designer is taken off; it isn’t made again', async () => {
  const w = await world({ kids: [AXEL], jobs: [axelJob()] });
  await w.run();
  w.jt.jobs[0].values[DESIGNED] = ['Crosby Design Group'];
  await w.run(MIN); await w.run();
  assert.deepEqual((await w.kid('axel')).designers, ['crosby-design-group']);
  w.jt.fields.splice(w.jt.fields.findIndex((f) => f.id === DESIGNED), 1);
  delete w.jt.jobs[0].values[DESIGNED];
  const r = await w.run();
  assert.ok(r.problems.some((p) => /Designed By field is gone/.test(p)), r.problems.join(' | '));
  await w.run();
  assert.deepEqual((await w.kid('axel')).designers, ['crosby-design-group'], 'kept');
  assert.ok(!w.jt.fields.some((f) => f.name === 'Designed By'), 'not made again by the site');
});

test('a choice spelled differently only by case: it’s the same choice, written as the field spells it, and nothing jams', async () => {
  const w = await world({ kids: [AXEL], jobs: [axelJob()],
    fields: [{ id: FIELD_MONETARY_SPONSOR, name: 'Monetary Sponsor', type: 'option', options: [], maxValuesAllowed: null }, { id: DESIGNED, name: 'Designed By', type: 'option', options: ['crosby design group'], maxValuesAllowed: null }] });
  await w.run();
  assert.ok(!w.jt.fields.find((f) => f.id === DESIGNED).options.includes('Crosby Design Group'), 'no second spelling added');
  w.jt.jobs[0].values[DESIGNED] = ['crosby design group'];
  await w.run(MIN); await w.run();
  assert.deepEqual((await w.kid('axel')).designers, ['crosby-design-group']);
  assert.deepEqual(w.jt.jobs[0].values[DESIGNED], ['crosby design group'], 'no rename for a case difference');
  await w.set({ record: 'axel', kind: 'designed', partner: 'means-interiors', on: true });
  await w.set({ record: 'axel', kind: 'designed', partner: 'crosby-design-group', on: false });
  assert.deepEqual(w.jt.jobs[0].values[DESIGNED], ['Means Interiors']);
  assert.equal((await readJobRows(w.DB)).get('axel designed').pending, null, 'nothing owed');
  // Admin picks of a case-different choice write the field's spelling
  await w.set({ record: 'axel', kind: 'designed', partner: 'crosby-design-group', on: true });
  assert.ok(w.jt.jobs[0].values[DESIGNED].includes('crosby design group'));
});

test('contacts saved for a sponsor staff took off, which JobTread still names at launch: nobody is put on', async () => {
  const w = await world({
    kids: [{ slug: 'lizzie', name: 'Lizzie Francis', year: 2026 }],
    jobs: [{ id: 'j-liz', name: 'Lizzie Francis (2026)', values: { [FIELD_MONETARY_SPONSOR]: ['Brian Robins Family Foundation'] }, access: [] }],
  });
  await w.DB.prepare('CREATE TABLE IF NOT EXISTS sponsor_jobs (record TEXT PRIMARY KEY, job_id TEXT, open INTEGER, field TEXT, dismissed TEXT, synced_at TEXT, result TEXT)').run();
  await w.DB.prepare("INSERT OR REPLACE INTO sponsor_jobs (record, job_id, open, field, dismissed) VALUES ('lizzie', 'j-liz', 1, '', ?)").bind(JSON.stringify(['brian-robins-family-foundation'])).run();
  const r = await w.run();
  assert.deepEqual(r.held[0]?.dismissed, ['brian-robins-family-foundation']);
  await saveContacts(w.DB, 'brian-robins-family-foundation', [{ name: 'Brian', email: 'brian@robins.org' }]);
  const g = await grantForSponsor(w.env, 'brian-robins-family-foundation', { emails: ['brian@robins.org'], fetchImpl: w.jt.fetchImpl, now: w.now(), deps: w.deps });
  assert.deepEqual(g.granted, []);
  assert.deepEqual(w.jt.jobs[0].access, []);
});

test('a write owed to a job that’s gone: the room’s new job gets it, and runs go on', async () => {
  const w = await world({ kids: [AXEL], jobs: [axelJob()] });
  await w.run();
  const real = w.jt.fetchImpl;
  w.jt.fetchImpl = async (u, init) => (JSON.parse(init.body).query.updateJob ? { ok: false, status: 500, text: async () => 'boom', json: async () => ({}) } : real(u, init));
  await setCredit(w.env, { record: 'axel', kind: 'designed', partner: 'crosby-design-group', on: true }, 'x', { fetchImpl: w.jt.fetchImpl, now: w.now() + MIN, deps: w.deps }).catch(() => {});
  w.jt.fetchImpl = real;
  w.jt.jobs.splice(0, 1, { ...axelJob(), id: 'j-axel-2' });
  const r = await w.run();
  assert.deepEqual(r.problems, []);
  assert.equal((await readJobRows(w.DB)).get('axel designed').jobId, 'j-axel-2');
  assert.deepEqual(w.jt.jobs[0].values[DESIGNED], ['Crosby Design Group']);
  assert.deepEqual((await w.run()).problems, []);
});

test('a sponsor put-on that stops at its second contact finishes next run', async () => {
  const w = await world({ kids: [AXEL], jobs: [axelJob()] });
  await saveContacts(w.DB, 'jimmy-helen-carlos', [{ name: 'Jimmy', email: 'jimmy@carlos.org' }, { name: 'Helen', email: 'helen@carlos.org' }]);
  w.deps.addToJob = async () => { w.jt.jobs[0].access.push('jimmy@carlos.org'); w.jt.people.set('jimmy@carlos.org', { id: 'mj', email: 'jimmy@carlos.org', name: 'Jimmy', role: 'Champion' }); return { added: ['Jimmy'], waiting: [] }; };
  await w.run();
  const real = w.jt.fetchImpl;
  let failed = false;
  w.jt.fetchImpl = async (u, init) => { const q = JSON.parse(init.body).query; if (q.createAce && /helen/.test(JSON.stringify(q)) && !failed) { failed = true; return { ok: false, status: 500, text: async () => 'boom', json: async () => ({}) }; } return real(u, init); };
  w.jt.jobs[0].values[FIELD_MONETARY_SPONSOR] = ['Jimmy & Helen Carlos'];
  await w.run(MIN); await w.run();
  assert.ok(!w.jt.jobs[0].access.includes('helen@carlos.org'));
  await w.run();
  assert.ok(w.jt.jobs[0].access.includes('helen@carlos.org'), 'Helen goes on when it finishes');
  assert.deepEqual((await readJobRows(w.DB)).get('axel sponsored').retry, []);
});

test('a company moved off a kid, then picked for it: in the admin, and by the Advisory Board’s Pick the kid, it goes back on', async () => {
  for (const person of [false, true]) {
    const w = await world({ kids: [AXEL], jobs: [axelJob()] });
    await takenOffAt(w, 'jimmy-helen-carlos', 'Jimmy & Helen Carlos', T0);
    await w.run();
    const r = await w.set({ record: 'axel', kind: 'sponsored', partner: 'jimmy-helen-carlos', on: true, person });
    assert.equal(r.put.off, false, 'the pick came after the take-off');
    assert.equal(r.put.logo, true, person ? 'Pick the kid' : 'a pick in the admin');
  }
});

// ── From the third review ──

test('after launch, a new job whose Designed By already names someone the page didn’t have: her pick, on the second look, put on', async () => {
  const w = await world({ kids: [{ ...AXEL, designers: ['crosby-design-group'], partnerLogos: [{ url: CROSBY.logo, name: CROSBY.name }] }], jobs: [] });
  await saveContacts(w.DB, 'means-interiors', [{ name: 'Angela Means', email: 'angela@meansinteriors.com' }]);
  await w.run();
  // A job made after launch (an approval makes one): what's on it is a person's picks
  w.jt.jobs.push(axelJob({ [DESIGNED]: ['Means Interiors'] }, { createdAt: new Date(w.now() + MIN).toISOString() }));
  await w.run();
  assert.deepEqual((await w.kid('axel')).designers, ['crosby-design-group'], 'not taken in before its second look');
  assert.deepEqual(w.jt.jobs[0].values[DESIGNED], ['Means Interiors', 'Crosby Design Group'], 'the page’s credit went into the job');
  await w.run(); await w.run();
  assert.deepEqual((await w.kid('axel')).designers.sort(), ['crosby-design-group', 'means-interiors']);
  assert.ok(w.jt.jobs[0].access.includes('angela@meansinteriors.com'), 'Means, not on the room, was put on');
});

test('a sponsor contact a person took off in JobTread stays off when staff add another contact', async () => {
  const w = await world({
    kids: [{ ...AXEL, sponsors: ['jimmy-helen-carlos'], partnerLogos: [{ url: CARLOS.logo, name: CARLOS.name }] }],
    jobs: [axelJob({ [FIELD_MONETARY_SPONSOR]: [] }, { access: ['jimmy@carlos.org', 'helen@carlos.org'] })],
    members: [{ email: 'jimmy@carlos.org', name: 'Jimmy', role: 'Champion' }, { email: 'helen@carlos.org', name: 'Helen', role: 'Champion' }],
  });
  await saveContacts(w.DB, 'jimmy-helen-carlos', [{ name: 'Jimmy', email: 'jimmy@carlos.org' }, { name: 'Helen', email: 'helen@carlos.org' }]);
  await w.run(); await w.run();
  w.jt.jobs[0].access = ['jimmy@carlos.org'];
  await saveContacts(w.DB, 'jimmy-helen-carlos', [{ name: 'Jimmy', email: 'jimmy@carlos.org' }, { name: 'Helen', email: 'helen@carlos.org' }, { name: 'Ana', email: 'ana@carlos.org' }]);
  await grantForSponsor(w.env, 'jimmy-helen-carlos', { emails: ['ana@carlos.org'], fetchImpl: w.jt.fetchImpl, now: w.now(), deps: w.deps });
  assert.deepEqual(w.jt.jobs[0].access, ['jimmy@carlos.org', 'ana@carlos.org'], 'Ana on; Helen stays off');
});

test('the contacts endpoints pass only the emails just added', async () => {
  const w = await world({ kids: [AXEL], jobs: [axelJob()] });
  const { onRequestPost: sponsorsPost } = await import('../functions/api/sponsors-admin.js');
  await saveContacts(w.DB, 'jimmy-helen-carlos', [{ name: 'Helen', email: 'helen@carlos.org' }]);
  // No credit on any job here, so nobody is granted; this checks the endpoint runs with the old list read first
  const r = await sponsorsPost({ env: { DB: w.DB }, data: { userEmail: 'x' }, request: new Request('https://x', { method: 'POST', body: JSON.stringify({ contacts: { partner: 'jimmy-helen-carlos', people: [{ name: 'Helen', email: 'helen@carlos.org' }, { name: 'Ana', email: 'ana@carlos.org' }] } }) }) }).then((x) => x.json());
  assert.equal(r.success, true);
  assert.deepEqual(r.contacts.map((c) => c.email), ['helen@carlos.org', 'ana@carlos.org']);
});

test('one JobTread blip before "already on the room?" is asked: the retry asks again, and puts nobody on', async () => {
  const w = await world({ kids: [{ ...AXEL, partnerLogos: [{ url: CARLOS.logo, name: CARLOS.name }] }], jobs: [axelJob()] });
  await saveContacts(w.DB, 'jimmy-helen-carlos', [{ name: 'Jimmy', email: 'jimmy@carlos.org' }]);
  await w.run();
  w.jt.fields.find((f) => f.id === FIELD_MONETARY_SPONSOR).options.push('Jimmy & Helen Carlos');
  w.jt.jobs[0].values[FIELD_MONETARY_SPONSOR] = ['Jimmy & Helen Carlos'];
  await w.run(MIN);
  const real = w.jt.fetchImpl;
  let blink = true;
  w.jt.fetchImpl = async (u, init) => { const q = JSON.parse(init.body).query; if (blink && Object.keys(q).some((k) => /^j\d+$/.test(k))) { blink = false; return { ok: false, status: 503, text: async () => 'x', json: async () => ({}) }; } return real(u, init); };
  await w.run();
  w.jt.fetchImpl = real;
  await w.run();
  assert.deepEqual(w.jt.jobs[0].access, [], 'its logo was already on the page: nobody goes on');
  assert.deepEqual(w.put, []);
});

test('a credit naming a partner since deleted from Partners can be taken off (a room with no job)', async () => {
  const w = await world({ kids: [{ slug: 'lexy', name: 'Lexy', year: 2018, status: 'completed', designers: ['gone-design-co'] }], jobs: [] });
  await w.set({ record: 'lexy', kind: 'designed', partner: 'gone-design-co', on: false });
  assert.deepEqual((await w.kid('lexy')).designers, []);
});

test('a credit on a job naming a partner since deleted stays shown until a person takes it off, then leaves JobTread too', async () => {
  const w = await world({ kids: [AXEL], jobs: [axelJob()] });
  await w.run();
  w.jt.jobs[0].values[DESIGNED] = ['Means Interiors'];
  await w.run(MIN); await w.run();
  await w.DB.prepare('DELETE FROM partners WHERE slug = ?').bind('means-interiors').run();
  await w.run();
  assert.deepEqual((await w.kid('axel')).designers, ['means-interiors'], 'kept until a person says');
  await w.set({ record: 'axel', kind: 'designed', partner: 'means-interiors', on: false });
  assert.deepEqual((await w.kid('axel')).designers, []);
  assert.deepEqual(w.jt.jobs[0].values[DESIGNED], []);
});

test('two picks at once on a room with no job: both stand', async () => {
  const w = await world({ kids: [{ slug: 'lexy', name: 'Lexy', year: 2018, status: 'completed' }], jobs: [] });
  await Promise.all([
    w.set({ record: 'lexy', kind: 'designed', partner: 'crosby-design-group', on: true }),
    w.set({ record: 'lexy', kind: 'designed', partner: 'means-interiors', on: true }),
  ]);
  assert.deepEqual((await w.kid('lexy')).designers.sort(), ['crosby-design-group', 'means-interiors']);
});

test('the copy isn’t written over a person’s Save that landed after it was read', async () => {
  const w = await world({ kids: [AXEL], jobs: [axelJob()] });
  await w.run();
  w.jt.jobs[0].values[DESIGNED] = ['Crosby Design Group'];
  await w.run(MIN);
  // A person saves the page (a new hero summary) between the sweep's read and its write: the write reads again
  const realPrepare = w.DB.prepare.bind(w.DB);
  let once = true;
  w.DB.prepare = (sql) => {
    const st = realPrepare(sql);
    if (once && /^UPDATE kids SET "data"/.test(sql)) {
      once = false;
      const realBind = st.bind.bind(st);
      st.bind = (...a) => { const b = realBind(...a); const run = b.run.bind(b); b.run = async () => { await realPrepare('UPDATE kids SET data = ? WHERE slug = ?').bind(JSON.stringify({ ...JSON.parse((await realPrepare("SELECT data FROM kids WHERE slug = 'axel'").first()).data), heroSummary: 'A person’s words' }), 'axel').run(); return run(); }; return b; };
    }
    return st;
  };
  await w.run();
  w.DB.prepare = realPrepare;
  const k = await w.kid('axel');
  assert.equal(k.heroSummary, 'A person’s words', 'their Save stands');
  assert.deepEqual(k.designers, ['crosby-design-group'], 'and the credit went on top of it');
});

// ── From the fourth review ──

test('a job value whose choice a person deleted in JobTread doesn’t jam the room: writes and picks go on', async () => {
  const w = await world({
    kids: [{ ...AXEL, sponsors: ['jimmy-helen-carlos'] }],
    jobs: [axelJob({ [FIELD_MONETARY_SPONSOR]: ['Old Name Since Deleted'] })],
    fields: [{ id: FIELD_MONETARY_SPONSOR, name: 'Monetary Sponsor', type: 'option', options: ['Beazer'], maxValuesAllowed: null }],
  });
  const r1 = await w.run();
  assert.deepEqual(r1.problems, []);
  assert.deepEqual(w.jt.jobs[0].values[FIELD_MONETARY_SPONSOR], ['Old Name Since Deleted', 'Jimmy & Helen Carlos'], 'the job keeps its value, and the website’s sponsor goes in');
  w.jt.jobs[0].values[FIELD_MONETARY_SPONSOR] = [...w.jt.jobs[0].values[FIELD_MONETARY_SPONSOR], 'Brian Robins Family Foundation'];
  await w.run(); await w.run();
  assert.deepEqual((await w.kid('axel')).sponsors.sort(), ['brian-robins-family-foundation', 'jimmy-helen-carlos'], 'her pick reaches the website');
  await w.set({ record: 'axel', kind: 'sponsored', partner: 'crosby-design-group', on: true });
  assert.ok(w.jt.jobs[0].values[FIELD_MONETARY_SPONSOR].includes('Crosby Design Group'), 'and the admin door works');
});

test('a credit a person took off, still owed to JobTread when the room’s job changes, stays off', async () => {
  const w = await world({ kids: [{ ...AXEL, designers: ['crosby-design-group'] }], jobs: [axelJob({ [DESIGNED]: ['Crosby Design Group'] })] });
  await w.run();
  const real = w.jt.fetchImpl;
  w.jt.fetchImpl = async (u, init) => (JSON.parse(init.body).query.updateJob ? { ok: false, status: 500, text: async () => 'boom', json: async () => ({}) } : real(u, init));
  await setCredit(w.env, { record: 'axel', kind: 'designed', partner: 'crosby-design-group', on: false }, 'staff', { fetchImpl: w.jt.fetchImpl, now: w.now() + MIN, deps: w.deps }).catch(() => {});
  w.jt.fetchImpl = real;
  w.jt.jobs.splice(0, 1, { ...axelJob(), id: 'j-axel-2' });
  await w.run(); await w.run(); await w.run();
  assert.deepEqual(w.jt.jobs[0].values[DESIGNED] || [], [], 'not written into the new job');
  assert.deepEqual((await w.kid('axel')).designers, [], 'and off the page');
});

test('a room whose job is deleted in JobTread goes on as a room with no job: its credits can still be changed', async () => {
  const w = await world({ kids: [{ ...AXEL, designers: ['crosby-design-group'] }], jobs: [axelJob({ [DESIGNED]: ['Crosby Design Group'] })] });
  await w.run();
  w.jt.jobs.splice(0, 1);
  const r = await w.run();
  assert.deepEqual(r.unlinked, ['axel'], 'the sweep says so');
  assert.equal((await readJobRows(w.DB)).get('axel designed'), undefined);
  const out = await w.set({ record: 'axel', kind: 'designed', partner: 'crosby-design-group', on: false });
  assert.equal(out.job, null);
  assert.deepEqual((await w.kid('axel')).designers, []);
  // And a pinned job id that's gone is handled the same way
  await w.DB.prepare('UPDATE kids SET data = ? WHERE slug = ?').bind(JSON.stringify({ ...(await w.kid('axel')), jobtreadJobId: 'j-gone' }), 'axel').run();
  const again = await w.set({ record: 'axel', kind: 'designed', partner: 'means-interiors', on: true });
  assert.equal(again.job, null);
  assert.deepEqual((await w.kid('axel')).designers, ['means-interiors']);
});

test('Add them back is only for a company credited on that room', async () => {
  const w = await world({ kids: [AXEL], jobs: [axelJob()] });
  await w.run();
  await assert.rejects(() => addBack(w.env, { record: 'axel', kind: 'designed', partner: 'crosby-design-group' }, 'staff', { fetchImpl: w.jt.fetchImpl, now: w.now(), deps: w.deps }), /isn’t credited/);
  assert.deepEqual(w.put, []);
});

test('an admin pick for one kind uses the room’s job read for the other', async () => {
  const w = await world({ kids: [AXEL], jobs: [axelJob()] });
  await w.run();
  await w.DB.prepare("DELETE FROM room_credit_jobs WHERE kind = 'designed'").run();
  const out = await w.set({ record: 'axel', kind: 'designed', partner: 'crosby-design-group', on: true });
  assert.equal(out.job, 'j-axel', 'JobTread written, not just the page');
  assert.deepEqual(w.jt.jobs[0].values[DESIGNED], ['Crosby Design Group']);
});

// ── From the fifth review ──
const acesTo = (jt) => jt.calls.filter((q) => q.createAce).map((q) => q.createAce.$.assignee.emailAddress || q.createAce.$.assignee.membershipId);

test('a job that stops matching its kid for a while (a rename) keeps its room: the question for a person stays, nobody is put on', async () => {
  const w = await world({
    kids: [{ slug: 'lizzie', name: 'Lizzie Francis', year: 2026 }],
    jobs: [{ id: 'j-liz', name: 'Lizzie Francis (2026)', values: { [FIELD_MONETARY_SPONSOR]: ['Brian Robins Family Foundation'] }, access: [] }],
  });
  await saveContacts(w.DB, 'brian-robins-family-foundation', [{ name: 'Brian', email: 'brian@robins.org' }]);
  const r1 = await w.run();
  assert.deepEqual(r1.held.map((h) => h.record), ['lizzie']);
  w.jt.jobs[0].name = 'Lizzie Fran. (2026)';
  const r2 = await w.run();
  assert.equal(r2.unlinked, undefined, 'still its room: the job is still there');
  assert.ok((await readJobRows(w.DB)).get('lizzie sponsored')?.held, 'the question stays');
  w.jt.jobs[0].name = 'Lizzie Francis (2026)';
  await w.run(); await w.run(); await w.run();
  assert.deepEqual((await w.kid('lizzie')).sponsors || [], [], 'still the website’s answer until a person says');
  assert.deepEqual(acesTo(w.jt), [], 'nobody given access');
});

test('a credit taken off while the job’s name didn’t match its kid stays off when it matches again', async () => {
  const w = await world({ kids: [{ ...AXEL, designers: ['crosby-design-group'] }], jobs: [axelJob({ [DESIGNED]: ['Crosby Design Group'] })] });
  await w.run();
  w.jt.jobs[0].name = 'Axel P. Arnao (2026)';
  await w.run();
  const off = await w.set({ record: 'axel', kind: 'designed', partner: 'crosby-design-group', on: false });
  assert.equal(off.job, 'j-axel', 'the room still writes its job');
  assert.deepEqual(w.jt.jobs[0].values[DESIGNED], []);
  w.jt.jobs[0].name = 'Axel Puente Arnao (2026)';
  await w.run(); await w.run(); await w.run();
  assert.deepEqual((await w.kid('axel')).designers, []);
  assert.deepEqual(w.put, []);
});

test('a warranty job named like the kid doesn’t take the room’s credits from its job', async () => {
  const w = await world({ kids: [{ ...AXEL, designers: ['crosby-design-group'] }], jobs: [axelJob({ [DESIGNED]: ['Crosby Design Group'] }, { closedOn: '2026-06-01' })] });
  await w.run();
  w.jt.jobs.push({ id: 'j-warranty', name: 'Axel Puente Arnao (2026)', values: {}, access: [], createdAt: new Date(w.now()).toISOString() });
  await w.run(); await w.run();
  assert.equal((await readJobRows(w.DB)).get('axel designed').jobId, 'j-axel');
  assert.deepEqual(w.jt.jobs[1].values[DESIGNED] || [], [], 'nothing written to the warranty job');
  assert.deepEqual((await w.kid('axel')).designers, ['crosby-design-group']);
});

test('an older job first linked after launch: what it says is a question for a person, never picks that put anyone on', async () => {
  const w = await world({ kids: [{ ...AXEL, name: 'Axel P' }], jobs: [axelJob({ [DESIGNED]: ['Means Interiors'] })] });
  await saveContacts(w.DB, 'means-interiors', [{ name: 'Angela', email: 'angela@meansinteriors.com' }]);
  await w.run();
  assert.equal((await readJobRows(w.DB)).get('axel designed'), undefined, 'not linked (the names differ)');
  await w.DB.prepare('UPDATE kids SET data = ? WHERE slug = ?').bind(JSON.stringify({ ...(await w.kid('axel')), name: 'Axel Puente Arnao' }), 'axel').run();
  const r = await w.run(); await w.run(); await w.run();
  assert.deepEqual(r.held.map((h) => h.record), ['axel'], 'asked');
  assert.deepEqual(acesTo(w.jt), []);
  assert.deepEqual((await w.kid('axel')).designers || [], []);
});

test('an admin pick waits for a sweep that’s running and builds on what it settled', async () => {
  const w = await world({ kids: [{ ...AXEL, sponsors: ['jimmy-helen-carlos', 'brian-robins-family-foundation'] }], jobs: [axelJob({ [FIELD_MONETARY_SPONSOR]: ['Jimmy & Helen Carlos', 'Brian Robins Family Foundation'] })] });
  await w.run();
  w.jt.jobs[0].values[FIELD_MONETARY_SPONSOR] = ['Jimmy & Helen Carlos'];
  await w.run(MIN);
  w.later(SECOND_LOOK_MS);
  await w.DB.prepare('INSERT OR REPLACE INTO kid_partner_lock (name, until) VALUES (?, ?)').bind('room-credits', Date.now() + 60_000).run();
  const t0 = w.now();
  const pick = setCredit(w.env, { record: 'axel', kind: 'sponsored', partner: 'crosby-design-group', on: true, put: false }, 'staff', { fetchImpl: w.jt.fetchImpl, now: t0 + MIN, deps: w.deps });
  await new Promise((r) => setTimeout(r, 300));
  await w.DB.prepare('DELETE FROM kid_partner_lock WHERE name = ?').bind('room-credits').run();
  await syncCredits(w.env, { fetchImpl: w.jt.fetchImpl, now: t0, deps: w.deps });
  await pick;
  const kid = await w.kid('axel');
  assert.ok(!kid.sponsors.includes('brian-robins-family-foundation'), 'Robins, taken off in JobTread and settled, stays off');
  assert.ok(kid.sponsors.includes('crosby-design-group'));
});

test('an admin pick whose put-on fails: the credit stands, the admin hears it’s tried again, and the next run finishes it', async () => {
  const w = await world({ kids: [AXEL], jobs: [axelJob()] });
  await saveContacts(w.DB, 'jimmy-helen-carlos', [{ name: 'Jimmy', email: 'jimmy@carlos.org' }, { name: 'Helen', email: 'helen@carlos.org' }]);
  await w.run();
  const real = w.deps.addToJob;
  w.deps.addToJob = async () => { throw new Error('JobTread is down'); };
  const r = await w.set({ record: 'axel', kind: 'sponsored', partner: 'jimmy-helen-carlos', on: true });
  assert.equal(r.put.retry, true);
  assert.deepEqual((await w.kid('axel')).sponsors, ['jimmy-helen-carlos'], 'the credit stands');
  assert.deepEqual(await retryOf(w, 'axel sponsored'), [{ s: 'jimmy-helen-carlos', r: true }]);
  w.deps.addToJob = real;
  await w.run();
  assert.ok(acesTo(w.jt).includes('helen@carlos.org') && acesTo(w.jt).includes('jimmy@carlos.org'), 'its contacts go on');
});

// ── From the sixth review ──

test('an admin pick whose put-on fails after the logo went on says the logo went on, so Undo takes it back; taking the credit off ends the retry', async () => {
  const w = await world({ kids: [AXEL], jobs: [axelJob()] });
  await w.run();
  w.deps.addToJob = async () => { throw new Error('JobTread is down'); };
  const r = await w.set({ record: 'axel', kind: 'designed', partner: 'crosby-design-group', on: true });
  assert.equal(r.put.logo, true, 'the logo did go on');
  assert.equal(r.put.retry, true);
  await w.set({ record: 'axel', kind: 'designed', partner: 'crosby-design-group', on: false, put: false });
  assert.deepEqual((await readJobRows(w.DB)).get('axel designed').retry, [], 'nothing left to finish');
});

test('a credit naming a company no longer in Partners stays through a first look, until a person takes it off', async () => {
  const w = await world({ kids: [{ ...AXEL, sponsors: ['old-sponsor-gone', 'jimmy-helen-carlos'] }], jobs: [axelJob({ [FIELD_MONETARY_SPONSOR]: [] })] });
  await w.run(); await w.run();
  assert.deepEqual((await w.kid('axel')).sponsors, ['old-sponsor-gone', 'jimmy-helen-carlos'], 'kept, in its place (shown “not in Partners” on the card)');
  await w.set({ record: 'axel', kind: 'sponsored', partner: 'old-sponsor-gone', on: false });
  assert.deepEqual((await w.kid('axel')).sponsors, ['jimmy-helen-carlos']);
});

test('a page Save never writes over a credit that landed while it was being saved: it’s refused, the editor reloads', async () => {
  const w = await world({ kids: [AXEL], jobs: [] });
  const { onRequestPost: savePost } = await import('../functions/api/save-content.js');
  const { generateSha } = await import('../functions/api/_collections.js');
  const raw = (await w.DB.prepare("SELECT data FROM kids WHERE slug = 'axel'").first()).data;
  const sha = await generateSha(raw);
  const realPrepare = w.DB.prepare.bind(w.DB);
  let once = true;
  w.DB.prepare = (sql) => {
    const st = realPrepare(sql);
    if (once && /^UPDATE kids SET "data"/.test(sql)) {
      once = false;
      const bind = st.bind.bind(st);
      st.bind = (...a) => { const b = bind(...a); const run = b.run.bind(b); b.run = async () => { await realPrepare('UPDATE kids SET data = ? WHERE slug = ?').bind(JSON.stringify({ ...JSON.parse(raw), designers: ['crosby-design-group'] }), 'axel').run(); return run(); }; return b; };
    }
    return st;
  };
  const res = await savePost({ env: { DB: w.DB }, data: { userEmail: 'x' }, waitUntil: () => {}, request: new Request('https://x', { method: 'POST', body: JSON.stringify({ path: 'src/content/kids/axel.json', content: JSON.stringify({ ...JSON.parse(raw), heroSummary: 'Edited' }), message: 'm', sha }) }) });
  w.DB.prepare = realPrepare;
  assert.equal(res.status, 409);
  assert.deepEqual((await w.kid('axel')).designers, ['crosby-design-group'], 'the credit stands');
});

// ── From the seventh review ──

test('a room whose job is replaced by an older job: what the older job says is a question for a person, nobody put on', async () => {
  const w = await world({ kids: [{ ...AXEL, designers: ['crosby-design-group'] }], jobs: [axelJob({ [DESIGNED]: ['Crosby Design Group'] })] });
  await saveContacts(w.DB, 'means-interiors', [{ name: 'Angela', email: 'angela@meansinteriors.com' }]);
  await w.run();
  // Axel's job is deleted; an older job of the same name, made in 2024, says Means
  w.jt.jobs.splice(0, 1, { id: 'j-axel-2024', name: 'Axel Puente Arnao (2026)', values: { [DESIGNED]: ['Means Interiors'] }, access: [], createdAt: '2024-03-01T00:00:00Z' });
  const r = await w.run(); await w.run(); await w.run();
  assert.deepEqual(r.held.map((h) => h.record), ['axel'], 'asked');
  assert.deepEqual(acesTo(w.jt), []);
  assert.deepEqual((await w.kid('axel')).designers, ['crosby-design-group'], 'the website’s answer until a person says');
  assert.deepEqual(w.jt.jobs[0].values[DESIGNED].sort(), ['Crosby Design Group', 'Means Interiors'], 'what the room had went into the job');
});

test('a run cut off after the logo went on (before the job) finishes next run', async () => {
  const w = await world({ kids: [AXEL], jobs: [axelJob()] });
  await w.run();
  w.jt.jobs[0].values[DESIGNED] = ['Crosby Design Group'];
  await w.run(MIN);
  // The run is cut off inside Add to job: nothing after it happens (no catch, no row written after)
  const real = w.deps.addToJob;
  w.deps.addToJob = async () => { throw Object.assign(new Error('cut off'), { cut: true }); };
  await w.run();
  w.deps.addToJob = real;
  assert.deepEqual(await retryOf(w, 'axel designed'), [{ s: 'crosby-design-group', r: true }], 'marked past “already on?” before anything was put on');
  await w.run();
  assert.ok(w.put.some((x) => x.job === 'Crosby Design Group'), 'Add to job finished');
});

// ── From the eighth review ──

const LIZ = { slug: 'lizzie', name: 'Lizzie Francis', year: 2026 };
const lizJob = (v, more = {}) => ({ id: 'j-liz', name: 'Lizzie Francis (2026)', values: { [FIELD_MONETARY_SPONSOR]: v }, access: [], ...more });
const robinsOnly = [{ id: FIELD_MONETARY_SPONSOR, name: 'Monetary Sponsor', type: 'option', options: ['Brian Robins Family Foundation'], maxValuesAllowed: null }];
const heldOf = async (w) => (await readJobRows(w.DB)).get('lizzie sponsored')?.held || null;

test('a question launch left open still takes Clareece’s changes: her taking the name out closes it, and her next pick reaches the page', async () => {
  const w = await world({ kids: [LIZ], jobs: [lizJob(['Brian Robins Family Foundation'])], fields: robinsOnly });
  await w.run();
  assert.deepEqual((await heldOf(w))?.jobtread, ['brian-robins-family-foundation'], 'launch asks');
  w.jt.jobs[0].values[FIELD_MONETARY_SPONSOR] = [];
  await w.run(MIN); await w.run();
  assert.equal(await heldOf(w), null, 'the name it asked about is gone from JobTread: nothing left to ask');
  assert.deepEqual((await creditsView(w.env)).held, []);
  w.jt.jobs[0].values[FIELD_MONETARY_SPONSOR] = ['Jimmy & Helen Carlos'];
  await w.run(MIN); await w.run();
  assert.deepEqual((await w.kid('lizzie')).sponsors, ['jimmy-helen-carlos'], 'her pick is on the page');
  assert.ok(w.put.some((x) => x.logo === 'Jimmy & Helen Carlos'), 'and the company put on, once');
});

test('while launch’s question is open, Clareece’s pick joins the website’s answer on the page, and the question stays', async () => {
  const w = await world({ kids: [{ ...LIZ, sponsors: ['means-interiors'] }], jobs: [lizJob(['Brian Robins Family Foundation'])], fields: robinsOnly });
  await w.run();
  w.jt.jobs[0].values[FIELD_MONETARY_SPONSOR] = [...w.jt.jobs[0].values[FIELD_MONETARY_SPONSOR], 'Jimmy & Helen Carlos'];
  await w.run(MIN); await w.run();
  assert.deepEqual((await w.kid('lizzie')).sponsors, ['means-interiors', 'jimmy-helen-carlos'], 'the website’s answer, with her pick: never the name asked about');
  assert.deepEqual(await heldOf(w), { jobtread: ['brian-robins-family-foundation'], website: ['means-interiors', 'jimmy-helen-carlos'], dismissed: [] });
  // And her taking the website's own sponsor out in JobTread takes it off the page too
  w.jt.jobs[0].values[FIELD_MONETARY_SPONSOR] = w.jt.jobs[0].values[FIELD_MONETARY_SPONSOR].filter((x) => x !== 'Means Interiors');
  await w.run(MIN); await w.run();
  assert.deepEqual((await w.kid('lizzie')).sponsors, ['jimmy-helen-carlos']);
  assert.deepEqual((await heldOf(w)).jobtread, ['brian-robins-family-foundation'], 'still asked');
});

test('an admin pick JobTread doesn’t take while launch’s question is open: the page gets the pick, never the name asked about', async () => {
  const w = await world({ kids: [LIZ], jobs: [lizJob(['Brian Robins Family Foundation'])], fields: robinsOnly });
  await w.run();
  const real = w.jt.fetchImpl;
  w.jt.fetchImpl = async (u, init) => (JSON.parse(init.body).query.updateJob ? { ok: false, status: 503, text: async () => 'down', json: async () => ({}) } : real(u, init));
  const r = await w.set({ record: 'lizzie', kind: 'sponsored', partner: 'jimmy-helen-carlos', on: true });
  assert.ok(r.owed, 'owed: written by the next run');
  assert.deepEqual((await w.kid('lizzie')).sponsors, ['jimmy-helen-carlos'], 'the website’s answer with the pick');
  assert.deepEqual((await heldOf(w))?.jobtread, ['brian-robins-family-foundation'], 'the question stays for a person');
  w.jt.fetchImpl = real;
  await w.run();
  assert.deepEqual(w.jt.jobs[0].values[FIELD_MONETARY_SPONSOR], ['Brian Robins Family Foundation', 'Jimmy & Helen Carlos'], 'the write finished');
  assert.deepEqual((await w.kid('lizzie')).sponsors, ['jimmy-helen-carlos'], 'still the website’s answer');
});

test('a room whose job is replaced while launch’s question is open moves the website’s answer, never the name asked about', async () => {
  const w = await world({ kids: [{ ...LIZ, sponsors: ['means-interiors'] }], jobs: [lizJob(['Brian Robins Family Foundation'])], fields: robinsOnly });
  await w.run();
  // The job is deleted in JobTread and a new one made for her
  w.jt.jobs.splice(0, 1, lizJob([], { id: 'j-liz2', createdAt: new Date(w.now() + MIN).toISOString() }));
  await w.run(); await w.run();
  assert.deepEqual(w.jt.jobs[0].values[FIELD_MONETARY_SPONSOR], ['Means Interiors'], 'the new job has the website’s answer');
  assert.deepEqual((await w.kid('lizzie')).sponsors, ['means-interiors']);
  assert.deepEqual(w.put, [], 'moving puts nobody on');
});

test('launch: the same couple spelled the other way round in JobTread is the same sponsor, one spelling, nothing asked', async () => {
  const w = await world({ kids: [{ ...AXEL, sponsors: ['jimmy-helen-carlos'] }], jobs: [axelJob({ [FIELD_MONETARY_SPONSOR]: ['Helen & Jimmy Carlos'] })] });
  const r = await w.run();
  assert.deepEqual(r.unknown, [], 'not a stranger');
  assert.deepEqual(r.held, [], 'nothing to ask');
  assert.deepEqual(w.jt.jobs[0].values[FIELD_MONETARY_SPONSOR], ['Jimmy & Helen Carlos'], 'spelled as Partners spells it, once');
  assert.deepEqual((await w.kid('axel')).sponsors, ['jimmy-helen-carlos']);
  assert.deepEqual(w.put, []);
  assert.equal(aces(w.jt), 0, 'no invite starts from it');
});

test('a put-on still to finish isn’t finished once a person takes the company off after the pick', async () => {
  const w = await world({ kids: [AXEL], jobs: [axelJob()] });
  await w.run();
  w.deps.pageLogosOn = async () => { throw new Error('That page is busy'); };
  w.jt.jobs[0].values[DESIGNED] = ['Crosby Design Group'];
  await w.run(MIN); await w.run();
  assert.equal((await retryOf(w, 'axel designed')).length, 1, 'to finish next run');
  await takenOffAt(w, 'crosby-design-group', 'Crosby Design Group', w.now() + 1000);
  w.deps.pageLogosOn = async () => { w.put.push({ late: true }); return {}; };
  await w.run();
  assert.deepEqual(w.put, [], 'the take-off came after the pick: it stands');
  assert.deepEqual(await retryOf(w, 'axel designed'), [], 'and there’s nothing left to finish');
  assert.deepEqual((await w.kid('axel')).designers, ['crosby-design-group'], 'the credit stands');
});

test('a name a person said isn’t a company isn’t counted as waiting for one', async () => {
  const w = await world({ kids: [AXEL], jobs: [axelJob({ [FIELD_MONETARY_SPONSOR]: ['SOARF'] })] });
  assert.equal((await w.run()).unknown.length, 1);
  await setNotCompany(w.DB, 'SOARF');
  assert.deepEqual((await w.run()).unknown, []);
});

test('a run that stops says why as a code, for Automations', async () => {
  const w = await world({ kids: [AXEL], jobs: [axelJob()] });
  await w.run();
  w.jt.fields.splice(w.jt.fields.findIndex((f) => f.id === DESIGNED), 1);
  const r = await w.run();
  assert.ok(r.problems.some((x) => /Designed By field is gone/.test(x)));
  const last = JSON.parse((await w.DB.prepare("SELECT value FROM room_credit_state WHERE key = 'last'").first()).value);
  assert.equal(last.code, 'designed-gone');
  assert.deepEqual((await w.kid('axel')).designers || [], [], 'nothing taken off');
});

// ── From the ninth review ──

test('a staff credit change between Clareece’s pick and its second look keeps her pick waiting, and when she made it', async () => {
  const w = await world({ kids: [AXEL], jobs: [axelJob()] });
  await w.run();
  w.jt.jobs[0].values[DESIGNED] = ['Crosby Design Group'];
  await w.run(MIN);
  w.later(30 * 1000);
  // A person takes Crosby off after her pick, then staff credit Means on the same card
  await takenOffAt(w, 'crosby-design-group', 'Crosby Design Group', w.now());
  await w.set({ record: 'axel', kind: 'designed', partner: 'means-interiors', on: true, put: false });
  const row = (await readJobRows(w.DB)).get('axel designed');
  assert.deepEqual(row.next?.map((x) => x.p).sort(), ['crosby-design-group', 'means-interiors'], 'still waiting, with the staff change made to it');
  await w.run(SECOND_LOOK_MS); await w.run(SECOND_LOOK_MS);
  assert.deepEqual(w.put.filter((x) => (x.logo || x.job) === 'Crosby Design Group'), [], 'the take-off after her pick stands');
  assert.deepEqual((await w.kid('axel')).designers.sort(), ['crosby-design-group', 'means-interiors']);
});

test('Use JobTread’s keeps a pick a person made here that JobTread hasn’t taken yet', async () => {
  const w = await world({ kids: [LIZ], jobs: [lizJob(['Brian Robins Family Foundation'])], fields: robinsOnly });
  await w.run();
  const real = w.jt.fetchImpl;
  w.jt.fetchImpl = async (u, init) => (JSON.parse(init.body).query.updateJob ? { ok: false, status: 503, text: async () => 'down', json: async () => ({}) } : real(u, init));
  assert.ok((await w.set({ record: 'lizzie', kind: 'sponsored', partner: 'jimmy-helen-carlos', on: true, put: false })).owed);
  w.jt.fetchImpl = real;
  w.later(MIN);
  await settleHeld(w.env, { record: 'lizzie', kind: 'sponsored', use: 'jobtread' }, 'staff', { fetchImpl: w.jt.fetchImpl, now: w.now() });
  assert.deepEqual((await w.kid('lizzie')).sponsors.sort(), ['brian-robins-family-foundation', 'jimmy-helen-carlos'], 'JobTread’s, with the pick still owed to it');
  await w.run();
  assert.deepEqual((await w.kid('lizzie')).sponsors.sort(), ['brian-robins-family-foundation', 'jimmy-helen-carlos'], 'unchanged when the write lands: one save, not two');
});

test('Take it out of JobTread when JobTread doesn’t take it just now: the answer stands, and the write is owed', async () => {
  const w = await world({ kids: [{ ...LIZ, sponsors: ['means-interiors'] }], jobs: [lizJob(['Brian Robins Family Foundation'])], fields: robinsOnly });
  await w.run();
  const real = w.jt.fetchImpl;
  w.jt.fetchImpl = async (u, init) => (JSON.parse(init.body).query.updateJob ? { ok: false, status: 503, text: async () => 'down', json: async () => ({}) } : real(u, init));
  const r = await settleHeld(w.env, { record: 'lizzie', kind: 'sponsored', use: 'website' }, 'staff', { fetchImpl: w.jt.fetchImpl, now: w.now() });
  assert.ok(r.owed, 'said: JobTread follows');
  assert.equal(await heldOf(w), null, 'settled');
  assert.deepEqual((await w.kid('lizzie')).sponsors, ['means-interiors']);
  w.jt.fetchImpl = real;
  await w.run();
  assert.deepEqual(w.jt.jobs[0].values[FIELD_MONETARY_SPONSOR], ['Means Interiors'], 'taken out of JobTread when it takes it');
  assert.deepEqual((await w.kid('lizzie')).sponsors, ['means-interiors']);
});

test('a page deleted with its job still in JobTread: nothing is asked about it, and its rows go', async () => {
  const fields = [{ id: FIELD_MONETARY_SPONSOR, name: 'Monetary Sponsor', type: 'option', options: ['Brian Robins Family Foundation', 'SOARF'], maxValuesAllowed: null }];
  // (Another kid as well: a read that found no pages at all lets nothing go)
  const w = await world({ kids: [LIZ, AXEL], jobs: [lizJob(['Brian Robins Family Foundation', 'SOARF']), axelJob()], fields });
  await w.run();
  assert.equal((await creditsView(w.env)).held.length, 1);
  await w.DB.prepare("DELETE FROM kids WHERE slug = 'lizzie'").run();
  const v = await creditsView(w.env);
  assert.deepEqual([v.held, v.unknown], [[], []], 'nothing to ask about a page that’s gone, even before the next run');
  const r = await w.run();
  assert.deepEqual(r.unlinked, ['lizzie']);
  assert.deepEqual([...(await readJobRows(w.DB)).keys()].sort(), ['axel designed', 'axel sponsored']);
  const last = JSON.parse((await w.DB.prepare("SELECT value FROM room_credit_state WHERE key = 'last'").first()).value);
  assert.deepEqual([last.held, last.unknown], [0, 0], 'Automations counts nothing for it');
});

test('a sponsor contact added in Kids names the page it went on, for the toast', async () => {
  const w = await world({ kids: [AXEL], jobs: [axelJob()] });
  await saveContacts(w.DB, 'jimmy-helen-carlos', [{ name: 'Jimmy', email: 'jimmy@carlos.org' }]);
  await w.run();
  w.jt.jobs[0].values[FIELD_MONETARY_SPONSOR] = ['Jimmy & Helen Carlos'];
  await w.run(MIN); await w.run();
  await saveContacts(w.DB, 'jimmy-helen-carlos', [{ name: 'Jimmy', email: 'jimmy@carlos.org' }, { name: 'Ana', email: 'ana@carlos.org' }]);
  const r = await grantForSponsor(w.env, 'jimmy-helen-carlos', { emails: ['ana@carlos.org'], fetchImpl: w.jt.fetchImpl, now: w.now(), deps: w.deps });
  assert.deepEqual(r.granted, [{ record: 'axel', kid: 'Axel Puente Arnao', name: 'Ana' }]);
});

test('a change JobTread keeps refusing stays owed, and doesn’t stop her own changes reaching the page', async () => {
  const w = await world({ kids: [{ ...AXEL, sponsors: ['jimmy-helen-carlos', 'brian-robins-family-foundation'] }],
    jobs: [axelJob({ [FIELD_MONETARY_SPONSOR]: ['Brian Robins Family Foundation'] }, { closedOn: '2025-06-01' })] });
  const real = w.jt.fetchImpl;
  w.jt.fetchImpl = async (u, init) => (JSON.parse(init.body).query.updateJob ? { ok: false, status: 400, text: async () => 'job is closed', json: async () => ({}) } : real(u, init));
  await w.run();
  assert.deepEqual((await w.kid('axel')).sponsors, ['jimmy-helen-carlos', 'brian-robins-family-foundation'], 'the page keeps its answer while the write is owed');
  // Clareece takes Robins off the job herself
  w.jt.jobs[0].values[FIELD_MONETARY_SPONSOR] = [];
  for (let i = 0; i < 3; i++) await w.run();
  assert.deepEqual((await w.kid('axel')).sponsors, ['jimmy-helen-carlos'], 'her change reached the page; the owed one is still shown');
  const row = (await readJobRows(w.DB)).get('axel sponsored');
  assert.ok(row.pending?.tries >= 3, 'still owed, counted');
  const v = await creditsView(w.env, { record: 'axel', fetchImpl: w.jt.fetchImpl });
  assert.ok(v.room.kinds.sponsored.pending.tries >= 3 && /HTTP 400|400|closed/.test(v.room.kinds.sponsored.pending.error || ''), 'the card can say why');
  // She makes the same change in JobTread herself: settled, nothing left owed
  w.jt.jobs[0].values[FIELD_MONETARY_SPONSOR] = ['Jimmy & Helen Carlos'];
  await w.run();
  assert.equal((await readJobRows(w.DB)).get('axel sponsored').pending, null);
  await w.run(); await w.run();
  assert.deepEqual((await w.kid('axel')).sponsors, ['jimmy-helen-carlos']);
});

test('a run cut short by its time budget is taken up where it stopped, and launch finishes over several runs', async () => {
  const N = 24;
  const kids = Array.from({ length: N }, (_, i) => ({ slug: `kid-${i}`, name: `Kid${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))} Zed`, year: 2026 }));
  const jobs = kids.map((k, i) => ({ id: `j-${i}`, name: `${k.name} (2026)`, values: {}, access: [] }));
  const w = await world({ kids, jobs });
  // Each row write takes a while, as D1 can
  const prep = w.DB.prepare.bind(w.DB);
  let writes = 0;
  w.DB.prepare = (sql) => {
    const st = prep(sql);
    if (!/INTO room_credit_jobs/.test(sql)) return st;
    const bind = st.bind.bind(st);
    st.bind = (...a) => { const b = bind(...a); const run = b.run.bind(b); b.run = async () => { writes += 1; await new Promise((r) => setTimeout(r, 25)); return run(); }; return b; };
    return st;
  };
  const runs = [];
  for (let i = 0; i < 12 && !runs.some((x) => x === false); i++) {
    w.later(SECOND_LOOK_MS);
    runs.push((await syncCredits(w.env, { fetchImpl: w.jt.fetchImpl, now: w.now(), deps: w.deps, budget: 200 })).more);
  }
  assert.ok(runs.length > 1 && runs.slice(0, -1).every(Boolean), `several runs, each cut short (${runs.join(', ')})`);
  assert.equal(new Set([...(await readJobRows(w.DB)).values()].map((r) => r.record)).size, N, 'every room reached');
  assert.ok(await w.DB.prepare("SELECT value FROM room_credit_state WHERE key = 'launched'").first(), 'launch is over');
  // Nothing new: a run writes no row
  writes = 0;
  w.later(SECOND_LOOK_MS);
  await syncCredits(w.env, { fetchImpl: w.jt.fetchImpl, now: w.now(), deps: w.deps });
  assert.equal(writes, 0, 'nothing written when nothing changed');
});

test('Same as reaches every room whose field says the name at once, its page too, and puts nobody on', async () => {
  const fields = [{ id: FIELD_MONETARY_SPONSOR, name: 'Monetary Sponsor', type: 'option', options: ['Carlos Fund'], maxValuesAllowed: null }];
  const w = await world({ kids: [AXEL], jobs: [axelJob({ [FIELD_MONETARY_SPONSOR]: [] })], fields });
  await w.run();
  w.jt.jobs[0].values[FIELD_MONETARY_SPONSOR] = ['Carlos Fund'];
  await w.run(MIN); await w.run();
  await setLink(w.DB, { company: nameKey('Carlos Fund'), partner: 'jimmy-helen-carlos' });
  assert.deepEqual((await creditsView(w.env)).unknown, [], 'known at once, before any run');
  const { applyLink } = await import('../functions/api/_room-credits.js');
  const r = await applyLink(w.env, { now: w.now() });
  assert.deepEqual(r.rooms, ['axel']);
  assert.deepEqual((await w.kid('axel')).sponsors, ['jimmy-helen-carlos']);
  assert.deepEqual(w.put, []);
});

// ── From the tenth review ──

const refuseWrites = (real) => async (u, init) => (JSON.parse(init.body).query.updateJob ? { ok: false, status: 503, text: async () => 'busy', json: async () => ({}) } : real(u, init));

test('an admin pick JobTread refuses twice keeps her waiting change and its time: a take-off after her pick stands', async () => {
  const w = await world({ kids: [AXEL], jobs: [axelJob()] });
  await w.run();
  w.later(3 * MIN);
  w.jt.jobs[0].values[DESIGNED] = ['Crosby Design Group'];
  w.later(2 * MIN);
  await takenOffAt(w, 'crosby-design-group', 'Crosby Design Group', w.now());
  await w.run(5 * MIN);
  const real = w.jt.fetchImpl;
  w.jt.fetchImpl = refuseWrites(real);
  assert.ok((await w.set({ record: 'axel', kind: 'designed', partner: 'means-interiors', on: true, put: false })).owed);
  const since = (await readJobRows(w.DB)).get('axel designed').nextSince;
  await w.run(5 * MIN);
  assert.equal((await readJobRows(w.DB)).get('axel designed').nextSince, since, 'still refused: her change keeps waiting, with its time');
  w.jt.fetchImpl = real;
  await w.run(); await w.run();
  assert.deepEqual(w.put.filter((x) => (x.logo || x.job) === 'Crosby Design Group'), [], 'Crosby, taken off after her pick, stays off');
  assert.deepEqual([...(await w.kid('axel')).designers].sort(), ['crosby-design-group', 'means-interiors']);
});

test('Take it out of JobTread refused while she has a change waiting: a take-off after her pick still stands', async () => {
  const w = await world({ kids: [{ ...LIZ, sponsors: ['means-interiors'] }], jobs: [lizJob(['Brian Robins Family Foundation'])], fields: robinsOnly });
  await w.run();
  w.later(3 * MIN);
  w.jt.jobs[0].values[FIELD_MONETARY_SPONSOR] = [...w.jt.jobs[0].values[FIELD_MONETARY_SPONSOR], 'Jimmy & Helen Carlos'];
  w.later(2 * MIN);
  await ensureVendorSchema(w.DB);
  await w.DB.prepare("INSERT OR REPLACE INTO vendor_job_seen (job_id, who, record, name, partner, off, updated_at) VALUES ('j-liz', 'p:jimmy-helen-carlos', 'lizzie', 'Jimmy & Helen Carlos', 'jimmy-helen-carlos', 'site', ?)").bind(new Date(w.now()).toISOString()).run();
  await w.run(5 * MIN);
  const real = w.jt.fetchImpl;
  w.jt.fetchImpl = refuseWrites(real);
  w.later(MIN);
  assert.ok((await settleHeld(w.env, { record: 'lizzie', kind: 'sponsored', use: 'website' }, 'staff', { fetchImpl: w.jt.fetchImpl, now: w.now() })).owed);
  await w.run(9 * MIN);
  w.jt.fetchImpl = real;
  await w.run(); await w.run();
  assert.deepEqual(w.put.filter((x) => (x.logo || x.job) === 'Jimmy & Helen Carlos'), [], 'Carlos, taken off after her pick, stays off');
  assert.deepEqual(w.jt.jobs[0].values[FIELD_MONETARY_SPONSOR].sort(), ['Jimmy & Helen Carlos', 'Means Interiors'], 'Robins taken out when JobTread took it; her pick kept');
});

test('a name on many jobs counts once, in Automations as in Partners → JobTread access', async () => {
  const w = await world({ kids: [AXEL, LIZ], jobs: [axelJob({ [FIELD_MONETARY_SPONSOR]: ['SOARF'] }), lizJob(['SOARF'])] });
  await w.run();
  const last = JSON.parse((await w.DB.prepare("SELECT value FROM room_credit_state WHERE key = 'last'").first()).value);
  assert.equal(roomCreditsFacts(last).unknown, 1);
  assert.equal((await creditsView(w.env)).unknown.length, 2, 'listed with both pages it’s on');
});

test('launch keeps a page’s credits in the order the page has them (no save, no deploy, for JobTread listing them another way)', async () => {
  const w = await world({ kids: [{ ...AXEL, sponsors: ['jimmy-helen-carlos', 'brian-robins-family-foundation'] }],
    jobs: [axelJob({ [FIELD_MONETARY_SPONSOR]: ['Brian Robins Family Foundation'] })],
    fields: [{ id: FIELD_MONETARY_SPONSOR, name: 'Monetary Sponsor', type: 'option', options: ['Brian Robins Family Foundation', 'Jimmy & Helen Carlos'], maxValuesAllowed: null }] });
  const before = (await w.DB.prepare("SELECT data FROM kids WHERE slug = 'axel'").first()).data;
  await w.run();
  assert.deepEqual(w.jt.jobs[0].values[FIELD_MONETARY_SPONSOR], ['Brian Robins Family Foundation', 'Jimmy & Helen Carlos'], 'the website’s sponsor written in');
  assert.equal((await w.DB.prepare("SELECT data FROM kids WHERE slug = 'axel'").first()).data, before, 'the page isn’t saved at all');
});

test('a change JobTread keeps refusing is tried each run three times, then once a day; the same change made in JobTread clears it at once', async () => {
  const w = await world({ kids: [{ ...AXEL, sponsors: ['jimmy-helen-carlos'] }], jobs: [axelJob({ [FIELD_MONETARY_SPONSOR]: [] }, { closedOn: '2025-06-01' })] });
  const real = w.jt.fetchImpl;
  w.jt.fetchImpl = refuseWrites(real);
  const problems = [];
  for (let i = 0; i < 5; i++) problems.push((await w.run()).problems.length);
  // The fake refuses at the fetch: count attempts by the pending's tries
  const row = (await readJobRows(w.DB)).get('axel sponsored');
  assert.equal(row.pending.tries, 3, 'the launch write, three more tries, then it waits a day');
  assert.deepEqual(problems, [1, 1, 1, 1, 0], 'said each time it was tried, then counted as waiting (not a problem every run)');
  const last = JSON.parse((await w.DB.prepare("SELECT value FROM room_credit_state WHERE key = 'last'").first()).value);
  assert.equal(last.owed, 1, 'Automations counts it');
  assert.deepEqual((await creditsView(w.env)).owed.map((o) => [o.record, o.kind]), [['axel', 'sponsored']], 'Partners → JobTread access lists it');
  w.later(24 * 60 * MIN);
  await w.run();
  assert.equal((await readJobRows(w.DB)).get('axel sponsored').pending.tries, 4, 'tried again a day on');
  // A person makes the same change in JobTread: settled at the next run, without waiting for the daily try
  w.jt.jobs[0].values[FIELD_MONETARY_SPONSOR] = ['Jimmy & Helen Carlos'];
  await w.run();
  assert.equal((await readJobRows(w.DB)).get('axel sponsored').pending, null);
  await w.run(); await w.run();
  assert.deepEqual((await w.kid('axel')).sponsors, ['jimmy-helen-carlos']);
  assert.deepEqual(w.put, [], 'a launch write landing is no pick');
});

test('a finished room’s job keeps its old spelling: no rename is written to a closed job', async () => {
  const w = await world({ kids: [{ ...AXEL, sponsors: ['jimmy-helen-carlos'] }], jobs: [axelJob({ [FIELD_MONETARY_SPONSOR]: ['Helen & Jimmy Carlos'] }, { closedOn: '2025-06-01' })] });
  await w.run(); await w.run();
  assert.deepEqual(w.jt.jobs[0].values[FIELD_MONETARY_SPONSOR], ['Helen & Jimmy Carlos'], 'left as it was');
  assert.equal(w.jt.writes(), 0);
  assert.deepEqual((await w.kid('axel')).sponsors, ['jimmy-helen-carlos'], 'the same company either way');
});

test('a run never outlasts the heartbeat: too little time left, it waits; some left, it stops in time and the next goes on', async () => {
  const w = await world({ kids: [AXEL], jobs: [axelJob()] });
  assert.equal(await maybeSyncCredits(w.env, { fetchImpl: w.jt.fetchImpl, now: w.now(), deps: w.deps, deadline: Date.now() + 2000 }), null, 'two seconds left: not started');
  const r = await syncCredits(w.env, { fetchImpl: w.jt.fetchImpl, now: w.now() + SECOND_LOOK_MS, deps: w.deps, deadline: Date.now() - 1 });
  assert.equal(r.more, true, 'past the deadline: stops before the first room');
  const again = await syncCredits(w.env, { fetchImpl: w.jt.fetchImpl, now: w.now() + 2 * SECOND_LOOK_MS, deps: w.deps });
  assert.equal(again.more, false);
  assert.equal((await readJobRows(w.DB)).size, 2);
});

test('a room moved to a new job takes a put-on still to finish with it, asked again there whether they’re on it', async () => {
  const w = await world({ kids: [AXEL], jobs: [axelJob()] });
  await w.run();
  const real = w.deps.pageLogosOn;
  w.deps.pageLogosOn = async () => { throw new Error('That page is busy'); };
  await w.set({ record: 'axel', kind: 'designed', partner: 'crosby-design-group', on: true });
  assert.equal((await retryOf(w, 'axel designed')).length, 1, 'nothing went on: still to finish');
  // The job is deleted and a new one made
  w.jt.jobs.splice(0, 1, axelJob({ [DESIGNED]: [] }, { id: 'j-axel2', createdAt: new Date(w.now() + MIN).toISOString() }));
  w.deps.pageLogosOn = real;
  await w.run();
  assert.deepEqual(w.jt.jobs[0].values[DESIGNED], ['Crosby Design Group'], 'the credit moved into the new job');
  await w.run();
  assert.deepEqual(w.put, [{ logo: 'Crosby Design Group', slug: 'axel' }, { job: 'Crosby Design Group', record: 'axel' }], 'put on at the new job, once');
  assert.deepEqual(await retryOf(w, 'axel designed'), []);
});

// ── From the eleventh review ──

test('a name from before launch, linked while a launch write is still owed, is still a question (Same as, or the sweep, landed or not)', async () => {
  const refuse = (real) => async (u, init) => (JSON.parse(init.body).query.updateJob ? { ok: false, status: 400, text: async () => 'job is closed', json: async () => ({}) } : real(u, init));
  for (const how of ['same as', 'sweep, write lands', 'sweep, still refused']) {
    const w = await world({ kids: [{ ...LIZ, sponsors: ['brian-robins-family-foundation'] }], jobs: [lizJob(['SOARF'])] });
    const real = w.jt.fetchImpl;
    w.jt.fetchImpl = refuse(real);
    await w.run();
    assert.ok((await readJobRows(w.DB)).get('lizzie sponsored').pending, `${how}: the launch write is owed`);
    await setLink(w.DB, { company: nameKey('SOARF'), partner: 'jimmy-helen-carlos' });
    if (how === 'same as') { const { applyLink } = await import('../functions/api/_room-credits.js'); await applyLink(w.env, { now: w.now() }); }
    else { if (how === 'sweep, write lands') w.jt.fetchImpl = real; await w.run(); }
    assert.deepEqual((await w.kid('lizzie')).sponsors, ['brian-robins-family-foundation'], `${how}: the page keeps its answer`);
    assert.deepEqual((await heldOf(w))?.jobtread, ['jimmy-helen-carlos'], `${how}: a question for a person`);
    assert.deepEqual(w.put, []);
  }
});

test('a Same as link changed later is knowing more, never a pick: the credit follows and nobody is put on', async () => {
  const w = await world({ kids: [{ ...AXEL, partnerLogos: [{ url: ROBINS.logo, name: ROBINS.name }] }], jobs: [axelJob()] });
  await saveContacts(w.DB, 'jimmy-helen-carlos', [{ name: 'Jimmy', email: 'jimmy@carlos.org' }, { name: 'Helen', email: 'helen@carlos.org' }]);
  w.jt.fields.find((f) => f.id === FIELD_MONETARY_SPONSOR).options.push('SOARF');
  await w.run();
  w.jt.jobs[0].values[FIELD_MONETARY_SPONSOR] = ['SOARF'];
  await w.run(MIN); await w.run();
  const { applyLink } = await import('../functions/api/_room-credits.js');
  await setLink(w.DB, { company: nameKey('SOARF'), partner: 'brian-robins-family-foundation' });
  await applyLink(w.env, { now: w.now() });
  assert.deepEqual((await w.kid('axel')).sponsors, ['brian-robins-family-foundation']);
  // The link is fixed: SOARF is Carlos. JobTread is untouched
  await setLink(w.DB, { company: nameKey('SOARF'), partner: 'jimmy-helen-carlos' });
  await applyLink(w.env, { now: w.now() });
  assert.deepEqual((await w.kid('axel')).sponsors, ['jimmy-helen-carlos'], 'the credit follows the name at once');
  await w.run(); await w.run();
  assert.deepEqual(w.jt.jobs[0].access, [], 'nobody put on the job');
  assert.deepEqual(w.put, [], 'no logo, no Add to job');
  assert.deepEqual((await w.kid('axel')).sponsors, ['jimmy-helen-carlos']);
});

test('a pick JobTread hasn’t taken yet survives its partner being renamed in Partners, and is written under the new name', async () => {
  const w = await world({ kids: [AXEL], jobs: [axelJob()] });
  await w.run();
  const real = w.jt.fetchImpl;
  w.jt.fetchImpl = refuseWrites(real);
  assert.ok((await w.set({ record: 'axel', kind: 'designed', partner: 'crosby-design-group', on: true, put: false })).owed);
  const row = await w.DB.prepare("SELECT data FROM partners WHERE slug = 'crosby-design-group'").first();
  await w.DB.prepare("UPDATE partners SET name = ?, data = ? WHERE slug = 'crosby-design-group'").bind('Crosby Interiors', JSON.stringify({ ...JSON.parse(row.data), name: 'Crosby Interiors' })).run();
  w.jt.fetchImpl = real;
  await w.run();
  assert.deepEqual(w.jt.jobs[0].values[DESIGNED], ['Crosby Interiors'], 'written under the name it has now');
  assert.deepEqual((await w.kid('axel')).designers, ['crosby-design-group'], 'still credited');
  assert.deepEqual((await creditsView(w.env)).unknown, [], 'and not listed as a stranger');
});

// ── From the twelfth review ──

/** A partner renamed in Partners, the way the editor saves it (its history keeps the name it had) */
const renamePartner = async (w, slug, name) => {
  const row = await w.DB.prepare('SELECT data FROM partners WHERE slug = ?').bind(slug).first();
  const before = JSON.parse(row.data);
  const after = { ...before, name };
  await w.DB.prepare('UPDATE partners SET name = ?, data = ? WHERE slug = ?').bind(name, JSON.stringify(after), slug).run();
  await recordVersion(w.DB, { collection: 'partners', slug, data: after, previous: before, userEmail: 'staff@soardcharity.com', now: new Date(w.now()).toISOString() });
};

test('a wrong Same as can be put right, even after a run: JobTread keeps her value, and the credit follows the link (or leaves with it)', async () => {
  const w = await world({ kids: [AXEL], jobs: [axelJob()] });
  w.jt.fields.find((f) => f.id === FIELD_MONETARY_SPONSOR).options.push('SOARF');
  await w.run();
  w.jt.jobs[0].values[FIELD_MONETARY_SPONSOR] = ['SOARF'];
  await w.run(MIN); await w.run();
  const { applyLink } = await import('../functions/api/_room-credits.js');
  await setLink(w.DB, { company: nameKey('SOARF'), partner: 'brian-robins-family-foundation' });
  await applyLink(w.env, { now: w.now() });
  await w.run(); await w.run();
  assert.deepEqual(w.jt.jobs[0].values[FIELD_MONETARY_SPONSOR], ['SOARF'], 'a value matched by a person’s link isn’t rewritten in JobTread');
  await setLink(w.DB, { company: nameKey('SOARF'), partner: 'jimmy-helen-carlos' });
  await applyLink(w.env, { now: w.now() });
  await w.run(); await w.run();
  assert.deepEqual((await w.kid('axel')).sponsors, ['jimmy-helen-carlos'], 'the fixed link holds');
  // The link taken away: the credit goes with it, and the name is asked about again
  await setLink(w.DB, { company: nameKey('SOARF'), partner: null });
  await applyLink(w.env, { now: w.now() });
  await w.run(); await w.run();
  assert.deepEqual((await w.kid('axel')).sponsors, [], 'no longer credited');
  assert.deepEqual((await creditsView(w.env)).unknown.map((u) => u.value), ['SOARF'], 'listed again');
  assert.deepEqual(w.put, [], 'and nobody was ever put on');
});

test('a partner renamed while her pick waits for its second look: still her pick of that partner, put on', async () => {
  const w = await world({ kids: [AXEL], jobs: [axelJob({ [DESIGNED]: [] })] });
  await w.run();
  w.jt.jobs[0].values[DESIGNED] = ['Crosby Design Group'];
  await w.run(MIN);
  await renamePartner(w, 'crosby-design-group', 'Crosby Interiors');
  await w.run(); await w.run();
  assert.deepEqual((await w.kid('axel')).designers, ['crosby-design-group']);
  assert.ok(w.put.some((x) => x.logo === 'Crosby Interiors' || x.job === 'Crosby Interiors'), 'put on, as her pick');
  assert.deepEqual(w.jt.jobs[0].values[DESIGNED], ['Crosby Interiors'], 'the job says the new name');
});

test('after a rename, the old spelling picked on another job is that partner; the site’s old choice goes once no job holds it', async () => {
  const LIZ2 = { slug: 'lizzie', name: 'Lizzie Francis', year: 2026 };
  const w = await world({ kids: [AXEL, LIZ2], jobs: [axelJob({ [DESIGNED]: [] }), { id: 'j-liz', name: 'Lizzie Francis (2026)', values: { [DESIGNED]: [] }, access: [] }] });
  await w.run();
  assert.ok(w.jt.fields.find((f) => f.id === DESIGNED).options.includes('Crosby Design Group'), 'the site added it');
  // She picks it on Lizzie's job before anyone renames anything
  w.jt.jobs[1].values[DESIGNED] = ['Crosby Design Group'];
  await renamePartner(w, 'crosby-design-group', 'Crosby Interiors');
  await w.run(MIN); await w.run();
  assert.deepEqual((await w.kid('lizzie')).designers, ['crosby-design-group'], 'the old spelling is Crosby');
  assert.ok(w.put.some((x) => x.logo === 'Crosby Interiors'), 'her pick, put on');
  await w.run();
  assert.deepEqual(w.jt.jobs[1].values[DESIGNED], ['Crosby Interiors'], 'respelled on her open job');
  assert.deepEqual(w.jt.fields.find((f) => f.id === DESIGNED).options.filter((o) => /Crosby/.test(o)), ['Crosby Interiors'], 'the site’s old choice gone, no job holding it');
});

test('a rename JobTread hasn’t taken yet, and the partner renamed again: still credited, written under the newest name', async () => {
  const w = await world({ kids: [{ ...AXEL, designers: ['crosby-design-group'] }], jobs: [axelJob({ [DESIGNED]: ['Crosby Design Group'] })] });
  await w.run();
  await renamePartner(w, 'crosby-design-group', 'Crosby Interiors');
  const real = w.jt.fetchImpl;
  w.jt.fetchImpl = refuseWrites(real);
  await w.run();
  assert.ok((await readJobRows(w.DB)).get('axel designed').pending?.rename?.length, 'the rename is owed');
  await renamePartner(w, 'crosby-design-group', 'Crosby Studio');
  await w.run();
  assert.deepEqual((await w.kid('axel')).designers, ['crosby-design-group'], 'never dropped while owed');
  w.jt.fetchImpl = real;
  await w.run(); await w.run();
  assert.deepEqual(w.jt.jobs[0].values[DESIGNED], ['Crosby Studio']);
  assert.deepEqual((await w.kid('axel')).designers, ['crosby-design-group']);
  assert.deepEqual((await creditsView(w.env)).unknown, []);
});

test('a run cut off during the first of two put-ons: the second is still put on later', async () => {
  const w = await world({ kids: [AXEL], jobs: [axelJob()] });
  await w.run();
  w.jt.jobs[0].values[FIELD_MONETARY_SPONSOR] = ['Jimmy & Helen Carlos', 'Brian Robins Family Foundation'];
  await w.run(MIN);
  const real = w.deps.pageLogosOn;
  let first = true;
  // The heartbeat's time runs out mid put-on: that run never comes back
  w.deps.pageLogosOn = (...a) => { if (first) { first = false; return new Promise(() => {}); } return real(...a); };
  w.later(SECOND_LOOK_MS);
  await Promise.race([syncCredits(w.env, { fetchImpl: w.jt.fetchImpl, now: w.now(), deps: w.deps }), new Promise((r) => setTimeout(r, 300))]);
  assert.equal((await retryOf(w, 'axel sponsored')).length, 2, 'both written down before either started');
  await w.DB.prepare('DELETE FROM kid_partner_lock').run(); // two minutes on, the dead run's locks have run out
  w.deps.pageLogosOn = real;
  await w.run(); await w.run();
  const logos = (await w.kid('axel')).partnerLogos.map((l) => l.name);
  assert.ok(logos.includes('Jimmy & Helen Carlos') && logos.includes('Brian Robins Family Foundation'), `both put on (${logos.join(', ')})`);
  assert.deepEqual(await retryOf(w, 'axel sponsored'), []);
});

// ── From the thirteenth review ──

/** One kind of D1 read fails for a moment (pattern: part of its SQL) */
const failing = (w, pattern) => {
  const prep = w.DB.prepare.bind(w.DB);
  let on = true;
  w.DB.prepare = (sql) => {
    const st = prep(sql);
    if (!on || !pattern.test(sql)) return st;
    const bind = st.bind.bind(st);
    const boom = () => Promise.reject(new Error('D1_ERROR: network connection lost'));
    st.all = boom; st.first = boom;
    st.bind = (...a) => { const b = bind(...a); b.all = boom; b.first = boom; return b; };
    return st;
  };
  return () => { on = false; w.DB.prepare = prep; };
};

test('a respelling JobTread won’t take backs off like any other change: three tries, then once a day, said only when tried', async () => {
  const w = await world({ kids: [{ ...AXEL, designers: ['crosby-design-group'] }], jobs: [axelJob({ [DESIGNED]: ['Crosby Design Group'] })] });
  await w.run();
  await renamePartner(w, 'crosby-design-group', 'Crosby Interiors');
  w.jt.fetchImpl = refuseWrites(w.jt.fetchImpl);
  const said = [];
  for (let i = 0; i < 6; i++) said.push((await w.run()).problems.length);
  assert.deepEqual(said, [1, 1, 1, 0, 0, 0], 'tried and said three times, then waiting a day');
  assert.equal((await readJobRows(w.DB)).get('axel designed').pending.tries, 3);
  assert.deepEqual((await w.kid('axel')).designers, ['crosby-design-group'], 'credited throughout');
});

test('partner history that can’t be read stops the run: no credit leaves a page for it', async () => {
  const w = await world({ kids: [{ ...AXEL, designers: ['crosby-design-group'] }], jobs: [axelJob({ [DESIGNED]: ['Crosby Design Group'] }, { closedOn: '2025-06-01' })] });
  await w.run();
  await renamePartner(w, 'crosby-design-group', 'Crosby Interiors');
  await w.run();
  const before = (await w.DB.prepare("SELECT data FROM kids WHERE slug = 'axel'").first()).data;
  const restore = failing(w, /content_versions/);
  const r = await w.run();
  restore();
  assert.ok(r.problems.some((x) => /network connection lost/.test(x)), 'said');
  assert.equal((await w.DB.prepare("SELECT data FROM kids WHERE slug = 'axel'").first()).data, before, 'the page untouched');
});

test('take-offs that can’t be read: a pick waits for the next run, never put on as if nobody was taken off', async () => {
  const w = await world({ kids: [AXEL], jobs: [axelJob()] });
  await w.run();
  w.later(30 * 1000);
  await takenOffAt(w, 'crosby-design-group', 'Crosby Design Group', w.now());
  w.jt.jobs[0].values[DESIGNED] = ['Crosby Design Group'];
  await w.run(MIN);
  const restore = failing(w, /vendor_job_seen/);
  await w.run();
  restore();
  assert.deepEqual(w.put, [], 'not put on while it couldn’t tell');
  assert.equal((await retryOf(w, 'axel designed')).length, 1, 'still to decide');
  await w.run();
  assert.deepEqual(w.put, [], 'and the take-off after her pick stands');
});

test('a match by a company’s own name stays put when what showed it fades: history pruned, or a second partner with the same words', async () => {
  // A name it had before a rename, its history later gone
  const w = await world({ kids: [{ ...AXEL, designers: ['crosby-design-group'] }], jobs: [axelJob({ [DESIGNED]: ['Crosby Design Group'] }, { closedOn: '2025-06-01' })] });
  await w.run();
  await renamePartner(w, 'crosby-design-group', 'Crosby Interiors');
  await w.run();
  await w.DB.prepare('DELETE FROM content_versions').run();
  await w.run(); await w.run();
  assert.deepEqual((await w.kid('axel')).designers, ['crosby-design-group'], 'still Crosby');
  // The same words, a second partner added later
  const v = await world({ kids: [{ ...AXEL, sponsors: ['jimmy-helen-carlos'] }], jobs: [axelJob({ [FIELD_MONETARY_SPONSOR]: ['Helen & Jimmy Carlos'] }, { closedOn: '2025-06-01' })] });
  await v.run();
  await v.DB.prepare('INSERT INTO partners (slug, name, level, category, featured, data) VALUES (?, ?, ?, ?, ?, ?)').bind('helen-jimmy-carlos-2', 'Carlos, Jimmy & Helen', 'friend', 'funding', 0, JSON.stringify({ slug: 'helen-jimmy-carlos-2', name: 'Carlos, Jimmy & Helen', category: ['funding'] })).run();
  await v.run(); await v.run();
  assert.deepEqual((await v.kid('axel')).sponsors, ['jimmy-helen-carlos'], 'still the same sponsor');
  assert.deepEqual(v.put, []);
});


// ── From the fourteenth review ──




test('a respelling still owed when the job closes is let go: a finished room’s job is never respelled', async () => {
  const w = await world({ kids: [{ ...AXEL, designers: ['crosby-design-group'] }], jobs: [axelJob({ [DESIGNED]: ['Crosby Design Group'] })] });
  await w.run();
  await renamePartner(w, 'crosby-design-group', 'Crosby Interiors');
  const real = w.jt.fetchImpl;
  w.jt.fetchImpl = refuseWrites(real);
  await w.run();
  assert.ok((await readJobRows(w.DB)).get('axel designed').pending?.rename?.length, 'owed while open');
  w.jt.jobs[0].closedOn = '2026-11-01';
  w.jt.fetchImpl = real;
  const before = w.jt.writes();
  await w.run(); await w.run();
  assert.equal(w.jt.writes(), before, 'nothing written to the closed job');
  assert.equal((await readJobRows(w.DB)).get('axel designed').pending, null);
  assert.deepEqual((await w.kid('axel')).designers, ['crosby-design-group']);
});

test('accounts or contacts that can’t be read stop the run: a company already on the job is never put on again for it', async () => {
  for (const table of ['vendor_accounts', 'partner_contacts']) {
    const w = await world({ kids: [AXEL], jobs: [axelJob({}, { access: ['pat@cdg-llc.com'] })], members: [{ email: 'pat@cdg-llc.com', name: 'Pat', account: { id: 'acct-crosby', name: 'CDG LLC' } }] });
    await ensureVendorSchema(w.DB);
    if (table === 'vendor_accounts') await w.DB.prepare("INSERT INTO vendor_accounts (partner, account_id, account_name, how) VALUES ('crosby-design-group', 'acct-crosby', 'CDG LLC', 'person')").run();
    else await saveContacts(w.DB, 'crosby-design-group', [{ name: 'Pat', email: 'pat@cdg-llc.com' }]);
    await w.run();
    w.jt.jobs[0].values[DESIGNED] = ['Crosby Design Group'];
    await w.run(MIN);
    const restore = failing(w, new RegExp(`FROM ${table}`));
    const r = await w.run();
    restore();
    assert.ok(r.problems.some((x) => /network connection lost/.test(x)), `${table}: said`);
    assert.deepEqual(w.put, [], `${table}: nobody put on while it couldn’t tell`);
    await w.run();
    assert.deepEqual((await w.kid('axel')).designers, ['crosby-design-group'], `${table}: credited when it can read again`);
    assert.deepEqual(w.put, [], `${table}: and already on the job, so still nobody put on`);
  }
});

test('Demo Day’s sponsor matcher stops when contacts can’t be read, never “this sponsor has no people”', async () => {
  const w = await world({ kids: [{ ...AXEL, sponsors: ['jimmy-helen-carlos'] }], jobs: [] });
  await saveContacts(w.DB, 'jimmy-helen-carlos', [{ name: 'Helen', email: 'helen.carlos@gmail.com' }]);
  assert.equal((await sponsorMatcher(w.DB))({ email: 'helen.carlos@gmail.com', company: null }, 'axel'), true);
  const restore = failing(w, /partner_contacts/);
  await assert.rejects(sponsorMatcher(w.DB), /network connection lost/);
  restore();
});

// ── From the fifteenth review ──



test('community projects that can’t be read stop the run: their rows, and a change owed to JobTread, are kept', async () => {
  const w = await world({ kids: [AXEL], jobs: [axelJob()] });
  await w.DB.prepare('INSERT INTO community (slug, name, data) VALUES (?, ?, ?)').bind('camp', 'Camp Twin Lakes', JSON.stringify({ name: 'Camp Twin Lakes', year: '2026', status: 'in-progress', partnerLogos: [], sponsors: ['brian-robins-family-foundation'] })).run();
  w.jt.jobs.push({ id: 'j-camp', name: 'Camp Twin Lakes (2026)', values: { [FIELD_MONETARY_SPONSOR]: [] }, access: [] });
  w.jt.fields.find((f) => f.id === FIELD_MONETARY_SPONSOR).options.push('Brian Robins Family Foundation');
  await w.run();
  assert.ok((await readJobRows(w.DB)).get('community/camp sponsored'), 'the project has its row');
  const restore = failing(w, /FROM community/);
  const r = await w.run();
  restore();
  assert.ok(r.problems.some((x) => /network connection lost/.test(x)), 'said');
  assert.ok((await readJobRows(w.DB)).get('community/camp sponsored'), 'kept');
  assert.deepEqual(w.put, []);
});

// ── From the sixteenth review ──







// ── Partners → Merge into (one way, nothing hidden): the old company deleted, then its credits, names, pledges and people move ──

const MEANS_DS = { slug: 'means-design', name: 'Means Design Studio', logo: '', website: '', category: ['design'], level: 'friend' };
const mergeWorld = (more = {}) => world({ kids: [AXEL, { slug: 'lizzie', name: 'Lizzie Francis', year: 2018, designers: ['means-design'] }], partners: [CROSBY, MEANS, CARLOS, ROBINS, MEANS_DS],
  jobs: [axelJob({ [DESIGNED]: [] })], fields: [{ id: FIELD_MONETARY_SPONSOR, name: 'Monetary Sponsor', type: 'option', options: [], maxValuesAllowed: null }], ...more });
/** As the merge window's last step does it: one call that moves everything and deletes the old company */
const mergeAway = async (w, from, fromName, into) => {
  const { mergeCredits } = await import('../functions/api/_room-credits.js');
  return mergeCredits(w.env, { from, fromName, into }, 'staff', { now: w.now() });
};

test('Partners merge: the rooms it was credited on are the other company’s, in its place; JobTread’s name for it means the other now; nobody is put on', async () => {
  const w = await mergeWorld({ kids: [{ ...AXEL }, { slug: 'lizzie', name: 'Lizzie Francis', year: 2018, designers: ['crosby-design-group', 'means-design', 'means-interiors'] }] });
  await w.run();
  w.jt.jobs[0].values[DESIGNED] = ['Means Design Studio'];
  await w.run(MIN); await w.run();
  assert.deepEqual((await w.kid('axel')).designers, ['means-design']);
  const put = w.put.length;
  const r = await mergeAway(w, 'means-design', 'Means Design Studio', 'means-interiors');
  assert.deepEqual(r.rooms.sort(), ['axel', 'lizzie']);
  assert.deepEqual((await w.kid('lizzie')).designers, ['crosby-design-group', 'means-interiors'], 'a room with no job: in its place (already there: once)');
  await w.run(); await w.run();
  assert.deepEqual((await w.kid('axel')).designers, ['means-interiors'], 'a room with a job: JobTread’s name is a Same as now');
  assert.deepEqual(w.jt.jobs[0].values[DESIGNED], ['Means Design Studio'], 'what she picked stays as she picked it');
  assert.equal(w.put.length, put, 'nobody put on');
  assert.deepEqual((await creditsView(w.env)).unknown, []);
});

test('Partners merge: names JobTread uses for it another way (word order, a name it had before) and Same as links made for it move too; a link to another company stays', async () => {
  const FAM = { slug: 'carlos-family-foundation', name: 'Carlos Family Foundation', logo: '', website: '', category: ['funding'], level: 'champion' };
  const w = await world({ kids: [{ ...AXEL, sponsors: ['jimmy-helen-carlos'], designers: ['crosby-design-group'] }], partners: [CROSBY, MEANS, CARLOS, ROBINS, FAM],
    jobs: [axelJob({ [FIELD_MONETARY_SPONSOR]: ['Helen & Jimmy Carlos'], [DESIGNED]: ['Crosby Design Group'] }, { closedOn: '2025-06-01' })] });
  await w.run();
  await renamePartner(w, 'crosby-design-group', 'Crosby Studio');
  await w.run();
  await setLink(w.DB, { company: nameKey('JHC'), partner: 'jimmy-helen-carlos' });
  await setLink(w.DB, { company: nameKey('Crosby Studio Old'), partner: 'brian-robins-family-foundation' });
  await mergeAway(w, 'jimmy-helen-carlos', 'Jimmy & Helen Carlos', 'carlos-family-foundation');
  await mergeAway(w, 'crosby-design-group', 'Crosby Studio', 'means-interiors');
  await w.run(); await w.run();
  assert.deepEqual((await w.kid('axel')).sponsors, ['carlos-family-foundation']);
  assert.deepEqual((await w.kid('axel')).designers, ['means-interiors']);
  const { readLinks } = await import('../functions/api/_kid-partners.js');
  const links = await readLinks(w.DB);
  assert.equal(links[nameKey('JHC')], 'carlos-family-foundation', 'a Same as made for the old company');
  assert.equal(links[nameKey('Helen & Jimmy Carlos')], 'carlos-family-foundation', 'JobTread’s word order, now a link a person can see and change');
  assert.equal(links[nameKey('Crosby Studio Old')], 'brian-robins-family-foundation', 'a person’s link to another company, as they made it');
  assert.deepEqual((await creditsView(w.env)).unknown, []);
});





test('Partners merge: a respelling still owed to the old company is dropped, her value stays as she picked it', async () => {
  const w = await world({ kids: [{ ...AXEL, designers: ['crosby-design-group'] }], jobs: [axelJob({ [DESIGNED]: ['Crosby Design Group'] })] });
  await w.run();
  await renamePartner(w, 'crosby-design-group', 'Crosby Studio');
  const real = w.jt.fetchImpl;
  w.jt.fetchImpl = refuseWrites(real);
  await w.run();
  assert.ok((await readJobRows(w.DB)).get('axel designed').pending?.rename?.length, 'the respelling is owed');
  await mergeAway(w, 'crosby-design-group', 'Crosby Studio', 'means-interiors');
  w.jt.fetchImpl = real;
  await w.run(); await w.run();
  assert.deepEqual(w.jt.jobs[0].values[DESIGNED], ['Crosby Design Group'], 'never rewritten to the other company');
  assert.deepEqual((await w.kid('axel')).designers, ['means-interiors']);
});

test('Partners merge: a name a person linked to a third company stays that company’s, with no flip after', async () => {
  const w = await mergeWorld();
  await w.run();
  w.jt.fields.find((f) => f.id === DESIGNED).options.push('MDS');
  w.jt.jobs[0].values[DESIGNED] = ['MDS'];
  await setLink(w.DB, { company: nameKey('MDS'), partner: 'means-design' });
  await w.run(MIN); await w.run();
  assert.deepEqual((await w.kid('axel')).designers, ['means-design']);
  // A person later says MDS is Crosby (their say), then the merge
  await setLink(w.DB, { company: nameKey('MDS'), partner: 'crosby-design-group' });
  await mergeAway(w, 'means-design', 'Means Design Studio', 'means-interiors');
  const seq = [(await w.kid('axel')).designers];
  await w.run(); seq.push((await w.kid('axel')).designers);
  await w.run(); seq.push((await w.kid('axel')).designers);
  assert.deepEqual(seq, [['crosby-design-group'], ['crosby-design-group'], ['crosby-design-group']]);
});

test('Partners merge: its pledges and people are the other company’s, so Demo Day and the kid card keep them', async () => {
  const FAM = { slug: 'carlos-family-foundation', name: 'Carlos Family Foundation', logo: '', website: '', category: ['funding'], level: 'champion' };
  const w = await world({ kids: [{ ...AXEL, sponsors: ['jimmy-helen-carlos'] }], partners: [CROSBY, MEANS, CARLOS, ROBINS, FAM],
    jobs: [axelJob({ [FIELD_MONETARY_SPONSOR]: ['Jimmy & Helen Carlos'] }, { access: ['jimmy.carlos@gmail.com'] })], members: [{ email: 'jimmy.carlos@gmail.com', name: 'Jimmy' }] });
  await saveContacts(w.DB, 'jimmy-helen-carlos', [{ name: 'Jimmy', email: 'jimmy.carlos@gmail.com' }]);
  await saveContacts(w.DB, 'carlos-family-foundation', [{ name: 'Dana', email: 'dana@carlosff.org' }]);
  const { savePledge, pledgesFor } = await import('../functions/api/_sponsor-pledges.js');
  await savePledge(w.DB, { kid: 'axel', partner: 'jimmy-helen-carlos', pledged: 25000, received: 5000 });
  await savePledge(w.DB, { kid: 'axel', partner: 'carlos-family-foundation', pledged: 1000, received: 0 });
  await w.run();
  await mergeAway(w, 'jimmy-helen-carlos', 'Jimmy & Helen Carlos', 'carlos-family-foundation');
  const p = (await pledgesFor(w.DB, ['axel'])).axel;
  assert.deepEqual([p['carlos-family-foundation']?.pledged, p['carlos-family-foundation']?.received, p['jimmy-helen-carlos']], [26000, 5000, undefined]);
  const { readContacts } = await import('../functions/api/_sponsors.js');
  assert.deepEqual((await readContacts(w.DB, ['carlos-family-foundation']))['carlos-family-foundation'].map((c) => c.email), ['dana@carlosff.org', 'jimmy.carlos@gmail.com'], 'shown in Partners for it');
  assert.equal((await sponsorMatcher(w.DB))({ email: 'jimmy.carlos@gmail.com', company: null }, 'axel'), true, 'Demo Day: still the kid’s sponsor’s person');
  await w.run();
  const v = await creditsView(w.env, { record: 'axel', fetchImpl: w.jt.fetchImpl });
  assert.deepEqual(v.room.kinds.sponsored.credits.map((c) => [c.slug, c.onRoom]), [['carlos-family-foundation', true]]);
});

test('a company brought back from Recently deleted after a merge is itself: a job room whose JobTread field has its name follows it back, nobody put on', async () => {
  const w = await mergeWorld();
  await w.run();
  w.jt.jobs[0].values[DESIGNED] = ['Means Design Studio'];
  await w.run(MIN); await w.run();
  const put = w.put.length;
  await mergeAway(w, 'means-design', 'Means Design Studio', 'means-interiors');
  await w.run();
  assert.deepEqual((await w.kid('axel')).designers, ['means-interiors']);
  await w.DB.prepare('INSERT INTO partners (slug, name, level, category, featured, data) VALUES (?, ?, ?, ?, ?, ?)').bind('means-design', 'Means Design Studio', 'friend', 'design', 0, JSON.stringify(MEANS_DS)).run();
  await w.run(); await w.run();
  assert.deepEqual((await w.kid('axel')).designers, ['means-design'], 'its own name beats the link');
  assert.equal(w.put.length, put);
});

test('Partners merge is one step: the old company is deleted by it (Recently deleted keeps it), and a run right after reads it all done', async () => {
  const w = await mergeWorld();
  await w.run();
  w.jt.jobs[0].values[DESIGNED] = ['Means Design Studio'];
  await w.run(MIN); await w.run();
  await mergeAway(w, 'means-design', 'Means Design Studio', 'means-interiors');
  assert.equal(await w.DB.prepare("SELECT slug FROM partners WHERE slug = 'means-design'").first(), null, 'deleted');
  const kept = await w.DB.prepare("SELECT action FROM content_versions WHERE collection = 'partners' AND slug = 'means-design' ORDER BY id DESC").first();
  assert.equal(kept?.action, 'delete', 'kept for Recently deleted');
  await w.run(MIN);
  assert.deepEqual([(await w.kid('axel')).designers, (await w.kid('lizzie')).designers], [['means-interiors'], ['means-interiors']], 'no “(not in Partners)” left anywhere');
});

test('Partners merge changes nothing when it can’t go through: JobTread being read, the old company already gone, or more people than a company keeps', async () => {
  const { mergeCredits, mergeCheck } = await import('../functions/api/_room-credits.js');
  const { takeLock } = await import('../functions/api/_kid-partners.js');
  // JobTread being read: the merge waits a moment, then says so, with nothing changed
  const w = await mergeWorld();
  await w.run();
  await takeLock(w.DB, false, 'room-credits');
  const realSet = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => realSet(fn, 0);
  await assert.rejects(mergeCredits(w.env, { from: 'means-design', fromName: 'Means Design Studio', into: 'means-interiors' }, 'staff', { now: w.now() }), /as they were/);
  globalThis.setTimeout = realSet;
  assert.ok(await w.DB.prepare("SELECT slug FROM partners WHERE slug = 'means-design'").first(), 'still there');
  assert.deepEqual((await w.kid('lizzie')).designers, ['means-design']);
  // More people than Partners keeps for a company: a person chooses first, nobody is dropped
  const v = await mergeWorld();
  await saveContacts(v.DB, 'means-design', [1, 2, 3].map((n) => ({ name: `Old ${n}`, email: `old${n}@means.example` })));
  await saveContacts(v.DB, 'means-interiors', [1, 2, 3].map((n) => ({ name: `New ${n}`, email: `new${n}@means.example` })));
  await assert.rejects(mergeCheck(v.env, { from: 'means-design', into: 'means-interiors' }), /6 people between them/);
  await assert.rejects(mergeAway(v, 'means-design', 'Means Design Studio', 'means-interiors'), /6 people between them/);
  assert.ok(await v.DB.prepare("SELECT slug FROM partners WHERE slug = 'means-design'").first(), 'nothing merged');
  const { readContacts } = await import('../functions/api/_sponsors.js');
  assert.equal((await readContacts(v.DB, ['means-design']))['means-design'].length, 3, 'nobody dropped');
  // Already gone: nothing to merge
  await v.DB.prepare("DELETE FROM partners WHERE slug = 'means-design'").run();
  await assert.rejects(mergeAway(v, 'means-design', 'Means Design Studio', 'means-interiors'), /isn’t in Partners any more/);
});

test('Partners merge stopped part way (a page write failing) leaves the old company there; merging again finishes it', async () => {
  const w = await mergeWorld();
  await w.run();
  const prep = w.DB.prepare.bind(w.DB);
  w.DB.prepare = (sql) => {
    const st = prep(sql);
    if (!/^UPDATE kids SET/.test(sql)) return st;
    const bind = st.bind.bind(st);
    st.bind = (...a) => { const b = bind(...a); b.run = () => Promise.reject(new Error('D1_ERROR: network connection lost')); return b; };
    return st;
  };
  await assert.rejects(mergeAway(w, 'means-design', 'Means Design Studio', 'means-interiors'));
  w.DB.prepare = prep;
  assert.ok(await w.DB.prepare("SELECT slug FROM partners WHERE slug = 'means-design'").first(), 'not deleted');
  await mergeAway(w, 'means-design', 'Means Design Studio', 'means-interiors');
  assert.deepEqual((await w.kid('lizzie')).designers, ['means-interiors']);
  assert.equal(await w.DB.prepare("SELECT slug FROM partners WHERE slug = 'means-design'").first(), null);
});

test('a merge, a credit pick and Same as wait for Publish; only the JobTread sweep deploys, as the other syncs do', async () => {
  const w = await mergeWorld();
  w.env.CF_DEPLOY_HOOK = 'https://deploy.example/hook';
  const realFetch = globalThis.fetch;
  let hooks = 0;
  globalThis.fetch = async (url, init) => (String(url).startsWith('https://deploy.example/') ? (hooks += 1, new Response('{}')) : realFetch(url, init));
  try {
    await w.run();
    await w.set({ record: 'axel', kind: 'designed', partner: 'crosby-design-group', on: true });
    await w.set({ record: 'lizzie', kind: 'designed', partner: 'crosby-design-group', on: true });
    await setLink(w.DB, { company: nameKey('SOARF'), partner: 'brian-robins-family-foundation' });
    const { applyLink } = await import('../functions/api/_room-credits.js');
    await applyLink(w.env, { now: w.now() });
    await mergeAway(w, 'means-design', 'Means Design Studio', 'means-interiors');
    assert.equal(hooks, 0, 'a person’s changes go live with Publish');
    // A pick in JobTread, saved by the sweep: an automation, it deploys
    w.jt.jobs[0].values[DESIGNED] = [...w.jt.jobs[0].values[DESIGNED], 'Means Interiors'];
    await w.run(MIN); await w.run();
    assert.equal(hooks, 1, 'the JobTread sweep deploys what it saved');
  } finally { globalThis.fetch = realFetch; }
});

// ── From the final review ──

test('Partners merge: a Same as on the old company’s name to a company since deleted counts as none: the credit holds after the merge', async () => {
  const w = await mergeWorld();
  await w.run();
  w.jt.jobs[0].values[DESIGNED] = ['Means Design Studio'];
  await w.run(MIN); await w.run();
  // An old link on that name, to a partner long gone from Partners (Delete leaves links behind)
  await w.DB.prepare("INSERT INTO partners (slug, name, level, category, featured, data) VALUES ('gone-co', 'Gone Co', 'friend', 'design', 0, '{\"slug\":\"gone-co\",\"name\":\"Gone Co\"}')").run();
  await setLink(w.DB, { company: nameKey('Means Design Studio'), partner: 'gone-co' });
  await w.DB.prepare("DELETE FROM partners WHERE slug = 'gone-co'").run();
  await mergeAway(w, 'means-design', 'Means Design Studio', 'means-interiors');
  await w.run(); await w.run();
  assert.deepEqual((await w.kid('axel')).designers, ['means-interiors']);
  assert.deepEqual((await creditsView(w.env)).unknown, []);
});

test('Partners merge: a company a person took off a job stays off there as the company it went into (a pick from before doesn’t put it on)', async () => {
  const w = await mergeWorld();
  await w.run();
  w.jt.jobs[0].values[DESIGNED] = ['Means Design Studio'];
  await w.run(MIN);
  await takenOffAt(w, 'means-design', 'Means Design Studio', w.now() + 1000);
  const put = w.put.length;
  await mergeAway(w, 'means-design', 'Means Design Studio', 'means-interiors');
  await w.run(); await w.run();
  assert.equal(w.put.length, put, 'nobody put on: the take-off came after the pick');
  assert.deepEqual((await w.kid('axel')).designers, ['means-interiors'], 'the credit stands');
});

test('a person’s credit change and a merge are theirs in History and the audit log, not the sync’s', async () => {
  const w = await mergeWorld();
  await w.run();
  await w.set({ record: 'axel', kind: 'designed', partner: 'crosby-design-group', on: true });
  const pick = await w.DB.prepare("SELECT user_email FROM audit_log WHERE entity_type = 'kids' AND entity_slug = 'axel' ORDER BY id DESC").first();
  assert.equal(pick?.user_email, 'clareece@soardcharity.com');
  await mergeAway(w, 'means-design', 'Means Design Studio', 'means-interiors');
  const merged = await w.DB.prepare("SELECT user_email FROM audit_log WHERE entity_type = 'kids' AND entity_slug = 'lizzie' ORDER BY id DESC").first();
  assert.equal(merged?.user_email, 'staff');
});

test('the SOARD Advisory Board, kept by the site, can’t be merged in or out', async () => {
  const w = await mergeWorld();
  const { mergeCheck } = await import('../functions/api/_room-credits.js');
  await assert.rejects(mergeCheck(w.env, { from: 'soard-advisory-board', into: 'means-interiors' }), /kept by the site/);
  await assert.rejects(mergeCheck(w.env, { from: 'means-design', into: 'soard-advisory-board' }), /kept by the site/);
});
