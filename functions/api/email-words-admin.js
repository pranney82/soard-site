/**
 * /api/email-words-admin — "Edit words" on the emails the site drafts in Kit by itself
 * =====================================================================
 * Behind Cloudflare Access (not in the middleware's public list).
 *
 * GET  ?key=<email>              → { ok, key, kind, what, parts, words, by, at, siteWords, email, block }
 *        the email's own parts, the words saved for it, the site's own words (what an empty box keeps)
 *        and the email as it would be drafted now
 * POST { key, words, preview: true } → { ok, email }  the email with these words, nothing saved
 * POST { key, words }            → { ok, words, by, at, result, message, email }  saved, and an untouched
 *        draft already in Kit brought up to date; none in Kit yet takes them when it's drafted
 *
 * Keys and parts: ./_email-words.js. Never sends anything and never makes a new
 * draft: drafting stays where it is (the kid's Emails in Kit card, the event's
 * recap block, Monthly Impact in Emails & invites).
 */

import { EMAIL_WORDS, WORD_PARTS, parseWordsKey, readWords, saveWords, cleanWords } from './_email-words.js';
import { revealInviteEmail } from './_reveal-invite-email.js';
import { projectKickoffEmail, projectRevealEmail } from './_project-email.js';
import { readKitRow } from './_reveal-invite-kit.js';
import { draftInviteEmailNow, inviteEmailFacts, readConfig } from './_reveal-invites.js';
import { readProjectRow, refreshProjectDraft } from './_project-emails.js';
import { readNewsletterRow, followNewsletter, newsletterEmailFor } from './_newsletter-drafts.js';
import { logAudit } from './_audit.js';

const NO_STORE = { 'Cache-Control': 'no-store' };
const fail = (error, status = 400) => Response.json({ ok: false, error }, { status, headers: NO_STORE });

/**
 * What an email is drafted from, read once and kept a couple of minutes, so a
 * preview redrawn as someone types doesn't ask JobTread or Kit each time.
 */
const KEEP_MS = 2 * 60 * 1000;
const kept = new Map();

async function readKid(DB, slug) {
  const row = await DB.prepare('SELECT data FROM kids WHERE slug = ?').bind(slug).first();
  try { return row ? { ...JSON.parse(row.data), slug } : null; } catch { return null; }
}

/** → { render(words) → email, block } for one email; block: why there's nothing to show yet */
async function emailFor(env, kind, id, { fresh = false } = {}) {
  const key = `${kind}:${id}`;
  const have = kept.get(key);
  if (!fresh && have && Date.now() - have.at < KEEP_MS) return have.ctx;
  let ctx;
  if (kind === 'invite' || kind === 'watch') {
    const got = await inviteEmailFacts(env, id);
    const kid = got?.who?.slug ? await readKid(env.DB, got.who.slug) : null;
    if (!got) ctx = { block: 'JobTread has no such job' };
    else if (!kid) ctx = { block: 'No published kid page matches this reveal’s JobTread job' };
    else {
      const { f } = got;
      const watch = kind === 'watch';
      // The whole-list copy never has the family's address or the guests' notes
      ctx = { render: (words) => revealInviteEmail({ kid, date: f.date, time: f.start, address: watch ? '' : f.address, notes: watch ? '' : f.details, room: f.room, watch, words }) };
    }
  } else if (kind === 'kickoff' || kind === 'reveal') {
    const kid = await readKid(env.DB, id);
    const build = kind === 'kickoff' ? projectKickoffEmail : projectRevealEmail;
    ctx = kid ? { render: (words) => build({ kid, words }) } : { block: 'No kid page by that name' };
  } else {
    const got = await newsletterEmailFor(env, `${kind}:${id}`);
    // A recap with no event has nothing to show; a month the site has little from still shows what it has
    ctx = got.missing ? { block: 'No event by that name' } : { render: got.render, note: got.block };
  }
  kept.set(key, { at: Date.now(), ctx });
  return ctx;
}

const asSeen = (email) => ({ subject: email.subject, preview: email.preview, html: email.html });

/** The parts an email has, in order, as the boxes show them */
const partsOf = (kind) => EMAIL_WORDS[kind].parts.map((k) => ({ key: k, ...WORD_PARTS[k] }));

export async function onRequestGet({ env, request }) {
  if (!env.DB) return fail('DB not bound', 500);
  const key = new URL(request.url).searchParams.get('key') || '';
  const parsed = parseWordsKey(key);
  if (!parsed) return fail('Not one of the emails');
  try {
    const saved = await readWords(env.DB, key);
    const ctx = await emailFor(env, parsed.kind, parsed.id, { fresh: true });
    const site = ctx.render ? ctx.render({}).siteWords : null;
    return Response.json({
      ok: true, key, kind: parsed.kind, what: EMAIL_WORDS[parsed.kind].what, parts: partsOf(parsed.kind),
      words: saved.words, by: saved.by, at: saved.at, siteWords: site,
      email: ctx.render ? asSeen(ctx.render(saved.words)) : null, block: ctx.block || null, note: ctx.note || null,
    }, { headers: NO_STORE });
  } catch (err) {
    return fail(err.message, 500);
  }
}

/**
 * Bring a draft already in Kit up to date with the words just saved. Never makes
 * a draft, and never touches one a person has changed in Kit, scheduled or sent.
 * → one of updated | saved (nothing in Kit yet) | edited | left (scheduled or sent) | later | off | blocked
 */
async function bringDraftUp(env, kind, id, hash) {
  const { DB } = env;
  if (kind === 'invite' || kind === 'watch') {
    const row = await readKitRow(DB, id, kind);
    if (!row?.broadcast_id || row.state === 'deleted in Kit') return { result: 'saved' };
    if (['sent', 'scheduled'].includes(row.state)) return { result: 'left' };
    const r = await draftInviteEmailNow(env, id, { kind, early: false });
    if (r.kit === 'off' || (r.kit === 'skip' && /paused/.test(r.reason || ''))) return { result: 'off' };
    if (['sent', 'scheduled', 'after-send'].includes(r.kit)) return { result: 'left' };
    // What the draft now has decides it, whatever the look said: the words it was last written with
    const after = await readKitRow(DB, id, kind);
    if (after?.state === 'deleted in Kit') return { result: 'saved' };
    if (['sent', 'scheduled'].includes(after?.state)) return { result: 'left' };
    if ((after?.words || '') === hash) return { result: 'updated' };
    return { result: r.kit === 'error' || r.kit === 'check' ? 'later' : 'edited' };
  }
  if (kind === 'kickoff' || kind === 'reveal') {
    const row = await readProjectRow(DB, id, kind);
    if (!row?.broadcast_id || row.state === 'deleted') return { result: 'saved' };
    if (row.state === 'edited') return { result: 'edited' };
    if (['sent', 'scheduled'].includes(row.state)) return { result: 'left' };
    if (row.state !== 'drafted') return { result: 'saved' };
    // Kept on the row first, so the hourly look still does it if Kit doesn't answer now ('force' stays 'force')
    await DB.prepare("UPDATE project_emails SET refresh = 'words' WHERE slug = ? AND kind = ? AND (refresh IS NULL OR refresh != 'force')").bind(id, kind).run();
    const config = await readConfig(DB);
    const r = await refreshProjectDraft(env, { ...row, refresh: row.refresh === 'force' ? 'force' : 'words' }, { config });
    if (r.project === 'off') return { result: 'off' };
    if (r.project === 'redesigned') return { result: 'updated' };
    if (r.project === 'edited') return { result: 'edited' };
    if (r.project === 'skip') return { result: /left the site/.test(r.reason || '') ? 'left' : 'saved' };
    return { result: 'later' };
  }
  const key = `${kind}:${id}`;
  const row = await readNewsletterRow(DB, key);
  if (!row?.broadcast_id || row.state === 'deleted') return { result: 'saved' };
  if (row.state === 'edited') return { result: 'edited' };
  if (['sent', 'scheduled'].includes(row.state)) return { result: 'left' };
  if (row.state !== 'drafted') return { result: 'saved' };
  // Due a look straight away on the hourly round too, should Kit not answer now
  await DB.prepare('UPDATE newsletter_drafts SET followed_at = NULL WHERE key = ?').bind(key).run();
  const config = await readConfig(DB);
  const r = await followNewsletter(env, { ...row, followed_at: null }, { config });
  if (r.newsletter === 'off') return { result: 'off' };
  if (r.newsletter === 'updated') return { result: 'updated' };
  // The same words as it already has
  if (r.newsletter === 'unchanged' && !r.reason) return { result: 'updated' };
  if (r.newsletter === 'unchanged') return { result: 'blocked', reason: r.reason };
  if (r.newsletter === 'edited') return { result: 'edited' };
  if (['left', 'sent', 'scheduled'].includes(r.newsletter)) return { result: 'left' };
  if (r.newsletter === 'deleted') return { result: 'saved' };
  return { result: 'later' };
}

const MESSAGES = {
  updated: (none) => (none ? 'Saved. The draft in Kit has the site’s own words again.' : 'Saved. The draft in Kit has your words now.'),
  saved: (none) => (none ? 'Saved. The email will have the site’s own words.' : 'Saved. The email will have your words when it’s drafted.'),
  edited: () => 'Saved, but someone changed this draft in Kit, so the site leaves it as they made it. Change it there, or delete it in Kit and draft it again here to use these words.',
  left: () => 'Saved. This one is already scheduled or sent from Kit, so it stays as it went.',
  later: () => 'Saved. Kit didn’t answer, so the draft gets these words on the site’s next look, within the hour.',
  off: () => 'Saved. Kit drafts are paused (Reveals → Invites), so the draft gets these words once they’re back on.',
  blocked: (none, reason) => `Saved. ${reason}, so the draft in Kit stays as it is for now.`,
};

export async function onRequestPost(context) {
  const { env, request } = context;
  if (!env.DB) return fail('DB not bound', 500);
  const me = context.data?.userEmail || '';
  if (!me.includes('@')) return fail('Could not tell who you are from Access', 403);
  let body;
  try { body = await request.json(); } catch { return fail('Bad request'); }
  const key = String(body?.key || '');
  const parsed = parseWordsKey(key);
  if (!parsed) return fail('Not one of the emails');
  const { kind, id } = parsed;
  const words = cleanWords(kind, body?.words || {});
  try {
    if (body?.preview === true) {
      const ctx = await emailFor(env, kind, id);
      if (!ctx.render) return fail(ctx.block || 'Nothing to show yet', 409);
      return Response.json({ ok: true, email: asSeen(ctx.render(words)) }, { headers: NO_STORE });
    }
    const stored = await saveWords(env.DB, key, words, { by: me });
    const none = !stored.hash;
    const { result, reason } = await bringDraftUp(env, kind, id, stored.hash);
    await logAudit(env.DB, { userEmail: me, action: 'updated', entityType: 'newsletter', entitySlug: key, entityName: `Edit words: ${EMAIL_WORDS[kind].what} (${id})`, gitStatus: 'ok' }).catch(() => {});
    const ctx = await emailFor(env, kind, id).catch(() => ({}));
    const saved = await readWords(env.DB, key);
    return Response.json({
      ok: true, words: saved.words, by: saved.by, at: saved.at, result, message: MESSAGES[result](none, reason),
      email: ctx.render ? asSeen(ctx.render(saved.words)) : null,
    }, { headers: NO_STORE });
  } catch (err) {
    return fail(err.message, 500);
  }
}
