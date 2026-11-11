/**
 * Edit words, the work behind it: the email as it would be drafted with
 * someone's words, and saving them, which brings an untouched draft already in
 * Kit up to date. Used by Admin → Edit words (./email-words-admin.js) and the
 * SOARD connection for Claude (./_mcp-tools.js), so both do exactly the same.
 * Keys and parts: ./_email-words.js. Never sends to the list and never makes a
 * new draft: drafting stays where it is.
 */

import { EMAIL_WORDS, WORD_PARTS, parseWordsKey, readWords, saveWords, cleanWords } from './_email-words.js';
import { revealInviteEmail } from './_reveal-invite-email.js';
import { projectKickoffEmail, projectRevealEmail } from './_project-email.js';
import { readKitRow } from './_reveal-invite-kit.js';
import { draftInviteEmailNow, inviteEmailFacts, readConfig } from './_reveal-invites.js';
import { readProjectRow, refreshProjectDraft } from './_project-emails.js';
import { readNewsletterRow, followNewsletter, newsletterEmailFor } from './_newsletter-drafts.js';
import { sendEmails, emailConfigured } from './_broadcast-notify.js';
import { logAudit } from './_audit.js';

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

/**
 * What the Edit words boxes start from: the email's own parts, the words saved
 * for it, the site's own words (what an empty box keeps) and the email as it
 * would be drafted now. block: why there's nothing to show; note: why it can't
 * be drafted yet (shown, all the same).
 */
export async function emailWordsView(env, key) {
  const parsed = parseWordsKey(key);
  if (!parsed) throw new Error('Not one of the emails');
  const saved = await readWords(env.DB, key);
  const ctx = await emailFor(env, parsed.kind, parsed.id, { fresh: true });
  return {
    key, kind: parsed.kind, what: EMAIL_WORDS[parsed.kind].what, parts: partsOf(parsed.kind),
    words: saved.words, by: saved.by, at: saved.at, siteWords: ctx.render ? ctx.render({}).siteWords : null,
    email: ctx.render ? asSeen(ctx.render(saved.words)) : null, block: ctx.block || null, note: ctx.note || null,
  };
}

/** The email with these words, nothing saved. → { email } or { block } */
export async function emailWordsPreview(env, key, input) {
  const parsed = parseWordsKey(key);
  if (!parsed) throw new Error('Not one of the emails');
  const ctx = await emailFor(env, parsed.kind, parsed.id);
  return ctx.render ? { email: asSeen(ctx.render(cleanWords(parsed.kind, input))) } : { block: ctx.block || 'Nothing to show yet' };
}

/**
 * Keep an email's words (none: the site's own again), bring an untouched draft
 * in Kit up to date, and log it. via: how it was done, for History (" (via Claude)").
 * → { words, by, at, result, message, email }
 */
export async function saveEmailWords(env, key, input, { by, via = '' }) {
  const parsed = parseWordsKey(key);
  if (!parsed) throw new Error('Not one of the emails');
  const { kind, id } = parsed;
  const stored = await saveWords(env.DB, key, cleanWords(kind, input), { by });
  const { result, reason } = await bringDraftUp(env, kind, id, stored.hash);
  await logAudit(env.DB, { userEmail: by, action: 'updated', entityType: 'newsletter', entitySlug: key, entityName: `Edit words: ${EMAIL_WORDS[kind].what} (${id})${via}`, gitStatus: 'ok' }).catch(() => {});
  const ctx = await emailFor(env, kind, id).catch(() => ({}));
  const saved = await readWords(env.DB, key);
  return {
    words: saved.words, by: saved.by, at: saved.at, result, message: MESSAGES[result](!stored.hash, reason),
    email: ctx.render ? asSeen(ctx.render(saved.words)) : null,
  };
}

/** The email with its saved words, to the person asking only, marked [Preview]. → { ok, to } or { ok: false, error } */
export async function sendEmailWordsTest(env, key, to) {
  const parsed = parseWordsKey(key);
  if (!parsed) return { ok: false, error: 'Not one of the emails' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(to || ''))) return { ok: false, error: 'Couldn’t tell who you are' };
  if (!emailConfigured(env)) return { ok: false, error: 'Email isn’t set up on the site' };
  const ctx = await emailFor(env, parsed.kind, parsed.id, { fresh: true });
  if (!ctx.render) return { ok: false, error: ctx.block || 'Nothing to show yet' };
  const m = ctx.render((await readWords(env.DB, key)).words);
  const out = await sendEmails(env, { to: [to], subject: `[Preview] ${m.subject}`, html: m.html, text: m.text, tags: [{ name: 'category', value: 'email-words-preview' }] }).catch(() => null);
  return (out?.sent || 0) > 0 ? { ok: true, to } : { ok: false, error: 'It didn’t go. Try again in a minute.' };
}
