/**
 * Event pages after the event (Peter, Oct 2026)
 * ==============================================
 * Once an event is over, its page is the recap: the pro photos, then the
 * sponsors (src/components/events/EventRecap.astro). The site is static, so
 * the page only changes when it's rebuilt. This job, on the hub heartbeat
 * (./broadcast-hooks.js), makes that happen with nobody pressing Publish:
 *
 *   The morning after. When an event's last day has passed in Atlanta, the
 *   site rebuilds (the deploy hook, at most every 10 minutes) and the team
 *   hears it in Slack, with a nudge to add photos if there are none yet.
 *
 *   Next year. While a gala or tournament is the newest of its series, its
 *   recap shows the Gala or Golf editor's Gallery photos (the ones added
 *   after its date) and Sponsors list. When next year's event is added, the
 *   older one keeps them: they're saved onto its own event record, from the
 *   editor's saved version as it was when next year's event appeared (Site
 *   docs keep history in content_versions). Saved once; the record is then
 *   marked recapSaved and edited like any other event.
 *
 * The rules for which photos and sponsors belong to which event live in
 * public/admin/events-shared.js. State lives in D1: event_recap_state.
 */
import {
  SERIES, seriesOf, seriesEvents, isOver, dayIn, yearOf, displayName, eventPath,
  cleanPhotos, cleanSponsors, hasOwnSponsors, galleryPhotosFor, recapPhotos, recapSponsors, sponsorCount,
} from '../../public/admin/events-shared.js';
import { EXTRACTORS } from './_collections.js';
import { commitFile } from './_github.js';
import { logAudit, diffJson } from './_audit.js';
import { slackPost } from './_broadcast-notify.js';
import { slackCard } from './_slack-cards.js';

export const SYNC_USER = 'Event recap (automatic)';
const CHECK_EVERY_MS = 15 * 60 * 1000;
const DEPLOY_COOLDOWN_MS = 10 * 60 * 1000;
// A page doc older than this, with no saved version to go by, may already be next year's
const FRESH_MS = 2 * 86400e3;
const HOOK_ENV_VARS = ['CF_PAGES_DEPLOY_HOOK', 'CF_DEPLOY_HOOK', 'DEPLOY_HOOK_URL'];
const SITE = 'https://sunshineonaranneyday.com';

// ── State ────────────────────────────────────────────────────────────────
async function readState(DB) {
  await DB.prepare('CREATE TABLE IF NOT EXISTS event_recap_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)').run();
  const row = await DB.prepare("SELECT value FROM event_recap_state WHERE key = 'state'").first();
  try { return JSON.parse(row?.value || '{}'); } catch { return {}; }
}
async function writeState(DB, patch) {
  const next = { ...(await readState(DB)), ...patch };
  await DB.prepare("INSERT OR REPLACE INTO event_recap_state (key, value) VALUES ('state', ?)").bind(JSON.stringify(next)).run();
  return next;
}
export async function eventRecapState(DB) {
  try { return await readState(DB); } catch { return {}; }
}

// ── The plan (no I/O, so the tests can drive it) ─────────────────────────
/**
 * What to save and which events are over.
 *   events   event records (data)
 *   docs     { gala, golf } page docs as they are now
 *   asOf     { [newerSlug]: { doc, trusted } } the page doc as it was when that
 *            newer event appeared; trusted = it came from saved history, or the
 *            newer event is new enough that the doc can't have moved on yet
 * Returns { saves: [{ slug, before, after, what }], over: [slug] }.
 */
export function planRecaps(events, docs = {}, { today = dayIn(), asOf = {}, nowIso = new Date().toISOString() } = {}) {
  const saves = [];
  for (const s of SERIES) {
    const list = seriesEvents(s, events);
    for (let i = 1; i < list.length; i++) {
      const ev = list[i];
      if (!isOver(ev, today) || ev.recapSaved) continue;
      const newer = list[i - 1];
      const at = asOf[newer.slug] || { doc: docs[s.doc] || null, trusted: false };
      const doc = at.doc;
      const after = { ...ev, recapSaved: nowIso };
      const what = [];
      if (!cleanPhotos(ev.photos).length && doc) {
        const photos = galleryPhotosFor(ev, events, doc);
        if (photos.length) { after.photos = photos; what.push(`${photos.length} photos`); }
      }
      if (!hasOwnSponsors(ev) && doc && at.trusted) {
        const sponsors = cleanSponsors(doc.sponsors);
        if (sponsors.length) { after.sponsors = sponsors; what.push(`${sponsorCount(sponsors)} sponsors`); }
      }
      saves.push({ slug: ev.slug, before: ev, after, what });
    }
  }
  const over = (events || []).filter((e) => isOver(e, today)).map((e) => e.slug).sort();
  return { saves, over };
}

// ── I/O ──────────────────────────────────────────────────────────────────
async function loadEvents(DB) {
  const { results = [] } = await DB.prepare('SELECT slug, data FROM events').all();
  return results.map((r) => { try { return { ...JSON.parse(r.data), slug: r.slug }; } catch { return null; } }).filter(Boolean);
}
async function loadDocs(DB) {
  const keys = SERIES.map((s) => s.doc);
  const { results = [] } = await DB.prepare(`SELECT key, data FROM site_config WHERE key IN (${keys.map(() => '?').join(', ')})`).bind(...keys).all();
  const out = {};
  for (const r of results) { try { out[r.key] = JSON.parse(r.data); } catch { /* skip */ } }
  return out;
}

/** The page doc as it was when `newer` first appeared (its first save in the audit log) */
async function docAsOf(DB, key, newer, current, now) {
  let since = null;
  try {
    const row = await DB.prepare("SELECT MIN(created_at) AS at FROM audit_log WHERE entity_type = 'events' AND entity_slug = ?").bind(newer.slug).first();
    if (row?.at) since = Date.parse(String(row.at).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(row.at) ? '' : 'Z'));
  } catch { /* no audit log */ }
  if (since) {
    try {
      const v = await DB.prepare("SELECT data FROM content_versions WHERE collection = 'site' AND slug = ? AND created_at <= ? ORDER BY id DESC LIMIT 1")
        .bind(key, new Date(since).toISOString()).first();
      if (v?.data) return { doc: JSON.parse(v.data), trusted: true };
    } catch { /* no history table yet */ }
  }
  // No saved version: the doc as it is now, trusted only while next year's event is brand new
  return { doc: current, trusted: !!since && now - since <= FRESH_MS };
}

/** Saved the way an admin save is: D1, the GitHub copy, the audit log */
async function saveEvent(env, { slug, before, after, what }, nowIso) {
  const { DB } = env;
  const [cols, vals] = EXTRACTORS.events(after);
  const all = ['"slug"', '"data"', '"updated_at"', ...cols];
  await DB.prepare(`INSERT OR REPLACE INTO events (${all.join(', ')}) VALUES (${all.map(() => '?').join(', ')})`)
    .bind(slug, JSON.stringify(after), nowIso, ...vals).run();
  const path = `src/content/events/${slug}.json`;
  const message = `${String(after.title || slug).trim()}: keep its ${what.length ? what.join(' and ') : 'recap'} now next year's is added`;
  let gitStatus = 'ok';
  try { await commitFile(env, path, JSON.stringify(after, null, 2) + '\n', message); } catch { gitStatus = 'failed'; }
  await logAudit(DB, { userEmail: SYNC_USER, action: 'updated', entityType: 'events', entitySlug: slug, entityName: after.title, changes: diffJson(before, after), path, gitStatus });
}

/** Fires the deploy hook the admin's Publish uses, at most every 10 minutes */
async function deploy(env, state, now, fetchImpl) {
  const hook = HOOK_ENV_VARS.map((k) => env[k]).find(Boolean);
  if (!hook) return { deployed: false, pending: true, noHook: true };
  const last = state.lastDeployAt ? Date.parse(state.lastDeployAt) : 0;
  if (now - last < DEPLOY_COOLDOWN_MS) return { deployed: false, pending: true };
  try {
    const res = await fetchImpl(hook, { method: 'POST' });
    if (!res.ok) return { deployed: false, pending: true };
  } catch {
    return { deployed: false, pending: true };
  }
  await logAudit(env.DB, { userEmail: SYNC_USER, action: 'deployed', entityType: 'site', entityName: 'Event pages after the event' });
  return { deployed: true, pending: false };
}

/** The Slack card the morning after: the page is the thank-you now */
export function recapCard(ev, events, docs) {
  const s = seriesOf(ev);
  const doc = s ? docs[s.doc] : null;
  const name = `${displayName(ev)} ${yearOf(ev)}`.trim();
  const path = eventPath(ev, events);
  const photos = recapPhotos(ev, events, doc).length;
  const sponsors = sponsorCount(recapSponsors(ev, events, doc));
  const where = s ? `the ${s.key === 'gala' ? 'Gala' : 'Golf'} editor’s Gallery tab` : 'the event’s Event Photos';
  return slackCard({
    icon: '📸',
    title: `${name} page is now its thank-you`,
    lead: photos
      ? `It’s over, so ${SITE}${path} now shows the ${photos} photos, then the ${sponsors || 'event’s'} sponsors. No tickets or countdown.`
      : `It’s over, so ${SITE}${path} now thanks everyone who came${sponsors ? ` and the ${sponsors} sponsors` : ''}. It says the photos are on the way.`,
    facts: [['Photos', photos ? String(photos) : 'None yet'], ['Sponsors', sponsors ? String(sponsors) : 'None listed']],
    fix: photos ? null : `When the photographer’s pictures come in, add them in ${where} (Events → ${String(ev.title || name).trim()}) and Publish. They show on the page first, then the sponsors.`,
    buttons: [{ label: 'Open the page', url: `${SITE}${path}` }, { label: 'Open the admin', url: `${SITE}/admin/` }],
    footer: 'Automatic · the site rebuilt itself the morning after the event',
  });
}

/**
 * One pass: save what older series events should keep, then rebuild for any
 * event that just ended. Returns { saved, newlyOver, deployed } or null. Never throws.
 */
export async function runEventRecaps(env, { now = Date.now(), fetchImpl = fetch } = {}) {
  try {
    if (!env.DB) return null;
    const DB = env.DB;
    const nowIso = new Date(now).toISOString();
    const today = dayIn(now);
    const [events, docs, state] = await Promise.all([loadEvents(DB), loadDocs(DB), readState(DB)]);

    // The page doc each older event should keep, as it was when the next one appeared
    const asOf = {};
    for (const s of SERIES) {
      const list = seriesEvents(s, events);
      for (let i = 1; i < list.length; i++) {
        if (!isOver(list[i], today) || list[i].recapSaved) continue;
        const newer = list[i - 1];
        if (!asOf[newer.slug]) asOf[newer.slug] = await docAsOf(DB, s.doc, newer, docs[s.doc] || null, now);
      }
    }
    const plan = planRecaps(events, docs, { today, asOf, nowIso });
    for (const save of plan.saves) {
      try { await saveEvent(env, save, nowIso); } catch (e) { console.error('[event-recap] save', save.slug, e.message); }
    }

    // First run: what's over now was already built that way
    const known = Array.isArray(state.over) ? new Set(state.over) : null;
    const newlyOver = known ? plan.over.filter((slug) => !known.has(slug)) : [];
    const patch = { lastRunAt: nowIso, over: plan.over, lastRun: { at: nowIso, saved: plan.saves.map((s) => s.slug), newlyOver } };
    let deployed = false;
    if (newlyOver.length || plan.saves.length || state.deployPending) {
      const d = await deploy(env, state, now, fetchImpl);
      deployed = d.deployed;
      patch.deployPending = d.pending;
      if (d.deployed) patch.lastDeployAt = nowIso;
      // Announce each event once, when its page has actually been sent to rebuild
      const toAnnounce = [...new Set([...(state.unannounced || []), ...newlyOver])];
      if (d.deployed) {
        for (const slug of toAnnounce) {
          const ev = events.find((e) => e.slug === slug);
          if (ev) await slackPost(env, recapCard(ev, events, docs)).catch(() => null);
        }
        patch.unannounced = [];
      } else {
        patch.unannounced = toAnnounce;
      }
    }
    await writeState(DB, patch);
    return { saved: plan.saves.map((s) => s.slug), newlyOver, deployed };
  } catch (err) {
    console.error('[event-recap]', err.message);
    return null;
  }
}

/** On the heartbeat: every 15 minutes, or sooner when a rebuild is waiting */
export async function maybeRunEventRecaps(env, { now = Date.now(), fetchImpl = fetch } = {}) {
  try {
    if (!env.DB) return null;
    const state = await readState(env.DB);
    const due = now - Date.parse(state.lastRunAt || 0) >= CHECK_EVERY_MS;
    // A waiting rebuild is tried again 10 minutes after the last try, not on every beat
    const deployDue = state.deployPending && now - Date.parse(state.lastRunAt || 0) >= DEPLOY_COOLDOWN_MS;
    if (!due && !deployDue) return null;
    // Claim the slot first so overlapping wake-ups don't double up
    await writeState(env.DB, { lastRunAt: new Date(now).toISOString() });
    return await runEventRecaps(env, { now, fetchImpl });
  } catch {
    return null;
  }
}
