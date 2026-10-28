/**
 * Community projects belong to their JobTread jobs (functions/api/_reveals.js
 * matchProject, loadProjects): an organization's job ("Perfect Harmony Health
 * (2026)", or "The Lionheart School" named by hand) is its project's, never a
 * kid's, and the places that list jobs (the board's makeovers in progress)
 * show the project, named only once it's public.
 * Run: node --test tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { matchProject, matchKid, yearsOf, normalizeName, loadProjects, loadKidsAndProjects, FIELD_JOB_STATUS } from '../functions/api/_reveals.js';
import { projectsNow } from '../functions/api/_board.js';

const org = (slug, name, year, extra = {}) => ({ kind: 'community', slug, name, year, status: 'in-progress', ...extra });
const kid = (slug, name, year, extra = {}) => ({ slug, name, year, ...extra });

test('the years a record is filed under', () => {
  assert.deepEqual(yearsOf({ year: 2026 }), [2026]);
  assert.deepEqual(yearsOf({ year: '2026' }), [2026]);
  assert.deepEqual(yearsOf({ year: '2025 - 2026' }), [2025, 2026], 'a project across two years');
  assert.deepEqual(yearsOf({ year: '2019-2021' }), [2019, 2020, 2021]);
  assert.deepEqual(yearsOf({ year: '' }), []);
  assert.deepEqual(yearsOf({}), []);
});

test('names: apostrophes close up, so "Children’s" and "Childrens" are one word', () => {
  assert.equal(normalizeName('Children’s Development Academy'), 'childrens development academy');
  assert.equal(normalizeName("Children's"), 'childrens');
  assert.equal(normalizeName("D'Andre O’Neil"), 'dandre oneil');
  assert.equal(normalizeName('Josué'), 'josue');
  assert.equal(matchKid("D'Andre Smith (2026)", [kid('dandre', "D'Andre", 2026)]).slug, 'dandre', 'a kid’s apostrophe still matches');
});

test('an organization’s job is its project’s; a kid’s job stays the kid’s', () => {
  const list = [
    kid('max', 'Max', 2026), kid('grace', 'Grace', 2026),
    org('perfect-harmony-health', 'Perfect Harmony Health', '2026'),
    org('grace-academy', 'Grace Academy', '2026'),
    org('childrens-development-academy', 'Children’s Development Academy', '2025 - 2026'),
    org('the-lionheart-school', 'The Lionheart School', '2026', { jobtreadJobId: 'jLion' }),
    org('the-cottage-school', 'The Cottage School', '2021', { status: 'completed' }),
  ];
  const m = (name, id = null) => matchProject(name, list, id)?.slug ?? null;
  assert.equal(m('Max Sample (2026)'), 'max');
  assert.equal(m('Perfect Harmony Health (2026)'), 'perfect-harmony-health');
  assert.equal(m('Perfect Harmony Health (2025)'), null, 'another year is another project');
  assert.equal(m('Grace Academy (2026)'), 'grace-academy', 'the longer name is the job’s, not the kid Grace’s');
  assert.equal(m('Grace Wells (2026)'), 'grace');
  assert.equal(m('Childrens Development Academy (2025)'), 'childrens-development-academy');
  assert.equal(m('The Lionheart School', 'jLion'), 'the-lionheart-school', 'linked by its job');
  assert.equal(m('Lionheart (2027)', 'jLion'), 'the-lionheart-school', 'the link wins whatever the job is called');
  assert.equal(m('The Lionheart School (2026)', 'jOther'), null, 'linked to another job: never by name');
  assert.equal(m('The Cottage School'), null, 'a hand-named job (no year) never reopens a finished project');
  assert.equal(m('Max'), null, 'a kid needs the year');
});

test('a job named by hand (no year) finds an unfinished organization by its exact name only', () => {
  const list = [org('brightway', 'Brightway Academy', '2026'), kid('bright', 'Bright', 2026)];
  assert.equal(matchProject('Brightway Academy', list)?.slug, 'brightway');
  assert.equal(matchProject('Brightway Academy Annex', list), null, 'the whole name, nothing more');
  assert.equal(matchProject('Brightway', list), null);
});

async function world() {
  const DB = await createD1({ schemaFiles: ['scripts/schema.sql'] });
  const put = (p) => DB.prepare('INSERT INTO community (slug, name, order_num, data) VALUES (?, ?, 0, ?)').bind(p.slug, p.name, JSON.stringify(p)).run();
  await put({ slug: 'perfect-harmony-health', name: 'Perfect Harmony Health', year: '2026', status: 'in-progress', story: '<p>The story</p>', heroImage: 'h.jpg' });
  await put({ slug: 'the-lionheart-school', name: 'The Lionheart School', year: '2026', status: 'in-progress', publishStatus: 'draft', jobtreadJobId: 'jLion' });
  await put({ slug: 'grace-academy', name: 'Grace Academy', year: '2026', status: 'in-progress' });
  await DB.prepare('INSERT INTO kids (slug, name, year, status, data) VALUES (?, ?, ?, ?, ?)').bind('max', 'Max', 2026, 'in-progress', JSON.stringify({ name: 'Max', year: 2026 })).run();
  return DB;
}

test('loading projects: published ones, drafts on request, and the public page only when there is one', async () => {
  const DB = await world();
  assert.deepEqual((await loadProjects(DB)).map((p) => p.slug).sort(), ['grace-academy', 'perfect-harmony-health']);
  const all = await loadProjects(DB, { drafts: true });
  const by = Object.fromEntries(all.map((p) => [p.slug, p]));
  assert.deepEqual([by['perfect-harmony-health'].page, by['grace-academy'].page, by['the-lionheart-school'].page], ['/community/perfect-harmony-health/', null, null], 'a page needs a story and to be published');
  assert.equal(by['the-lionheart-school'].jobtreadJobId, 'jLion');
  assert.equal(by['the-lionheart-school'].published, false);
  assert.equal('data' in by['perfect-harmony-health'], false);
  assert.equal((await loadProjects(DB, { withData: true }))[0].data.name !== undefined, true);
  assert.deepEqual((await loadKidsAndProjects(DB)).map((r) => r.slug).sort(), ['grace-academy', 'max', 'perfect-harmony-health', 'the-lionheart-school']);
  assert.deepEqual(await loadProjects({ prepare: () => ({ all: async () => { throw new Error('no such table'); } }) }), [], 'no table: none');
});

test('the board’s makeovers in progress: a project by name once it’s public, never the job’s own name', async () => {
  const DB = await world();
  const job = (id, name, status) => ({ id, name, customFieldValues: { nodes: [{ value: status, customField: { id: FIELD_JOB_STATUS } }] } });
  const jobs = [
    job('jMax', 'Max Sample (2026)', 'Build'),
    job('jPHH', 'Perfect Harmony Health (2026)', 'Design'),
    job('jLion', 'The Lionheart School', 'Build'),
    job('jGA', 'Grace Academy (2026)', 'Build'),
    job('jX', 'Not Published Yet (2026)', 'Build'),
    job('jW', 'Somebody Waiting (2026)', 'Awaiting Funding'),
  ];
  const fetchImpl = async () => Response.json({ organization: { jobs: { nodes: jobs, nextPage: null } } });
  const v = await projectsNow({ DB, JOBTREAD_GRANT_KEY: 'k' }, { fetchImpl, fresh: true });
  assert.deepEqual(v.byStatus, { Build: 4, Design: 1, 'Awaiting Funding': 1 });
  assert.deepEqual(v.building, [
    { name: 'Max', slug: 'max', status: 'Build' },
    { name: 'Perfect Harmony Health', slug: 'perfect-harmony-health', status: 'Design', kind: 'community', url: '/community/perfect-harmony-health/' },
    { name: null, slug: null, status: 'Build', kind: 'community', url: null },
    { name: 'Grace Academy', slug: null, status: 'Build', kind: 'community', url: null },
    { name: null, slug: null, status: 'Build' },
  ], 'the hidden Lionheart draft goes unnamed; Grace Academy is public with no page yet, so no link');
  assert.ok(!JSON.stringify(v).includes('Not Published Yet'), 'a job’s own name never reaches the board');
});
