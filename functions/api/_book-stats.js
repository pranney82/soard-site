/**
 * The anniversary book's readers, counted: what the reader on the page sends
 * (/api/book-stats) and what Admin → Site Config → Anniversary book shows
 * (/api/book-stats-admin). Daily counters only, in D1 table book_stats
 * (day, version, metric, key, n): no cookie, no address, no id is kept, so
 * nothing here is about a person.
 *
 * Metrics (key in brackets):
 *   visit         a visit to the book's page (once per browser tab session)
 *   reader        a visit that turned at least one page
 *   view [page]   a page shown (0-based)
 *   ms [page]     milliseconds it was on screen, the tab in front and the book in view
 *   time          milliseconds of reading in all (two pages side by side count once)
 *   reach [page]  how far each visit that began at the cover got: +1 at the furthest page, −1 where it had got to before
 *   end           a visit that began at the cover and reached the last pages
 *   download, print, search, play, full
 *   share [copy | email | facebook | x | linkedin | native]
 *   link [address]   a link in the book followed
 *   device [phone | tablet | computer], from [referring site]
 *   place [the page it was read on: /about/ (Our Story) or the book's own, /15-years/]
 */

const VERSION = /^[a-z0-9]{4,20}$/;
const TZ = 'America/New_York';
const MAX_PAGE = 2000;
const SHARES = new Set(['copy', 'email', 'facebook', 'x', 'linkedin', 'native']);
const DEVICES = new Set(['phone', 'tablet', 'computer']);
const COUNTS = ['download', 'print', 'search', 'play', 'full'];

const _ready = new WeakSet();
export async function ensureSchema(DB) {
  if (_ready.has(DB)) return;
  await DB.prepare(`CREATE TABLE IF NOT EXISTS book_stats (
    day TEXT NOT NULL, version TEXT NOT NULL, metric TEXT NOT NULL, key TEXT NOT NULL DEFAULT '', n INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, version, metric, key))`).run();
  _ready.add(DB);
}

const int = (v, max) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(max, Math.max(0, n)) : 0; };
const pageKey = (k) => { const n = Number(k); return Number.isInteger(n) && n >= 0 && n < MAX_PAGE ? String(n) : null; };

/** A link's address as a counter key: http(s) or mailto, no query, at most 160 characters */
export function linkKey(url) {
  const s = String(url || '').trim();
  if (/^mailto:/i.test(s)) return s.slice(0, 160).toLowerCase();
  try {
    const u = new URL(s);
    if (!/^https?:$/.test(u.protocol)) return null;
    return `${u.hostname.replace(/^www\./, '')}${u.pathname}`.replace(/\/$/, '').slice(0, 160).toLowerCase();
  } catch { return null; }
}
/** The page a visit read the book on (a site path like /about/), or null for junk */
export function placeKey(path) {
  const s = String(path || '').toLowerCase();
  return /^\/(?:[a-z0-9-]{1,60}\/)?$/.test(s) ? s : null;
}
/** A referring site's name, or null for none, this site, or junk */
export function fromKey(ref, self = 'sunshineonaranneyday.com') {
  try {
    const h = new URL(String(ref || '')).hostname.replace(/^www\./, '').toLowerCase();
    return h && h !== self && /^[a-z0-9.-]{1,80}$/.test(h) ? h : null;
  } catch { return null; }
}

/**
 * What one beacon adds: [[metric, key, n]…], everything checked and capped
 * (a page's time is at most ten minutes a beacon, any count at most 50).
 * Returns null when it isn't a beacon for a book at all.
 */
export function statsRows(body) {
  if (!body || typeof body !== 'object' || !VERSION.test(String(body.v || ''))) return null;
  const rows = [];
  if (body.visit) rows.push(['visit', '', 1]);
  if (body.reader) rows.push(['reader', '', 1]);
  if (body.end) rows.push(['end', '', 1]);
  for (const [k, n] of Object.entries(body.views || {}).slice(0, 200)) { const p = pageKey(k); const c = int(n, 50); if (p && c) rows.push(['view', p, c]); }
  for (const [k, n] of Object.entries(body.ms || {}).slice(0, 200)) { const p = pageKey(k); const c = int(n, 600000); if (p && c) rows.push(['ms', p, c]); }
  if (Array.isArray(body.reach) && body.reach.length === 2) {
    const [from, to] = body.reach.map(Number);
    if (Number.isInteger(to) && to >= 0 && to < MAX_PAGE && (from === -1 || (Number.isInteger(from) && from >= 0 && from < to))) {
      if (from >= 0) rows.push(['reach', String(from), -1]);
      rows.push(['reach', String(to), 1]);
    }
  }
  const time = int(body.time, 600000);
  if (time) rows.push(['time', '', time]);
  for (const m of COUNTS) { const c = int(body[m], 50); if (c) rows.push([m, '', c]); }
  for (const [k, n] of Object.entries(body.share || {})) { const c = int(n, 50); if (SHARES.has(k) && c) rows.push(['share', k, c]); }
  for (const [k, n] of Object.entries(body.links || {}).slice(0, 20)) { const key = linkKey(k); const c = int(n, 50); if (key && c) rows.push(['link', key, c]); }
  if (DEVICES.has(body.device)) rows.push(['device', body.device, 1]);
  const from = body.visit ? fromKey(body.from) : null;
  if (from) rows.push(['from', from, 1]);
  const place = body.visit ? placeKey(body.place) : null;
  if (place) rows.push(['place', place, 1]);
  return rows;
}

/** A moment's day in Atlanta (YYYY-MM-DD): someone reading at nine at night counts that evening, not the next day */
export const dayOf = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
/** A day so many days on from another (calendar days, YYYY-MM-DD) */
export const addDays = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

/** Add a beacon's rows to the day's counters, all in one batch */
export async function recordStats(DB, version, rows, day = dayOf()) {
  if (!rows?.length) return 0;
  await ensureSchema(DB);
  const sql = 'INSERT INTO book_stats (day, version, metric, key, n) VALUES (?, ?, ?, ?, ?) ON CONFLICT (day, version, metric, key) DO UPDATE SET n = n + excluded.n';
  await DB.batch(rows.map(([m, k, n]) => DB.prepare(sql).bind(day, version, m, k, n)));
  return rows.length;
}

/**
 * The admin's view of a stretch of days (days = 0: everything), in Atlanta's days: totals, each
 * day's visits and readers, and, for one upload of the book (version), each
 * page's views and time and how far readers got.
 */
export async function readStats(DB, { days = 30, version = null, today = new Date() } = {}) {
  await ensureSchema(DB);
  const end = dayOf(today);
  const since = days > 0 ? addDays(end, -(days - 1)) : '0000-00-00';
  const { results = [] } = await DB.prepare('SELECT day, version, metric, key, SUM(n) AS n FROM book_stats WHERE day >= ? AND day <= ? GROUP BY day, version, metric, key').bind(since, days > 0 ? end : '9999-12-31').all();
  const sum = (pred) => results.filter(pred).reduce((s, r) => s + Number(r.n || 0), 0);
  const by = (metric, mine = false) => {
    const out = {};
    for (const r of results) if (r.metric === metric && (!mine || r.version === version)) out[r.key] = (out[r.key] || 0) + Number(r.n || 0);
    return out;
  };
  const days_ = {};
  for (const r of results) {
    if (r.metric !== 'visit' && r.metric !== 'reader') continue;
    days_[r.day] ||= { day: r.day, visits: 0, readers: 0 };
    days_[r.day][r.metric === 'visit' ? 'visits' : 'readers'] += Number(r.n || 0);
  }
  const top = (o, k = 8) => Object.entries(o).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, k).map(([key, n]) => ({ key, n }));
  return {
    since: days > 0 ? since : null,
    today: end,
    totals: {
      visits: sum((r) => r.metric === 'visit'),
      readers: sum((r) => r.metric === 'reader'),
      time: sum((r) => r.metric === 'time'),
      end: sum((r) => r.metric === 'end'),
      // Visits that began at the cover (how far people read nets +1 a visit): what "read to the end" is out of
      started: sum((r) => r.metric === 'reach'),
      download: sum((r) => r.metric === 'download'),
      share: sum((r) => r.metric === 'share'),
      print: sum((r) => r.metric === 'print'),
      search: sum((r) => r.metric === 'search'),
      play: sum((r) => r.metric === 'play'),
      link: sum((r) => r.metric === 'link'),
    },
    days: Object.values(days_).sort((a, b) => a.day.localeCompare(b.day)),
    pages: { views: by('view', true), ms: by('ms', true), reach: by('reach', true) },
    devices: by('device'),
    places: by('place'),
    shares: by('share'),
    links: top(by('link')),
    from: top(by('from')),
  };
}
