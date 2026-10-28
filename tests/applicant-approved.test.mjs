/**
 * Approved → the makeover's JobTread job and the kid's website profile
 * (functions/api/_applicant-approved.js): when it happens (only once the
 * family's decision has settled, the way their email sees it), what it makes,
 * what it reuses, what it never touches, and the matching that keeps the
 * profile on its own job.
 * Run: node --test tests/
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { fakeApplicantWorld, ORG } from './lib/fake-applicant-world.mjs';
import { handleWorkflowCall, runNotifications, pauseEmails, resolveHeld, resumeEmails } from '../functions/api/_applicant-notify.js';
import {
  runApprovals, approvalsStatus, siteNameOf, cleanName, childCountOf, jobNameFor, ageOn, cleanYear, freeSlug, existingJob, newKidRecord,
  JOB_FIELD_TYPES, JOB_START_STATUS,
} from '../functions/api/_applicant-approved.js';
import { FIELD_STATUS as JOB_STATUS, linkJobs, syncKidStatuses } from '../functions/api/_kid-status.js';
import { matchKid } from '../functions/api/_reveals.js';
import { writeSlackConfig } from '../functions/api/_broadcast-notify.js';
import { ensureCompanyCamSchema } from '../functions/api/_companycam-sync.js';

const STATUS = '22P46wDp3NLd';
const YEAR = '22P52xmCz3cx';
const TYPES = '22P5KVgrLeXK';
const BIRTHDAY = '22P46syd4j6E';
const DIAGNOSIS = '22P46st8HNPY';
const EMAIL = '22NJw43QvHeJ';
const T0 = Date.parse('2026-10-21T15:00:00Z'); // 11 AM Eastern
const MIN = 60 * 1000;
const iso = (t) => new Date(t).toISOString();

// ─── The fake world, plus what this needs from JobTread: jobs ───────

let w; let env; let jt; let fetchImpl;
function withJobs(inner) {
  let seq = 0;
  const state = { jobCalls: [], deny: new Set(), fail: 0 };
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const values = (fields, where) => {
    const ids = where ? (where[1] === 'in' ? where[2] : [where[2]]) : Object.keys(fields);
    const nodes = [];
    for (const id of ids) for (const one of [].concat(fields[id] ?? [])) nodes.push({ value: one, customField: { id } });
    return { nodes };
  };
  const fn = async (url, init = {}) => {
    const u = new URL(typeof url === 'string' ? url : url.url);
    if (u.host === 'api.jobtread.com' && init.body) {
      const { query } = JSON.parse(init.body);
      const { $, ...rest } = query;
      if (rest.createJob) {
        const input = rest.createJob.$;
        state.jobCalls.push({ grantKey: $.grantKey, input });
        // JobTread's refusal wording isn't something to match on: any 4xx means nothing was made
        if (state.deny.has($.grantKey)) return new Response('{"errors":["You can’t do that in this organization"]}', { status: 400 });
        if (state.fail > 0) { state.fail--; return new Response('busy', { status: 500 }); }
        if (input.name.length > 30) return new Response('name too long', { status: 400 });
        if (input.companycamId === 'linked-elsewhere') return new Response('This CompanyCam project is already linked to Another Job. If you want to link it to this job, unlink it there first.', { status: 400 });
        const owner = Object.values(w.world.accounts).find(a => a.locations.some(l => l.id === input.locationId));
        if (!owner) return new Response('no such location', { status: 400 });
        const job = { id: `job${String(++seq).padStart(8, '0')}`, name: input.name, closedOn: null, fields: input.customFieldValues };
        owner.jobs.push(job);
        return json({ createJob: { createdJob: { id: job.id, name: job.name } } });
      }
      if (rest.updateJob) {
        const input = rest.updateJob.$;
        state.coverCalls = [...(state.coverCalls || []), { grantKey: $.grantKey, jobId: input.id, coverPhoto: input.coverPhoto }];
        return json({ updateJob: {} });
      }
      // The approval module's account read (it asks for the family's homes)
      if (rest.account?.locations) {
        const sel = rest.account;
        const a = w.world.accounts[sel.$.id];
        if (!a) return json({ account: null });
        return json({ account: {
          id: a.id, name: a.name, type: a.type, createdAt: a.createdAt, archivedAt: a.archivedAt || null, organization: { id: a.org },
          customFieldValues: values(a.fields, sel.customFieldValues.$?.where),
          primaryLocation: a.locations[0] ? { id: a.locations[0].id } : null,
          locations: { nodes: a.locations.slice(0, 5).map(l => ({ id: l.id })) },
          jobs: { nodes: [...a.jobs].reverse().map(j => ({ id: j.id, name: j.name, closedOn: j.closedOn || null })) },
        } });
      }
    }
    return inner(url, init);
  };
  return { fn, state };
}

beforeEach(async () => {
  w = fakeApplicantWorld();
  jt = withJobs(w.fetchImpl);
  fetchImpl = jt.fn;
  env = { ...w.env, DB: await createD1({ schemaFiles: ['scripts/schema.sql'] }), JOBTREAD_QC_GRANT_KEY: 'qc-grant' };
  globalThis.fetch = fetchImpl; // the summary email (Resend) and Slack go through the global fetch
  // It starts before any of these families is approved
  await runApprovals(env, { fetchImpl, now: T0 - 60 * MIN });
});

let n = 0;
function family(name, status, { fields = {}, home = true, jobs = [] } = {}) {
  const id = `acctA${String(++n).padStart(7, '0')}`;
  w.world.accounts[id] = {
    id, name, type: 'customer', org: ORG, createdAt: '2026-10-19T12:00:00Z',
    fields: { [STATUS]: status, [YEAR]: '2027', [TYPES]: ['Bedroom', 'Bathroom'], [BIRTHDAY]: '2015-03-02', [DIAGNOSIS]: 'Cerebral palsy', ...fields },
    contacts: [{ id: `${id}-c`, name: `${name.split(' ')[0]}'s Mom`, fields: { [EMAIL]: `${name.split(' ')[0].toLowerCase()}@example.com` } }],
    primaryContactId: `${id}-c`, locations: home ? [{ id: `${id}-home`, address: '1 Main St', city: 'Atlanta' }] : [], files: [], comments: [], jobs,
  };
  return w.world.accounts[id];
}
/** A status change in JobTread: the event JobTread logs, then the workflow's call */
async function change(a, to, at) {
  const from = a.fields[STATUS];
  a.fields[STATUS] = to;
  const id = `evt${++n}`;
  w.world.events.push({ id, createdAt: iso(at), type: 'accountUpdated', createdByGrantId: 'g1', createdByGrantName: 'JobTread App', createdByUser: { name: 'Linzi Berkowitz', emailAddress: 'linzi@soardcharity.com' }, data: { next: { custom: { Status: to } }, previous: { custom: { Status: from } } }, account: { id: a.id, type: 'customer' } });
  return handleWorkflowCall(env, { eventId: id, accountId: a.id, previousStatus: from ?? 'null', nextStatus: to ?? 'null' }, { fetchImpl, now: at });
}
/** The application sweep at each time: family emails, then approvals */
async function sweep(...times) {
  const out = [];
  for (const t of times) { await runNotifications(env, { fetchImpl, now: t }); out.push(await runApprovals(env, { fetchImpl, now: t })); }
  return out;
}
const minutes = (from, to, step = 2) => Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => T0 + (from + i * step) * MIN);
const kids = async () => ((await env.DB.prepare('SELECT slug, data FROM kids').all()).results || []).map(r => ({ slug: r.slug, ...JSON.parse(r.data) }));
const activity = async (id) => (await env.DB.prepare("SELECT title, body FROM applicant_activity WHERE account_id = ? AND id LIKE 'approved:%' ORDER BY at").bind(id).all()).results;
const news = () => w.world.slack.filter(s => /set up/.test(s.text || ''));

// ─── The pieces ─────────────────────────────────────────────────────

test('the name on the site: first names only, never the last name', () => {
  assert.equal(siteNameOf('Remi & Nico Powell'), 'Remi & Nico');
  assert.equal(siteNameOf('Declan “Dex” Noel'), 'Dex', 'a nickname in quotes is what the family goes by');
  assert.equal(siteNameOf('Logan Michael Sesto'), 'Logan', 'no middle names');
  assert.equal(siteNameOf('Damon Tremayne Green Jr,'), 'Damon');
  assert.equal(siteNameOf('Ava, Ben and Cal Ortiz'), 'Ava, Ben & Cal');
  assert.equal(siteNameOf('Isabella Moore', 'Bella'), 'Bella', 'the form’s first-name answer wins');
  assert.equal(siteNameOf('Max'), 'Max');
  assert.equal(childCountOf('Remi & Nico'), 2);
  assert.equal(childCountOf('Ava, Ben & Cal'), 3);
  assert.equal(childCountOf('Max'), 1);
});

test('a typed first name reaches the public page only as letters, spaces, apostrophes, hyphens and periods', () => {
  // Names from every alphabet, accents (composed or not) and the punctuation names use stay
  assert.equal(siteNameOf('X', 'José'), 'José');
  assert.equal(siteNameOf('X', 'Jose\u0301'), 'Jos\u00e9', 'a combining accent is kept (and composed)');
  assert.equal(siteNameOf('X', "D'Andre"), "D'Andre");
  assert.equal(siteNameOf('X', 'Mary-Kate'), 'Mary-Kate');
  assert.equal(siteNameOf('X', 'J.J.'), 'J.J.');
  assert.equal(siteNameOf('X', 'Zoë Anne'), 'Zoë Anne');
  assert.equal(siteNameOf('X', '美咲'), '美咲');
  // Markup and script breakouts don't survive, whatever's typed
  assert.equal(siteNameOf('X', '<script>alert(1)</script>'), 'script alert script');
  for (const typed of ['Ava</script><img src=x onerror=alert(1)>', 'Ava "\\u003c/script\\u003e', "Ava';alert`1`//", 'Ava{{7*7}}${1}']) {
    const name = siteNameOf('X', typed);
    assert.match(name, /^Ava\b/, typed);
    assert.doesNotMatch(name, /[<>"=()/\\;`{}$*\d]/, typed);
  }
  assert.equal(siteNameOf('X', '  Ava   🎉  '), 'Ava', 'emoji and runs of spaces go');
  assert.equal(siteNameOf('X', 'Ava\n\tLee'), 'Ava Lee');
  // Twins typed as one answer: the " & " is the site's own
  assert.equal(siteNameOf('X', 'Remi and Nico'), 'Remi & Nico');
  assert.equal(siteNameOf('X', 'Remi <b>&</b> Nico'), 'Remi b & b Nico');
  // Nothing usable typed: the account name decides
  assert.equal(siteNameOf('Ava Stone', '<>{}'), 'Ava');
  // Capped: 30 characters a name, 60 for the whole
  assert.equal(siteNameOf('X', 'A'.repeat(80)), 'A'.repeat(30));
  assert.ok(siteNameOf('X', `${'A'.repeat(29)} & ${'B'.repeat(29)} & ${'C'.repeat(29)}`).length <= 60);
  assert.doesNotMatch(siteNameOf('X', `${'A'.repeat(29)} & ${'B'.repeat(29)} & C`), /[&,\s]$/, 'never ends on a separator');
  // The account name's own path is cleaned too (it can come from the form)
  assert.doesNotMatch(siteNameOf('<i>Ava</i> Stone'), /[<>/]/);
  assert.equal(siteNameOf('Declan “<b>” Noel'), 'Declan');
  assert.equal(cleanName(null), '');
});

test('the job’s name: "Name (Year)", inside JobTread’s 30 characters', () => {
  assert.equal(jobNameFor('Remi & Nico Powell', 2026), 'Remi & Nico Powell (2026)', 'the Zap’s format');
  assert.equal(jobNameFor('Oakley Faye Xiu Ping Roberson', 2027), 'Oakley Roberson (2027)', 'middle names go first');
  const long = jobNameFor('Maximiliano Bartholomew-Fitzgerald', 2027);
  assert.ok(long.length <= 30 && long.endsWith(' (2027)'), long);
  assert.equal(cleanYear('2027'), 2027);
  assert.equal(cleanYear('**ADD YEAR**'), null);
  assert.equal(cleanYear(''), null);
});

test('ages, web addresses and the job to reuse', () => {
  assert.equal(ageOn('2015-10-21', '2026-10-20'), 10, 'the day before the birthday');
  assert.equal(ageOn('2015-10-20', '2026-10-20'), 11);
  assert.equal(ageOn(null, '2026-10-20'), null);
  assert.equal(freeSlug('Remi & Nico', 2027, new Set()), 'remi-and-nico');
  assert.equal(freeSlug('Remi & Nico', 2027, new Set(['remi-and-nico'])), 'remi-and-nico-2027');
  assert.equal(freeSlug('Josué', 2027, new Set(['josue', 'josue-2027'])), 'josue-2027-2');
  const jobs = [
    { id: 'old', name: 'Ava Stone (2024)', closedOn: '2024-12-01' },
    { id: 'byhand', name: 'Ava Stone', closedOn: null },
    { id: 'this', name: 'Ava Stone (2027)', closedOn: null },
  ];
  assert.equal(existingJob(jobs, 2027).id, 'this', 'an open job for the year first');
  assert.equal(existingJob(jobs.slice(0, 2), 2027).id, 'byhand', 'an open job with no year in its name is this one');
  assert.equal(existingJob(jobs.slice(0, 1), 2027), null, 'last makeover’s closed job is another makeover');
  const rec = newKidRecord({ name: 'Remi & Nico', slug: 'remi-and-nico', year: 2027, age: 11, types: ['Bedroom', 'Ramp'], jobId: 'J1' });
  assert.deepEqual([rec.publishStatus, rec.status, rec.childCount, rec.jobtreadJobId], ['draft', 'needs-funding', 2, 'J1']);
  assert.deepEqual(rec.roomTypes, ['Dream Bedroom', 'Wheelchair Ramp']);
  assert.deepEqual([rec.roomCount, rec.bedroomCount, rec.bathroomCount], [2, 1, 0], 'a ramp counts toward rooms built');
  assert.equal(rec.diagnosis, '', 'the diagnosis stays private (the GitHub copy is public)');
});

// ─── When it happens ────────────────────────────────────────────────

test('approved: once the family’s email is out, the job and a hidden profile, once', async () => {
  const a = family('Ava Stone', 'In Review');
  await change(a, 'Approved', T0);
  await sweep(...minutes(1, 29));
  assert.equal(jt.state.jobCalls.length, 0, 'nothing while the decision can still be moved back');
  await sweep(...minutes(30, 40));
  assert.equal(a.comments.filter(c => c.name === 'Application Decision').length, 1, 'the family heard first');
  assert.equal(jt.state.jobCalls.length, 1);
  const call = jt.state.jobCalls[0];
  assert.equal(call.grantKey, 'qc-grant', 'made as the Qualification Committee, like the Zap');
  assert.equal(call.input.name, 'Ava Stone (2027)');
  assert.equal(call.input.locationId, `${a.id}-home`);
  assert.deepEqual(call.input.customFieldValues, { [JOB_STATUS]: JOB_START_STATUS, [JOB_FIELD_TYPES]: ['Bedroom', 'Bathroom'] });

  const [kid] = await kids();
  assert.equal(kid.slug, 'ava');
  assert.deepEqual([kid.name, kid.year, kid.age, kid.status, kid.publishStatus, kid.jobtreadJobId], ['Ava', 2027, 11, 'needs-funding', 'draft', a.jobs[0].id]);
  assert.deepEqual(kid.roomTypes, ['Dream Bedroom', 'Accessible Bathroom']);
  assert.equal(JSON.stringify(kid).includes('Stone'), false, 'no last name anywhere in the profile');
  assert.equal(JSON.stringify(kid).includes('Cerebral'), false, 'no diagnosis');
  const audit = await env.DB.prepare("SELECT user_email, action, entity_slug FROM audit_log WHERE entity_type = 'kids'").all();
  assert.deepEqual(audit.results, [{ user_email: 'JobTread (automatic)', action: 'created', entity_slug: 'ava' }], 'reads like an admin save in Recent changes');
  const hist = await env.DB.prepare("SELECT count(*) AS n FROM content_versions WHERE collection = 'kids' AND slug = 'ava'").first('n');
  assert.equal(hist, 1, 'History has the first version');

  assert.equal(news().length, 1, 'one good-news card');
  assert.match(news()[0].text, /Ava’s makeover is set up/);
  assert.match(JSON.stringify(news()[0].blocks), /Ava Stone \(2027\)/);
  assert.match((await activity(a.id)).map(r => r.title).join('\n'), /Website profile made: Ava/);

  await sweep(...minutes(42, 120, 6));
  assert.equal(jt.state.jobCalls.length, 1, 'never a second job');
  assert.equal((await kids()).length, 1, 'never a second profile');
  assert.equal(news().length, 1);
  const status = await approvalsStatus(env.DB);
  assert.equal(status.recent[0].kid_slug, 'ava');
  assert.equal(status.waiting.length, 0);
});

test('a mis-click moved back makes nothing', async () => {
  const a = family('Blake Ray', 'In Review');
  await change(a, 'Approved', T0);
  await sweep(T0 + 2 * MIN);
  await change(a, 'In Review', T0 + 3 * MIN);
  await sweep(...minutes(4, 120, 4));
  assert.equal(jt.state.jobCalls.length, 0);
  assert.equal((await kids()).length, 0);
});

test('a 9 PM approval waits for the family’s 8 AM email', async () => {
  const a = family('Casey Moore', 'In Review');
  const night = Date.parse('2026-10-22T01:00:00Z'); // 9 PM Eastern
  await change(a, 'Approved', night);
  for (let t = night + 2 * MIN; t < Date.parse('2026-10-22T12:00:00Z'); t += 30 * MIN) await sweep(t);
  assert.equal(jt.state.jobCalls.length, 0, 'not overnight: the family hasn’t been told');
  await sweep(Date.parse('2026-10-22T12:01:00Z'), Date.parse('2026-10-22T12:03:00Z'));
  assert.equal(a.comments.filter(c => c.name === 'Application Decision').length, 1);
  assert.equal(jt.state.jobCalls.length, 1, 'right after the family’s email');
});

test('paused for a cleanup: nothing until staff decide; "Don’t send" still makes the job', async () => {
  const a = family('Drew Lane', 'In Review');
  await pauseEmails(env.DB, { minutes: 120, user: 'Peter', now: T0 - MIN });
  await change(a, 'Approved', T0);
  const [r] = await sweep(T0 + 40 * MIN);
  assert.equal(r.paused, true);
  assert.equal((await approvalsStatus(env.DB)).lastRun.paused, true, 'Site → Automations still sees it running');
  assert.equal(jt.state.jobCalls.length, 0);
  await resolveHeld(env, { send: false, user: 'Peter', fetchImpl, now: T0 + 50 * MIN });
  await sweep(T0 + 52 * MIN);
  assert.equal(jt.state.jobCalls.length, 0, 'still paused: the cleanup may not be over');
  await resumeEmails(env.DB, { now: T0 + 60 * MIN });
  await sweep(T0 + 62 * MIN);
  assert.equal(jt.state.jobCalls.length, 1, 'they’re approved; staff only chose not to email');
});

test('a family approved before this started is never touched', async () => {
  const a = family('Emery Brown', 'In Review');
  // Approved (and emailed) in the Zap era, before the first run
  const before = T0 - 3 * 60 * MIN;
  await change(a, 'Approved', before);
  await runNotifications(env, { fetchImpl, now: before + 40 * MIN });
  // That first run happened at T0 - 60 min (beforeEach); the approval is older
  await sweep(...minutes(0, 60, 10));
  assert.equal(jt.state.jobCalls.length, 0);
});

test('a forged wake-up for a family approved long ago makes no job, no profile and no Slack post', async () => {
  // Approved in a past season, no applicant_notify row: the old hole was a body saying "previously Applied"
  const a = family('Finley Hart', 'Approved');
  const r = await handleWorkflowCall(env, { accountId: a.id, previousStatus: 'Applied', nextStatus: 'Approved', status: 'Approved' }, { fetchImpl, now: T0 });
  assert.equal(r.verified, false);
  await sweep(...minutes(1, 120, 4));
  assert.equal(a.comments.filter(c => c.name === 'Application Decision').length, 0, 'no email');
  assert.equal(jt.state.jobCalls.length, 0, 'no JobTread job');
  assert.equal((await kids()).length, 0, 'no kid draft (it would be committed to the public repo)');
  assert.equal(news().length, 0, 'nothing in Slack');
});

// ─── What it reuses and what it can't do yet ────────────────────────

test('a job already in JobTread is used, and the profile links to it', async () => {
  const a = family('Finn Hale', 'In Review', { jobs: [{ id: 'jobByHand', name: 'Finn Hale (2027)', closedOn: null }] });
  await change(a, 'Approved', T0);
  await sweep(...minutes(30, 40));
  assert.equal(jt.state.jobCalls.length, 0, 'no duplicate job');
  const [kid] = await kids();
  assert.equal(kid.jobtreadJobId, 'jobByHand');
  assert.match((await activity(a.id)).map(r => r.title).join('\n'), /Makeover job: Finn Hale \(2027\)/);
  assert.equal(news().length, 1, 'the profile is new, so it’s news');
  assert.match(JSON.stringify(news()[0].blocks), /already there/);
});

test('a profile staff already made (same name and year) is linked, never rewritten', async () => {
  const before = { name: 'Gia', slug: 'gia', year: 2027, status: 'in-progress', publishStatus: 'published', bio: '<p>Gia loves music.</p>' };
  await env.DB.prepare('INSERT INTO kids (slug, name, year, status, data) VALUES (?, ?, ?, ?, ?)').bind('gia', 'Gia', 2027, 'in-progress', JSON.stringify(before)).run();
  const a = family('Gia Park', 'In Review');
  await change(a, 'Approved', T0);
  await sweep(...minutes(30, 40));
  assert.equal(jt.state.jobCalls.length, 1);
  const all = await kids();
  assert.equal(all.length, 1);
  assert.deepEqual(all[0], before, 'untouched');
  assert.match((await activity(a.id)).map(r => r.title).join('\n'), /Website profile: Gia/);
});

test('the name is taken by another year’s kid: the new profile gets its own address', async () => {
  await env.DB.prepare('INSERT INTO kids (slug, name, year, status, data) VALUES (?, ?, ?, ?, ?)').bind('hugo', 'Hugo', 2023, 'completed', JSON.stringify({ name: 'Hugo', slug: 'hugo', year: 2023 })).run();
  const a = family('Hugo Diaz', 'In Review');
  await change(a, 'Approved', T0);
  await sweep(...minutes(30, 40));
  assert.deepEqual((await kids()).map(k => k.slug).sort(), ['hugo', 'hugo-2027']);
});

test('no home in JobTread: Slack hears once, and it’s made when the address arrives', async () => {
  env.SLACK_BOT_TOKEN = 'xoxb-test';
  await writeSlackConfig(env.DB, { channel: { id: 'C0NEWS', name: 'team' }, attention: { id: 'C0ALERT', name: 'alerts' } });
  const a = family('Ivy Cole', 'In Review', { home: false });
  await change(a, 'Approved', T0);
  await sweep(...minutes(30, 40));
  await sweep(...minutes(42, 50));
  assert.equal(jt.state.jobCalls.length, 0);
  const problems = w.world.slack.filter(s => /not made yet/.test(s.text || ''));
  assert.equal(problems.length, 1, 'one problem post, not one per try');
  assert.equal(problems[0].channel, 'C0ALERT');
  assert.match(JSON.stringify(problems[0].blocks), /home address/);
  assert.equal((await approvalsStatus(env.DB)).waiting[0].problem, 'no-home');

  a.locations.push({ id: `${a.id}-home`, address: '2 Oak St' });
  await sweep(...minutes(60, 70));
  assert.equal(jt.state.jobCalls.length, 1);
  assert.ok((w.world.slackEdits || []).some(e => /Resolved/.test(JSON.stringify(e))), 'the problem post turns ✅');
  assert.equal((await approvalsStatus(env.DB)).waiting.length, 0);
});

test('no *Makeover Year ("**ADD YEAR**"): waits for one', async () => {
  const a = family('Jade Wu', 'In Review', { fields: { [YEAR]: '**ADD YEAR**' } });
  await change(a, 'Approved', T0);
  await sweep(...minutes(30, 40));
  assert.equal(jt.state.jobCalls.length, 0);
  assert.equal((await approvalsStatus(env.DB)).waiting[0].problem, 'no-year');
  a.fields[YEAR] = '2027';
  await sweep(...minutes(60, 70));
  assert.equal(jt.state.jobCalls[0].input.name, 'Jade Wu (2027)');
});

const projects = async () => ((await env.DB.prepare('SELECT slug, data FROM community').all()).results || []).map(r => ({ slug: r.slug, ...JSON.parse(r.data) }));
const ORG_FIELDS = { [BIRTHDAY]: null, [DIAGNOSIS]: null };
async function addProject(p) {
  await env.DB.prepare('INSERT INTO community (slug, data, updated_at, name, order_num) VALUES (?, ?, ?, ?, ?)').bind(p.slug, JSON.stringify(p), iso(T0), p.name, p.order ?? 0).run();
}

test('an organization (no birthday or diagnosis) gets its job and a hidden community project linked to it', async () => {
  await addProject({ slug: 'camp-twin-lakes', name: 'Camp Twin Lakes', year: '2018', status: 'completed', order: 1 });
  const a = family('Lionheart School', 'In Review', { fields: ORG_FIELDS });
  await change(a, 'Approved', T0);
  await sweep(...minutes(30, 40));
  assert.equal(jt.state.jobCalls.length, 1);
  assert.equal((await kids()).length, 0, 'no kid profile for a school');
  const p = (await projects()).find(x => x.slug === 'lionheart-school');
  assert.ok(p, 'the project is in Community Projects');
  assert.deepEqual([p.name, p.year, p.status, p.publishStatus, p.jobtreadJobId, p.order], ['Lionheart School', '2027', 'in-progress', 'draft', a.jobs[0].id, 0],
    'hidden, In progress, linked to its job, first in the page’s order');
  assert.equal(p.story, '', 'no story: staff write it');
  assert.match((await activity(a.id)).map(r => r.title).join('\n'), /Community project made: Lionheart School/);
  const [card] = news();
  assert.match(card.text, /Lionheart School’s makeover is set up/);
  assert.match(JSON.stringify(card.blocks), /\/community\/lionheart-school\/, hidden until the story and photos are in/);
  assert.match(JSON.stringify(card.blocks), /#kids\/community\/lionheart-school/, 'the button opens the project');
  const row = await env.DB.prepare('SELECT project_slug, kid_slug, detail FROM applicant_approvals WHERE account_id = ?').bind(a.id).first();
  assert.deepEqual([row.project_slug, row.kid_slug, row.detail], ['lionheart-school', null, null]);
  const audit = await env.DB.prepare("SELECT user_email, action, entity_type FROM audit_log WHERE entity_type = 'community'").all();
  assert.deepEqual(audit.results.map(r => [r.user_email, r.action]), [['JobTread (automatic)', 'created']], 'saved like an admin save');
});

test('an organization’s project staff already made (same name and year) is linked, never rewritten; a TEST one is a dry run', async () => {
  await addProject({ slug: 'perfect-harmony-health', name: 'Perfect Harmony Health', year: '2027', status: 'in-progress', story: '<p>Ours</p>', order: 1 });
  const a = family('Perfect Harmony Health', 'In Review', { fields: ORG_FIELDS });
  const t = family('TEST Org Check', 'In Review', { fields: ORG_FIELDS });
  await change(a, 'Approved', T0);
  await change(t, 'Approved', T0);
  await sweep(...minutes(30, 40));
  const list = await projects();
  assert.deepEqual(list.map(p => p.slug), ['perfect-harmony-health'], 'nothing new: the test made nothing either');
  assert.equal(list[0].story, '<p>Ours</p>');
  assert.equal(list[0].jobtreadJobId, undefined, 'linked by its name and year, not rewritten');
  assert.match((await activity(a.id)).map(r => r.title).join('\n'), /Community project: Perfect Harmony Health/);
  assert.match((await activity(t.id)).map(r => r.title).join('\n'), /Test organization: project not saved/);
});

test('organizations approved before projects were made get theirs on the next run, once; TEST ones are left alone', async () => {
  await addProject({ slug: 'the-cottage-school', name: 'The Cottage School', year: '2021', status: 'completed', order: 2 });
  // As it was on Oct 21: the school's job (named by hand, no year) and nothing else
  const a = family('The Lionheart School', 'Approved', { fields: { ...ORG_FIELDS, [YEAR]: '2026' }, jobs: [{ id: 'jobLION0001', name: 'The Lionheart School', closedOn: null }] });
  const put = (id, name, jobId, jobName) => env.DB.prepare(`INSERT INTO applicant_approvals (account_id, name, approved_at, state, job_id, job_name, job_made, kid_made, detail, attempts, done_at, updated_at)
    VALUES (?, ?, ?, 'done', ?, ?, 0, 0, 'organization: no profile', 0, ?, ?)`).bind(id, name, iso(T0), jobId, jobName, iso(T0), iso(T0)).run();
  await put(a.id, 'The Lionheart School', 'jobLION0001', 'The Lionheart School');
  await put('acctTEST0001', 'TEST CompanyCam Approved', 'jobTEST0001', 'TEST (2) (2027)');
  await runApprovals(env, { fetchImpl, now: T0 + 5 * MIN });
  const p = (await projects()).find(x => x.slug === 'the-lionheart-school');
  assert.ok(p, 'made');
  assert.deepEqual([p.year, p.status, p.publishStatus, p.jobtreadJobId, p.order], ['2026', 'in-progress', 'draft', 'jobLION0001', 1], 'the account’s *Makeover Year; ahead of the others');
  assert.equal(jt.state.jobCalls.length, 0, 'its job was already there');
  const rows = (await env.DB.prepare('SELECT name, project_slug, detail FROM applicant_approvals ORDER BY name').all()).results;
  assert.deepEqual(rows.map(r => [r.name, r.project_slug, r.detail]), [['TEST CompanyCam Approved', null, 'organization: no profile'], ['The Lionheart School', 'the-lionheart-school', null]]);
  assert.match((await activity(a.id)).map(r => r.title).join('\n'), /Community project made: The Lionheart School/);
  assert.equal(news().length, 1, 'Slack hears it as good news');
  await runApprovals(env, { fetchImpl, now: T0 + 10 * MIN });
  assert.equal((await projects()).length, 2, 'once');
  assert.equal(news().length, 1);
});

test('the application form decides: an organization’s gets its project, a family’s gets a kid page whatever its name', async () => {
  const { ensureSchema } = await import('../functions/api/_applications.js');
  await ensureSchema(env.DB);
  const made = (accountId, kind) => env.DB.prepare(`INSERT INTO applications (id, draft_id, year, child_name, status, submitted_at, updated_at, jt_account_id, kind)
    VALUES (?, ?, '2027', 'x', 'done', ?, ?, ?, ?)`).bind(`app-${accountId}`, `d-${accountId}`, iso(T0), iso(T0), accountId, kind).run();
  const org = family('Sunnyside Academy', 'In Review', { fields: ORG_FIELDS });
  const kidNamedLikeASchool = family('Academy Rivers', 'In Review', { fields: ORG_FIELDS });
  await made(org.id, 'organization');
  await made(kidNamedLikeASchool.id, 'family');
  await change(org, 'Approved', T0);
  await change(kidNamedLikeASchool, 'Approved', T0);
  await sweep(...minutes(30, 40));
  assert.deepEqual((await projects()).map(p => p.slug), ['sunnyside-academy']);
  assert.deepEqual((await kids()).map(k => k.slug), ['academy'], 'the family form made it: a kid page');
  assert.equal(org.jobs[0].name, 'Sunnyside Academy (2027)');
});

test('an organization’s long name keeps its start in the job name', () => {
  assert.equal(jobNameFor('Boys & Girls Club of Metro Atlanta', 2027, { organization: true }), 'Boys & Girls Club (2027)');
  assert.equal(jobNameFor('Oakley Faye Xiu Ping Roberson', 2027), 'Oakley Roberson (2027)', 'a child keeps first and last');
});

test('a JobTread hiccup in the catch-up leaves the organization for the next run', async () => {
  const a = family('Brightway Academy', 'Approved', { fields: { ...ORG_FIELDS, [YEAR]: '2026' }, jobs: [{ id: 'jobBRIGHT001', name: 'Brightway Academy (2026)', closedOn: null }] });
  await env.DB.prepare(`INSERT INTO applicant_approvals (account_id, name, approved_at, state, job_id, job_name, job_made, kid_made, detail, attempts, done_at, updated_at)
    VALUES (?, 'Brightway Academy', ?, 'done', 'jobBRIGHT001', 'Brightway Academy (2026)', 0, 0, 'organization: no profile', 0, ?, ?)`).bind(a.id, iso(T0), iso(T0), iso(T0)).run();
  const down = async (url, init) => (JSON.parse(init?.body || '{}').query?.account ? new Response('busy', { status: 503 }) : fetchImpl(url, init));
  await runApprovals(env, { fetchImpl: down, now: T0 + 5 * MIN });
  assert.equal((await projects()).length, 0);
  await runApprovals(env, { fetchImpl, now: T0 + 10 * MIN });
  assert.deepEqual((await projects()).map(p => [p.slug, p.year]), [['brightway-academy', '2026']]);
});

test('a grant JobTread refuses falls back to the site’s; a busy JobTread is retried', async () => {
  jt.state.deny.add('qc-grant');
  const a = family('Kai Ross', 'In Review');
  await change(a, 'Approved', T0);
  await sweep(...minutes(30, 40));
  assert.deepEqual(jt.state.jobCalls.map(c => c.grantKey), ['qc-grant', 'site-grant']);
  assert.equal(a.jobs.length, 1);

  const b = family('Lena Fox', 'In Review');
  jt.state.deny.clear();
  jt.state.fail = 1;
  await change(b, 'Approved', T0 + 60 * MIN);
  await sweep(...minutes(90, 100));
  assert.equal(b.jobs.length, 0, 'the first try failed');
  assert.equal(jt.state.jobCalls.filter(c => c.input.name === 'Lena Fox (2027)').length, 1, 'a 5xx might have made the job: no second grant tries right away');
  await sweep(...minutes(102, 110));
  assert.equal(b.jobs.length, 1, 'the retry five minutes later made it');
  assert.equal(w.world.slack.filter(s => /not made yet/.test(s.text || '')).length, 0, 'one hiccup is no Slack problem');
});

// ─── The profile stays on its own job ───────────────────────────────

test('matching: a profile linked to its job wins, and never matches another job by name', () => {
  const kidsList = [
    { slug: 'dylan-2027', name: 'Dylan', year: 2027, jobtreadJobId: 'J1' },
    { slug: 'dylan-2027-2', name: 'Dylan', year: 2027 },
  ];
  assert.equal(matchKid('Dylan Carr (2027)', kidsList), null, 'by name alone two Dylans are ambiguous');
  assert.equal(matchKid('Dylan Carr (2027)', kidsList, 'J1').slug, 'dylan-2027');
  assert.equal(matchKid('Dylan Moss (2027)', kidsList, 'J2').slug, 'dylan-2027-2', 'the linked Dylan is out of the running for another job');
  const links = linkJobs(
    [{ id: 'J1', name: 'Dylan Carr (2027)' }, { id: 'J2', name: 'Dylan Moss (2027)' }],
    kidsList.map(k => ({ slug: k.slug, name: k.name, year: k.year, data: k })),
  );
  assert.deepEqual([links.get('dylan-2027')?.id, links.get('dylan-2027-2')?.id], ['J1', 'J2']);
});

test('the new profile’s status follows its job from then on', async () => {
  const a = family('Mia Lopez', 'In Review');
  await change(a, 'Approved', T0);
  await sweep(...minutes(30, 40));
  const job = a.jobs[0];
  // Staff move the job to Awaiting Funding; the profile is staff's to show, so it stays a draft
  const jtJob = { id: job.id, name: job.name, closedOn: null, customFieldValues: { nodes: [{ value: 'Build', customField: { id: JOB_STATUS } }] }, tasks: { nodes: [] } };
  const jobsFetch = async (url, init) => {
    const { query } = JSON.parse(init.body);
    if (query.organization?.jobs) return new Response(JSON.stringify({ organization: { jobs: { nodes: [jtJob], nextPage: null } } }), { status: 200 });
    return fetchImpl(url, init);
  };
  const changed = await syncKidStatuses(env, { fetchImpl: jobsFetch, now: T0 + 2 * 60 * MIN });
  assert.deepEqual(changed.map(c => c.slug), ['mia']);
  const [kid] = await kids();
  assert.deepEqual([kid.status, kid.publishStatus], ['in-progress', 'draft'], 'status follows JobTread; showing it is staff’s call');
});

test('the new job’s cover is the child’s photo from their application, not a picture of the house', async () => {
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS applications (id TEXT, jt_account_id TEXT, jt_state TEXT, answers TEXT)').run();
  const a = family('Nora Kim', 'In Review');
  await env.DB.prepare('INSERT INTO applications VALUES (?, ?, ?, ?)').bind('app-nora', a.id, JSON.stringify({ files: { photoChild: { id: 'FILE-NORA' } } }), JSON.stringify({ childName: { first: 'Nora', last: 'Kim' } })).run();
  await change(a, 'Approved', T0);
  await sweep(...minutes(30, 40));
  assert.equal(jt.state.jobCalls.length, 1);
  assert.deepEqual(jt.state.coverCalls, [{ grantKey: 'site-grant', jobId: a.jobs[0].id, coverPhoto: { fileId: 'FILE-NORA' } }]);
  const row = await env.DB.prepare('SELECT source FROM job_covers WHERE job_id = ?').bind(a.jobs[0].id).first();
  assert.equal(row.source, 'application:FILE-NORA', 'remembered, so the profile’s Main photo replaces it once there is one');
  assert.equal((await kids())[0].name, 'Nora', 'the form’s first-name answer names the profile');
  await sweep(...minutes(42, 60, 6));
  assert.equal(jt.state.coverCalls.length, 1, 'set once');
});

test('a family with a home-visit CompanyCam project gets their job made with it; one without, without', async () => {
  await ensureCompanyCamSchema(env.DB);
  const a = family('Quinn Avery', 'In Review');
  const b = family('Rowan Blake', 'In Review');
  await env.DB.prepare("INSERT INTO companycam_projects (account_id, project_id, stage, created_at, updated_at) VALUES (?, '9001', 'customer', ?, ?)").bind(a.id, iso(T0), iso(T0)).run();
  await change(a, 'Approved', T0);
  await change(b, 'Approved', T0);
  await sweep(...minutes(30, 40));
  const byName = Object.fromEntries(jt.state.jobCalls.map(c => [c.input.name, c.input]));
  assert.equal(byName['Quinn Avery (2027)'].companycamId, '9001', 'so CompanyCam doesn’t start a second project');
  assert.equal('companycamId' in byName['Rowan Blake (2027)'], false);
});

test('JobTread refusing the CompanyCam link (it’s another job’s) still makes the family’s job, without it', async () => {
  await ensureCompanyCamSchema(env.DB);
  const a = family('Sky Lane', 'In Review');
  await env.DB.prepare("INSERT INTO companycam_projects (account_id, project_id, stage, created_at, updated_at) VALUES (?, 'linked-elsewhere', 'customer', ?, ?)").bind(a.id, iso(T0), iso(T0)).run();
  await change(a, 'Approved', T0);
  await sweep(...minutes(30, 40));
  assert.equal(a.jobs.length, 1, 'the job is made');
  const calls = jt.state.jobCalls.map(c => c.input.companycamId ?? null);
  assert.equal(calls.at(-1), null, 'the last try went without the link');
});

test('no application photo (a family added by hand): the job is made without a cover', async () => {
  const a = family('Owen Hart', 'In Review');
  await change(a, 'Approved', T0);
  await sweep(...minutes(30, 40));
  assert.equal(a.jobs.length, 1);
  assert.equal((jt.state.coverCalls || []).length, 0);
});

test('an office TEST family: its job is made, the profile is a dry run, and Slack says it’s a test', async () => {
  const a = family('TEST Notify Check', 'In Review');
  await change(a, 'Approved', T0);
  await sweep(...minutes(30, 40));
  assert.equal(a.jobs[0].name, 'TEST Notify Check (2027)', 'TEST jobs are skipped by everything else');
  assert.equal((await kids()).length, 0, 'no profile saved');
  const log = await activity(a.id);
  assert.match(log.map(r => r.title).join('\n'), /Test family: profile not saved/);
  assert.match(log.find(r => /Test family/.test(r.title)).body, /\/kids\/test-and-notify|\/kids\/test/);
  assert.equal(news().length, 1);
  assert.match(news()[0].text, /🧪 Test/, 'marked as a test on the lock screen too');
  const audit = await env.DB.prepare("SELECT count(*) AS n FROM audit_log WHERE entity_type = 'kids'").first('n');
  assert.equal(audit, 0, 'nothing in Recent changes');
  assert.equal((await approvalsStatus(env.DB)).recent[0].kid_slug, null);
});
