/**
 * Emails staff write themselves (Emails & invites → Write an email): saved on
 * the site, drafted in Kit, never sent from here. The layout is the site's own
 * (./_custom-email.js), so the header, footer and sign-off are the same as every
 * email the site drafts, and change in one place.
 *
 * Drafting again updates the draft that's waiting in Kit, but only while nobody
 * has changed it there: Kit's copy is read first (and again just before the
 * write), and one a person edited, scheduled or sent is left alone. Drafts go
 * to the newsletter list (less the families who only asked about
 * applications), as every Kit draft the site makes does. The other reviewers
 * (Linzi and Peter) are emailed when someone drafts one; whoever drafted it isn't.
 */

import { kitConfigured, kitCreateBroadcast, kitReadBroadcast, kitUpdateDraft } from './_kit.js';
import { sendEmails, emailConfigured } from './_broadcast-notify.js';
import { emailShell, facts as factRows, button as noteButton, esc } from './_email-shell.js';
import { brokenLogos, kitInviteSettings, reviewersOf, kitDraftUrl, copyHash, wentOut } from './_reveal-invite-kit.js';
import { readConfig } from './_reveal-invites.js';
import { customEmail, customImageUrls, cleanEmail, emailProblems } from './_custom-email.js';

const SCHEMA = `CREATE TABLE IF NOT EXISTS custom_emails (
  id TEXT PRIMARY KEY, data TEXT NOT NULL, broadcast_id TEXT, state TEXT, content_hash TEXT,
  created_by TEXT, created_at TEXT, updated_by TEXT, updated_at TEXT, drafted_by TEXT, drafted_at TEXT, deleted_at TEXT)`;
const _ready = new WeakSet();
export async function ensureCustomSchema(DB) {
  if (_ready.has(DB)) return;
  await DB.prepare(SCHEMA).run();
  _ready.add(DB);
}
const iso = (ms = Date.now()) => new Date(ms).toISOString();
const isEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || ''));
const samePerson = (a, b) => isEmail(a) && String(a).trim().toLowerCase() === String(b || '').trim().toLowerCase();
const personOf = (email) => String(email || '').split('@')[0].split(/[._-]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ') || 'Someone';
const goneInKit = (got) => /HTTP 404/.test(got?.error || '') || got?.broadcast?.status === 'aborted';
const ID_RE = /^em_[a-z0-9]{8,24}$/;
export const isEmailId = (id) => ID_RE.test(String(id || ''));
const newId = () => `em_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
const OFF_REASON = 'Kit drafts are off while reveal invites are paused (Reveals → Invites)';

const fromRow = (r) => {
  if (!r) return null;
  let data = {};
  try { data = JSON.parse(r.data); } catch { /* an unreadable record reads as empty */ }
  return { id: r.id, ...cleanEmail(data), broadcastId: r.broadcast_id || null, state: r.state || 'writing', createdBy: r.created_by, createdAt: r.created_at, updatedBy: r.updated_by, updatedAt: r.updated_at, draftedBy: r.drafted_by, draftedAt: r.drafted_at };
};

export async function listCustomEmails(DB) {
  await ensureCustomSchema(DB);
  const { results = [] } = await DB.prepare('SELECT * FROM custom_emails WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT 200').all();
  return results.map(fromRow);
}
export async function readCustomEmail(DB, id) {
  await ensureCustomSchema(DB);
  if (!isEmailId(id)) return null;
  return fromRow(await DB.prepare('SELECT * FROM custom_emails WHERE id = ? AND deleted_at IS NULL').bind(id).first());
}

/** Save what's written (a new one when there's no id). → the email */
export async function saveCustomEmail(DB, { id = null, email, by }) {
  await ensureCustomSchema(DB);
  const data = JSON.stringify(cleanEmail(email));
  const at = iso();
  if (id) {
    if (!isEmailId(id)) throw new Error('Not an email');
    const r = await DB.prepare('UPDATE custom_emails SET data = ?, updated_by = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL').bind(data, by, at, id).run();
    if (!(r?.meta?.changes > 0)) throw new Error('That email isn’t here any more');
    return readCustomEmail(DB, id);
  }
  const fresh = newId();
  await DB.prepare('INSERT INTO custom_emails (id, data, state, created_by, created_at, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(fresh, data, 'writing', by, at, by, at).run();
  return readCustomEmail(DB, fresh);
}

/** Put away (a draft already in Kit stays there). → done? */
export async function removeCustomEmail(DB, id) {
  await ensureCustomSchema(DB);
  if (!isEmailId(id)) return false;
  const r = await DB.prepare('UPDATE custom_emails SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').bind(iso(), id).run();
  return r?.meta?.changes > 0;
}

/** Where its Kit draft stands, read from Kit. → { state: 'writing'|'draft'|'edited'|'scheduled'|'sent'|'deleted', id?, at? } */
export async function customEmailStatus(env, e) {
  if (!e?.broadcastId) return { state: 'writing' };
  if (!kitConfigured(env)) return { state: 'draft', id: e.broadcastId, unread: true };
  const got = await kitReadBroadcast(env, e.broadcastId);
  if (goneInKit(got)) return { state: 'deleted', id: e.broadcastId };
  if (!got.ok) return { state: 'draft', id: e.broadcastId, unread: true };
  const went = wentOut(got.broadcast);
  if (went) return { state: went, id: e.broadcastId, at: got.broadcast.published_at || got.broadcast.send_at || null };
  const { DB } = env;
  const row = await DB.prepare('SELECT content_hash FROM custom_emails WHERE id = ?').bind(e.id).first();
  const edited = !row?.content_hash || got.broadcast.public === true || (await copyHash(got.broadcast)) !== row.content_hash;
  return { state: edited ? 'edited' : 'draft', id: e.broadcastId, at: got.broadcast.created_at || e.draftedAt || null };
}

/** The email as it will go, with any picture that won't load left out */
export async function renderCustomEmail(email, { fetchImpl = fetch, check = true } = {}) {
  const broken = check ? await brokenLogos({}, { fetchImpl, extra: customImageUrls(email) }) : new Set();
  return customEmail(email, { brokenLogos: broken });
}

/** The other reviewers hear that it's waiting in Kit. An email only. */
export function customNote({ subject, id, by }) {
  const heading = `${personOf(by)} drafted “${subject}” in Kit`;
  const intro = `${personOf(by)} wrote it in Emails & invites → Write an email, and it’s waiting in Kit for the newsletter list. Look it over; nothing goes out until someone sends it from Kit.`;
  const bodyHtml = factRows([['Subject', esc(subject)], ['Goes to', 'The newsletter list in Kit']])
    + `<div style="margin:18px 0 6px;">${noteButton('Open the draft in Kit', kitDraftUrl(id))}</div>`;
  const html = emailShell({ preheader: intro, eyebrow: 'Newsletter email', heading, intro: esc(intro), bodyHtml, footerHtml: 'Sent by the website when someone drafts an email they wrote.' });
  return { subject: `Review “${subject}” in Kit`, html, text: [heading, '', intro, '', `Subject: ${subject}`, `Kit: ${kitDraftUrl(id)}`].join('\n') };
}

/**
 * Draft it in Kit, or update the draft that's waiting. A draft only.
 * @returns {Promise<{ ok: boolean, result: 'drafted'|'updated'|'unchanged'|'edited'|'sent'|'scheduled'|'off'|'missing'|'error', id?: string, error?: string, missing?: string[] }>}
 */
export async function draftCustomEmail(env, { id, by, fetchImpl = fetch, now = Date.now() }) {
  const { DB } = env;
  try {
    const e = await readCustomEmail(DB, id);
    if (!e) return { ok: false, result: 'error', error: 'That email isn’t here any more' };
    if (!isEmail(by)) return { ok: false, result: 'error', error: 'Couldn’t tell who you are' };
    const config = await readConfig(DB);
    const s = kitInviteSettings(config);
    if (!s.enabled || config.enabled === false) return { ok: false, result: 'off', error: OFF_REASON };
    if (!kitConfigured(env)) return { ok: false, result: 'off', error: 'Kit isn’t connected' };
    const missing = emailProblems(e);
    if (missing.length) return { ok: false, result: 'missing', missing, error: `Add ${missing.join(', and ')} first.` };
    const row = await DB.prepare('SELECT content_hash FROM custom_emails WHERE id = ?').bind(id).first();
    const mark = `· email:${id} ·`;
    const email = await renderCustomEmail(e, { fetchImpl });
    const body = { subject: email.subject, previewText: email.preview, description: `[site] ${e.subject} ${mark}`, html: email.html };
    // Already in Kit: update it, unless a person has changed it there or it's gone out
    if (e.broadcastId) {
      const got = await kitReadBroadcast(env, e.broadcastId);
      if (!goneInKit(got)) {
        if (!got.ok) return { ok: false, result: 'error', error: 'Kit couldn’t be reached. Try again in a minute.' };
        const went = wentOut(got.broadcast, now);
        if (went) return { ok: false, result: went, id: e.broadcastId, error: went === 'sent' ? 'It’s already been sent from Kit.' : 'It’s scheduled in Kit, so it’s left as it is.' };
        const theirs = async (b) => !row?.content_hash || b.public === true || (await copyHash(b)) !== row.content_hash;
        if (await theirs(got.broadcast)) return { ok: false, result: 'edited', id: e.broadcastId, error: 'Someone changed it in Kit, so the site leaves it as it is. Make the change there, or delete it in Kit and draft it again.' };
        if ((await copyHash({ ...got.broadcast, subject: body.subject, preview_text: body.previewText, content: body.html })) === row.content_hash) return { ok: true, result: 'unchanged', id: e.broadcastId };
        const u = await kitUpdateDraft(env, e.broadcastId, { ...body, guard: async (b) => !(await theirs(b)) });
        if (u.edited) return { ok: false, result: 'edited', id: e.broadcastId, error: 'Someone changed it in Kit just now, so the site left it as it is.' };
        if (u.status) return { ok: false, result: 'sent', id: e.broadcastId, error: 'It went out from Kit meanwhile.' };
        if (!u.ok) return { ok: false, result: 'error', error: `Kit didn’t take the change (${u.error || 'no answer'}).` };
        const after = await kitReadBroadcast(env, e.broadcastId);
        await DB.prepare('UPDATE custom_emails SET content_hash = ?, drafted_by = ?, drafted_at = ? WHERE id = ?').bind(after.ok ? await copyHash(after.broadcast) : null, by, iso(now), id).run();
        return { ok: true, result: 'updated', id: e.broadcastId };
      }
    }
    const c = await kitCreateBroadcast(env, body);
    const bid = String(c.broadcast?.id || '');
    if (!c.ok || !bid) return { ok: false, result: 'error', error: `Kit didn’t take the draft (${c.error || 'no answer'}).` };
    const seen = await kitReadBroadcast(env, bid);
    await DB.prepare("UPDATE custom_emails SET broadcast_id = ?, state = 'drafted', content_hash = ?, drafted_by = ?, drafted_at = ? WHERE id = ?")
      .bind(bid, seen.ok ? await copyHash(seen.broadcast) : null, by, iso(now), id).run();
    // The other reviewers hear; whoever pressed it doesn't need to
    const to = reviewersOf(s).filter((r) => !samePerson(by, r));
    if (to.length && emailConfigured(env)) {
      const n = customNote({ subject: e.subject, id: bid, by });
      await sendEmails(env, { to, subject: n.subject, html: n.html, text: n.text, tags: [{ name: 'category', value: 'newsletter-review' }] }).catch(() => null);
    }
    return { ok: true, result: 'drafted', id: bid };
  } catch (err) {
    console.error('[custom-emails]', err.message);
    return { ok: false, result: 'error', error: 'The site couldn’t draft it. Try again in a minute.' };
  }
}

/** "Send it to me": the email as it will go, to the person asking, marked [Preview]. → sent? */
export async function sendCustomPreview(env, { id, to, fetchImpl = fetch }) {
  const e = await readCustomEmail(env.DB, id);
  if (!e) return { ok: false, error: 'That email isn’t here any more' };
  if (!isEmail(to)) return { ok: false, error: 'Couldn’t tell who you are' };
  if (!emailConfigured(env)) return { ok: false, error: 'Email isn’t set up on the site' };
  const m = await renderCustomEmail(e, { fetchImpl });
  const out = await sendEmails(env, { to: [to], subject: `[Preview] ${m.subject}`, html: m.html, text: m.text, tags: [{ name: 'category', value: 'custom-email-preview' }] }).catch(() => null);
  return (out?.sent || 0) > 0 ? { ok: true, to } : { ok: false, error: 'It didn’t go. Try again in a minute.' };
}
