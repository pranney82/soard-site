/**
 * JobTread's five file tags and who sees each (functions/api/_file-tags.js)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { ensureTags, tagIds, TAGS, maybeKeepTags, tagsFacts } from '../functions/api/_file-tags.js';

const ROLES = [
  { id: 'r-sig', name: 'Signature', type: 'vendor' }, { id: 'r-champ', name: 'Champion', type: 'vendor' },
  { id: 'r-build', name: 'Builder', type: 'vendor' }, { id: 'r-friend', name: 'Friend', type: 'vendor' },
  { id: 'r-trade', name: 'Trade Partner', type: 'vendor' }, { id: 'r-design', name: 'Design Partner', type: 'vendor' },
  { id: 'r-photo', name: 'Photographer', type: 'vendor' }, { id: 'r-family', name: 'Makeover Family', type: 'customer' },
  { id: 'r-board', name: 'Board Member', type: 'customer' }, { id: 'r-pm', name: 'Project Manager', type: 'internal' },
];

function world({ tags = [], roles = ROLES } = {}) {
  const w = { tags: tags.map((t) => ({ ...t, aces: t.aces || [] })), writes: [], next: 1 };
  w.fetchImpl = async (_url, init) => {
    const q = JSON.parse(init.body).query;
    if (q.organization) {
      return Response.json({ organization: { roles: { nodes: roles }, fileTags: { nodes: w.tags.map((t) => ({ id: t.id, name: t.name, aces: { nodes: t.aces.map((a) => ({ id: a.id, role: { id: a.roleId } })) } })) } } });
    }
    w.writes.push(q);
    if (q.createFileTag) { const t = { id: `t${w.next++}`, name: q.createFileTag.$.name, description: q.createFileTag.$.description, color: q.createFileTag.$.color, aces: [] }; w.tags.push(t); return Response.json({ createFileTag: { createdFileTag: { id: t.id, name: t.name } } }); }
    if (q.createAce) { const t = w.tags.find((x) => x.id === q.createAce.$.targetId); t.aces.push({ id: `a${w.next++}`, roleId: q.createAce.$.assignee.role.roleId, notify: q.createAce.$.notify }); return Response.json({}); }
    if (q.deleteAce) { for (const t of w.tags) t.aces = t.aces.filter((a) => a.id !== q.deleteAce.$.id); return Response.json({}); }
    throw new Error(`unexpected ${JSON.stringify(q).slice(0, 80)}`);
  };
  return w;
}
const audience = (w, name) => w.tags.find((t) => t.name === name).aces.map((a) => ROLES.find((r) => r.id === a.roleId).name).sort();
const env = async () => ({ DB: await createD1({ schemaFiles: ['scripts/schema.sql'] }), JOBTREAD_GRANT_KEY: 'k' });

test('the five tags are made with their audiences, notify off, and their ids kept', async () => {
  const e = await env();
  const w = world();
  const r = await ensureTags(e, { fetchImpl: w.fetchImpl });
  assert.deepEqual(r.made, ['Before', 'During', 'After', 'Design', 'Plans']);
  for (const n of ['Before', 'During', 'After']) assert.deepEqual(audience(w, n), ['Builder', 'Champion', 'Design Partner', 'Friend', 'Photographer', 'Signature', 'Trade Partner']);
  assert.deepEqual(audience(w, 'Design'), ['Builder', 'Champion', 'Design Partner', 'Friend', 'Signature']);
  assert.deepEqual(audience(w, 'Plans'), ['Builder', 'Champion', 'Design Partner', 'Friend', 'Signature', 'Trade Partner']);
  assert.ok(w.writes.filter((q) => q.createAce).every((q) => q.createAce.$.notify === false), 'nobody is notified');
  assert.ok(!w.tags.some((t) => t.aces.some((a) => ['r-family', 'r-board', 'r-pm'].includes(a.roleId))), 'never families, the board or staff roles');
  assert.ok(TAGS.every((t) => t.name.length <= 25 && t.description.length <= 256 && /^#[0-9a-f]{6}$/.test(t.color)));
  const ids = await tagIds(e.DB);
  assert.deepEqual([...ids.keys()].sort(), ['After', 'Before', 'Design', 'During', 'Plans']);
  // Nothing to do the second time
  const n = w.writes.length;
  const again = await ensureTags(e, { fetchImpl: w.fetchImpl });
  assert.deepEqual([again.made, again.added, again.removed], [[], [], []]);
  assert.equal(w.writes.length, n);
});

test('an existing tag of that name is used, its audience set right, and a role added by hand comes off', async () => {
  const e = await env();
  const w = world({ tags: [{ id: 'old-plans', name: 'plans', aces: [{ id: 'x1', roleId: 'r-family' }, { id: 'x2', roleId: 'r-sig' }] }] });
  const r = await ensureTags(e, { fetchImpl: w.fetchImpl });
  assert.ok(!r.made.includes('Plans'));
  assert.deepEqual(audience(w, 'plans'), ['Builder', 'Champion', 'Design Partner', 'Friend', 'Signature', 'Trade Partner']);
  assert.ok(r.removed.includes('plans: Makeover Family'));
  assert.equal((await tagIds(e.DB)).get('Plans'), 'old-plans');
});

test('families come off the old .BeforePics; its other audience and every other old tag stay as they are', async () => {
  const e = await env();
  const w = world({ tags: [
    { id: 'bp', name: '.BeforePics', aces: [{ id: 'b1', roleId: 'r-family' }, { id: 'b2', roleId: 'r-design' }] },
    { id: 'mf', name: '_MakeoverFamily', aces: [{ id: 'm1', roleId: 'r-family' }] },
    { id: 'fp', name: '.FinalPlans', aces: [{ id: 'f1', roleId: 'r-design' }] },
  ] });
  const r = await ensureTags(e, { fetchImpl: w.fetchImpl });
  assert.deepEqual(audience(w, '.BeforePics'), ['Design Partner']);
  assert.deepEqual(audience(w, '_MakeoverFamily'), ['Makeover Family'], 'their papers stay theirs');
  assert.deepEqual(audience(w, '.FinalPlans'), ['Design Partner']);
  assert.ok(r.removed.includes('.BeforePics: Makeover Family'));
});

test('a role JobTread doesn’t have is reported, and the rest still set', async () => {
  const e = await env();
  const w = world({ roles: ROLES.filter((r) => r.name !== 'Photographer') });
  const r = await ensureTags(e, { fetchImpl: w.fetchImpl });
  assert.deepEqual(r.missingRoles, ['Photographer']);
  assert.ok(audience(w, 'Before').includes('Champion'));
});

test('hourly on the heartbeat, one run at a time; the last result kept for Site → Automations, a JobTread failure too', async () => {
  const e = await env();
  const w = world();
  const T = Date.parse('2026-11-11T21:00:00Z');
  const first = await maybeKeepTags(e, { fetchImpl: w.fetchImpl, now: T });
  assert.deepEqual(first.made, ['Before', 'During', 'After', 'Design', 'Plans']);
  assert.equal(await maybeKeepTags(e, { fetchImpl: w.fetchImpl, now: T + 30 * 60 * 1000 }), null, 'not again within the hour');
  const down = async () => new Response('busy', { status: 503 });
  const failed = await maybeKeepTags(e, { fetchImpl: down, now: T + 61 * 60 * 1000 });
  assert.match(failed.error, /JobTread/);
  const facts = await tagsFacts(e.DB);
  assert.match(facts.last.error, /JobTread/);
  assert.deepEqual(facts.kept.sort(), ['After', 'Before', 'Design', 'During', 'Plans']);
});
