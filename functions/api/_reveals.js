/**
 * Reveal dates, read live from JobTread
 * ===========================================================================
 * JobTread is the source of truth for reveal dates. Each SOARD job has a
 * "Reveal Date" custom field (UTC date-time, kept in sync with the job's
 * Reveal schedule task by ./_reveal-sync.js) and a "Reveal Date Confirmed" field.
 *
 * A confirmed reveal is public with its day and time. A tentative one (a
 * date, not confirmed yet) on a job that's being built is public only as a
 * third of a month, "mid November" (Peter, Oct 22 2026: the schedule is
 * close by then, but never a specific day); its exact date never leaves this
 * file. Rehearsal jobs ("TEST …") and the office sandbox are never public.
 *
 * A reveal whose Eastern time is exactly midnight has no time set yet (the
 * date sync's convention), so it's shown as a date only.
 *
 * Jobs are matched to kid pages by year and name: "Max Sample (2026)" matches
 * the 2026 kid "Max", "Remi & Nico Powell (2026)" matches "Remi & Nico".
 * Job names carry family surnames, so nothing from JobTread except the date
 * is ever returned; names and slugs come from the kids table.
 *
 * Needs JOBTREAD_GRANT_KEY (Cloudflare env). Without it, or when JobTread is
 * down, the last good result in D1 (site_config "reveals") is served.
 */

export const JT_URL = 'https://api.jobtread.com/pave';
export const SOARD_ORG_ID = '22NJw42j5GLg';
export const FIELD_REVEAL_DATE = '22PgGhcE8jte';
export const FIELD_REVEAL_CONFIRMED = '22PgGhWscUgE';
/** The job's Status (Design, Build, Awaiting Funding, …) */
export const FIELD_JOB_STATUS = '22P52qfFub9b';
/** Statuses of a job that's being built (./_kid-status.js shows these kids as in progress) */
export const BUILDING_STATUSES = new Set(['Design', 'Finalization', 'Approval', 'Mobilization', 'Build']);
export const TZ = 'America/New_York';
const CF_HASH = 'ROYFuPmfN2vPS6mt5sCkZQ';
const CACHE_KEY = 'reveals';
const MAX_PAGES = 5;
/** Past reveals the calendar feed keeps, so they don't vanish from people's calendars the next day */
const PAST_KEEP_DAYS = 120;
const SANDBOX_JOB_ID = '22P3HTX9cXn4';
/** A rehearsal job ("TEST Max Example (2026)") or the office sandbox: never public (same rule as ./_reveal-invites.js) */
export const isRehearsalJob = (job) => job?.id === SANDBOX_JOB_ID || /^\s*TEST\b/.test(String(job?.name || ''));

/** Lowercase, strip accents and punctuation: "Josué" → "josue", "Declan “Dex” Noel" → "declan dex noel" */
export function normalizeName(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** "Max Sample (2026)" → { year: 2026, tokens: Set{max, sample} } */
export function parseJobName(name) {
  const m = String(name || '').match(/\((\d{4})\)\s*$/);
  const year = m ? Number(m[1]) : null;
  const base = m ? name.slice(0, m.index) : name;
  return { year, tokens: new Set(normalizeName(base).split(' ').filter(Boolean)) };
}

function kidTokens(kidName) {
  return normalizeName(kidName).split(' ').filter(t => t && t !== 'and');
}

/** The job a profile names as its own (jobtreadJobId, set when approval made it) */
const pinnedJob = (k) => k?.jobtreadJobId || k?.data?.jobtreadJobId || null;

/**
 * The kid a job belongs to, or null when there's no match or more than one
 * (a wrong date on the wrong kid's page is worse than no date). With the
 * job's id, a profile linked to that job wins, and one linked to another job
 * never matches by name.
 */
export function matchKid(jobName, kids, jobId = null) {
  if (jobId) {
    const pinned = kids.filter(k => pinnedJob(k) === jobId);
    if (pinned.length === 1) return pinned[0];
  }
  const { year, tokens } = parseJobName(jobName);
  if (!year || tokens.size === 0) return null;
  const hits = kids.filter(k => {
    if (jobId && pinnedJob(k) && pinnedJob(k) !== jobId) return false;
    if (Number(k.year) !== year) return false;
    const kt = kidTokens(k.name);
    return kt.length > 0 && kt.every(t => tokens.has(t));
  });
  return hits.length === 1 ? hits[0] : null;
}

/** UTC instant → { date: 'YYYY-MM-DD', time: 'HH:MM' | null } in Eastern time */
export function easternParts(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).map(p => [p.type, p.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const time = `${parts.hour}:${parts.minute}`;
  return { date, time: time === '00:00' ? null : time };
}

export function todayEastern(now = Date.now()) {
  return easternParts(new Date(now).toISOString()).date;
}

/** Eastern wall-clock offset from UTC at an instant, in ms (−4 h or −5 h) */
function easternOffsetMs(ts) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ts)).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ts / 1000) * 1000;
}

/**
 * Eastern local date + time ('HH:MM', or null for midnight) → UTC ISO.
 * Exact for any date, daylight time or not: the offset is the one in force
 * at that local time, found by settling the guess twice.
 */
export function easternToUtcIso(date, time) {
  const [y, m, d] = String(date).split('-').map(Number);
  const [hh, mm] = String(time || '00:00').split(':').map(Number);
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  let ts = wall;
  for (let i = 0; i < 2; i++) ts = wall - easternOffsetMs(ts);
  return new Date(ts).toISOString();
}

/** "Tuesday, November 18" from 'YYYY-MM-DD' (weekday computed, never guessed) */
export function longDay(date) {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

/** "3:00 PM" from 'HH:MM' */
export function clockTime(time) {
  const [h, m] = String(time).split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/** Whole days from one 'YYYY-MM-DD' to another */
export function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
}

/**
 * The third of a month a tentative date falls in, with nothing finer:
 * '2026-11-17' → { part: 'mid', month: '2026-11', through: '2026-11-20', label: 'mid November' }.
 * Early is the 1st to 10th, mid the 11th to 20th, late the 21st to the end.
 * `through` is the window's last day (it drops off after that); the label
 * names the year only when it isn't this year's.
 */
export function revealWindow(date, today = todayEastern()) {
  const [y, m, d] = String(date).split('-').map(Number);
  const part = d <= 10 ? 'early' : d <= 20 ? 'mid' : 'late';
  const last = part === 'early' ? 10 : part === 'mid' ? 20 : new Date(Date.UTC(y, m, 0)).getUTCDate();
  const mm = String(m).padStart(2, '0');
  const monthName = new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });
  const sameYear = String(today).slice(0, 4) === String(y);
  return { part, month: `${y}-${mm}`, through: `${y}-${mm}-${String(last).padStart(2, '0')}`, label: `${part} ${monthName}${sameYear ? '' : ` ${y}`}` };
}

/** One JobTread (Pave) query with the grant key. Throws with JobTread's message on failure. */
export async function pave(grantKey, query, fetchImpl = fetch) {
  if (!grantKey) throw new Error('JOBTREAD_GRANT_KEY is not set');
  const res = await fetchImpl(JT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { $: { grantKey }, ...query } }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`JobTread returned ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
  }
  return res.json();
}

/** Bare Cloudflare Images id from a full delivery URL, or the input if it's already an id */
export function cfImageId(src) {
  if (!src) return null;
  const s = String(src);
  const m = s.match(/(?:imagedelivery\.net|\/cdn-cgi\/imagedelivery)\/[^/]+\/(.+)$/);
  let id = m ? m[1] : s;
  const last = id.lastIndexOf('/');
  if (last > 0) {
    const suffix = id.slice(last + 1);
    if (suffix === 'public' || suffix.includes('=')) id = id.slice(0, last);
  }
  return /^[\w\-./%]+$/.test(id) ? id : null;
}

function thumb(src) {
  const id = cfImageId(src);
  return id ? `/cdn-cgi/imagedelivery/${CF_HASH}/${id}/w=640,h=480,fit=cover,gravity=face,q=80` : null;
}

/** Published kids from D1, in the shape matchKid needs */
export async function loadKids(DB) {
  const { results } = await DB.prepare('SELECT slug, name, year, data FROM kids').all();
  const kids = [];
  for (const row of results || []) {
    let data = {};
    try { data = JSON.parse(row.data || '{}'); } catch { /* bad row, use columns */ }
    if (data.publishStatus === 'draft') continue;
    kids.push({
      slug: row.slug, name: data.name || row.name, year: row.year ?? data.year,
      heroImage: data.heroImage || data.photos?.[0]?.url || null, jobtreadJobId: data.jobtreadJobId || null,
      rooms: Array.isArray(data.roomTypes) ? data.roomTypes.filter((r) => typeof r === 'string' && r).slice(0, 4) : [],
    });
  }
  return kids;
}

/** Open SOARD jobs with their custom field values (follows pagination) */
export async function fetchJobs(grantKey, fetchImpl = fetch) {
  const jobs = [];
  let page = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    const args = { size: 100, where: ['closedOn', '=', null], ...(page ? { page } : {}) };
    const res = await fetchImpl(JT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: {
          $: { grantKey },
          organization: {
            $: { id: SOARD_ORG_ID },
            jobs: {
              $: args,
              nextPage: {},
              nodes: { id: {}, name: {}, customFieldValues: { $: { size: 50 }, nodes: { value: {}, customField: { id: {} } } } },
            },
          },
        },
      }),
    });
    if (!res.ok) throw new Error(`JobTread returned ${res.status}`);
    const body = await res.json();
    const conn = body?.organization?.jobs;
    if (!conn) throw new Error('JobTread response had no jobs');
    jobs.push(...(conn.nodes || []));
    page = conn.nextPage || null;
    if (!page) break;
  }
  return jobs;
}

const isConfirmed = (values) => String(values[FIELD_REVEAL_CONFIRMED] || '').trim().toLowerCase().startsWith('yes');

/**
 * Every reveal coming up on a published kid's job, soonest first, one per kid:
 *   reveals   confirmed only: { slug, name, startsAt, date, time, image, kidUrl, liveUrl }
 *             (the shape kid pages and the events page have always read)
 *   upcoming  confirmed and tentative together, in date order, each with
 *             { slug, name, confirmed, image, rooms, kidUrl, liveUrl } plus
 *             startsAt/date/time when confirmed, or window (see revealWindow)
 *             when tentative. A tentative reveal needs a job that's being
 *             built, and never carries its date.
 */
export function buildSchedule(jobs, kids, now = Date.now()) {
  const today = todayEastern(now);
  const found = [];
  for (const job of jobs) {
    if (isRehearsalJob(job)) continue;
    const values = {};
    for (const v of job.customFieldValues?.nodes || []) values[v.customField?.id] = v.value;
    const startsAt = values[FIELD_REVEAL_DATE];
    const parts = startsAt ? easternParts(startsAt) : null;
    if (!parts || parts.date < today) continue;
    const confirmed = isConfirmed(values);
    if (!confirmed && !BUILDING_STATUSES.has(String(values[FIELD_JOB_STATUS] || '').trim())) continue;
    const kid = matchKid(job.name, kids, job.id);
    if (!kid) continue;
    found.push({ kid, confirmed, startsAt: new Date(startsAt).toISOString(), parts });
  }
  // One reveal per kid (the soonest), soonest first
  found.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const seen = new Set();
  const reveals = [];
  const upcoming = [];
  for (const { kid, confirmed, startsAt, parts } of found) {
    if (seen.has(kid.slug)) continue;
    seen.add(kid.slug);
    const links = { image: thumb(kid.heroImage), kidUrl: `/kids/${kid.slug}/`, liveUrl: `/live/${kid.slug}/` };
    if (confirmed) {
      const r = { slug: kid.slug, name: kid.name, startsAt, date: parts.date, time: parts.time, ...links };
      reveals.push(r);
      upcoming.push({ ...r, confirmed: true, rooms: kid.rooms || [] });
    } else {
      upcoming.push({ slug: kid.slug, name: kid.name, confirmed: false, window: revealWindow(parts.date, today), ...links, rooms: kid.rooms || [] });
    }
  }
  return { reveals, upcoming };
}

/** Confirmed reveals from today on, matched to published kids, soonest first (see buildSchedule) */
export function buildReveals(jobs, kids, now = Date.now()) {
  return buildSchedule(jobs, kids, now).reveals;
}

/**
 * Confirmed reveals whose day has passed, kept for the calendar feed: the
 * last copy's reveals that are now in the past join the ones already kept,
 * newest first, for PAST_KEEP_DAYS. A reveal that disappears before its day
 * (no longer confirmed, or the kid page was hidden) is simply dropped.
 */
export function carryPast(previous, today) {
  const cutoff = new Date(Date.parse(`${today}T12:00:00Z`) - PAST_KEEP_DAYS * 86_400_000).toISOString().slice(0, 10);
  const byKid = new Map();
  for (const r of [...(previous?.reveals || []), ...(previous?.past || [])]) {
    if (!r?.slug || !r.date || r.date >= today || r.date < cutoff || byKid.has(r.slug)) continue;
    byKid.set(r.slug, r);
  }
  return [...byKid.values()].sort((a, b) => b.date.localeCompare(a.date));
}

async function readCache(DB) {
  const row = await DB.prepare('SELECT data FROM site_config WHERE key = ?').bind(CACHE_KEY).first();
  if (!row) return null;
  try { return JSON.parse(row.data); } catch { return null; }
}

async function writeCache(DB, value) {
  await DB.prepare('INSERT OR REPLACE INTO site_config (key, data, updated_at) VALUES (?, ?, ?)')
    .bind(CACHE_KEY, JSON.stringify(value), new Date().toISOString()).run();
}

/** A cached upcoming entry is still ahead: a confirmed day from today on, or a window that hasn't closed */
const stillAhead = (today) => (r) => (r.confirmed === false ? String(r.window?.through || '') >= today : String(r.date || '') >= today);

/**
 * The last good copy in D1 as getReveals serves it (reveals that have since
 * passed moved to past), without asking JobTread. updatedAt says how old it is.
 */
export async function cachedReveals(env, now = Date.now()) {
  const today = todayEastern(now);
  const cached = env.DB ? await readCache(env.DB).catch(() => null) : null;
  const reveals = (cached?.reveals || []).filter(r => r.date >= today);
  // A copy from before tentative reveals were public has no upcoming list: its confirmed reveals are the list
  const upcoming = Array.isArray(cached?.upcoming) ? cached.upcoming.filter(stillAhead(today)) : reveals.map((r) => ({ ...r, confirmed: true, rooms: [] }));
  return { reveals, upcoming, past: carryPast(cached, today), updatedAt: cached?.updatedAt || null, source: cached ? 'cache' : 'none' };
}

/**
 * Fresh from JobTread when possible, else the last good copy (re-filtered so
 * reveals that have since passed drop off). Never throws.
 * → { reveals, upcoming, past, updatedAt, source, error? }; past is for the
 *   calendar feed only (./reveals.js leaves it out).
 */
export async function getReveals(env, { fetchImpl = fetch, now = Date.now() } = {}) {
  const today = todayEastern(now);
  const fromCache = async (error) => ({ ...(await cachedReveals(env, now)), ...(error ? { error } : {}) });
  if (!env.JOBTREAD_GRANT_KEY) return fromCache('JOBTREAD_GRANT_KEY is not set');
  try {
    const [jobs, kids, previous] = await Promise.all([
      fetchJobs(env.JOBTREAD_GRANT_KEY, fetchImpl),
      loadKids(env.DB),
      env.DB ? readCache(env.DB).catch(() => null) : null,
    ]);
    const result = { ...buildSchedule(jobs, kids, now), past: carryPast(previous, today), updatedAt: new Date(now).toISOString() };
    await writeCache(env.DB, result).catch(() => {});
    return { ...result, source: 'jobtread' };
  } catch (err) {
    return fromCache(err.message);
  }
}
