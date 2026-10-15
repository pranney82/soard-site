/**
 * Confirmed reveal dates, read live from JobTread
 * ===========================================================================
 * JobTread is the source of truth for reveal dates. Each SOARD job has a
 * "Reveal Date" custom field (UTC date-time, kept in sync with the job's
 * Reveal schedule task by a DataX agent) and a "Reveal Date Confirmed" field.
 * Only confirmed reveals are public; projected dates never leave JobTread.
 *
 * A reveal whose Eastern time is exactly midnight has no time set yet (the
 * sync agent's convention), so it's shown as a date only.
 *
 * Jobs are matched to kid pages by year and name: "Max Daniel (2026)" matches
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
export const TZ = 'America/New_York';
const CF_HASH = 'ROYFuPmfN2vPS6mt5sCkZQ';
const CACHE_KEY = 'reveals';
const MAX_PAGES = 5;

/** Lowercase, strip accents and punctuation: "Josué" → "josue", "Declan “Dex” Noel" → "declan dex noel" */
export function normalizeName(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** "Max Daniel (2026)" → { year: 2026, tokens: Set{max, daniel} } */
export function parseJobName(name) {
  const m = String(name || '').match(/\((\d{4})\)\s*$/);
  const year = m ? Number(m[1]) : null;
  const base = m ? name.slice(0, m.index) : name;
  return { year, tokens: new Set(normalizeName(base).split(' ').filter(Boolean)) };
}

function kidTokens(kidName) {
  return normalizeName(kidName).split(' ').filter(t => t && t !== 'and');
}

/**
 * The kid a job belongs to, or null when there's no match or more than one
 * (a wrong date on the wrong kid's page is worse than no date).
 */
export function matchKid(jobName, kids) {
  const { year, tokens } = parseJobName(jobName);
  if (!year || tokens.size === 0) return null;
  const hits = kids.filter(k => {
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
    kids.push({ slug: row.slug, name: data.name || row.name, year: row.year ?? data.year, heroImage: data.heroImage || data.photos?.[0]?.url || null });
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

/**
 * Confirmed reveals from today on, matched to published kids, soonest first.
 * Public shape: { slug, name, startsAt, date, time, image, kidUrl, liveUrl }
 */
export function buildReveals(jobs, kids, now = Date.now()) {
  const today = todayEastern(now);
  const out = [];
  for (const job of jobs) {
    const values = {};
    for (const v of job.customFieldValues?.nodes || []) values[v.customField?.id] = v.value;
    if (!String(values[FIELD_REVEAL_CONFIRMED] || '').trim().toLowerCase().startsWith('yes')) continue;
    const startsAt = values[FIELD_REVEAL_DATE];
    const parts = startsAt ? easternParts(startsAt) : null;
    if (!parts || parts.date < today) continue;
    const kid = matchKid(job.name, kids);
    if (!kid) continue;
    out.push({
      slug: kid.slug,
      name: kid.name,
      startsAt: new Date(startsAt).toISOString(),
      date: parts.date,
      time: parts.time,
      image: thumb(kid.heroImage),
      kidUrl: `/kids/${kid.slug}/`,
      liveUrl: `/live/${kid.slug}/`,
    });
  }
  // One reveal per kid (the soonest), soonest first
  out.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const seen = new Set();
  return out.filter(r => (seen.has(r.slug) ? false : seen.add(r.slug)));
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

/**
 * Fresh from JobTread when possible, else the last good copy (re-filtered so
 * reveals that have since passed drop off). Never throws.
 */
export async function getReveals(env, { fetchImpl = fetch, now = Date.now() } = {}) {
  const today = todayEastern(now);
  const fromCache = async (error) => {
    const cached = env.DB ? await readCache(env.DB).catch(() => null) : null;
    const reveals = (cached?.reveals || []).filter(r => r.date >= today);
    return { reveals, updatedAt: cached?.updatedAt || null, source: cached ? 'cache' : 'none', ...(error ? { error } : {}) };
  };
  if (!env.JOBTREAD_GRANT_KEY) return fromCache('JOBTREAD_GRANT_KEY is not set');
  try {
    const [jobs, kids] = await Promise.all([fetchJobs(env.JOBTREAD_GRANT_KEY, fetchImpl), loadKids(env.DB)]);
    const result = { reveals: buildReveals(jobs, kids, now), updatedAt: new Date(now).toISOString() };
    await writeCache(env.DB, result).catch(() => {});
    return { ...result, source: 'jobtread' };
  } catch (err) {
    return fromCache(err.message);
  }
}
