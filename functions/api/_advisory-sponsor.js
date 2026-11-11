/**
 * The kid the Advisory Board sponsors
 * ===========================================================================
 * Peter, Nov 5 2026: the group sponsors a real kid, the Advisory Board is a real
 * partner with its own logo, and advisory@soardcharity.com is how JobTread knows
 * them. So the group works like any monetary sponsor (./_room-credits.js): the
 * partner "SOARD Advisory Board" is the kid's Monetary Sponsor (in JobTread's
 * field when the kid has a job), its one contact is the group's address, and that
 * address gets the sponsor's access on that one job. No advisor gets a JobTread
 * login. Its logo goes on the kid's page when it's picked, like any sponsor's.
 * Moving on to another kid takes the group off the old one completely: the
 * credit, then the logo and the access (Take off this job, ./_vendor-access.js).
 *
 * The Demo Day invite reaches the group through that address. A reveal doesn't:
 * advisors already get every reveal invite by name, so the group's address is left
 * off reveals (./_reveal-invites.js NO_REVEAL_INVITE) and nobody gets two.
 *
 * Only a kid who's waiting on funding and has a public page can be picked, and the
 * page checks again on every read, so a kid drafted later drops off it. What the page
 * shows is what the public page shows, with no dollar figure beside it.
 *
 * The pledge row (./_sponsor-pledges.js) is the site's, kept equal to what's actually
 * been raised (pledged = received), and staff can't type over it (sponsors-admin.js).
 */

import { loadAllKids, SYNC_USER } from './_kid-status.js';
import { saveContacts, readContacts } from './_sponsors.js';
import { setCredit } from './_room-credits.js';
import { takeOffJob } from './_vendor-access.js';
import { savePledge } from './_sponsor-pledges.js';
import { saveSettings, GROUP_ADDRESS } from './_advisory.js';

export const ADVISORY_PARTNER = 'soard-advisory-board';
const SYNC_BY = 'Advisory Board';
const err = (message, status = 400) => Object.assign(new Error(message), { status });
const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';
const STAGES = { 'needs-funding': 'Getting ready', 'in-progress': 'Being built', completed: 'Finished' };

const photoOf = (d) => d.heroImage || d.photos?.[0]?.url || '';

/** Who can be picked: waiting on funding, with a public page */
export async function pickableKids(env) {
  const kids = await loadAllKids(env.DB);
  return kids.filter((k) => k.data.publishStatus !== 'draft' && k.data.status === 'needs-funding')
    .map((k) => ({ slug: k.slug, name: firstName(k.data.name || k.name), year: k.year || null, photo: photoOf(k.data), url: `/kids/${k.slug}/` }));
}

async function ensureContact(DB) {
  const have = (await readContacts(DB, [ADVISORY_PARTNER]))[ADVISORY_PARTNER] || [];
  if (!have.some((c) => c.email === GROUP_ADDRESS)) await saveContacts(DB, ADVISORY_PARTNER, [{ name: 'SOARD Advisory Board', email: GROUP_ADDRESS }], { by: SYNC_USER });
}

/** The group sponsors this kid. One kid per term: picking another moves the sponsor and the pledge, on the record */
export async function pickKid(env, settings, slug, { by = '', now = Date.now(), fetchImpl = fetch, raised = 0 } = {}) {
  const { DB } = env;
  if (!(await DB.prepare('SELECT slug FROM partners WHERE slug = ?').bind(ADVISORY_PARTNER).first())) throw err('SOARD Advisory Board isn’t in Partners yet. Peter or Holly can add it, then try again.', 409);
  const kids = await loadAllKids(DB);
  const kid = kids.find((k) => k.slug === slug);
  if (!kid || kid.data.publishStatus === 'draft' || kid.data.status !== 'needs-funding') throw err('Pick a kid who’s waiting on funding and has a public page', 409);
  // Another kid: last term's finished makeover keeps its sponsor, logo and pledge; one still open moves
  const was = settings.kid && settings.kid !== slug ? kids.find((k) => k.slug === settings.kid) : null;
  if (was && was.data.status !== 'completed') await clearKid(env, settings, { by, now, fetchImpl });
  await ensureContact(DB);
  // Who the group is sponsoring is written first and put back on a failure, so nothing is left half done
  const next = await saveSettings(DB, { kid: slug });
  let credit;
  try {
    // A person pressed Pick the kid: the group goes on that makeover, even one it was moved off before
    credit = await setCredit(env, { record: slug, kind: 'sponsored', partner: ADVISORY_PARTNER, on: true, person: true }, by || SYNC_BY, { fetchImpl, now });
    await savePledge(DB, { kid: slug, partner: ADVISORY_PARTNER, pledged: raised, received: raised }, { by: 'Advisory Board', now });
  } catch (e) {
    await saveSettings(DB, { kid: '' });
    throw e;
  }
  return { settings: next, sync: { job: credit.job, put: credit.put, problems: credit.job ? [] : ['This kid has no JobTread job yet'] } };
}

export async function clearKid(env, settings, { by = '', now = Date.now(), fetchImpl = fetch } = {}) {
  const { DB } = env;
  if (!settings.kid) return { settings, problems: [] };
  const problems = [];
  const kid = (await loadAllKids(DB)).find((k) => k.slug === settings.kid);
  // A finished makeover keeps its sponsor, logo and pledge: the group just moves on
  if (kid && kid.data.status !== 'completed') {
    // The credit (JobTread's field too), which takes the group off the room with it: its logo off the page, its access
    // off the job (functions/api/_room-credits.js). The credit not taken off: the group still comes off the room, and
    // the credits sweep takes the credit away with it
    let credit = null;
    try {
      credit = await setCredit(env, { record: kid.slug, kind: 'sponsored', partner: ADVISORY_PARTNER, on: false }, by || SYNC_BY, { fetchImpl, now });
    } catch (e) { problems.push(`Couldn’t take the group off as the sponsor: ${e.message}`); }
    await savePledge(DB, { kid: kid.slug, partner: ADVISORY_PARTNER, pledged: null, received: null }, { by: 'Advisory Board', now });
    // (a kid with no open job: the logo comes off the page all the same, as it always has)
    const off = credit?.off || (credit?.stays ? null : await takeOffJob(env, { record: kid.slug, partner: ADVISORY_PARTNER }, by || SYNC_BY, { fetchImpl, now }).catch((e) => ({ pending: [e.message] })));
    problems.push(...(off?.pending || []).map((x) => `Still to come off the job: ${x}`));
  }
  return { settings: await saveSettings(DB, { kid: '' }), problems };
}

/** Kept equal to what's been raised, on each read of the money */
export async function keepPledge(env, settings, raised, { now = Date.now() } = {}) {
  if (!settings.kid) return;
  // A finished makeover's pledge stays what it was: a new term starts counting from nothing
  const row = await env.DB.prepare('SELECT data FROM kids WHERE slug = ?').bind(settings.kid).first();
  let status = '';
  try { status = JSON.parse(row?.data || '{}').status; } catch { /* treated as open */ }
  if (status !== 'completed') await savePledge(env.DB, { kid: settings.kid, partner: ADVISORY_PARTNER, pledged: raised, received: raised }, { by: 'Advisory Board', now });
}

/**
 * The group's makeover on the page: { state: 'open' } until a kid is picked and while their page isn't public.
 * A kid's name, photo and stage come only from a published page; the reveal's date only from the public list.
 */
export async function kidCard(env, settings, bits) {
  if (!settings.kid) return { state: 'open' };
  const pub = bits.published.get(settings.kid);
  if (!pub) return { state: 'open' };
  const row = await env.DB.prepare('SELECT data FROM kids WHERE slug = ?').bind(settings.kid).first();
  let d = {};
  try { d = JSON.parse(row?.data || '{}'); } catch { /* nothing to show */ }
  if (d.publishStatus === 'draft' || !STAGES[d.status]) return { state: 'open' };
  const reveal = bits.reveals.find((r) => r.slug === settings.kid);
  const demo = d.jobtreadJobId ? await env.DB.prepare('SELECT demo_date FROM demo_invites WHERE job_id = ?').bind(d.jobtreadJobId).first().catch(() => null) : null;
  return { state: 'kid', demo: demo?.demo_date || '', slug: settings.kid, name: firstName(d.name), photo: pub.heroImage || '', url: `/kids/${settings.kid}/`, stage: STAGES[d.status], reveal: reveal ? { date: reveal.date, window: reveal.window, confirmed: reveal.confirmed } : null };
}
