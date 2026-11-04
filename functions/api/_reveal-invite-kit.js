/**
 * The reveal invite email, drafted in Kit by itself when JobTread confirms a
 * reveal (Reveal Date Confirmed = Yes, with a time), for staff to review and send.
 *
 * - Filled in from the kid's page and JobTread (see ./_reveal-invite-email.js):
 *   name, photo, story, rooms, partners, the day and time, the family's address,
 *   the "Reveal Invite Details" notes, calendar buttons and the live link.
 * - Addressed to Kit's "Reveal Emails" group (a segment, else a tag, by that
 *   name). It carries the family's address, so with no such group there is no
 *   draft: Kit's default audience is every subscriber.
 * - Never sent by the site. The reviewer (Linzi by default) gets an email and
 *   Slack hears about it, with a link to the draft.
 * - The reveal changes (day, time, address, notes) while it's a draft: the
 *   draft is rewritten and the reviewer told. Changed after it went out: the
 *   reviewer is told so an update can go out. Deleted in Kit: left alone.
 * - Rehearsals (TEST jobs, the office sandbox) leave Kit alone.
 * - Reveals Settings → Invites can turn it off or name another reviewer
 *   (site_config 'reveal-invites' → kitInvite).
 */

import { kitConfigured, kitCreateBroadcast, kitUpdateDraft, kitListAudiences } from './_kit.js';
import { sendEmails, slackPost, emailConfigured } from './_broadcast-notify.js';
import { slackCard } from './_slack-cards.js';
import { emailShell, facts as factRows, button, esc } from './_email-shell.js';
import { revealInviteEmail, revealWhen, SITE_URL } from './_reveal-invite-email.js';

export const KIT_INVITE_DEFAULTS = Object.freeze({ enabled: true, reviewer: 'linzi@soardcharity.com', audience: 'Reveal Emails' });
export const kitInviteSettings = (config) => ({ ...KIT_INVITE_DEFAULTS, ...(config?.kitInvite || {}) });
export const kitDraftUrl = (id) => `https://app.kit.com/campaigns/${encodeURIComponent(id)}`;
const ADMIN_URL = `${SITE_URL}/admin/#broadcast/invites`;
// A draft Kit wouldn't take is tried again on the next look, but staff hear about one problem once
const isEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || ''));

const SCHEMA = `CREATE TABLE IF NOT EXISTS reveal_invite_kit (
  job_id TEXT PRIMARY KEY, broadcast_id TEXT, slug TEXT, reveal_date TEXT, hash TEXT,
  state TEXT, audience TEXT, reviewer TEXT, notified TEXT, error TEXT, updated_at TEXT)`;
const _ready = new WeakSet();
export async function ensureKitSchema(DB) {
  if (_ready.has(DB)) return;
  await DB.prepare(SCHEMA).run();
  _ready.add(DB);
}

async function sha(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

export async function readKitRow(DB, jobId) {
  await ensureKitSchema(DB);
  return DB.prepare('SELECT * FROM reveal_invite_kit WHERE job_id = ?').bind(jobId).first();
}

async function writeKitRow(DB, row) {
  await DB.prepare(`INSERT OR REPLACE INTO reveal_invite_kit
    (job_id, broadcast_id, slug, reveal_date, hash, state, audience, reviewer, notified, error, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(row.job_id, row.broadcast_id ?? null, row.slug ?? null, row.reveal_date ?? null, row.hash ?? null, row.state ?? null,
      row.audience ?? null, row.reviewer ?? null, row.notified ?? null, row.error ?? null, new Date().toISOString())
    .run();
}

/** Kit's "Reveal Emails" group: a segment by that name first, else a tag */
export async function findAudience(env, name) {
  const got = await kitListAudiences(env);
  if (!got.ok) throw new Error(got.error || 'Kit didn’t list its groups');
  const want = String(name || '').trim().toLowerCase();
  const seg = (got.segments || []).find((s) => String(s.name || '').trim().toLowerCase() === want);
  const tag = (got.tags || []).find((t) => String(t.name || '').trim().toLowerCase() === want);
  // Kit doesn't count a segment's people; a tag by the same name is how big it is
  if (seg) return { type: 'segment', id: seg.id, name: seg.name, count: tag?.count ?? null };
  if (tag) return { type: 'tag', id: tag.id, name: tag.name, count: tag.count ?? null };
  return null;
}

/** What the email says, as facts: a change to any of these rewrites the draft */
export function inviteFacts(plan, who, room = '') {
  return {
    name: who?.name || '', slug: who?.slug || '',
    date: plan?.facts?.date || plan?.date || '', start: plan?.facts?.start || '',
    address: plan?.facts?.address || '', details: plan?.facts?.details || '', room: String(room || ''),
  };
}

/**
 * The reviewer's note: a new draft, a draft rewritten, or a reveal that moved
 * after the email went out. Email to the reviewer, and a Slack card.
 */
export function reviewNote(kind, { name, f, id, audienceName, count }) {
  const when = revealWhen(f.date, f.start);
  const url = id ? kitDraftUrl(id) : null;
  const goesTo = `${audienceName || 'Reveal Emails'}${count ? ` (${count.toLocaleString('en-US')} people)` : ''} in Kit`;
  const t = {
    created: {
      subject: `Review ${name}’s reveal invite in Kit`,
      heading: `${name}’s reveal invite is ready to review`,
      intro: `JobTread confirmed ${name}’s reveal, so the invite email is drafted in Kit. Look it over, then send it from Kit. Nothing goes out until you do.`,
      slack: `JobTread confirmed the reveal. The invite email is drafted in Kit, addressed to ${goesTo}. Nothing goes out until someone sends it.`,
      icon: '✉️',
    },
    early: {
      subject: `Review ${name}\u2019s reveal invite in Kit`,
      heading: `${name}\u2019s reveal invite is ready to review`,
      intro: `It\u2019s drafted in Kit ahead of JobTread\u2019s confirmation, with the date JobTread has now and the time still to be confirmed. When JobTread confirms the reveal, the draft fills in the time by itself and you\u2019ll hear again. Nothing goes out until you send it.`,
      slack: `The invite email is drafted in Kit ahead of JobTread\u2019s confirmation, addressed to ${goesTo}. It fills in the time once JobTread confirms. Nothing goes out until someone sends it.`,
      icon: '✉️',
    },
    updated: {
      subject: `${name}’s reveal invite draft changed`,
      heading: `${name}’s reveal changed, so the draft did too`,
      intro: `JobTread changed ${name}’s reveal. The draft in Kit now says what JobTread says. Look it over before you send it.`,
      slack: `The reveal changed in JobTread, and the Kit draft was rewritten to match.`,
      icon: '✏️',
    },
    'after-send': {
      subject: `${name}’s reveal changed after the invite went out`,
      heading: `${name}’s reveal changed after the invite email went out`,
      intro: `The invite email already went out from Kit, and JobTread now says something different. Send the Reveal Emails group a short update from Kit.`,
      slack: `The reveal changed in JobTread after the invite email went out. The group needs a short update from Kit.`,
      icon: '⚠️',
    },
  }[kind];
  const rows = [
    ['When', esc(when)],
    ['Where', esc(f.address || 'No address in JobTread yet')],
    ['Room', f.room ? esc(f.room) : null],
    ['Notes', f.details ? esc(f.details).replace(/\n/g, '<br>') : null],
    ['Goes to', esc(goesTo)],
  ];
  const bodyHtml = factRows(rows)
    + (url ? `<div style="margin:18px 0 6px;">${button(kind === 'after-send' ? 'Open Kit' : 'Open the draft in Kit', url)}</div>` : '')
    + `<p class="muted" style="margin:14px 0 0;font-size:13px;line-height:1.55;">It has the family’s address, so it only goes to the ${esc(audienceName || 'Reveal Emails')} group. Check the photo, the story and the partners. Fix anything on ${esc(name)}’s page in the admin, or edit the draft in Kit.</p>`;
  const html = emailShell({ preheader: t.intro, eyebrow: 'Reveal invite', heading: t.heading, intro: esc(t.intro), bodyHtml, footerHtml: `Sent by the website when JobTread confirms a reveal. <a href="${esc(ADMIN_URL)}" style="color:inherit;">Reveals in the admin</a>` });
  const text = [t.heading, '', t.intro, '', `When: ${when}`, `Where: ${f.address || 'No address in JobTread yet'}`, f.room && `Room: ${f.room}`, f.details && `Notes: ${f.details}`, `Goes to: ${goesTo}`, '', url && `Kit: ${url}`].filter(Boolean).join('\n');
  const card = slackCard({
    icon: t.icon, title: t.heading, lead: t.slack,
    facts: [['When', when], ['Where', f.address || '—'], ['Goes to', goesTo]].filter(([, v]) => v),
    buttons: url ? [{ label: kind === 'after-send' ? 'Open Kit' : 'Review the draft', url }] : [],
    footer: 'Reveal invite email',
  });
  return { subject: t.subject, html, text, card };
}

async function notify(env, kind, settings, ctx) {
  const note = reviewNote(kind, ctx);
  const to = [settings.reviewer].filter(isEmail);
  await Promise.allSettled([
    emailConfigured(env) && to.length ? sendEmails(env, { to, subject: note.subject, html: note.html, text: note.text, tags: [{ name: 'category', value: 'reveal-invite-review' }] }) : null,
    slackPost(env, note.card, { kind: kind === 'after-send' ? 'attention' : 'info', area: 'reveals' }),
  ]);
}

async function problem(env, alertTo, row, { jobId, name, error }) {
  if (row?.error === error) return; // told once per problem
  const title = `${name ? `${name}’s` : 'A'} reveal invite email wasn’t drafted`;
  const fix = /group/i.test(error)
    ? 'In Kit, make sure a segment or tag is named “Reveal Emails” (the people who get reveal invites). The site tries again within minutes.'
    : 'The site tries again within minutes. If this keeps happening, check Kit under Reveals → Settings in the admin.';
  await Promise.allSettled([
    slackPost(env, slackCard({ icon: '⚠️', title, lead: error, fix, buttons: [{ label: 'Open Reveals', url: ADMIN_URL }], footer: 'Reveal invite email' }), { kind: 'attention', area: 'reveals' }),
    emailConfigured(env) && alertTo.length ? sendEmails(env, {
      to: alertTo, subject: `[SOARD] ${title}`,
      html: `<p><strong>${esc(title)}</strong></p><p>${esc(error)}</p><p>${esc(fix)}</p><p><a href="${esc(ADMIN_URL)}">Open Reveals in the admin</a></p>`,
      text: `${title}\n\n${error}\n\n${fix}\n\n${ADMIN_URL}`,
      tags: [{ name: 'category', value: 'reveal-invite-alert' }],
    }) : null,
  ]);
}

/**
 * Called on every look at a job (JobTread change, the 5-minute check, the
 * sweep). Quiet unless the reveal is confirmed with a time and something the
 * email says changed. Never throws.
 *
 * @returns {Promise<{kit: string, reason?: string, id?: string, error?: string}>}
 */
export async function syncKitInvite(env, { jobId, plan, who, room = '', config = {}, sandbox = false, alertTo = [], dryRun = false, early = false }) {
  const s = kitInviteSettings(config);
  if (!s.enabled) return { kit: 'off' };
  if (sandbox) return { kit: 'skip', reason: 'a rehearsal leaves Kit alone' };
  if (plan?.action !== 'upsert') return { kit: 'skip', reason: plan?.reason || 'no reveal to invite to' };
  if (!who?.slug) return { kit: 'skip', reason: 'no kid page to fill it from' };
  if (!kitConfigured(env)) return { kit: 'skip', reason: 'Kit is not connected' };
  const { DB } = env;
  try {
    const row = await readKitRow(DB, jobId);
    // JobTread's confirmation (with a time) drafts it. Staff can draft it
    // early from the admin; a draft made early then follows JobTread's date
    // and fills in the time once the reveal is confirmed.
    if (!early && !row?.broadcast_id && !(plan.confirmed && plan.facts?.start)) return { kit: 'skip', reason: 'not confirmed with a time' };
    const f = inviteFacts(plan, who, room);
    const hash = await sha(f);
    if (row && row.hash === hash && (row.broadcast_id || row.state === 'deleted in Kit')) return { kit: 'unchanged', id: row.broadcast_id };
    if (row?.state === 'deleted in Kit') return { kit: 'skip', reason: 'the draft was deleted in Kit' };

    const kidRow = await DB.prepare('SELECT data FROM kids WHERE slug = ?').bind(who.slug).first();
    let kid = null;
    try { kid = kidRow ? JSON.parse(kidRow.data) : null; } catch { /* unreadable */ }
    if (!kid || (kid.publishStatus && kid.publishStatus !== 'published')) return { kit: 'skip', reason: 'the kid page isn’t published' };
    const email = revealInviteEmail({ kid: { ...kid, slug: who.slug }, date: f.date, time: f.start, address: f.address, notes: f.details, room: f.room });
    const description = `[auto] ${who.name} reveal invite`;
    if (dryRun) return { kit: row?.broadcast_id ? 'would-update' : 'would-draft', subject: email.subject };
    const base = { job_id: jobId, slug: who.slug, reveal_date: f.date, reviewer: s.reviewer };

    if (!row?.broadcast_id) {
      const audience = await findAudience(env, s.audience);
      if (!audience) {
        const error = `Kit has no group named “${s.audience}”, so there’s no draft: the email has the family’s address and Kit would send it to everyone.`;
        await problem(env, alertTo, row, { jobId, name: who.name, error });
        await writeKitRow(DB, { ...(row || {}), ...base, state: 'waiting', error });
        return { kit: 'error', error };
      }
      const r = await kitCreateBroadcast(env, { subject: email.subject, previewText: email.preview, description, html: email.html, audience });
      if (!r.ok) {
        const error = `Kit didn’t take the draft: ${r.error || `HTTP ${r.status}`}`;
        await problem(env, alertTo, row, { jobId, name: who.name, error });
        await writeKitRow(DB, { ...(row || {}), ...base, state: 'waiting', error });
        return { kit: 'error', error };
      }
      const id = String(r.broadcast?.id || '');
      await writeKitRow(DB, { ...base, broadcast_id: id, hash, state: 'draft', audience: audience.name, notified: new Date().toISOString(), error: null });
      await notify(env, plan.confirmed && f.start ? 'created' : 'early', s, { name: who.name, f, id, audienceName: audience.name, count: audience.count });
      return { kit: 'drafted', id };
    }

    const u = await kitUpdateDraft(env, row.broadcast_id, { subject: email.subject, previewText: email.preview, description, html: email.html });
    if (u.ok) {
      await writeKitRow(DB, { ...row, ...base, hash, state: 'draft', notified: new Date().toISOString(), error: null });
      await notify(env, 'updated', s, { name: who.name, f, id: row.broadcast_id, audienceName: row.audience });
      return { kit: 'updated', id: row.broadcast_id };
    }
    if (u.status) {
      // Scheduled or sent from Kit: the site never rewrites that, it says so
      await writeKitRow(DB, { ...row, ...base, hash, state: u.status, notified: new Date().toISOString(), error: null });
      await notify(env, 'after-send', s, { name: who.name, f, id: row.broadcast_id, audienceName: row.audience });
      return { kit: 'after-send', id: row.broadcast_id };
    }
    if (/HTTP 404/.test(u.error || '')) {
      await writeKitRow(DB, { ...row, ...base, hash, state: 'deleted in Kit', error: null });
      return { kit: 'skip', reason: 'the draft was deleted in Kit' };
    }
    // Kit unreachable: the old facts stay, so the next look tries again
    await writeKitRow(DB, { ...row, error: u.error || 'Kit unreachable' });
    return { kit: 'error', error: u.error || 'Kit unreachable' };
  } catch (err) {
    return { kit: 'error', error: err.message };
  }
}
