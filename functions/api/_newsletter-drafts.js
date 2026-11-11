/**
 * Event Recap and Monthly Impact, drafted in Kit by themselves for staff to
 * review and send, like the reveal invite, Project Kickoff and Project Reveal.
 * The emails are ./_newsletter-email.js; this is when and how they're drafted.
 *
 * - Event Recap ("What a Night!"): once an event is over (the morning after,
 *   Atlanta time) and its recap page on the live site shows the photographer's
 *   photos. Photos saved but not published yet wait: the email's "See all the
 *   photos" must never land on "photos are on the way". Still no photos a
 *   week later, the reviewer gets one reminder; 60 days on, it's let go.
 * - Monthly Impact ("Your Monthly Dose of Sunshine"): on the 1st of each month
 *   for the month before, from the site's own data. A month with nothing to say
 *   isn't drafted.
 * - By hand: Draft in Kit on the event's "After the event" panel, or on the
 *   Monthly Impact entry in Emails & invites (draftNewsletterNow).
 *
 * Once a draft is waiting, the site keeps it true until someone touches it: a
 * new photo, a reveal coming up or a day passing rebuilds it (Kit's copy is
 * read first, and one a person edited, scheduled or sent is left alone for
 * good). Nothing is ever sent from here. Neither email says where a family
 * lives, so both go to the newsletter list (everyone but the families who only
 * asked about applications, as Kit drafts always are). The reviewer is emailed,
 * never Slack. Off with the reveal invite email (site_config kitInvite).
 *
 * The past stays out on purpose: the first look marks every event already over
 * and the month before as done, so nothing old is drafted when this goes live.
 */

import { kitConfigured, kitCreateBroadcast, kitFindDraft, kitReadBroadcast, kitUpdateDraft } from './_kit.js';
import { sendEmails, emailConfigured } from './_broadcast-notify.js';
import { emailShell, facts as factRows, button, esc } from './_email-shell.js';
import { SITE_URL, TEAM_PICTURE } from './_reveal-invite-email.js';
import { brokenLogos, kitInviteSettings, reviewersOf, kitDraftUrl, copyHash, wentOut } from './_reveal-invite-kit.js';
import { readConfig, alertList } from './_reveal-invites.js';
import { readWords } from './_email-words.js';
import {
  getReveals, fetchJobs, pave, matchKid, loadKids as loadMatchKids, easternParts, isRehearsalJob, SOARD_ORG_ID, FIELD_REVEAL_DATE, FIELD_REVEAL_CONFIRMED,
} from './_reveals.js';
import {
  eventRecapEmail, monthlyImpactEmail, recapParts, recapUrl, recapImageUrls, monthlyImageUrls, monthlyHasNews, monthName, eventName, eventTitle, NEWSLETTER_DESIGN,
} from './_newsletter-email.js';
import { SERIES, seriesOf, isOver, dayIn, lastDay, yearOf, eventPath, hasOwnPage } from '../../public/admin/events-shared.js';

const DAY_MS = 24 * 60 * 60 * 1000;
// A recap's clock runs from the event's last day: a reminder a week after the morning after, let go after 60 days
const REMIND_AFTER_MS = 8 * DAY_MS;
const GIVE_UP_AFTER_MS = 60 * DAY_MS;
// An event that ended longer ago than this when the site first sees it over is from before (a backfilled old event): by hand only
const NEW_FOR_MS = 14 * DAY_MS;
// Drafts made in one look, so a backlog never piles into one heartbeat
const DRAFTS_PER_LOOK = 3;
// A worker that died mid-draft frees its claim after this
const CLAIM_MS = 10 * 60 * 1000;
// How often the heartbeat looks
const LOOK_EVERY_MS = 60 * 60 * 1000;
// A waiting draft is checked against the site at most this often (each check reads Kit, and JobTread for the monthly)
const FOLLOW_EVERY_MS = 6 * 60 * 60 * 1000;
// Weeks on, nobody is sending it any more: the site stops looking
const FOLLOW_FOR_MS = 45 * DAY_MS;
const SEEDED = '__seeded__';
const LAST_LOOK = '__last_look__';
const isEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || ''));
const iso = (ms) => new Date(ms).toISOString();
const OFF_REASON = 'Kit drafts are off while reveal invites are paused (Reveals → Invites)';
const goneInKit = (got) => /HTTP 404/.test(got?.error || '') || got?.broadcast?.status === 'aborted';

export const recapKey = (slug) => `recap:${slug}`;
export const monthlyKey = (month) => `monthly:${month}`;
/** The month before the one `today` is in: '2026-11-09' → '2026-10' */
export function monthBefore(today) {
  const [y, m] = String(today).split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}
const keyOk = (key) => /^recap:[a-z0-9][a-z0-9-]{0,120}$/.test(key) || /^monthly:\d{4}-(0[1-9]|1[0-2])$/.test(key);

const SCHEMA = `CREATE TABLE IF NOT EXISTS newsletter_drafts (
  key TEXT PRIMARY KEY, kind TEXT NOT NULL, broadcast_id TEXT, state TEXT, told TEXT, reminded TEXT,
  error TEXT, alarmed TEXT, facts TEXT, content_hash TEXT, by TEXT, queued_at TEXT, claimed_at TEXT, followed_at TEXT, updated_at TEXT)`;
// design: the NEWSLETTER_DESIGN a draft was last written in, so a new one reaches it within the hour
const ADDED = ['design'];
const _ready = new WeakSet();
export async function ensureNewsletterSchema(DB) {
  if (_ready.has(DB)) return;
  await DB.prepare(SCHEMA).run();
  for (const col of ADDED) await DB.prepare(`ALTER TABLE newsletter_drafts ADD COLUMN ${col} TEXT`).run().catch(() => {});
  _ready.add(DB);
}
export async function readNewsletterRow(DB, key) {
  await ensureNewsletterSchema(DB);
  return DB.prepare('SELECT * FROM newsletter_drafts WHERE key = ?').bind(key).first();
}
async function writeRow(DB, row) {
  await DB.prepare(`UPDATE newsletter_drafts SET broadcast_id = ?, state = ?, told = ?, reminded = ?, error = ?, alarmed = ?, facts = ?,
    content_hash = ?, by = ?, followed_at = ?, design = ?, updated_at = ? WHERE key = ?`)
    .bind(row.broadcast_id ?? null, row.state ?? null, row.told ?? null, row.reminded ?? null, row.error ?? null, row.alarmed ?? null,
      row.facts ?? null, row.content_hash ?? null, row.by ?? null, row.followed_at ?? null, row.design ?? null, new Date().toISOString(), row.key)
    .run();
}
/** Its moment has come: a row to follow. A second call changes nothing. → the row */
async function queue(DB, key, kind, now, state = 'waiting') {
  await ensureNewsletterSchema(DB);
  await DB.prepare('INSERT OR IGNORE INTO newsletter_drafts (key, kind, state, queued_at) VALUES (?, ?, ?, ?)').bind(key, kind, state, iso(now)).run();
  return readNewsletterRow(DB, key);
}
/** One conditional write, so two looks at once can't both draft. → is it ours? */
async function claim(DB, row, now) {
  const r = await DB.prepare(`UPDATE newsletter_drafts SET state = 'claimed', claimed_at = ?
    WHERE key = ? AND broadcast_id IS NULL AND (state = 'waiting' OR (state = 'claimed' AND claimed_at < ?))`)
    .bind(iso(now), row.key, iso(now - CLAIM_MS)).run();
  return r?.meta?.changes > 0;
}

/**
 * The first look marks every event already over, and the month before, as done
 * (with the mark that says so, in one step), so nothing from before this went
 * live is drafted by itself. Never runs again. By hand still drafts any of them.
 */
async function seedOnce(DB, events, now) {
  if (await DB.prepare('SELECT key FROM newsletter_drafts WHERE key = ?').bind(SEEDED).first()) return;
  const today = dayIn(now);
  const at = iso(now);
  const past = events.filter((ev) => isOver(ev, today));
  await DB.batch([
    ...past.map((ev) => DB.prepare("INSERT OR IGNORE INTO newsletter_drafts (key, kind, state, queued_at) VALUES (?, 'recap', 'skipped', ?)").bind(recapKey(ev.slug), at)),
    DB.prepare("INSERT OR IGNORE INTO newsletter_drafts (key, kind, state, queued_at) VALUES (?, 'monthly', 'skipped', ?)").bind(monthlyKey(monthBefore(today)), at),
    DB.prepare("INSERT OR IGNORE INTO newsletter_drafts (key, kind, state, queued_at) VALUES (?, 'seed', 'done', ?)").bind(SEEDED, at),
  ]);
}

// ── What the site knows ───────────────────────────────────────────────────

/**
 * A table that isn't there yet (a fresh database) reads as empty. Any other
 * failure throws: an empty read would look like no events, or a month with no
 * reveals, and the look would act on it.
 */
async function rows(DB, sql, ...binds) {
  try { return (await DB.prepare(sql).bind(...binds).all()).results || []; } catch (err) {
    if (/no such table/i.test(String(err?.message || err))) return [];
    throw err;
  }
}
/** Milliseconds since an event's last day (noon UTC that day, about the morning after in Atlanta) */
const sinceOver = (ev, now) => now - Date.parse(`${lastDay(ev)}T12:00:00Z`);
async function loadEvents(DB) {
  const results = await rows(DB, 'SELECT slug, data FROM events');
  return results.map((r) => { try { return { ...JSON.parse(r.data), slug: r.slug }; } catch { return null; } }).filter(Boolean);
}
async function loadDocs(DB) {
  const keys = SERIES.map((s) => s.doc);
  const results = await rows(DB, `SELECT key, data FROM site_config WHERE key IN (${keys.map(() => '?').join(', ')})`, ...keys);
  const out = {};
  for (const r of results) { try { out[r.key] = JSON.parse(r.data); } catch { /* skip */ } }
  return out;
}
async function loadKids(DB) {
  const results = await rows(DB, 'SELECT slug, data FROM kids');
  return results.map((r) => { try { return { ...JSON.parse(r.data), slug: r.slug }; } catch { return null; } }).filter(Boolean);
}
async function loadPress(DB) {
  const results = await rows(DB, 'SELECT slug, data FROM press');
  return results.map((r) => { try { return { ...JSON.parse(r.data), slug: r.slug }; } catch { return null; } }).filter(Boolean);
}

/** SOARD jobs closed on or after a day ('YYYY-MM-DD'), with their custom fields */
async function closedJobsSince(grantKey, since, fetchImpl) {
  const jobs = [];
  let page = null;
  for (let i = 0; i < 5; i++) {
    const data = await pave(grantKey, {
      organization: {
        $: { id: SOARD_ORG_ID },
        jobs: {
          $: { size: 100, where: ['closedOn', '>=', since], ...(page ? { page } : {}) },
          nextPage: {},
          nodes: { id: {}, name: {}, customFieldValues: { $: { size: 50 }, nodes: { value: {}, customField: { id: {} } } } },
        },
      },
    }, fetchImpl);
    const conn = data?.organization?.jobs;
    if (!conn) throw new Error('JobTread response had no jobs');
    jobs.push(...(conn.nodes || []));
    page = conn.nextPage || null;
    if (!page) break;
  }
  return jobs;
}

/**
 * The month's reveals: each published kid whose job's Reveal Date (JobTread's,
 * the day it happened) falls in the month and has passed. A job is often closed
 * soon after its reveal, so closed jobs are read too. Without JobTread, the
 * site's own record of past reveals is the next best (it can be short).
 * → [{ slug, date }] oldest first
 */
export async function monthReveals(env, month, today, { fetchImpl = fetch, schedule = null } = {}) {
  const inMonth = (d) => String(d || '').slice(0, 7) === month && d < today;
  if (env.JOBTREAD_GRANT_KEY) {
    try {
      const [open, closed, kids, full] = await Promise.all([
        fetchJobs(env.JOBTREAD_GRANT_KEY, fetchImpl),
        closedJobsSince(env.JOBTREAD_GRANT_KEY, `${month}-01`, fetchImpl),
        loadMatchKids(env.DB),
        loadKids(env.DB),
      ]);
      const status = new Map(full.map((k) => [k.slug, k.status]));
      const byKid = new Map();
      const seen = new Set();
      for (const job of [...open, ...closed]) {
        if (!job?.id || seen.has(job.id) || isRehearsalJob(job)) continue;
        seen.add(job.id);
        const values = {};
        for (const v of job.customFieldValues?.nodes || []) values[v.customField?.id] = v.value;
        const parts = values[FIELD_REVEAL_DATE] ? easternParts(values[FIELD_REVEAL_DATE]) : null;
        if (!parts || !inMonth(parts.date)) continue;
        const kid = matchKid(job.name, kids, job.id);
        // A day JobTread never confirmed may never have happened, unless the kid is finished
        const confirmed = String(values[FIELD_REVEAL_CONFIRMED] || '').trim().toLowerCase().startsWith('yes');
        if (!kid || (!confirmed && status.get(kid.slug) !== 'completed')) continue;
        if (!byKid.has(kid.slug) || parts.date < byKid.get(kid.slug)) byKid.set(kid.slug, parts.date);
      }
      return [...byKid].map(([slug, date]) => ({ slug, date })).sort((a, b) => a.date.localeCompare(b.date));
    } catch (err) {
      console.error('[newsletter-drafts] reveals from JobTread', err.message);
    }
  }
  const sched = schedule || await getReveals(env, { fetchImpl });
  const seen = new Set();
  return [...(sched.past || []), ...(sched.reveals || [])]
    .filter((r) => r?.slug && inMonth(r.date) && !seen.has(r.slug) && seen.add(r.slug))
    .map((r) => ({ slug: r.slug, date: r.date })).sort((a, b) => a.date.localeCompare(b.date));
}

/** The page doc an event's recap reads (the Gala or Golf editor's), or null */
const docFor = (ev, docs) => (seriesOf(ev) ? docs[seriesOf(ev).doc] || null : null);

/**
 * Does the live recap page show the photos yet? Saved photos reach the site
 * only on Publish, so the email waits for the page: its first photo has to be
 * there. → true | false | null (couldn't tell)
 */
export async function recapIsLive(ev, events, pageDoc, { fetchImpl = fetch, site = SITE_URL } = {}) {
  const { photos } = recapParts(ev, events, pageDoc);
  if (!photos.length) return false;
  try {
    const res = await fetchImpl(recapUrl(ev, events, site), { headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return false;
    const page = await res.text();
    return page.includes(photos[0].id);
  } catch {
    return null;
  }
}

/**
 * Why an event's recap can't be drafted (by hand or by itself) → words, or null.
 * live: the answer from recapIsLive.
 */
export function recapBlock(ev, { photos = 0, live = true, today }) {
  if (!ev) return 'This event isn’t saved yet';
  if (ev.status === 'cancelled') return 'The event was cancelled';
  if (!isOver(ev, today)) return 'Ready the morning after the event, once its photos are on the page';
  if (!photos) return 'Add the photographer’s photos first: the email is the photos';
  if (live === null) return 'The live page couldn’t be checked just now. Try again in a minute';
  if (live === false) return 'Publish first: the page doesn’t show the photos yet, and the email links to it';
  return null;
}

/** Everything a month's email says, from the site's own data */
export async function monthlyFacts(env, month, { now = Date.now(), fetchImpl = fetch } = {}) {
  const { DB } = env;
  const today = dayIn(now);
  const [kids, events, docs, press, schedule] = await Promise.all([
    loadKids(DB), loadEvents(DB), loadDocs(DB), loadPress(DB), getReveals(env, { fetchImpl, now }),
  ]);
  const published = kids.filter((k) => k.publishStatus !== 'draft');
  const bySlug = new Map(published.map((k) => [k.slug, k]));
  const inMonth = (d) => String(d || '').slice(0, 7) === month;
  // The month's reveals: the days JobTread has, matched to published kid pages
  const revealed = (await monthReveals(env, month, today, { fetchImpl, schedule }))
    .filter((r) => bySlug.has(r.slug)).map((r) => ({ kid: bySlug.get(r.slug), date: r.date }));
  const seen = new Set(revealed.map((r) => r.kid.slug));
  const building = published.filter((k) => k.status === 'in-progress' && !seen.has(k.slug))
    .sort((a, b) => (Number(a.sortOrder ?? 999) - Number(b.sortOrder ?? 999)) || String(a.name).localeCompare(String(b.name)));
  const upcoming = (schedule.upcoming || []).filter((u) => u?.slug && bySlug.has(u.slug));
  const eventsAhead = events.filter((e) => e.date && e.status !== 'cancelled' && e.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date))
    // An event with no page of its own yet (nothing on it but a date) goes to the events page, never a page that isn't built
    .map((e) => ({ title: eventName(e), date: e.date, url: `${SITE_URL}${hasOwnPage(e, events, today) ? eventPath(e, events, today) : '/events/'}`, tickets: /^https?:\/\//.test(String(e.ticketUrl || '')) ? e.ticketUrl : '' }));
  // An event's photos, once they're on its live page: never "see the photos" for a page that says they're on the way
  const recaps = [];
  for (const e of events.filter((x) => x.status !== 'cancelled' && inMonth(lastDay(x)) && isOver(x, today))) {
    const doc = docFor(e, docs);
    const { photos } = recapParts(e, events, doc);
    if (!photos.length) continue;
    const row = await DB.prepare('SELECT state FROM newsletter_drafts WHERE key = ?').bind(recapKey(e.slug)).first().catch(() => null);
    const live = ['drafted', 'edited', 'scheduled', 'sent'].includes(row?.state) || (await recapIsLive(e, events, doc, { fetchImpl })) === true;
    if (live) recaps.push({ name: eventName(e), year: yearOf(e), url: recapUrl(e, events), photo: photos[0], when: seriesOf(e)?.key === 'gala' ? 'night' : 'day', count: photos.length, series: !!seriesOf(e) });
  }
  // The press page's own rules: a hidden story stays out, and a story the outlet took down links to its saved copy (src/utils/press.ts)
  const pressIn = press.filter((p) => p.publishStatus !== 'draft' && inMonth(p.date) && p.title).sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .map((p) => {
      const link = p.linkGone ? p.archiveUrl : p.url;
      return { outlet: p.outlet || '', title: p.title, url: /^https?:\/\//.test(String(link || '')) ? link : '', date: p.date };
    });
  const totals = {
    kids: published.reduce((n, k) => n + (Number(k.childCount) || 1), 0),
    rooms: published.reduce((n, k) => n + (Number(k.roomCount) || 1), 0),
  };
  return { month, today, revealed, building, upcoming, events: eventsAhead, recaps, press: pressIn, totals };
}

/** What each kind needs to render, check and name itself */
async function contextFor(env, row, { now, fetchImpl }) {
  const { DB } = env;
  const today = dayIn(now);
  // Staff's own words for this email (Edit words), if they gave any: a change to them is a change to what it says
  const { words } = await readWords(DB, row.key);
  if (row.kind === 'recap') {
    const slug = row.key.slice('recap:'.length);
    const [events, docs] = await Promise.all([loadEvents(DB), loadDocs(DB)]);
    const ev = events.find((e) => e.slug === slug) || null;
    const pageDoc = ev ? docFor(ev, docs) : null;
    const photos = ev ? recapParts(ev, events, pageDoc).photos.length : 0;
    const live = ev && photos && isOver(ev, today) ? await recapIsLive(ev, events, pageDoc, { fetchImpl }) : false;
    const title = ev ? eventTitle(ev) : slug;
    return {
      title, what: 'Event Recap', ev,
      block: recapBlock(ev, { photos, live, today }),
      images: (broken) => (ev ? recapImageUrls(ev, events, pageDoc, broken) : []),
      render: (broken, w = words) => eventRecapEmail({ event: ev, events, pageDoc, brokenLogos: broken, teamPicture: !broken.has(TEAM_PICTURE), words: w }),
    };
  }
  const month = row.key.slice('monthly:'.length);
  const facts = await monthlyFacts(env, month, { now, fetchImpl });
  const done = `${month}-01` <= today && month < today.slice(0, 7);
  return {
    title: `${monthName(month, { year: true })} Monthly Impact`, what: 'Monthly Impact', month,
    block: !done ? `Ready on the 1st of ${monthName(nextMonth(month))}, when ${monthName(month)} is over` : !monthlyHasNews(facts) ? `The site has nothing from ${monthName(month)} to put in it` : null,
    images: () => monthlyImageUrls(facts),
    render: (broken, w = words) => monthlyImpactEmail({ ...facts, brokenLogos: broken, teamPicture: !broken.has(TEAM_PICTURE), words: w }),
  };
}

/**
 * An Event Recap or Monthly Impact as the site would draft it now, for Edit words' preview: its title,
 * why it can't be drafted yet (block), and render(words) → the email with those words in place of the
 * site's. Reads what drafting reads, once; no picture check.
 */
export async function newsletterEmailFor(env, key, { now = Date.now(), fetchImpl = fetch } = {}) {
  const ctx = await contextFor(env, { key, kind: key.startsWith('recap:') ? 'recap' : 'monthly' }, { now, fetchImpl });
  // missing: a recap whose event isn't there (nothing to render)
  if (key.startsWith('recap:') && !ctx.ev) return { title: ctx.title, block: ctx.block, missing: true };
  return { title: ctx.title, block: ctx.block, render: (words) => ctx.render(new Set(), words) };
}
/** An email's name without reading Kit or the live page */
async function titleFor(DB, key) {
  if (key.startsWith('monthly:')) return `${monthName(key.slice(8), { year: true })} Monthly Impact`;
  const ev = (await loadEvents(DB)).find((e) => e.slug === key.slice(6));
  return ev ? eventTitle(ev) : key.slice(6);
}
function nextMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

async function sha(value) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}
const factsOf = (email) => sha([email.subject, email.preview, email.html]);

/**
 * Which pictures won't load, asked of exactly the ones the email would show.
 * A broken one's stand-in is asked about too (up to three rounds), so the email
 * never shows a picture nobody checked.
 */
async function checkImages(ctx, fetchImpl) {
  const broken = new Set();
  const asked = new Set();
  for (let round = 0; round < 3; round++) {
    const urls = ctx.images(broken).filter((u) => !asked.has(u));
    if (!urls.length && round) break;
    urls.forEach((u) => asked.add(u));
    const found = await brokenLogos({}, { fetchImpl, extra: urls });
    const before = broken.size;
    found.forEach((u) => broken.add(u));
    if (broken.size === before) break;
  }
  return broken;
}

// ── The reviewer ──────────────────────────────────────────────────────────

const personOf = (email) => String(email || '').split('@')[0].split(/[._-]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ') || 'Someone';
const samePerson = (a, b) => isEmail(a) && String(a).trim().toLowerCase() === String(b || '').trim().toLowerCase();
const ADMIN = `${SITE_URL}/admin/`;

/** The reviewer's note. An email only. note: 'ready' | 'waiting' (a recap still without its photos on the page) */
export function newsletterNote(note, { kind, title, id, subject, by = null, again = false, block = '' }) {
  const what = kind === 'recap' ? 'Event Recap email' : 'Monthly Impact email';
  const t = note === 'waiting' ? {
    subject: `${title}: the recap email is waiting on the photos`,
    heading: `The ${title} recap email is waiting`,
    intro: `${block}. The email drafts itself as soon as the photos are on the event’s page.`,
  } : {
    subject: `Review the ${title} ${kind === 'recap' ? 'recap' : 'email'} in Kit`,
    heading: `The ${title} ${kind === 'recap' ? 'recap' : 'email'} is ready to review`,
    intro: `${again ? `The ${what} is drafted in Kit`
      : `${by ? `${personOf(by)} drafted it from the admin`
        : kind === 'recap' ? `The event is over and its photos are on the page` : `${title.replace(/ Monthly Impact$/, '')} is over`}, so the ${what} is drafted in Kit`}. Look it over, add a note of your own if you like, then send it from Kit. Nothing goes out until you do.`,
  };
  const rows = note === 'waiting' ? [] : [['Subject', esc(subject || '')], ['Goes to', 'The newsletter list in Kit']];
  const reminder = note === 'waiting' ? '' : 'Until someone edits it in Kit, the site keeps it up to date (new photos, what’s coming up). After an edit it’s yours, and the site leaves it alone.';
  const bodyHtml = (rows.length ? factRows(rows) : '')
    + `<div style="margin:18px 0 6px;">${id ? button('Open the draft in Kit', kitDraftUrl(id)) : button('Open the admin', ADMIN)}</div>`
    + (reminder ? `<p class="muted" style="margin:14px 0 0;font-size:13px;line-height:1.55;">${esc(reminder)}</p>` : '');
  const html = emailShell({ preheader: t.intro, eyebrow: 'Newsletter email', heading: t.heading, intro: esc(t.intro), bodyHtml, footerHtml: 'Sent by the website when a newsletter email is ready in Kit.' });
  const text = [t.heading, '', t.intro, '', subject && note !== 'waiting' ? `Subject: ${subject}` : null, id ? `Kit: ${kitDraftUrl(id)}` : `Admin: ${ADMIN}`, reminder].filter((l) => l !== null).join('\n');
  return { subject: t.subject, html, text };
}
async function tell(env, settings, note, ctx) {
  const n = newsletterNote(note, ctx);
  // Every reviewer but the one who drafted it by hand: nobody needs an email about their own press of a button
  const to = reviewersOf(settings).filter((r) => !samePerson(ctx.by, r));
  if (!to.length) return true;
  if (!emailConfigured(env)) return false;
  const out = await sendEmails(env, { to, subject: n.subject, html: n.html, text: n.text, tags: [{ name: 'category', value: 'newsletter-review' }] }).catch(() => null);
  return (out?.sent || 0) > 0;
}
/** Tell staff once → did it really go? One that didn't is tried again on the next look. */
async function alarm(env, to, row, title, error) {
  if (row.alarmed === error) return true;
  if (!emailConfigured(env) || !to.length) return false;
  const head = `The ${title} email wasn’t drafted`;
  const out = await sendEmails(env, {
    to, subject: `[SOARD] ${head}`,
    html: `<p><strong>${esc(head)}</strong></p><p>${esc(error)}</p><p>The site tries again on its own.</p>`,
    text: `${head}\n\n${error}\n\nThe site tries again on its own.`,
    tags: [{ name: 'category', value: 'newsletter-alert' }],
  }).catch(() => null);
  return (out?.sent || 0) > 0;
}

// ── Drafting and following ────────────────────────────────────────────────

/**
 * One look at one email with no draft yet: draft it if it's ready, and tell the
 * reviewer. by (a staff email): drafted by hand, so it needn't wait for its
 * moment or the reminder clock. ctx: what contextFor already worked out. Never throws.
 * @returns {Promise<{newsletter: string, reason?: string, id?: string, error?: string, told?: boolean}>}
 */
export async function syncNewsletter(env, row, { config = {}, alertTo = [], now = Date.now(), fetchImpl = fetch, by = null, ctx: known = null } = {}) {
  const { DB } = env;
  const s = kitInviteSettings(config);
  if (!s.enabled || config.enabled === false) return { newsletter: 'off', reason: OFF_REASON };
  if (!kitConfigured(env)) return { newsletter: 'skip', reason: 'Kit isn’t connected' };
  const everyone = [...new Set([...alertTo, ...reviewersOf(s)].filter(isEmail))];
  let title = row.key;
  // The row as it now stands: once a draft is saved, a later failure never takes it back
  let current = row;
  const trouble = async (error) => {
    const heard = current.error === error ? await alarm(env, everyone, current, title, error) : false;
    current = { ...current, state: current.broadcast_id ? current.state : 'waiting', error, alarmed: heard ? error : current.alarmed };
    await writeRow(DB, current);
    return { newsletter: 'error', error, ...(current.broadcast_id ? { id: current.broadcast_id } : {}) };
  };
  try {
    const ctx = known || await contextFor(env, row, { now, fetchImpl });
    title = ctx.title;
    if (row.broadcast_id) {
      // Drafted, but the reviewer's email didn't go: only that is owed
      if (row.told) return { newsletter: 'unchanged', id: row.broadcast_id };
      const heard = await tell(env, s, 'ready', { kind: row.kind, title, id: row.broadcast_id, subject: ctx.block ? '' : ctx.render(new Set()).subject, again: true });
      if (heard) await writeRow(DB, { ...row, told: iso(now) });
      return { newsletter: 'told', id: row.broadcast_id };
    }
    // By itself, a recap is timed from the event's last day: too long after, it's let go (drafts paused for weeks, say)
    const age = row.kind === 'recap' && ctx.ev ? sinceOver(ctx.ev, now) : 0;
    if (!by && row.kind === 'recap' && ctx.ev && age >= GIVE_UP_AFTER_MS) {
      await writeRow(DB, { ...row, state: 'skipped', error: null });
      return { newsletter: 'skip', reason: 'too long after the event' };
    }
    if (ctx.block) {
      if (by) return { newsletter: 'skip', reason: ctx.block };
      if (row.kind === 'monthly' && /nothing from/.test(ctx.block)) {
        await writeRow(DB, { ...row, state: 'skipped', error: null });
        return { newsletter: 'skip', reason: ctx.block };
      }
      if (row.kind === 'recap') {
        if (/cancelled/.test(ctx.block)) {
          await writeRow(DB, { ...row, state: 'skipped', error: null });
          return { newsletter: 'skip', reason: ctx.block };
        }
        if (ctx.ev && isOver(ctx.ev, dayIn(now)) && !row.reminded && age >= REMIND_AFTER_MS) {
          const heard = await tell(env, s, 'waiting', { kind: 'recap', title, block: ctx.block });
          if (heard) await writeRow(DB, { ...row, reminded: iso(now) });
        }
      }
      return { newsletter: 'waiting', reason: ctx.block };
    }

    if (!(await claim(DB, row, now))) return { newsletter: 'unchanged', reason: 'It’s being drafted right now. Look again in a minute.' };
    current = { ...row, state: 'claimed', claimed_at: iso(now) };
    // Kit may have taken a draft whose answer never arrived: never a second one
    const mark = `· ${row.key} ·`;
    const lost = await kitFindDraft(env, mark);
    if (!lost.ok) return await trouble(`Kit couldn’t be reached, so the ${title} email wasn’t drafted.`);
    const broken = await checkImages(ctx, fetchImpl);
    const email = ctx.render(broken);
    let id = String(lost.broadcast?.id || '');
    if (!id) {
      const r = await kitCreateBroadcast(env, { subject: email.subject, previewText: email.preview, description: `[auto] ${title} ${mark}`, html: email.html });
      id = String(r.broadcast?.id || '');
      if (!r.ok || !id) return await trouble(`Kit didn’t take the ${title} email.`);
    }
    // Kit's copy as the site wrote it, so a later rebuild can tell a person's edit from its own.
    // facts: what the site knows, before the picture check, so a later look can tell nothing changed without asking again
    const seenCopy = await kitReadBroadcast(env, id);
    current = { ...row, broadcast_id: id, state: 'drafted', error: null, alarmed: null, by: by || null, facts: await factsOf(ctx.render(new Set())), content_hash: seenCopy.ok ? await copyHash(seenCopy.broadcast) : null, followed_at: iso(now), design: NEWSLETTER_DESIGN };
    await writeRow(DB, current); // kept first: a draft Kit has is never made twice
    const heard = await tell(env, s, 'ready', { kind: row.kind, title, id, subject: email.subject, by });
    if (heard) { current = { ...current, told: iso(now) }; await writeRow(DB, current); }
    return { newsletter: 'drafted', id, told: heard };
  } catch (err) {
    console.error('[newsletter-drafts]', err.message);
    try { return await trouble(`The site couldn’t draft the ${title} email.`); } catch { return { newsletter: 'error', error: err.message }; }
  }
}

/**
 * A draft waiting in Kit, brought up to date when what it says has changed (a
 * new photo, a reveal coming up, a day passing). Kit's copy is read first: one a
 * person edited (or made public), scheduled or sent is left alone, and the site
 * stops looking at it; Kit is asked again just before writing, so an edit made
 * meanwhile is never written over. Emails nobody. Never throws.
 */
export async function followNewsletter(env, row, { config = {}, now = Date.now(), fetchImpl = fetch } = {}) {
  const { DB } = env;
  const stop = async (state) => { await writeRow(DB, { ...row, state, followed_at: iso(now) }); };
  const theirs = async (b) => !row.content_hash || b.public === true || (await copyHash(b)) !== row.content_hash;
  try {
    if (!row.broadcast_id || row.state !== 'drafted') return { newsletter: 'skip', reason: 'no draft waiting' };
    if (!kitInviteSettings(config).enabled || config.enabled === false) return { newsletter: 'off' };
    if (!kitConfigured(env)) return { newsletter: 'skip', reason: 'Kit isn’t connected' };
    const got = await kitReadBroadcast(env, row.broadcast_id);
    if (goneInKit(got)) { await stop('deleted'); return { newsletter: 'deleted' }; }
    if (!got.ok) return { newsletter: 'error', error: `Kit couldn’t be reached (${got.error})` };
    const went = wentOut(got.broadcast, now);
    if (went) { await stop(went); return { newsletter: went }; }
    // No copy kept, or it differs, or made public: a person's draft now
    if (await theirs(got.broadcast)) { await stop('edited'); return { newsletter: 'edited' }; }
    const ctx = await contextFor(env, row, { now, fetchImpl });
    // The event's photos came off the page, or the month has nothing left: leave the draft as staff saw it
    if (ctx.block) { await writeRow(DB, { ...row, followed_at: iso(now) }); return { newsletter: 'unchanged', reason: ctx.block }; }
    // Nothing the site knows has changed: no pictures to check, nothing to write
    const facts = await factsOf(ctx.render(new Set()));
    if (facts === row.facts) { await writeRow(DB, { ...row, followed_at: iso(now), design: NEWSLETTER_DESIGN }); return { newsletter: 'unchanged' }; }
    const broken = await checkImages(ctx, fetchImpl);
    const email = ctx.render(broken);
    const u = await kitUpdateDraft(env, row.broadcast_id, {
      subject: email.subject, previewText: email.preview, description: got.broadcast.description || `[auto] ${ctx.title} · ${row.key} ·`, html: email.html,
      guard: async (b) => !(await theirs(b)),
    });
    if (u.edited) { await stop('edited'); return { newsletter: 'edited' }; }
    if (u.status) { await stop(u.status === 'scheduled' ? 'scheduled' : 'sent'); return { newsletter: 'left' }; }
    if (!u.ok) return { newsletter: 'error', error: `Kit didn’t take the update (${u.error || 'no answer'})` };
    const after = await kitReadBroadcast(env, row.broadcast_id);
    await writeRow(DB, { ...row, facts, content_hash: after.ok ? await copyHash(after.broadcast) : null, followed_at: iso(now), design: NEWSLETTER_DESIGN });
    return { newsletter: 'updated', id: row.broadcast_id };
  } catch (err) {
    console.error('[newsletter-drafts] follow', err.message);
    return { newsletter: 'error', error: err.message };
  }
}

/**
 * The hourly look: events newly over, the month just ended, drafts owed, and
 * waiting drafts kept up to date. Never throws; a failed read ends the look
 * with nothing done.
 */
export async function runNewsletterDrafts(env, { now = Date.now(), fetchImpl = fetch } = {}) {
  try {
    const { DB } = env;
    if (!DB) return [];
    await ensureNewsletterSchema(DB);
    const events = await loadEvents(DB);
    await seedOnce(DB, events, now);
    const today = dayIn(now);
    // What's due: an event that just ended (one ended long before is an old event added later: by hand only), and the month just ended
    for (const ev of events) if (isOver(ev, today) && sinceOver(ev, now) <= NEW_FOR_MS) await queue(DB, recapKey(ev.slug), 'recap', now);
    await queue(DB, monthlyKey(monthBefore(today)), 'monthly', now);
    // An event whose date moved ahead again (a mistyped year, fixed) starts over when it's next over
    const ahead = new Set(events.filter((ev) => ev.date && !isOver(ev, today)).map((ev) => recapKey(ev.slug)));
    if (ahead.size) {
      const { results: stale = [] } = await DB.prepare("SELECT key FROM newsletter_drafts WHERE kind = 'recap' AND broadcast_id IS NULL").all();
      for (const r of stale.filter((x) => ahead.has(x.key))) await DB.prepare('DELETE FROM newsletter_drafts WHERE key = ? AND broadcast_id IS NULL').bind(r.key).run();
    }
    const config = await readConfig(DB);
    const alertTo = alertList(env, config);
    const out = [];
    const { results: due = [] } = await DB.prepare(`SELECT * FROM newsletter_drafts
      WHERE kind IN ('recap', 'monthly') AND ((state IN ('waiting', 'claimed') AND broadcast_id IS NULL) OR (broadcast_id IS NOT NULL AND told IS NULL))
      ORDER BY queued_at`).all();
    let drafted = 0;
    for (const row of due) {
      // A month whose time has passed with no draft: the next one's coming
      if (row.kind === 'monthly' && !row.broadcast_id && row.key !== monthlyKey(monthBefore(today))) {
        await writeRow(DB, { ...row, state: 'skipped' });
        continue;
      }
      if (!row.broadcast_id && drafted >= DRAFTS_PER_LOOK) continue;
      const r = await syncNewsletter(env, row, { config, alertTo, now, fetchImpl });
      if (r.newsletter === 'drafted') drafted += 1;
      out.push({ key: row.key, ...r });
    }
    // Due a look, or written in an older design (that one straight away, not hours later)
    const { results: waiting = [] } = await DB.prepare(`SELECT * FROM newsletter_drafts
      WHERE state = 'drafted' AND broadcast_id IS NOT NULL AND queued_at > ?
        AND (followed_at IS NULL OR followed_at < ? OR design IS NULL OR design != ?) ORDER BY followed_at LIMIT 5`)
      .bind(iso(now - FOLLOW_FOR_MS), iso(now - FOLLOW_EVERY_MS), NEWSLETTER_DESIGN).all();
    for (const row of waiting) out.push({ key: row.key, ...(await followNewsletter(env, row, { config, now, fetchImpl })) });
    return out;
  } catch (err) {
    console.error('[newsletter-drafts]', err.message);
    return [];
  }
}

/** On the heartbeat: once an hour. Claims the slot first, so overlapping wake-ups don't double up. Never throws. */
export async function maybeRunNewsletterDrafts(env, { now = Date.now(), fetchImpl = fetch } = {}) {
  try {
    if (!env.DB) return null;
    await ensureNewsletterSchema(env.DB);
    const r = await env.DB.prepare(`INSERT INTO newsletter_drafts (key, kind, state, updated_at) VALUES (?, 'seed', 'look', ?)
      ON CONFLICT(key) DO UPDATE SET updated_at = excluded.updated_at WHERE newsletter_drafts.updated_at < ?`)
      .bind(LAST_LOOK, iso(now), iso(now - LOOK_EVERY_MS)).run();
    if (!(r?.meta?.changes > 0)) return null;
    return await runNewsletterDrafts(env, { now, fetchImpl });
  } catch {
    return null;
  }
}

/**
 * Draft one now, by hand: the event's "After the event" panel, or the Monthly
 * Impact entry in Emails & invites. A draft only. It doesn't wait for the
 * email's moment or a past event's mark, only for what keeps it true; when that
 * isn't there, nothing is written at all. A draft still in Kit, scheduled or
 * sent is never made again; one deleted there can be. Never throws.
 */
export async function draftNewsletterNow(env, { key, by, now = Date.now(), fetchImpl = fetch }) {
  try {
    const { DB } = env;
    if (!keyOk(key)) return { newsletter: 'error', error: 'Not a newsletter email' };
    if (!isEmail(by)) return { newsletter: 'error', error: 'Couldn’t tell who asked for it' };
    await ensureNewsletterSchema(DB);
    const config = await readConfig(DB);
    const s = kitInviteSettings(config);
    if (!s.enabled || config.enabled === false) return { newsletter: 'off', reason: OFF_REASON };
    if (!kitConfigured(env)) return { newsletter: 'skip', reason: 'Kit isn’t connected' };
    const kind = key.startsWith('recap:') ? 'recap' : 'monthly';
    const have = await readNewsletterRow(DB, key);
    let gone = false;
    if (have?.broadcast_id) {
      const got = await kitReadBroadcast(env, have.broadcast_id);
      if (!goneInKit(got)) {
        if (!got.ok) return { newsletter: 'error', error: 'Kit couldn’t be reached, so nothing was drafted. Try again in a minute.' };
        return { newsletter: 'unchanged', id: have.broadcast_id, state: wentOut(got.broadcast, now) || 'draft' };
      }
      gone = true;
    }
    // Not ready (a month not over, an event still ahead, no photos on the page): say why and leave everything as it was
    const ctx = await contextFor(env, { key, kind }, { now, fetchImpl });
    if (ctx.block) return { newsletter: 'skip', reason: ctx.block };
    if (gone) {
      // Deleted in Kit: start again from nothing
      await DB.prepare(`UPDATE newsletter_drafts SET broadcast_id = NULL, state = 'waiting', told = NULL, reminded = NULL, error = NULL, alarmed = NULL,
        facts = NULL, content_hash = NULL, by = NULL, updated_at = ? WHERE key = ? AND broadcast_id = ?`).bind(iso(now), key, have.broadcast_id).run();
    } else if (have && have.state !== 'waiting' && have.state !== 'claimed') {
      await DB.prepare(`UPDATE newsletter_drafts SET state = 'waiting', error = NULL, updated_at = ? WHERE key = ? AND broadcast_id IS NULL`).bind(iso(now), key).run();
    }
    const row = have ? await readNewsletterRow(DB, key) : await queue(DB, key, kind, now);
    return await syncNewsletter(env, row, { config, alertTo: alertList(env, config), now, fetchImpl, by, ctx });
  } catch (err) {
    console.error('[newsletter-drafts]', err.message);
    return { newsletter: 'error', error: err.message };
  }
}

/**
 * Where an email stands, for its place in the admin. Read from Kit each time,
 * since the site isn't told when staff send or delete a draft. Read only.
 * @returns {Promise<{off: string|null, state: string, id?: string, at?: string, edited?: boolean, block: string|null, error: string|null, title: string}>}
 *   state 'none' | 'waiting' | 'skipped' | 'drafting' | 'draft' | 'scheduled' | 'sent' | 'deleted'
 */
export async function newsletterStatus(env, key, { now = Date.now(), fetchImpl = fetch } = {}) {
  const { DB } = env;
  await ensureNewsletterSchema(DB);
  const config = await readConfig(DB);
  const s = kitInviteSettings(config);
  const off = !s.enabled || config.enabled === false ? OFF_REASON : !kitConfigured(env) ? 'Kit isn’t connected' : null;
  const kind = key.startsWith('recap:') ? 'recap' : 'monthly';
  const row = await readNewsletterRow(DB, key);
  const base = { off, error: row?.error || null };
  if (!row?.broadcast_id) {
    const ctx = await contextFor(env, { key, kind }, { now, fetchImpl });
    const fresh = row?.state === 'claimed' && Date.parse(row.claimed_at || '') > now - CLAIM_MS;
    // A recap the site won't draft by itself: an event long over when first seen, or past its 60 days
    const age = kind === 'recap' && ctx.ev && isOver(ctx.ev, dayIn(now)) ? sinceOver(ctx.ev, now) : 0;
    const passed = kind === 'recap' && ((!row && age > NEW_FOR_MS) || age >= GIVE_UP_AFTER_MS);
    return { ...base, title: ctx.title, block: ctx.block, state: fresh ? 'drafting' : row?.state === 'skipped' || passed ? 'skipped' : row ? 'waiting' : 'none' };
  }
  const id = row.broadcast_id;
  const got = kitConfigured(env) ? await kitReadBroadcast(env, id) : { ok: false };
  const title = await titleFor(DB, key);
  if (goneInKit(got)) {
    const ctx = await contextFor(env, row, { now, fetchImpl });
    return { ...base, title: ctx.title, block: ctx.block, state: 'deleted', id, error: null };
  }
  if (!got.ok) return { ...base, title, block: null, state: 'draft', id, at: row.updated_at || null, unread: true };
  const b = got.broadcast;
  const went = wentOut(b, now);
  return { ...base, title, block: null, state: went || 'draft', id, edited: !went && row.state === 'edited',
    at: went === 'scheduled' ? b.send_at : went === 'sent' ? b.published_at || b.send_at || null : b.created_at || row.updated_at || null };
}

