/**
 * The press monitor: finds SOARD coverage, files it, and keeps the press
 * list in good repair. Runs on the hub heartbeat (functions/api/broadcast-hooks.js)
 * with nobody's help; Admin → Press shows what it did and lets staff undo it.
 *
 *   Finding: Google News and Bing News for the search terms (Press → Found),
 *   the TV stations' YouTube uploads, and a YouTube search, every few hours.
 *   Each article is read: its outlet, date, picture and words. Workers AI
 *   says whether it's about SOARD, writes the summary in the site's voice,
 *   and confirms which kids and partners it's about (from names actually in
 *   the text). A clear story is filed on the publicity page and the site
 *   publishes itself (at most every 30 minutes, like the kid status sync);
 *   an unclear one waits in Press → Found. Slack hears about both.
 *
 *   Repair (the tidy, once): every story linked to one outlet record, the
 *   duplicates merged, Google News links swapped for the outlet's own,
 *   outlet names taken off headlines, pictures pulled from the articles (or
 *   their archived copies), web code taken out of summaries, kids and
 *   partners linked. Each change is logged in press_log and can be undone.
 *
 *   Upkeep (weekly): every link checked. A story taken down twice in a row
 *   links to its Internet Archive copy instead (or shows without a link),
 *   and comes back when it works again. New stories are saved to the
 *   archive when they're filed.
 *
 * Writes never clobber an edit made meanwhile: each record is written only
 * if it's still what was read (UPDATE … WHERE data = <what was read>).
 * Every write goes to the audit log (so Publish lists it) and to History.
 * Work is cut into small steps (one fetch or two) kept in D1, so a step cut
 * short just runs again on the next beat.
 */
import { EXTRACTORS } from './_collections.js';
import { commitFile, deleteFile } from './_github.js';
import { logAudit, diffJson } from './_audit.js';
import { recordVersion, recordDeletion } from './_content-history.js';
import { slackPost } from './_broadcast-notify.js';
import { slackCard } from './_slack-cards.js';
import * as P from '../../public/admin/press-shared.js';
import { googleNews, decodeGoogleLink, bingNews, youTubeChannel, youTubeSearch, UA } from './_press-sources.js';
import { readPage, checkLink, archiveLookup, archiveSave, archiveRaw, saveImage, safeUrl } from './_press-page.js';

export const PRESS_USER = 'Press monitor (automatic)';
export const SETTINGS_KEY = 'press-monitor';
export const STATE_KEY = 'press-monitor-state';
const SITE = 'https://sunshineonaranneyday.com';
const H = 3600e3;
const SCAN_EVERY = { google: 3 * H, bing: 3 * H, youtube: 6 * H };
const SWEEP_EVERY = 7 * 24 * H;
const GONE_CONFIRM_MS = 5 * 24 * H;   // gone on two checks at least this far apart
const DEPLOY_COOLDOWN = 30 * 60e3;
// The heartbeat's waitUntil gets ~30s: new steps start only in the first few
// seconds, and the slowest step (a page, its archive lookup, its archived
// copy) stays under ~25s with the timeouts in _press-page.js
const STEP_WINDOW_MS = 6000;
const MAX_TRIES = 3;                   // a step cut short this often is skipped
const LOCK_MS = 45000;
export const TIDY_VERSION = 1;
const TEXT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const HOOK_ENV_VARS = ['CF_PAGES_DEPLOY_HOOK', 'CF_DEPLOY_HOOK', 'DEPLOY_HOOK_URL'];
const STYLE = 'Plain, warm and specific. Facts from the text only; never invent names, dates or outcomes. No em dashes or en dashes (use commas or periods). No exclamation marks. Avoid stock phrases such as "journey", "testament", "heartwarming", "life-changing", "truly", "a space where".';

const iso = (t = Date.now()) => new Date(t).toISOString();
// The Internet Archive turns a burst away (429), so it's asked one thing at a
// time, and left alone for an hour after it says to slow down
const ARCHIVE_GAP_MS = 20000;
const ARCHIVE_BACKOFF_MS = 60 * 60e3;
const parse = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const clip = (s, n) => (s && s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s || '');
const dateOnly = (s) => { const t = Date.parse(s || ''); return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null; };

// ── Tables ───────────────────────────────────────────────────────────
let tablesReady = false;
export async function ensurePressTables(DB) {
  if (tablesReady) return;
  await DB.batch([
    DB.prepare(`CREATE TABLE IF NOT EXISTS press_mentions (
      id TEXT PRIMARY KEY, key TEXT, provider TEXT, query TEXT, url TEXT, link TEXT, title TEXT, source TEXT, source_url TEXT,
      published TEXT, description TEXT, video_id TEXT, state TEXT NOT NULL DEFAULT 'new', stage TEXT, reason TEXT, story TEXT,
      data TEXT, tries INTEGER DEFAULT 0, found_at TEXT NOT NULL, updated_at TEXT, decided_at TEXT, decided_by TEXT, alerted INTEGER DEFAULT 0)`),
    DB.prepare('CREATE INDEX IF NOT EXISTS press_mentions_state ON press_mentions (state, found_at)'),
    DB.prepare('CREATE INDEX IF NOT EXISTS press_mentions_key ON press_mentions (key)'),
    DB.prepare(`CREATE TABLE IF NOT EXISTS press_links (
      slug TEXT PRIMARY KEY, url TEXT, status TEXT, http INTEGER, fails INTEGER DEFAULT 0, first_failed_at TEXT, checked_at TEXT,
      archive_url TEXT, archive_checked_at TEXT, saved_at TEXT, data TEXT, enriched_at TEXT)`),
    DB.prepare(`CREATE TABLE IF NOT EXISTS press_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, kind TEXT NOT NULL, slug TEXT, label TEXT,
      before TEXT, after TEXT, extra TEXT, undone_at TEXT, undone_by TEXT)`),
    DB.prepare('CREATE INDEX IF NOT EXISTS press_log_at ON press_log (id)'),
  ]);
  tablesReady = true;
}
export const _resetTablesForTests = () => { tablesReady = false; };

async function readDoc(DB, key) {
  const row = await DB.prepare('SELECT data FROM site_config WHERE key = ?').bind(key).first();
  return parse(row?.data, null);
}
const writeDoc = (DB, key, data) => DB.prepare('INSERT OR REPLACE INTO site_config (key, data, updated_at) VALUES (?, ?, ?)').bind(key, JSON.stringify(data), iso()).run();

export async function readSettings(DB) {
  const s = (await readDoc(DB, SETTINGS_KEY)) || {};
  return {
    queries: Array.isArray(s.queries) && s.queries.length ? s.queries : P.DEFAULT_QUERIES,
    channels: Array.isArray(s.channels) ? s.channels : P.DEFAULT_CHANNELS,
    updatedBy: s.updatedBy || null, updatedAt: s.updatedAt || null, custom: !!s.queries,
  };
}
export async function readState(DB) {
  const s = (await readDoc(DB, STATE_KEY)) || {};
  return { scans: {}, sweep: {}, tidy: {}, ...s };
}
const writeState = (DB, s) => writeDoc(DB, STATE_KEY, s);

/** Asks the Archive at most once per gap; state.archiveNextAt carries the pause between beats */
export function archiveGate(state, gapMs = ARCHIVE_GAP_MS) {
  const ready = () => Date.now() >= Date.parse(state.archiveNextAt || 0);
  const after = (r) => { state.archiveNextAt = iso(Date.now() + (r?.limited ? ARCHIVE_BACKOFF_MS : gapMs)); if (r?.limited) state.archiveLimitedAt = iso(); };
  return {
    ready,
    async lookup(url, date, fetchImpl = fetch) { if (!ready()) return { skipped: true }; const r = await archiveLookup(url, date, { fetchImpl }); after(r); return r; },
    async save(url, fetchImpl = fetch) { if (!ready()) return { skipped: true }; const r = await archiveSave(url, { fetchImpl }); after(r); return r; },
  };
}
// A person's own action (or a test) asks straight away
const OPEN_GATE = { ready: () => true, lookup: (u, d, f = fetch) => archiveLookup(u, d, { fetchImpl: f }), save: (u, f = fetch) => archiveSave(u, { fetchImpl: f }) };

// ── Records ──────────────────────────────────────────────────────────
const DIRS = { press: 'src/content/press', medialogos: 'src/content/medialogos' };
export async function loadAll(DB, table) {
  const rows = (await DB.prepare(`SELECT slug, data FROM ${table}`).all()).results || [];
  return rows.map((r) => ({ slug: r.slug, raw: r.data, data: { ...parse(r.data, {}), slug: r.slug } }));
}
async function loadOne(DB, table, slug) {
  const r = await DB.prepare(`SELECT data FROM ${table} WHERE slug = ?`).bind(slug).first();
  return r ? { slug, raw: r.data, data: parse(r.data, {}) } : null;
}
/**
 * Write a record only if it's still what was read (raw null: only if it
 * doesn't exist yet). Audit log, History and the GitHub copy, like
 * save-content. Returns false when someone changed it meanwhile.
 */
export async function writeRecord(env, table, slug, raw, next, { message, user = PRESS_USER, before = null } = {}) {
  const { DB } = env;
  const clean = { ...next };
  // Press files have no slug field (the file name is it); outlets carry theirs (the content schema needs it)
  if (table === 'press') delete clean.slug; else clean.slug = slug;
  const json = JSON.stringify(clean);
  const now = iso();
  const [cols, vals] = EXTRACTORS[table](clean);
  let res;
  if (raw == null) {
    const all = ['"slug"', '"data"', '"updated_at"', ...cols];
    res = await DB.prepare(`INSERT INTO ${table} (${all.join(', ')}) VALUES (${all.map(() => '?').join(', ')}) ON CONFLICT(slug) DO NOTHING`).bind(slug, json, now, ...vals).run();
  } else {
    if (raw === json) return true;
    res = await DB.prepare(`UPDATE ${table} SET "data" = ?, "updated_at" = ?, ${cols.map((c) => `${c} = ?`).join(', ')} WHERE slug = ? AND data = ?`).bind(json, now, ...vals, slug, raw).run();
  }
  if (!res?.meta?.changes) return false;
  const path = `${DIRS[table]}/${slug}.json`;
  let gitStatus = 'ok';
  try { await commitFile(env, path, `${JSON.stringify(clean, null, 2)}\n`, message || `Press monitor: ${slug}`); } catch { gitStatus = 'failed'; }
  const old = before || (raw ? parse(raw, null) : null);
  await logAudit(DB, { userEmail: user, action: raw == null ? 'created' : (clean.publishStatus === 'draft' ? 'drafted' : 'updated'), entityType: table, entitySlug: slug, entityName: clean.title || clean.name || slug, changes: old ? diffJson(old, clean) : null, path, gitStatus });
  try { await recordVersion(DB, { collection: table, slug, data: clean, previous: old, userEmail: user, now }); } catch { /* history is a nicety */ }
  return true;
}
export async function deleteRecord(env, table, slug, raw, { message, user = PRESS_USER } = {}) {
  const { DB } = env;
  const res = await DB.prepare(`DELETE FROM ${table} WHERE slug = ? AND data = ?`).bind(slug, raw).run();
  if (!res?.meta?.changes) return false;
  const data = parse(raw, {});
  const path = `${DIRS[table]}/${slug}.json`;
  let gitStatus = 'ok';
  try { await deleteFile(env, path, message || `Press monitor: remove ${slug}`); } catch { gitStatus = 'failed'; }
  await logAudit(DB, { userEmail: user, action: 'deleted', entityType: table, entitySlug: slug, entityName: data.title || data.name || slug, changes: null, path, gitStatus });
  try { await recordDeletion(DB, { collection: table, slug, data, userEmail: user, now: iso() }); } catch { /* ok */ }
  return true;
}
async function logChange(DB, { kind, slug = null, label, before = null, after = null, extra = null }) {
  await DB.prepare('INSERT INTO press_log (at, kind, slug, label, before, after, extra) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(iso(), kind, slug, label, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, extra ? JSON.stringify(extra) : null).run();
}
/** The fields that differ, as { before, after } holding just those */
function fieldDiff(a, b) {
  const before = {};
  const after = {};
  for (const k of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) {
    if (k === 'slug') continue;
    if (JSON.stringify(a?.[k] ?? null) !== JSON.stringify(b?.[k] ?? null)) { before[k] = a?.[k] ?? null; after[k] = b?.[k] ?? null; }
  }
  return Object.keys(after).length ? { before, after } : null;
}

// ── Workers AI ───────────────────────────────────────────────────────
function firstJson(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  return start >= 0 && end > start ? parse(s.slice(start, end + 1), null) : null;
}
/**
 * Is it about SOARD, a summary in the site's voice, its category, and which
 * of the candidate kids and partners it's really about. null without AI.
 */
export async function judgeWithAi(env, { title, outlet, date, text, description, kids = [], partners = [], wantSummary = true }) {
  if (!env.AI) return null;
  const body = clip(String(text || description || ''), 3600);
  const prompt = `You check press coverage for Sunshine on a Ranney Day (SOARD), a nonprofit in Roswell, Georgia that builds dream bedrooms, bathrooms and therapy rooms for children with special needs, at no cost to their families. Its founders are Peter and Holly Ranney. It also runs a home furnishings store, Sunny & Ranney.

Story: ${outlet || 'Unknown outlet'}, "${title}"${date ? ` (${date})` : ''}
Text:
"""
${body || '(the outlet would not show the text)'}
"""
${kids.length ? `\nChildren SOARD helped whose names appear in the text:\n${kids.map((k) => `- ${k.slug}: ${k.name}${k.year ? `, room built ${k.year}` : ''}${k.diagnosis ? `, ${k.diagnosis}` : ''}`).join('\n')}\n` : ''}${partners.length ? `\nSOARD partners named in the text:\n${partners.map((p) => `- ${p.slug}: ${p.name}`).join('\n')}\n` : ''}
Answer with JSON only, no other words:
{"about": "about" or "mentions" or "unrelated", "summary": "...", "category": "national-tv" or "local-tv" or "print" or "magazine" or "entertainment", "kids": [...], "partners": [...]}
- about: "about" when SOARD, its founders, its store or a room it built is a main subject; "mentions" when SOARD only comes up in passing; "unrelated" when it is a different organization or person.
- summary: ${wantSummary ? `one or two sentences, under 260 characters, saying what the story reports, for SOARD's press page. ${STYLE}` : 'an empty string.'}
- category: national-tv for national TV networks, local-tv for local TV stations, magazine for magazines, entertainment for radio, podcasts and entertainment sites, print for newspapers and other websites.
- kids: the slugs of listed children the story is actually about (empty if none).
- partners: the slugs of listed partners the story says helped (empty if none).`;
  try {
    const r = await env.AI.run(TEXT_MODEL, { messages: [{ role: 'user', content: prompt }], max_tokens: 450 });
    const j = typeof r?.response === 'object' && r.response ? r.response : firstJson(r?.response);
    if (!j) return null;
    const kidSet = new Set(kids.map((k) => k.slug));
    const partnerSet = new Set(partners.map((p) => p.slug));
    return {
      about: ['about', 'mentions', 'unrelated'].includes(j.about) ? j.about : null,
      summary: P.plain(String(j.summary || '')).replace(/\s*[—–]\s*/g, ', ').replace(/!/g, '.').slice(0, 300),
      category: P.CATEGORIES.includes(j.category) ? j.category : null,
      kids: (Array.isArray(j.kids) ? j.kids : []).filter((s) => kidSet.has(s)),
      partners: (Array.isArray(j.partners) ? j.partners : []).filter((s) => partnerSet.has(s)),
    };
  } catch { return null; }
}

/** The words names are looked for in: headline, then the article (its description only when the article doesn't already start with it) */
function corpus(title, description, text) {
  const d = P.plain(description);
  const repeats = d && text && P.plain(text).includes(d.slice(0, 40));
  return [P.plain(title), repeats ? '' : d, text || ''].filter(Boolean).join('\n');
}
/** Kids and partners for a story, from candidates (AI confirms; without AI only the unmistakable ones) */
function pickPeople(cands, ai) {
  // A name that's also a place or a word ("Georgia", "Peter") counts only when Workers AI agrees and it comes up twice
  const usable = cands.kids.filter((k) => !k.ambiguous || (ai && k.count >= 2));
  const kids = ai
    ? usable.filter((k) => ai.kids.includes(k.slug))
    : usable.filter((k) => !k.ambiguous && k.count >= 2 && cands.kids.filter((o) => o.matched.some((m) => k.matched.includes(m))).length === 1);
  const partners = ai ? ai.partners : cands.partners.filter((p) => p.name.split(/\s+/).length >= 2).map((p) => p.slug);
  return { kids: kids.map((k) => k.slug), partners };
}

// ── Finding ──────────────────────────────────────────────────────────
async function insertMentions(DB, items, now) {
  let added = 0;
  for (const it of items) {
    const key = it.url ? P.urlKey(it.url) : null;
    const r = await DB.prepare(`INSERT INTO press_mentions (id, key, provider, query, url, link, title, source, source_url, published, description, video_id, state, stage, found_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?) ON CONFLICT(id) DO NOTHING`)
      .bind(it.id, key, it.provider, it.query || '', it.url || null, it.link || null, clip(it.title, 300), clip(it.source, 120), it.sourceUrl || null, it.published || null, clip(it.description, 600), it.videoId || null, it.url ? 'match' : 'resolve', iso(now), iso(now)).run();
    added += r?.meta?.changes ? 1 : 0;
  }
  return added;
}
export async function scan(env, provider, { now = Date.now(), fetchImpl = fetch } = {}) {
  const settings = await readSettings(env.DB);
  const runs = provider === 'youtube'
    ? [...settings.channels.map((c) => () => youTubeChannel(c, { fetchImpl })), () => youTubeSearch('"Sunshine on a Ranney Day"', { fetchImpl })]
    : settings.queries.map((q) => () => (provider === 'google' ? googleNews(q, { fetchImpl }) : bingNews(q, { fetchImpl })));
  const results = await Promise.all(runs.map((f) => f()));
  const items = results.flatMap((r) => r.items);
  const errors = results.map((r) => r.error).filter(Boolean);
  const added = await insertMentions(env.DB, items, now);
  return { at: iso(now), found: items.length, added, error: errors.length === results.length && results.length ? errors[0] : null, partial: errors.length && errors.length < results.length ? errors.length : 0 };
}

// ── Each found article, one step at a time ───────────────────────────
async function context(DB) {
  const [stories, outlets, kids, partners] = await Promise.all([loadAll(DB, 'press'), loadAll(DB, 'medialogos'), loadAll(DB, 'kids'), loadAll(DB, 'partners')]);
  return { stories, outlets, kids: kids.map((k) => k.data), partners: partners.map((p) => p.data) };
}
/** A story already on the site that's this article */
function storyFor(ctx, { url, title, source }) {
  const key = P.urlKey(url);
  const outlet = P.matchOutlet(ctx.outlets.map((o) => o.data), { name: source, url });
  const syndicated = P.AGGREGATORS.test(P.hostOf(url));
  return ctx.stories.find((s) => {
    const d = s.data;
    if (key && [P.urlKey(d.url), P.urlKey(P.archivedOriginal(d.archiveUrl))].includes(key)) return true;
    if (!P.sameHeadline(P.storyTitle(d), title)) return false;
    // A copy on MSN or Yahoo is the same story whoever ran it first
    return syndicated || (outlet ? d.outletLogo === outlet.slug : P.outletKey(d.outlet) === P.outletKey(source));
  }) || null;
}
const setMention = (DB, id, fields) => {
  const keys = Object.keys(fields);
  return DB.prepare(`UPDATE press_mentions SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).bind(...keys.map((k) => fields[k]), iso(), id).run();
};

/**
 * Move one found article along: resolve → match → read → judge → picture → file.
 * `force` (a person pressed Add) files it whatever the judgement.
 */
export async function stepMention(env, m, { fetchImpl = fetch, ctx = null, force = false, user = PRESS_USER, gate = OPEN_GATE } = {}) {
  const { DB } = env;
  const data = parse(m.data, {});
  const stage = m.stage || 'resolve';
  if (['read', 'picture'].includes(stage)) {
    const tries = (data.tries?.[stage] || 0) + 1;
    if (tries > MAX_TRIES && !force) {
      // The outlet never answers in time: on with what's known (the title and the outlet's name)
      await setMention(DB, m.id, { stage: stage === 'read' ? 'judge' : 'file', data: JSON.stringify({ ...data, read: data.read || 'timed out' }) });
      return { next: stage === 'read' ? 'judge' : 'file' };
    }
    data.tries = { ...(data.tries || {}), [stage]: tries };
    await setMention(DB, m.id, { data: JSON.stringify(data) });
  }
  if (stage === 'resolve') {
    const url = m.url || (m.provider === 'google' ? await decodeGoogleLink(m.link, { fetchImpl }) : m.link);
    if (!url) {
      const tries = (m.tries || 0) + 1;
      await setMention(DB, m.id, tries >= 3 ? { tries, state: 'failed', reason: 'Couldn’t find the outlet’s own address for it' } : { tries });
      return { done: tries >= 3 };
    }
    await setMention(DB, m.id, { url, key: P.urlKey(url), stage: 'match' });
    return { next: 'match' };
  }
  ctx = ctx || await context(DB);
  if (stage === 'match') {
    const notPress = P.notPressReason(m.url, m.title);
    if (notPress && !force) { await setMention(DB, m.id, { state: 'unrelated', reason: notPress }); return { done: true }; }
    const onSite = storyFor(ctx, { url: m.url, title: m.title, source: m.source });
    if (onSite && !force) { await setMention(DB, m.id, { state: 'duplicate', reason: 'Already on the publicity page', story: onSite.slug }); return { done: true }; }
    const twin = await DB.prepare("SELECT id, state, story FROM press_mentions WHERE key = ? AND id != ? AND state != 'new' LIMIT 1").bind(P.urlKey(m.url), m.id).first();
    if (twin && !force) { await setMention(DB, m.id, { state: 'duplicate', reason: 'Found twice', story: twin.story || null }); return { done: true }; }
    // The same headline found elsewhere a moment ago (Google and Bing, or a copy on MSN)
    const recent = ((await DB.prepare("SELECT id, title, url, story, state FROM press_mentions WHERE id != ? AND state IN ('filed', 'review', 'duplicate') ORDER BY found_at DESC LIMIT 300").bind(m.id).all()).results || [])
      .find((x) => P.sameHeadline(x.title, m.title) && (P.AGGREGATORS.test(P.hostOf(m.url)) || P.AGGREGATORS.test(P.hostOf(x.url)) || P.hostOf(x.url) === P.hostOf(m.url)));
    if (recent && !force) { await setMention(DB, m.id, { state: 'duplicate', reason: 'Found twice', story: recent.story || null }); return { done: true }; }
    await setMention(DB, m.id, { stage: 'read' });
    return { next: 'read' };
  }
  if (stage === 'read') {
    const r = await readPage(m.url, { fetchImpl });
    data.page = r.ok ? { ...r.page, finalUrl: r.finalUrl, text: clip(r.page.text, 6000) } : null;
    data.read = r.ok ? 'ok' : r.blocked ? 'blocked' : (r.error || `HTTP ${r.status}`);
    await setMention(DB, m.id, { stage: 'judge', data: JSON.stringify(data) });
    return { next: 'judge' };
  }
  if (stage === 'judge') {
    const page = data.page || {};
    // A YouTube video's outlet is its channel ("YouTube" is only the site's name)
    const video = m.provider === 'youtube';
    const outletName = video ? m.source : (page.siteName || m.source);
    const title = P.cleanTitle(page.title || m.title, outletName) || m.title;
    const text = page.text || '';
    const all = corpus(title, page.description || m.description, text);
    const rel = P.relevance({ title, description: page.description || m.description, text });
    const outlets = ctx.outlets.map((o) => o.data);
    const outletRec = P.matchOutlet(outlets, video ? { name: outletName } : { name: outletName, url: m.url, source: m.source_url })
      || (!video && m.source && m.source !== outletName ? P.matchOutlet(outlets, { name: m.source }) : null);
    const date = dateOnly(page.published) || dateOnly(m.published) || iso().slice(0, 10);
    const year = Number(date.slice(0, 4));
    const cands = { kids: P.kidCandidates(all, ctx.kids, year), partners: P.partnerCandidates(all, ctx.partners) };
    const ai = await judgeWithAi(env, { title, outlet: outletRec?.name || outletName, date, text, description: page.description || m.description, kids: cands.kids, partners: cands.partners });
    const people = pickPeople(cands, ai);
    const about = ai?.about || (rel.strong ? 'about' : rel.any ? 'mentions' : 'unrelated');
    data.judge = { about, rel, ai: !!ai, title, date, summary: ai?.summary || '', category: ai?.category || null, ...people, outlet: outletRec?.slug || null };
    // Filed by itself only from a known outlet or a news site: a YouTube video from
    // someone's own channel, or a copy on MSN, waits for a person
    const syndicated = P.AGGREGATORS.test(P.hostOf(m.url));
    // A station on the watch list is a news outlet even before it has a record
    const unknownVideo = video && !outletRec && !String(m.query || '').startsWith('channel:');
    let fields;
    if (force || (about === 'about' && (rel.any || ai) && !syndicated && !unknownVideo)) fields = { stage: 'picture' };
    else if (about === 'unrelated' && !rel.strong) fields = { state: 'unrelated', reason: ai ? 'Workers AI says it’s about someone else' : 'SOARD isn’t named in it' };
    else fields = { state: 'review', reason: syndicated ? `A copy on ${m.source || P.hostOf(m.url)}: the original outlet’s own link is better` : unknownVideo ? `A video from ${m.source || 'a YouTube channel'}, not a news outlet` : data.read !== 'ok' ? 'The outlet wouldn’t show the article, so nobody could check it' : about === 'mentions' ? 'SOARD only comes up in passing' : 'Not clearly about SOARD' };
    await setMention(DB, m.id, { ...fields, data: JSON.stringify(data) });
    return fields.state ? { done: true, review: fields.state === 'review' } : { next: 'picture' };
  }
  if (stage === 'picture') {
    const page = data.page || {};
    if (!m.video_id && page.image && !data.imageId) {
      const slugBase = P.slugify(`${data.judge?.outlet || m.source || 'press'} ${data.judge?.date || ''}`) || 'press';
      const r = await saveImage(env, page.image, `press/${slugBase}`, { fetchImpl, referer: page.finalUrl || m.url });
      if (r.imageId) data.imageId = r.imageId; else data.imageError = r.error;
    }
    await setMention(DB, m.id, { stage: 'file', data: JSON.stringify(data) });
    return { next: 'file' };
  }
  if (stage === 'file') return fileStory(env, m, data, ctx, { fetchImpl, user, gate });
  return { done: true };
}

/** File a found article as a story (and its outlet, if it's a new one) */
async function fileStory(env, m, data, ctx, { fetchImpl, user, gate = OPEN_GATE }) {
  const { DB } = env;
  const page = data.page || {};
  const j = data.judge || {};
  const video = m.provider === 'youtube';
  let outlet = ctx.outlets.find((o) => o.slug === j.outlet)?.data || null;
  if (!outlet) {
    const name = P.cleanOutletName(video ? m.source : (page.siteName || m.source || P.hostOf(m.url)));
    outlet = P.matchOutlet(ctx.outlets.map((o) => o.data), video ? { name } : { name, url: m.url, source: m.source_url });
    if (!outlet) {
      const slug = P.dedupeSlug(P.slugify(name) || 'outlet', ctx.outlets.map((o) => o.slug));
      outlet = P.outletRecord({ name, slug, logo: '', order: 0, strip: false, kind: j.category || P.guessKind(name, video ? '' : P.hostOf(m.url)), domains: video ? [] : [P.hostOf(m.url)] });
      if (await writeRecord(env, 'medialogos', slug, null, outlet, { message: `Press monitor: new outlet ${name}`, user })) {
        await logChange(DB, { kind: 'outlet-created', slug, label: `New outlet: ${name}`, after: outlet });
        ctx.outlets.push({ slug, raw: JSON.stringify(outlet), data: outlet });
      }
    }
  }
  const story = P.storyRecord({
    outlet: outlet.name, outletLogo: outlet.slug, category: j.category || outlet.kind || P.guessKind(outlet.name, P.hostOf(m.url)),
    title: P.cleanTitle(j.title || m.title, outlet.name), date: j.date, url: safeUrl(page.canonical)?.toString() && P.hostOf(page.canonical) === P.hostOf(page.finalUrl || m.url) ? page.canonical : (page.finalUrl || m.url),
    excerpt: j.summary || clip(P.plain(page.description || m.description), P.SUMMARY_MAX), image: data.imageId || null,
    videoId: m.video_id || null, kids: j.kids || [], partners: j.partners || [], featured: false, order: 0,
  });
  const slug = P.storySlug(story, ctx.stories.map((s) => s.slug));
  if (!(await writeRecord(env, 'press', slug, null, story, { message: `Press monitor: ${story.title}`, user }))) return { retry: true };
  ctx.stories.push({ slug, raw: JSON.stringify(story), data: { ...story, slug } });
  await logChange(DB, { kind: 'filed', slug, label: `Added: ${story.title}`, after: story, extra: { mention: m.id, by: user } });
  await setMention(DB, m.id, { state: 'filed', story: slug, stage: 'done', decided_at: iso(), decided_by: user === PRESS_USER ? null : user });
  await DB.prepare('INSERT INTO press_links (slug, url, status, checked_at, saved_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(slug) DO UPDATE SET url = excluded.url')
    .bind(slug, story.url, 'ok', iso(), iso()).run();
  if (!story.videoId) { const sv = await gate.save(story.url, fetchImpl); if (sv.skipped) await DB.prepare('UPDATE press_links SET saved_at = NULL WHERE slug = ?').bind(slug).run(); }
  return { done: true, filed: slug, story };
}

/**
 * Fold copies of a story into the one kept (what only they had fills its
 * gaps; a 1 January placeholder date gives way to a real one), delete the
 * copies (History keeps them), and log it so Undo brings them back.
 */
async function mergeRecords(env, keepRec, others, { user = PRESS_USER, message } = {}) {
  const keep = { ...keepRec.data, slug: keepRec.slug };
  const folded = P.foldInto(keep, others.map((r) => ({ ...r.data, slug: r.slug })));
  if (/-01-01$/.test(folded.date || '')) { const real = others.map((r) => r.data.date).find((d) => d && d.slice(0, 4) === folded.date.slice(0, 4) && !/-01-01$/.test(d)); if (real) folded.date = real; }
  const next = P.storyRecord(folded);
  const diff = fieldDiff(keepRec.data, next);
  if (diff && !(await writeRecord(env, 'press', keepRec.slug, keepRec.raw, next, { message, user }))) return { ok: false };
  const removed = [];
  for (const o of others) {
    if (!(await deleteRecord(env, 'press', o.slug, o.raw, { message, user }))) continue;
    removed.push({ slug: o.slug, data: parse(o.raw, {}) });
    await env.DB.prepare('DELETE FROM press_links WHERE slug = ?').bind(o.slug).run();
  }
  const r = await env.DB.prepare('INSERT INTO press_log (at, kind, slug, label, before, after, extra) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(iso(), 'merge', keepRec.slug, `Merged ${removed.length + 1} copies of “${P.storyTitle(keep)}”${user === PRESS_USER ? '' : ` (${user})`}`, diff ? JSON.stringify(diff.before) : null, diff ? JSON.stringify(diff.after) : null, JSON.stringify({ removed })).run();
  return { ok: true, removed, logId: r?.meta?.last_row_id ?? null };
}
/** A person merged a copy into the story they're keeping */
export async function mergeStories(env, keepSlug, dropSlug, user) {
  const { DB } = env;
  if (!keepSlug || !dropSlug || keepSlug === dropSlug) return { success: false, error: 'Pick two different stories' };
  const [k, d] = await Promise.all([loadOne(DB, 'press', keepSlug), loadOne(DB, 'press', dropSlug)]);
  if (!k || !d) return { success: false, error: 'One of them isn’t there any more. Reload.' };
  const r = await mergeRecords(env, { ...k, slug: keepSlug }, [{ ...d, slug: dropSlug }], { user, message: `Merged a copy of ${k.data.title}` });
  if (!r.ok || !r.removed.length) return { success: false, error: 'It changed meanwhile. Reload and try again.' };
  const id = r.logId ?? (await DB.prepare("SELECT max(id) AS id FROM press_log WHERE kind = 'merge' AND slug = ?").bind(keepSlug).first('id'));
  return { success: true, logId: id };
}
/** The count the sidebar and the Dashboard show */
export async function summary(env) {
  await ensurePressTables(env.DB);
  const review = await env.DB.prepare("SELECT count(*) AS n FROM press_mentions WHERE state = 'review'").first('n');
  return { review: review || 0 };
}

// ── The tidy (once) ──────────────────────────────────────────────────
const STORY_STAGES = ['decode', 'read', 'judge', 'picture', 'save'];
/** Stories with their Google News links swapped for the outlet's own (found in the tidy's first phase) */
async function withDecodedLinks(DB, stories) {
  const rows = (await DB.prepare("SELECT slug, data FROM press_links WHERE data LIKE '%\"url\":%'").all()).results || [];
  const decoded = new Map(rows.map((r) => [r.slug, parse(r.data, {}).url]).filter(([, u]) => u));
  return stories.map((s) => (decoded.has(s.slug) && P.googleLink(s.data.url) ? { ...s, data: { ...s.data, url: decoded.get(s.slug) } } : s));
}
/**
 * One step of the tidy. Phases: Google News links decoded → outlets →
 * duplicates → each story (read, judge, picture, save) → done. Decoding comes
 * first so every story's real website helps match its outlet and its copies.
 * Returns { did, done }.
 */
export async function tidyStep(env, state, { fetchImpl = fetch, gate = OPEN_GATE } = {}) {
  const { DB } = env;
  const t = state.tidy;
  t.phase ||= 'decode';
  t.counts ||= {};
  const bump = (k, n = 1) => { t.counts[k] = (t.counts[k] || 0) + n; };
  if (t.phase === 'decode') {
    const stories = await loadAll(DB, 'press');
    const done = new Set(((await DB.prepare("SELECT slug FROM press_links WHERE data LIKE '%\"url\":%' OR data LIKE '%decodeFailed%'").all()).results || []).map((r) => r.slug));
    const next = stories.find((st) => P.googleLink(st.data.url) && !done.has(st.slug));
    if (!next) { t.phase = 'outlets'; return { did: 'decoding done' }; }
    const real = await decodeGoogleLink(next.data.url, { fetchImpl });
    const link = await DB.prepare('SELECT data FROM press_links WHERE slug = ?').bind(next.slug).first();
    const d = { ...parse(link?.data, {}), ...(real ? { url: real } : { decodeFailed: true }) };
    await DB.prepare('INSERT INTO press_links (slug, url, data) VALUES (?, ?, ?) ON CONFLICT(slug) DO UPDATE SET data = excluded.data').bind(next.slug, next.data.url, JSON.stringify(d)).run();
    return { did: `decoded ${next.slug}${real ? '' : ' (failed)'}` };
  }
  if (t.phase === 'outlets') {
    const [stories, outlets] = await Promise.all([loadAll(DB, 'press').then((x) => withDecodedLinks(DB, x)), loadAll(DB, 'medialogos')]);
    const plan = P.planOutletTidy(stories.map((s) => s.data), outlets.map((o) => o.data));
    // A few per step: each write is ~7 queries (record, audit, history) and D1 counts them per run
    const work = [...plan.create.map((o) => ['create', o]), ...plan.update.map((o) => ['update', o])].slice(0, 8);
    for (const [kind, o] of work) {
      const cur = outlets.find((x) => x.slug === o.slug);
      if (kind === 'create') {
        if (await writeRecord(env, 'medialogos', o.slug, null, o, { message: `Press tidy: outlet ${o.name}` })) { bump('outletsCreated'); await logChange(DB, { kind: 'outlet-created', slug: o.slug, label: `New outlet: ${o.name}`, after: o }); }
      } else if (cur) {
        const next = { ...cur.data, ...o };
        delete next.slug;
        const diff = fieldDiff(cur.data, { ...next, slug: o.slug });
        if (diff && await writeRecord(env, 'medialogos', o.slug, cur.raw, next, { message: `Press tidy: ${o.name}'s other spellings and websites` })) {
          bump('outletsUpdated');
          await logChange(DB, { kind: 'outlet', slug: o.slug, label: `${o.name}: other spellings and websites`, ...diff });
        }
      }
    }
    if (work.length) return { did: `outlets ${work.length}` };
    t.phase = 'duplicates';
    return { did: 'outlets done' };
  }
  if (t.phase === 'duplicates') {
    const stories = await loadAll(DB, 'press');
    const group = P.duplicateGroups((await withDecodedLinks(DB, stories)).map((s) => s.data))[0];
    if (!group) { t.phase = 'stories'; return { did: 'duplicates done' }; }
    const recs = group.map((slug) => stories.find((s) => s.slug === slug));
    const keep = P.pickKeeper(recs.map((r) => r.data));
    const keepRec = recs.find((r) => r.slug === keep.slug);
    const r = await mergeRecords(env, keepRec, recs.filter((x) => x.slug !== keep.slug), { message: `Press tidy: merged copies of ${keep.title}` });
    if (!r.ok) return { did: 'conflict' };
    bump('duplicatesRemoved', r.removed.length);
    return { did: `merged ${group.join(', ')}` };
  }
  if (t.phase === 'stories') {
    const row = await DB.prepare(`SELECT p.slug FROM press p LEFT JOIN press_links l ON l.slug = p.slug WHERE l.enriched_at IS NULL ORDER BY p.slug LIMIT 1`).first();
    if (!row) { t.phase = 'done'; t.doneAt = iso(); t.version = TIDY_VERSION; return { did: 'tidy done', done: true }; }
    return storyStep(env, row.slug, { fetchImpl, tidy: t, gate });
  }
  return { did: null };
}

/**
 * One step of looking after a saved story (the tidy's per-story pass):
 * decode a Google News link, read the article (or its archived copy),
 * judge (kids, partners, a summary if it needs one), find a picture, save.
 * Only empty or broken fields are filled; what a person wrote stays.
 */
export async function storyStep(env, slug, { fetchImpl = fetch, tidy = { counts: {} }, gate = OPEN_GATE } = {}) {
  const { DB } = env;
  const bump = (k, n = 1) => { tidy.counts ||= {}; tidy.counts[k] = (tidy.counts[k] || 0) + n; };
  const rec = await loadOne(DB, 'press', slug);
  if (!rec) { await DB.prepare('DELETE FROM press_links WHERE slug = ?').bind(slug).run(); return { did: 'gone' }; }
  let link = await DB.prepare('SELECT * FROM press_links WHERE slug = ?').bind(slug).first();
  if (!link) { await DB.prepare('INSERT INTO press_links (slug, url, data) VALUES (?, ?, ?)').bind(slug, rec.data.url || null, '{}').run(); link = { slug, data: '{}' }; }
  const data = parse(link.data, {});
  const stage = STORY_STAGES.includes(data.stage) ? data.stage : 'decode';
  const save = (fields) => { const keys = Object.keys(fields); return DB.prepare(`UPDATE press_links SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE slug = ?`).bind(...keys.map((k) => fields[k]), slug).run(); };
  // A step that keeps getting cut short (a site that never answers) is skipped, not retried forever
  if (data.tries?.[stage] >= MAX_TRIES && stage !== 'save') {
    data.stage = STORY_STAGES[STORY_STAGES.indexOf(stage) + 1];
    await save({ data: JSON.stringify(data) });
    return { did: `${slug} skipped ${stage}` };
  }
  if (stage !== 'save') { data.tries = { ...(data.tries || {}), [stage]: (data.tries?.[stage] || 0) + 1 }; await save({ data: JSON.stringify(data) }); }
  const s = rec.data;
  if (stage === 'decode') {
    if (P.googleLink(s.url) && !data.url && !data.decodeFailed) { const real = await decodeGoogleLink(s.url, { fetchImpl }); if (real) data.url = real; else data.decodeFailed = true; }
    data.stage = 'read';
    await save({ data: JSON.stringify(data) });
    return { did: `${slug} decode` };
  }
  const url = data.url || s.url;
  if (stage === 'read') {
    if (!url || P.googleLink(url)) { data.stage = 'judge'; await save({ data: JSON.stringify(data) }); return { did: `${slug} no link` }; }
    const r = await readPage(url, { fetchImpl });
    let page = r.ok ? r.page : null;
    const linkFields = { url, checked_at: iso(), http: r.status || 0 };
    if (r.ok) Object.assign(linkFields, { status: 'ok', fails: 0, first_failed_at: null });
    else if ([404, 410].includes(r.status) || r.unreachable) Object.assign(linkFields, { status: 'failing', fails: (link.fails || 0) + 1, first_failed_at: link.first_failed_at || iso() });
    else linkFields.status = 'blocked';
    // The outlet won't show it (or it's gone): read the archived copy instead. A
    // working story's copy is looked up later, one at a time (the archive job)
    let snap = link.archive_url || null;
    if (!page && !snap) {
      const a = await gate.lookup(url, s.date, fetchImpl);
      if (a.url) snap = a.url;
      if (a.url || a.none) Object.assign(linkFields, { archive_url: snap, archive_checked_at: iso() });
    }
    if (!page && snap) { const a = await readPage(archiveRaw(snap), { fetchImpl }); if (a.ok) { page = a.page; data.fromArchive = true; } }
    data.page = page ? { title: page.title, siteName: page.siteName, description: page.description, image: page.image, published: page.published, videos: (page.videos || []).slice(0, 3), text: clip(page.text, 5000) } : null;
    data.stage = 'judge';
    await save({ ...linkFields, data: JSON.stringify(data) });
    return { did: `${slug} read ${r.status || r.error || ''}` };
  }
  if (stage === 'judge') {
    const page = data.page || {};
    const needsPeople = !s.kids && !s.partners;
    const needsSummary = !P.plain(s.excerpt) || P.junkSummary(s) || P.hasMarkup(s.excerpt);
    if (page.text && (needsPeople || needsSummary)) {
      const [kids, partners] = await Promise.all([loadAll(DB, 'kids'), loadAll(DB, 'partners')]);
      const all = corpus(P.storyTitle(s), page.description, page.text);
      const cands = needsPeople ? { kids: P.kidCandidates(all, kids.map((k) => k.data), P.yearOf(s)), partners: P.partnerCandidates(all, partners.map((p) => p.data)) } : { kids: [], partners: [] };
      const ai = (cands.kids.length || cands.partners.length || needsSummary)
        ? await judgeWithAi(env, { title: P.storyTitle(s), outlet: s.outlet, date: s.date, text: page.text, description: page.description, kids: cands.kids, partners: cands.partners, wantSummary: needsSummary })
        : null;
      if (needsPeople) Object.assign(data, pickPeople(cands, ai));
      if (needsSummary) data.summary = (ai?.summary && ai.about !== 'unrelated' ? ai.summary : '') || clip(P.plain(page.description), P.SUMMARY_MAX) || '';
    } else if (needsSummary && !page.text) {
      data.summary = clip(P.plain(page.description), P.SUMMARY_MAX) || '';
    }
    // A video in the article: suggested in the editor, never switched on by itself.
    // The same video on two stories is the site's own player, not this story's
    if (!s.videoId && page.videos?.length) {
      const v = page.videos[0];
      const twin = await DB.prepare('SELECT slug, data FROM press_links WHERE slug != ? AND (data LIKE ? OR data LIKE ?)').bind(slug, `%"suggestVideo":"${v}"%`, `%"siteVideo":"${v}"%`).first();
      if (twin) {
        const td = parse(twin.data, {});
        if (td.suggestVideo === v) { delete td.suggestVideo; td.siteVideo = v; await DB.prepare('UPDATE press_links SET data = ? WHERE slug = ?').bind(JSON.stringify(td), twin.slug).run(); }
        data.siteVideo = v;
      } else data.suggestVideo = v;
    }
    data.stage = 'picture';
    await save({ data: JSON.stringify(data) });
    return { did: `${slug} judge` };
  }
  if (stage === 'picture') {
    const page = data.page || {};
    if (!s.image && page.image) {
      // The same picture on two stories is the site's default share image, not this story's
      const twin = await DB.prepare('SELECT slug FROM press_links WHERE slug != ? AND data LIKE ?').bind(slug, `%"imageSrc":${JSON.stringify(page.image)}%`).first();
      if (twin) data.genericImage = true;
      else {
        const outlets = await loadAll(DB, 'medialogos');
        const hasLogo = !!outlets.find((o) => o.slug === s.outletLogo)?.data?.logo;
        const r = await saveImage(env, page.image, `press/${slug}`, { fetchImpl, referer: url });
        data.imageSrc = page.image;
        // A featured card that shows its outlet's logo keeps it: the picture is offered instead
        if (r.imageId) { if (s.featured && hasLogo) data.suggestImage = r.imageId; else data.image = r.imageId; }
      }
    }
    data.stage = 'save';
    await save({ data: JSON.stringify(data) });
    return { did: `${slug} picture` };
  }
  // save: everything found, on top of the story as it is now
  const outlets = (await loadAll(DB, 'medialogos')).map((o) => o.data);
  const outlet = outlets.find((o) => o.slug === s.outletLogo) || P.matchOutlet(outlets, { name: s.outlet, url });
  const next = { ...s };
  if (outlet) { next.outletLogo = outlet.slug; next.outlet = outlet.name; }
  next.title = P.storyTitle({ ...s, outletAliases: outlet ? [outlet.name, ...(outlet.aliases || [])] : [] });
  if (data.url && P.googleLink(s.url)) next.url = data.url;
  if (data.image && !s.image) next.image = data.image;
  if (data.summary && (!P.plain(s.excerpt) || P.junkSummary(s) || P.hasMarkup(s.excerpt))) next.excerpt = data.summary;
  else if (P.hasMarkup(s.excerpt)) next.excerpt = P.plain(s.excerpt);
  if (!s.kids && !s.partners) {
    if (data.kids?.length) next.kids = data.kids;
    if (data.partners?.length) next.partners = data.partners;
  }
  const clean = P.storyRecord(next);
  const diff = fieldDiff(s, clean);
  if (diff) {
    if (!(await writeRecord(env, 'press', slug, rec.raw, clean, { message: `Press tidy: ${clean.title}` }))) return { did: `${slug} changed meanwhile` };
    const what = [];
    if ('outletLogo' in diff.after || 'outlet' in diff.after) { what.push('outlet'); bump('storiesLinked'); }
    if ('title' in diff.after) { what.push('headline'); bump('titlesCleaned'); }
    if ('url' in diff.after) { what.push('the outlet’s own link'); bump('googleLinksFixed'); }
    if ('image' in diff.after) { what.push('picture'); bump('pictures'); }
    if ('excerpt' in diff.after) { what.push('summary'); bump('summaries'); }
    if ('kids' in diff.after) { what.push(`${clean.kids.length === 1 ? 'a kid' : `${clean.kids.length} kids`}`); bump('kidLinks', clean.kids.length); }
    if ('partners' in diff.after) { what.push(`${clean.partners.length === 1 ? 'a partner' : `${clean.partners.length} partners`}`); bump('partnerLinks', clean.partners.length); }
    await logChange(DB, { kind: 'story', slug, label: `${clip(clean.title, 70)}: ${what.join(', ')}`, ...diff });
  }
  const keep = {};
  if (data.suggestVideo) keep.suggestVideo = data.suggestVideo;
  if (data.suggestImage) keep.suggestImage = data.suggestImage;
  if (data.siteVideo) keep.siteVideo = data.siteVideo;
  if (data.imageSrc) keep.imageSrc = data.imageSrc;
  if (data.fromArchive) keep.fromArchive = true;
  await save({ enriched_at: iso(), url: clean.url || null, data: JSON.stringify(keep) });
  return { did: `${slug} saved${diff ? '' : ' (nothing to change)'}` };
}

// ── Weekly link check ────────────────────────────────────────────────
/** Check one story's link; a story gone on two checks days apart links to its archived copy */
export async function checkStory(env, slug, { fetchImpl = fetch, now = Date.now(), gate = OPEN_GATE } = {}) {
  const { DB } = env;
  const rec = await loadOne(DB, 'press', slug);
  if (!rec?.data?.url || P.googleLink(rec.data.url)) return { slug, status: 'skipped' };
  const s = rec.data;
  const link = (await DB.prepare('SELECT * FROM press_links WHERE slug = ?').bind(slug).first()) || {};
  const r = await checkLink(s.url, { fetchImpl });
  const failing = r.status === 'gone' || r.status === 'moved';
  const firstFailed = failing ? (link.first_failed_at || iso(now)) : null;
  const fails = failing ? (link.fails || 0) + 1 : 0;
  let archive = link.archive_url || null;
  let archiveChecked = link.archive_checked_at || null;
  if (!archive && (failing || !archiveChecked || now - Date.parse(archiveChecked) > 30 * 24 * H)) {
    const a = await gate.lookup(s.url, s.date, fetchImpl);
    if (a.url || a.none) { archiveChecked = iso(now); archive = a.url || null; }
  }
  // A working story with no saved copy yet: ask for one (a later lookup finds it)
  if (r.status === 'ok' && !archive && (!link.saved_at || now - Date.parse(link.saved_at) > 30 * 24 * H)) { const sv = await gate.save(s.url, fetchImpl); if (!sv.skipped) link.saved_at = iso(now); }
  // Gone on two checks days apart, and the Archive asked (so a copy isn't missed for being busy)
  const confirmed = failing && fails >= 2 && now - Date.parse(firstFailed) >= GONE_CONFIRM_MS && !!(archive || archiveChecked);
  await DB.prepare(`INSERT INTO press_links (slug, url, status, http, fails, first_failed_at, checked_at, archive_url, archive_checked_at, saved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(slug) DO UPDATE SET url = excluded.url, status = excluded.status, http = excluded.http, fails = excluded.fails, first_failed_at = excluded.first_failed_at,
      checked_at = excluded.checked_at, archive_url = excluded.archive_url, archive_checked_at = excluded.archive_checked_at, saved_at = excluded.saved_at`)
    .bind(slug, s.url, confirmed ? 'gone' : failing ? 'failing' : r.status, r.http || 0, fails, firstFailed, iso(now), archive, archiveChecked, link.saved_at || null).run();
  let changed = null;
  if (confirmed && !s.linkGone) {
    const next = P.storyRecord({ ...s, linkGone: iso(now).slice(0, 10), archiveUrl: archive || s.archiveUrl || null });
    if (await writeRecord(env, 'press', slug, rec.raw, next, { message: `Press monitor: ${s.title} was taken down` })) {
      const diff = fieldDiff(s, next);
      await logChange(DB, { kind: 'link', slug, label: `${clip(s.title, 70)}: taken down${next.archiveUrl ? ', links to the saved copy' : ', shown without a link'}`, ...diff });
      changed = { gone: true, archived: !!next.archiveUrl, title: s.title, outlet: s.outlet };
    }
  } else if (r.status === 'ok' && s.linkGone) {
    const next = P.storyRecord({ ...s, linkGone: null });
    if (await writeRecord(env, 'press', slug, rec.raw, next, { message: `Press monitor: ${s.title} works again` })) {
      await logChange(DB, { kind: 'link', slug, label: `${clip(s.title, 70)}: working again`, ...fieldDiff(s, next) });
      changed = { gone: false, title: s.title, outlet: s.outlet };
    }
  }
  return { slug, status: r.status, confirmed, changed };
}

// ── Publishing and telling people ────────────────────────────────────
async function deploy(env, state, now) {
  const hook = HOOK_ENV_VARS.map((k) => env[k]).find(Boolean);
  if (!hook) return false;
  try { const res = await fetch(hook, { method: 'POST' }); if (!res.ok) return false; } catch { return false; }
  state.lastDeployAt = iso(now);
  state.deployPending = false;
  await logAudit(env.DB, { userEmail: PRESS_USER, action: 'deployed', entityType: 'site', entityName: 'Press monitor' });
  return true;
}
const adminLink = (hash) => `${SITE}/admin/#${hash}`;
const fmtDate = (d) => { const t = Date.parse(`${d}T12:00:00Z`); return Number.isFinite(t) ? new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : ''; };
/** Post a card (the look every site alert shares): new coverage is good news, the rest needs attention */
async function tell(env, card, kind = 'attention') { try { await slackPost(env, slackCard({ footer: 'Press monitor', ...card }), { kind }); } catch { /* Slack is a nicety */ } }
const autoPublishes = (env) => !!(env.CF_PAGES_DEPLOY_HOOK || env.CF_DEPLOY_HOOK || env.DEPLOY_HOOK_URL);
async function namesOf(DB, table, slugs) {
  if (!slugs?.length) return '';
  const rows = (await DB.prepare(`SELECT slug, data FROM ${table} WHERE slug IN (${slugs.map(() => '?').join(', ')})`).bind(...slugs).all()).results || [];
  return rows.map((r) => parse(r.data, {}).name || r.slug).join(', ');
}

/** A story whose archived copy hasn't been looked for (or not for a month, when there wasn't one) */
async function nextForArchive(DB, now) {
  const r = await DB.prepare(`SELECT l.slug, l.url, p.date FROM press_links l JOIN press p ON p.slug = l.slug
    WHERE l.archive_url IS NULL AND l.url IS NOT NULL AND l.url NOT LIKE '%news.google.com%' AND l.url NOT LIKE '%youtube.com%'
      AND (l.archive_checked_at IS NULL OR l.archive_checked_at < ?)
    ORDER BY (l.archive_checked_at IS NOT NULL), l.slug LIMIT 1`).bind(iso(now - 30 * 24 * H)).first();
  return r || null;
}

// ── The heartbeat ────────────────────────────────────────────────────
/**
 * What's due, most urgent first: the tidy until it's done, a scan per
 * source when its time comes, found articles one step at a time, the weekly
 * link check, then publishing what changed. Never throws.
 */
export async function maybeRunPress(env, { now = Date.now(), fetchImpl = fetch, budgetMs = STEP_WINDOW_MS, archiveGapMs = ARCHIVE_GAP_MS } = {}) {
  try {
    if (!env.DB) return null;
    const { DB } = env;
    await ensurePressTables(DB);
    const state = await readState(DB);
    if (state.busyUntil && Date.parse(state.busyUntil) > now) return null;
    const started = Date.now();
    const log = [];
    const pendingNew = await DB.prepare("SELECT COUNT(*) AS n FROM press_mentions WHERE state = 'new'").first('n');
    const tidyDue = (state.tidy?.version || 0) < TIDY_VERSION;
    const scanDue = Object.keys(SCAN_EVERY).filter((p) => now - Date.parse(state.scans?.[p]?.at || 0) >= SCAN_EVERY[p]);
    const sweepDue = !tidyDue && (state.sweep?.cursor != null || now - Date.parse(state.sweep?.doneAt || 0) >= SWEEP_EVERY);
    const deployDue = state.deployPending && now - Date.parse(state.lastDeployAt || 0) >= DEPLOY_COOLDOWN;
    const gate = archiveGate(state, archiveGapMs);
    const archiveDue = !tidyDue && gate.ready() && !!(await nextForArchive(DB, now));
    if (!tidyDue && !scanDue.length && !pendingNew && !sweepDue && !deployDue && !archiveDue) return null;
    state.busyUntil = iso(now + LOCK_MS);
    await writeState(DB, state);
    const more = () => Date.now() - started < budgetMs;
    try {
      // 1. A scan whose time has come (one source per beat)
      if (scanDue.length) {
        const p = scanDue[0];
        state.scans[p] = await scan(env, p, { now, fetchImpl });
        log.push(`scan ${p}: ${state.scans[p].found} found, ${state.scans[p].added} new`);
        await writeState(DB, state); // kept even if this beat is cut short
      }
      // 2. Found articles, a step at a time
      let ctx = null;
      while (more()) {
        const m = await DB.prepare("SELECT * FROM press_mentions WHERE state = 'new' ORDER BY found_at ASC LIMIT 1").first();
        if (!m) break;
        ctx = m.stage === 'resolve' ? ctx : (ctx || await context(DB));
        const r = await stepMention(env, m, { fetchImpl, ctx, gate });
        log.push(`mention ${m.id}: ${r.next || (r.filed ? `filed ${r.filed}` : r.review ? 'review' : 'done')}`);
        if (r.filed) {
          state.deployPending = true;
          const st = r.story;
          await tell(env, {
            icon: '📰', title: `New coverage: ${st.outlet}`,
            lead: `“${st.title}”\n${autoPublishes(env) ? 'It’s on the publicity page once the site updates. The site publishes itself.' : 'It goes on the publicity page with the next Publish.'}`,
            facts: [['Outlet', st.outlet], ['Published', fmtDate(st.date)], ['Kids', await namesOf(DB, 'kids', st.kids)], ['Partners', await namesOf(DB, 'partners', st.partners)]],
            buttons: [{ label: 'Open in Press', url: adminLink(`press/${r.filed}`) }, { label: 'Read the story', url: st.url }],
          }, 'news');
        }
        if (r.review) {
          const row = await DB.prepare('SELECT title, source, url, link, reason, alerted FROM press_mentions WHERE id = ?').bind(m.id).first();
          if (row && !row.alerted) {
            await DB.prepare('UPDATE press_mentions SET alerted = 1 WHERE id = ?').bind(m.id).run();
            await tell(env, {
              icon: '⚠️', title: `Needs a look: ${row.source || 'possible coverage'}`,
              lead: `“${row.title}”\nThe monitor wasn’t sure it belongs on the publicity page: ${String(row.reason || 'not clearly about SOARD').replace(/^./, (c) => c.toLowerCase())}.`,
              fix: 'Add it to the publicity page, or skip it.',
              buttons: [{ label: 'Open Found coverage', url: adminLink('press/found') }, { label: 'Read it', url: row.url || row.link }],
            });
          }
        }
      }
      // 3. The tidy
      if (tidyDue) {
        state.tidy ||= {};
        state.tidy.startedAt ||= iso(now);
        while (more()) {
          const r = await tidyStep(env, state, { fetchImpl, gate });
          if (r.did) log.push(`tidy: ${r.did}`);
          if (r.done) {
            state.deployPending = true;
            const c = state.tidy.counts || {};
            const parts = [
              c.outletsCreated || c.storiesLinked ? `${c.storiesLinked || 0} stories linked to ${(c.outletsCreated || 0) + (c.outletsUpdated || 0)} outlets` : null,
              c.duplicatesRemoved ? `${c.duplicatesRemoved} duplicates merged` : null,
              c.googleLinksFixed ? `${c.googleLinksFixed} Google News links swapped for the outlet’s own` : null,
              c.titlesCleaned ? `${c.titlesCleaned} headlines tidied` : null,
              c.pictures ? `${c.pictures} pictures added` : null,
              c.summaries ? `${c.summaries} summaries rewritten` : null,
              c.kidLinks ? `${c.kidLinks} kid links` : null,
              c.partnerLinks ? `${c.partnerLinks} partner links` : null,
            ].filter(Boolean);
            await tell(env, {
              icon: '🧹', title: 'Press list tidied',
              lead: `${parts.length ? parts.map((x) => x[0].toUpperCase() + x.slice(1)).join('\n') : 'Nothing needed changing.'}\nEvery change is listed in Press, and each one can be undone.`,
              buttons: [{ label: 'See every change', url: adminLink('press/found') }],
            }, 'news');
            break;
          }
          if (!r.did || r.did === 'conflict') break;
        }
      }
      // 4. The weekly link check
      if (sweepDue && more()) {
        const slugs = ((await DB.prepare('SELECT slug FROM press ORDER BY slug').all()).results || []).map((r) => r.slug);
        state.sweep ||= {};
        if (state.sweep.cursor == null) { state.sweep.cursor = 0; state.sweep.startedAt = iso(now); state.sweep.gone = []; }
        while (more() && state.sweep.cursor < slugs.length) {
          const r = await checkStory(env, slugs[state.sweep.cursor], { fetchImpl, now, gate });
          state.sweep.cursor += 1;
          if (r.changed) { state.deployPending = true; state.sweep.gone.push(r.changed); }
        }
        if (state.sweep.cursor >= slugs.length) {
          const changes = state.sweep.gone || [];
          state.sweep = { doneAt: iso(now), checked: slugs.length, changes: changes.length };
          if (changes.length) await tell(env, {
            icon: '🔗', title: changes.length === 1 ? 'A press link changed' : `${changes.length} press links changed`,
            lead: changes.map((c) => `“${c.title}” (${c.outlet}) ${c.gone ? (c.archived ? 'was taken down, so the site links to a saved copy.' : 'was taken down and has no saved copy, so it’s shown without a link.') : 'works again.'}`).join('\n'),
            buttons: [{ label: 'Open Press', url: adminLink('press') }],
          });
        }
      }
      // 5. Archived copies, one at a time (the Archive turns bursts away)
      if (!tidyDue && more() && gate.ready()) {
        const row = await nextForArchive(DB, now);
        if (row) {
          const a = await gate.lookup(row.url, row.date, fetchImpl);
          if (a.url || a.none) await DB.prepare('UPDATE press_links SET archive_url = ?, archive_checked_at = ? WHERE slug = ?').bind(a.url || null, iso(now), row.slug).run();
          log.push(`archive ${row.slug}: ${a.url ? 'found' : a.none ? 'none yet' : a.limited ? 'asked to slow down' : a.error || 'skipped'}`);
        }
      }
      // 6. Publish what changed (not halfway through the tidy's story pass)
      if (state.deployPending && now - Date.parse(state.lastDeployAt || 0) >= DEPLOY_COOLDOWN && !(tidyDue && state.tidy?.phase === 'stories')) {
        if (await deploy(env, state, now)) log.push('deployed');
      }
    } finally {
      state.busyUntil = null;
      state.lastTick = { at: iso(now), did: log.slice(-12) };
      await writeState(DB, state);
    }
    return log;
  } catch (e) {
    console.error('[press]', e);
    return null;
  }
}

// ── For the admin (press-admin.js) ───────────────────────────────────
export async function overview(env) {
  const { DB } = env;
  await ensurePressTables(DB);
  const [settings, state, mentions, links, log] = await Promise.all([
    readSettings(DB), readState(DB),
    DB.prepare("SELECT id, provider, query, url, link, title, source, published, description, video_id, state, stage, reason, story, found_at, decided_at, decided_by, data FROM press_mentions WHERE state != 'new' OR stage IS NOT NULL ORDER BY found_at DESC LIMIT 400").all(),
    DB.prepare('SELECT slug, url, status, http, fails, first_failed_at, checked_at, archive_url, enriched_at, data FROM press_links').all(),
    DB.prepare('SELECT id, at, kind, slug, label, before, after, extra, undone_at, undone_by FROM press_log ORDER BY id DESC LIMIT 400').all(),
  ]);
  return {
    settings, defaults: { queries: P.DEFAULT_QUERIES, channels: P.DEFAULT_CHANNELS },
    state: { scans: state.scans || {}, sweep: state.sweep || {}, tidy: state.tidy || {}, lastDeployAt: state.lastDeployAt || null, deployPending: !!state.deployPending, lastTick: state.lastTick || null, tidyVersion: TIDY_VERSION },
    mentions: (mentions.results || []).map((m) => {
      const d = parse(m.data, {});
      return { ...m, data: undefined, summary: d.judge?.summary || '', about: d.judge?.about || null, image: d.imageId || null, outletGuess: d.page?.siteName || null, read: d.read || null };
    }),
    links: Object.fromEntries((links.results || []).map((l) => { const d = parse(l.data, {}); return [l.slug, { status: l.status, http: l.http, fails: l.fails, firstFailedAt: l.first_failed_at, checkedAt: l.checked_at, archiveUrl: l.archive_url, enrichedAt: l.enriched_at, suggestVideo: d.suggestVideo || null, suggestImage: d.suggestImage || null, fromArchive: !!d.fromArchive }]; })),
    log: (log.results || []).map((r) => ({ ...r, before: parse(r.before), after: parse(r.after), extra: parse(r.extra) })),
  };
}

/** Fill a new story from its link: read it, match its outlet, write the summary, save its picture */
export async function fillFromUrl(env, rawUrl, { fetchImpl = fetch } = {}) {
  const { DB } = env;
  let url = String(rawUrl || '').trim();
  if (P.googleLink(url)) url = (await decodeGoogleLink(url, { fetchImpl })) || url;
  if (!safeUrl(url)) return { success: false, error: 'Paste the story’s full web address (starting with https://)' };
  const ctx = await context(DB);
  const vid = P.youTubeId(url);
  const r = await readPage(url, { fetchImpl });
  const page = r.ok ? r.page : {};
  const finalUrl = r.finalUrl || url;
  const siteName = page.siteName || '';
  const outlet = P.matchOutlet(ctx.outlets.map((o) => o.data), { name: siteName, url: finalUrl });
  const title = P.cleanTitle(page.title || '', outlet?.name || siteName);
  const date = dateOnly(page.published);
  const all = corpus(title, page.description, page.text);
  const cands = { kids: P.kidCandidates(all, ctx.kids, Number((date || iso()).slice(0, 4))), partners: P.partnerCandidates(all, ctx.partners) };
  const ai = (page.text || page.description) ? await judgeWithAi(env, { title, outlet: outlet?.name || siteName, date, text: page.text, description: page.description, kids: cands.kids, partners: cands.partners }) : null;
  const people = pickPeople(cands, ai);
  let imageId = null;
  let imageError = null;
  if (!vid && page.image) {
    const res = await saveImage(env, page.image, `press/${P.slugify(`${outlet?.slug || siteName || 'press'} ${date || ''}`) || 'press'}`, { fetchImpl, referer: finalUrl });
    imageId = res.imageId || null;
    imageError = res.error || null;
  }
  const dupe = storyFor(ctx, { url: finalUrl, title, source: outlet?.name || siteName });
  return {
    success: true,
    read: r.ok ? 'ok' : r.blocked ? 'blocked' : 'failed',
    story: {
      url: P.hostOf(page.canonical) === P.hostOf(finalUrl) && page.canonical ? page.canonical : finalUrl,
      title, date, excerpt: ai?.summary || clip(P.plain(page.description), P.SUMMARY_MAX),
      outlet: outlet?.name || P.cleanOutletName(siteName), outletLogo: outlet?.slug || '', category: ai?.category || outlet?.kind || P.guessKind(siteName, P.hostOf(finalUrl)),
      image: imageId, videoId: vid || null, kids: people.kids, partners: people.partners,
    },
    newOutlet: outlet ? null : { name: P.cleanOutletName(siteName || P.hostOf(finalUrl)), domain: P.hostOf(finalUrl), kind: ai?.category || P.guessKind(siteName, P.hostOf(finalUrl)) },
    suggestVideo: !vid && page.videos?.length ? page.videos[0] : null,
    imageError, about: ai?.about || null,
    duplicateOf: dupe ? { slug: dupe.slug, title: dupe.data.title } : null,
  };
}

/** A person pressed Add on a found article: file it now, whatever the judgement */
export async function addMention(env, id, user, { fetchImpl = fetch } = {}) {
  const { DB } = env;
  let m = await DB.prepare('SELECT * FROM press_mentions WHERE id = ?').bind(id).first();
  if (!m) return { success: false, error: 'That article isn’t in the list any more' };
  if (m.state === 'filed' && m.story) return { success: true, slug: m.story };
  await setMention(DB, id, { state: 'new', stage: m.stage && !['done'].includes(m.stage) ? (m.stage === 'match' ? 'read' : m.stage) : (m.url ? 'read' : 'resolve') });
  const ctx = await context(DB);
  for (let i = 0; i < 8; i++) {
    m = await DB.prepare('SELECT * FROM press_mentions WHERE id = ?').bind(id).first();
    if (m.stage === 'match') { await setMention(DB, id, { stage: 'read' }); continue; }
    const r = await stepMention(env, m, { fetchImpl, ctx, force: true, user });
    if (r.filed) {
      const state = await readState(DB);
      state.deployPending = true;
      await writeState(DB, state);
      return { success: true, slug: r.filed };
    }
    if (r.done && !r.next) {
      m = await DB.prepare('SELECT state, reason FROM press_mentions WHERE id = ?').bind(id).first();
      if (m.state === 'failed') return { success: false, error: m.reason };
    }
  }
  return { success: false, error: 'It couldn’t be added. Try again, or add it by hand with its link.' };
}
export async function decideMention(env, id, decision, user) {
  const { DB } = env;
  const m = await DB.prepare('SELECT id, state FROM press_mentions WHERE id = ?').bind(id).first();
  if (!m) return { success: false, error: 'That article isn’t in the list any more' };
  if (decision === 'skip') await setMention(DB, id, { state: 'dismissed', decided_at: iso(), decided_by: user });
  else if (decision === 'restore') await setMention(DB, id, { state: 'review', decided_at: null, decided_by: null });
  else return { success: false, error: 'Unknown choice' };
  return { success: true };
}

/** Put one logged change back, field by field (only fields nobody has changed since) */
export async function undoChange(env, id, user) {
  const { DB } = env;
  const e = await DB.prepare('SELECT * FROM press_log WHERE id = ?').bind(id).first();
  if (!e) return { success: false, error: 'That change isn’t in the list' };
  if (e.undone_at) return { success: true, already: true };
  const before = parse(e.before, null);
  const after = parse(e.after, null);
  const extra = parse(e.extra, {}) || {};
  const table = e.kind.startsWith('outlet') ? 'medialogos' : 'press';
  const kept = [];
  if (e.kind === 'filed' || e.kind === 'outlet-created') {
    const rec = await loadOne(DB, table, e.slug);
    if (rec) {
      if (table === 'medialogos') {
        const using = (await loadAll(DB, 'press')).filter((s) => s.data.outletLogo === e.slug);
        if (using.length) return { success: false, error: `${using.length === 1 ? 'A story uses' : `${using.length} stories use`} this outlet. Move ${using.length === 1 ? 'it' : 'them'} to another outlet first.` };
      }
      if (!(await deleteRecord(env, table, e.slug, rec.raw, { message: `Undo: ${e.label}`, user }))) return { success: false, error: 'It changed meanwhile. Reload and try again.' };
    }
    if (e.kind === 'filed' && extra.mention) await setMention(DB, extra.mention, { state: 'dismissed', decided_at: iso(), decided_by: user, story: null });
  } else {
    if (after && before) {
      const rec = await loadOne(DB, table, e.slug);
      if (rec) {
        const next = { ...rec.data };
        for (const [k, v] of Object.entries(after)) {
          if (JSON.stringify(next[k] ?? null) !== JSON.stringify(v ?? null)) { kept.push(k); continue; }
          if (before[k] == null) delete next[k]; else next[k] = before[k];
        }
        if (Object.keys(after).length > kept.length && !(await writeRecord(env, table, e.slug, rec.raw, table === 'press' ? P.storyRecord(next) : next, { message: `Undo: ${e.label}`, user }))) return { success: false, error: 'It changed meanwhile. Reload and try again.' };
      }
    }
    for (const r of extra.removed || []) {
      const exists = await loadOne(DB, 'press', r.slug);
      if (!exists) await writeRecord(env, 'press', r.slug, null, r.data, { message: `Undo: ${e.label}`, user });
    }
    for (const r of extra.stories || []) {
      const rec = await loadOne(DB, 'press', r.slug);
      if (rec && rec.data.outletLogo === r.after.outletLogo) await writeRecord(env, 'press', r.slug, rec.raw, P.storyRecord({ ...rec.data, ...r.before }), { message: `Undo: ${e.label}`, user });
    }
  }
  await DB.prepare('UPDATE press_log SET undone_at = ?, undone_by = ? WHERE id = ?').bind(iso(), user, id).run();
  return { success: true, kept };
}

/** Two outlet records that are one outlet: move `from`'s stories, spellings and websites to `into` */
export async function mergeOutlets(env, from, into, user) {
  const { DB } = env;
  if (!from || !into || from === into) return { success: false, error: 'Pick two different outlets' };
  const [a, b] = await Promise.all([loadOne(DB, 'medialogos', from), loadOne(DB, 'medialogos', into)]);
  if (!a || !b) return { success: false, error: 'One of them isn’t there any more. Reload.' };
  const target = P.outletRecord({ ...b.data, slug: into, aliases: [...(b.data.aliases || []), a.data.name, ...(a.data.aliases || [])], domains: [...(b.data.domains || []), ...(a.data.domains || [])], logo: b.data.logo || a.data.logo, strip: b.data.logo ? b.data.strip : (a.data.logo ? a.data.strip : b.data.strip), kind: b.data.kind || a.data.kind });
  const merged = { ...b.data, ...target };
  delete merged.slug;
  const stories = (await loadAll(DB, 'press')).filter((s) => s.data.outletLogo === from);
  const moved = [];
  for (const s of stories) {
    const next = P.storyRecord({ ...s.data, outletLogo: into, outlet: target.name });
    if (await writeRecord(env, 'press', s.slug, s.raw, next, { message: `Outlet merge: ${s.data.title}`, user })) moved.push({ slug: s.slug, before: { outletLogo: from, outlet: s.data.outlet }, after: { outletLogo: into, outlet: target.name } });
  }
  const diff = fieldDiff(b.data, { ...merged, slug: into });
  if (diff && !(await writeRecord(env, 'medialogos', into, b.raw, merged, { message: `Outlet merge: ${a.data.name} into ${b.data.name}`, user }))) return { success: false, error: `${b.data.name} changed meanwhile. Reload and try again.` };
  if (!(await deleteRecord(env, 'medialogos', from, a.raw, { message: `Outlet merge: ${a.data.name} into ${b.data.name}`, user }))) return { success: false, error: `${a.data.name} changed meanwhile. Reload and try again.` };
  await logChange(DB, { kind: 'outlet-merge', slug: into, label: `Merged ${a.data.name} into ${b.data.name}`, before: diff?.before || null, after: diff?.after || null, extra: { removed: [], outletRemoved: { slug: from, data: parse(a.raw, {}) }, stories: moved } });
  return { success: true, moved: moved.length };
}

/** A new outlet from the story editor (no logo, not in the strip) */
export async function createOutlet(env, { name, url = '', kind = '' }, user) {
  const { DB } = env;
  const clean = P.cleanOutletName(name);
  if (!P.outletKey(clean)) return { success: false, error: 'Give the outlet a name' };
  const outlets = await loadAll(DB, 'medialogos');
  const existing = P.matchOutlet(outlets.map((o) => o.data), { name: clean });
  if (existing) return { success: true, outlet: existing, existed: true };
  const slug = P.dedupeSlug(P.slugify(clean) || 'outlet', outlets.map((o) => o.slug));
  const host = P.hostOf(url);
  const rec = P.outletRecord({ name: clean, slug, logo: '', order: 0, strip: false, kind: P.CATEGORIES.includes(kind) ? kind : P.guessKind(clean, host), domains: host ? [host] : [] });
  if (!(await writeRecord(env, 'medialogos', slug, null, rec, { message: `New outlet: ${clean}`, user }))) return { success: false, error: 'Couldn’t add it. Try again.' };
  return { success: true, outlet: { ...rec, slug } };
}

export async function saveSettings(env, { queries, channels }, user) {
  const q = [...new Set((queries || []).map((x) => String(x || '').trim()).filter(Boolean))];
  if (!q.length) return { success: false, error: 'Keep at least one search' };
  if (q.length > 12 || q.some((x) => x.length > 100)) return { success: false, error: 'Up to 12 searches, each under 100 characters' };
  const ch = (channels || []).filter((c) => /^UC[\w-]{22}$/.test(c?.id || '')).map((c) => ({ name: P.plain(c.name).slice(0, 60) || 'YouTube channel', id: c.id }));
  if (ch.length > 15) return { success: false, error: 'Up to 15 channels' };
  const doc = { queries: q, channels: ch, updatedBy: user, updatedAt: iso() };
  await writeDoc(env.DB, SETTINGS_KEY, doc);
  return { success: true, settings: { ...doc, custom: true } };
}
/** A YouTube channel's id and name from its address (youtube.com/@11Alive) */
export async function resolveChannel(url, { fetchImpl = fetch } = {}) {
  const s = String(url || '').trim();
  const direct = s.match(/(UC[\w-]{22})/)?.[1];
  const target = direct ? `https://www.youtube.com/channel/${direct}` : /^@/.test(s) ? `https://www.youtube.com/${s}` : s;
  const u = safeUrl(target);
  if (!u || !/(^|\.)youtube\.com$/i.test(u.hostname)) return { success: false, error: 'Paste the channel’s YouTube address, like youtube.com/@11Alive' };
  try {
    const res = await fetchImpl(u.toString(), { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US' }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return { success: false, error: `YouTube answered ${res.status}` };
    const html = await res.text();
    const id = direct || html.match(/"externalId":"(UC[\w-]{22})"/)?.[1] || html.match(/<meta itemprop="identifier" content="(UC[\w-]{22})"/)?.[1];
    const name = P.plain(html.match(/<meta property="og:title" content="([^"]+)"/)?.[1] || '');
    return id ? { success: true, channel: { id, name: name || 'YouTube channel' } } : { success: false, error: 'That page isn’t a YouTube channel' };
  } catch (e) { return { success: false, error: e.message }; }
}
