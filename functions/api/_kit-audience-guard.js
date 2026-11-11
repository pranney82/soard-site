/**
 * Who an email written in Kit goes to
 * ===================================
 * Kit has one list: everyone active is in "All subscribers", and the audience
 * is picked per email. Two kinds of people in it asked for less than the
 * newsletter (Peter, Nov 10 2026: "make it perfect then! ... no patches, no
 * shortcuts"):
 *   - REVEAL_ONLY_TAG: signed up on the website for reveal emails only
 *   - WAITLIST_ONLY_TAG: waiting only for applications to open
 * Every email the site drafts leaves them out by itself (./_kit.js
 * kitCreateBroadcast). An email staff write in Kit's own editor is aimed by
 * whoever writes it. Kit's segment NEWSLETTER_SEGMENT is the newsletter
 * without them, ready to pick under Recipients.
 *
 * This watches for the other choice: an email written in Kit, not yet sent,
 * set to go to all subscribers, that would reach either group. The reviewers
 * get one email about it, with the way to fix it, while there's still time.
 * It only reads: it never changes anyone's draft (an email about a reveal
 * rightly goes to everyone). Every few minutes from the heartbeat. Never throws.
 */

import { kitConfigured, kitFetch, kitReadBroadcast, kitListAudiences, REVEAL_ONLY_TAG, WAITLIST_ONLY_TAG } from './_kit.js';
import { sendEmails, emailConfigured } from './_broadcast-notify.js';
import { emailShell, facts as factRows, button, esc } from './_email-shell.js';
import { kitDraftUrl, kitInviteSettings, reviewersOf } from './_reveal-invite-kit.js';

/** The segment in Kit to pick for a newsletter: all subscribers, matching none of the two tags above */
export const NEWSLETTER_SEGMENT = 'Everyone on the newsletter';
const EVERY_MS = 4 * 60e3;
const MAX_LOOKS = 20; // emails read in full per look (Kit allows 120 calls a minute, shared)

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS kit_audience_alerts (broadcast_id TEXT PRIMARY KEY, sig TEXT, at TEXT)',
  'CREATE TABLE IF NOT EXISTS kit_audience_runs (key TEXT PRIMARY KEY, at INTEGER NOT NULL)',
];

/** Every draft and scheduled email in Kit, briefly (id, subject, description). null: Kit didn't answer */
async function waiting(env) {
  const out = [];
  for (const status of ['draft', 'scheduled']) {
    const res = await kitFetch(env, `/broadcasts?status=${status}&slim=true&per_page=1000`);
    if (!res.ok) return null;
    const got = await res.json().catch(() => ({}));
    out.push(...(got.broadcasts || []));
  }
  return out;
}

/**
 * Of the people who asked for less, who would this email reach? → the tags it
 * doesn't leave out, among `guarded` ([{ id, name, count }]). An email aimed at
 * a tag, a segment (the newsletter segment among them) or a form is someone's
 * deliberate pick: only "everyone", Kit's default, is checked.
 */
export function reaches(b, guarded) {
  const groups = b?.subscriber_filter || [];
  const picks = groups.flatMap((g) => [...(g?.all || []), ...(g?.any || [])]).filter((e) => e?.type !== 'all_subscribers');
  if (picks.length) return [];
  const none = new Set(groups.flatMap((g) => (g?.none || []).flatMap((e) => (e?.type === 'tag' ? e.ids || [] : []).map(Number))));
  return guarded.filter((t) => !none.has(Number(t.id)) && (t.count ?? 1) > 0);
}

/** The reviewers' note about one email */
export function audienceNote({ subject, id, groups, segment }) {
  const who = groups.map((t) => `${(t.count ?? 0).toLocaleString('en-US')} ${t.name === REVEAL_ONLY_TAG ? `${t.count === 1 ? 'person' : 'people'} who signed up on the website for reveal emails only` : `${t.count === 1 ? 'family' : 'families'} waiting only for applications to open`}`);
  const said = who.length > 1 ? `${who.slice(0, -1).join(', ')} and ${who.at(-1)}` : who[0];
  const fix = segment
    ? `If it’s a newsletter, change Recipients to “${NEWSLETTER_SEGMENT}”. If it’s about a reveal or applications, it’s right as it is.`
    : `If it’s a newsletter, add “${REVEAL_ONLY_TAG}” and “${WAITLIST_ONLY_TAG}” to its Recipients as tags it matches none of. If it’s about a reveal or applications, it’s right as it is.`;
  const heading = `Check who “${subject || 'an email in Kit'}” goes to`;
  const intro = `It’s set to go to all subscribers in Kit, and that includes ${said}. They asked us not to send them the newsletter.`;
  const url = kitDraftUrl(id);
  const html = emailShell({
    preheader: intro, eyebrow: 'Kit', heading, intro: esc(intro),
    bodyHtml: factRows([['What to do', esc(fix)]]) + `<div style="margin:18px 0 6px;">${button('Open it in Kit', url)}</div>`,
    footerHtml: 'Sent once for each email by the website, which looks at the emails waiting in Kit every few minutes.',
  });
  return { subject: `Check who “${subject || 'an email in Kit'}” goes to`, html, text: `${heading}\n\n${intro}\n\n${fix}\n\nKit: ${url}` };
}

export async function maybeGuardAudiences(env, { now = Date.now(), config = {} } = {}) {
  const { DB } = env;
  if (!DB || !kitConfigured(env) || !emailConfigured(env)) return null;
  try {
    for (const sql of SCHEMA) await DB.prepare(sql).run();
    await DB.prepare("INSERT OR IGNORE INTO kit_audience_runs (key, at) VALUES ('look', 0)").run();
    const turn = await DB.prepare("UPDATE kit_audience_runs SET at = ? WHERE key = 'look' AND at <= ?").bind(now, now - EVERY_MS).run();
    if (!(turn?.meta?.changes > 0)) return null;

    const groups = await kitListAudiences(env);
    if (!groups.ok) return null;
    const guarded = (groups.tags || []).filter((t) => [REVEAL_ONLY_TAG, WAITLIST_ONLY_TAG].includes(t.name));
    if (!guarded.length) return [];
    const segment = (groups.segments || []).find((x) => String(x.name || '').trim().toLowerCase() === NEWSLETTER_SEGMENT.toLowerCase()) || null;

    const list = await waiting(env);
    if (!list) return null;
    // The site's own drafts are aimed by the site (their descriptions start "[auto]")
    const theirs = list.filter((b) => !/^\[auto\]/.test(String(b.description || ''))).slice(0, MAX_LOOKS);
    const out = [];
    for (const brief of theirs) {
      const got = await kitReadBroadcast(env, brief.id);
      if (!got.ok) continue;
      const b = got.broadcast;
      const hit = reaches(b, guarded);
      if (!hit.length) continue;
      const sig = hit.map((t) => t.id).sort().join(',');
      const was = await DB.prepare('SELECT sig FROM kit_audience_alerts WHERE broadcast_id = ?').bind(String(b.id)).first();
      if (was?.sig === sig) continue;
      const to = reviewersOf(kitInviteSettings(config));
      if (!to.length) continue;
      const note = audienceNote({ subject: b.subject, id: b.id, groups: hit, segment });
      const sent = await sendEmails(env, { to, subject: note.subject, html: note.html, text: note.text, tags: [{ name: 'category', value: 'kit-audience-check' }] }).catch(() => null);
      if ((sent?.sent || 0) > 0) {
        await DB.prepare('INSERT OR REPLACE INTO kit_audience_alerts (broadcast_id, sig, at) VALUES (?, ?, ?)').bind(String(b.id), sig, new Date(now).toISOString()).run();
        out.push({ id: b.id, reaches: hit.map((t) => t.name) });
      }
    }
    return out;
  } catch {
    return null;
  }
}
