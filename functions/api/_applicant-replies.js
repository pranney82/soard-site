/**
 * A family replied: tell staff
 * ===========================================================================
 * Families answer a JobTread message by replying to its email (or in the
 * JobTread customer portal). JobTread files the reply on their account, and
 * the event sync (./_applicants.js syncEvents) stores it as a 'reply' row.
 * JobTread itself notifies no one (Tiffany Moody's reply in Mar 2026 made no
 * notification at all), so this does: a card in the Slack alerts channel and
 * an email to the staff list in Applications → Settings, once per reply,
 * with what they wrote. Reply opens the family's page already answering in
 * that thread, so the answer goes back through JobTread in the same
 * conversation. More replies in one JobTread thread reply in one Slack thread.
 *
 * Only replies that arrive after this first ran (`since`), and within two
 * days, so a history backfill or a late sync never floods anyone. Each reply
 * is claimed in applicant_reply_alerts before anything goes out, so a re-read
 * or a second sweep never sends twice.
 *
 * TEST families: the card says it's a test, and the email goes only to the
 * site's alert address, never the staff list.
 */

import { sendEmails, slackIssue, SITE_ORIGIN, alertEmails } from './_broadcast-notify.js';
import { slackCard } from './_slack-cards.js';
import * as mail from './_email-shell.js';
import { getLiveForm } from './_application-forms.js';
import { resolveForm } from './_application-form.js';

const ALERT_EMAILS = ['peter@soardcharity.com'];
const RECENT_MS = 2 * 24 * 60 * 60 * 1000;
const SLACK_CHARS = 280;

export async function ensureReplyAlertSchema(DB) {
  await DB.prepare(`CREATE TABLE IF NOT EXISTS applicant_reply_alerts (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL, at TEXT NOT NULL, sent_at TEXT NOT NULL, name TEXT, slack TEXT, email TEXT)`).run();
}

const isTest = (name) => /^test\b/i.test(String(name || '').trim());

/** The JobTread thread a reply belongs to: its first message */
export function threadIdOf(row) {
  let d = row?.data;
  if (typeof d === 'string') { try { d = JSON.parse(d); } catch { d = null; } }
  return d?.parentCommentId || d?.commentId || null;
}
const clip = (s, n) => (s.length > n ? `${s.slice(0, n).replace(/\s+\S*$/, '')}…` : s);

/** What they wrote, without the quoted email history some mail apps keep under a reply */
export function replyText(body) {
  const lines = String(body || '').replace(/\r/g, '').split('\n');
  const next = (i) => String(lines[i + 1] || '').trim();
  const cut = lines.findIndex((l, i) => {
    const t = l.trim();
    if (/^>/.test(t) || /^-{2,}\s*Original Message/i.test(t) || /^_{5,}$/.test(t)) return true;
    // "On Thu, Oct 22, 2026 at 12:10 PM Someone <a@b.org> wrote:", which some apps wrap over two lines
    if (/^On\s\S/.test(t) && (/wrote:$/.test(t) || /wrote:$/.test(next(i)))) return true;
    // Outlook: "From: …" then "Sent: …"
    return /^From:\s/.test(t) && /^(Sent|Date):\s/.test(next(i));
  });
  return (cut >= 0 ? lines.slice(0, cut) : lines).join('\n').trim();
}

/** The card and the email for one reply */
export function replyAlert(row, applicant) {
  const who = row.by_name || 'The family';
  const family = applicant.name;
  const text = replyText(row.body) || '(The reply had no text; it may be an attachment.)';
  const thread = threadIdOf(row);
  // Opens the family's page with the box already answering in this thread
  const page = `${SITE_ORIGIN}/admin/#applications/applicants/${applicant.id}${thread ? `/reply/${thread}` : ''}`;
  const jt = `https://app.jobtread.com/customers/${applicant.id}`;
  const test = isTest(family);
  const where = [applicant.status || null, applicant.year ? `${applicant.year} season` : null].filter(Boolean).join(' · ');
  const card = slackCard({
    icon: '💬',
    title: `${who} replied`,
    test: test ? 'Test family · not a real family' : null,
    lead: `About ${family}${where ? ` (${where})` : ''}\n“${clip(text.replace(/\s+/g, ' '), SLACK_CHARS)}”`,
    fix: 'Reply opens the family’s page with your answer going back in the same JobTread conversation.',
    buttons: [{ label: 'Reply', url: page }, { label: 'Open in JobTread', url: jt }],
  });
  const { esc } = mail;
  const html = mail.emailShell({
    preheader: clip(text.replace(/\s+/g, ' '), 140),
    eyebrow: test ? 'Test family · not a real family' : 'Applicants · A family replied',
    heading: `${who} replied`,
    intro: `About ${esc(family)}${where ? ` (${esc(where)})` : ''}. JobTread filed it on the family’s account.`,
    bodyHtml: mail.panel(`<div style="font-family:${mail.SANS};font-size:15px;line-height:1.55;white-space:pre-wrap;">${esc(clip(text, 4000))}</div>`, { accent: true })
      + `<div style="margin-top:16px;">${mail.button('Reply', page, 'primary')}${mail.button('Open in JobTread', jt, 'outline')}</div>`,
    footerHtml: `Reply opens the family’s page with your answer going back to them in the same JobTread conversation. This goes to the staff list in ${mail.link('Applications settings', `${SITE_ORIGIN}/admin/#applications/settings`)}.`,
  });
  return {
    card,
    email: {
      subject: `${test ? '[TEST] ' : ''}${who} replied: ${family}`,
      html,
      text: `${who} replied about ${family}${where ? ` (${where})` : ''}:\n\n${text}\n\nReply: ${page}\nOpen in JobTread: ${jt}\n\nYour answer goes back to them in the same JobTread conversation.`,
    },
  };
}

/**
 * Alert staff about new family replies. `rows` are activity rows from the
 * event sync; `getApplicant(id)` reads the mirror (only applicants alert).
 * Never throws: the sync it rides on must keep going.
 */
export async function alertFamilyReplies(env, rows, { since, getApplicant, now = Date.now() } = {}) {
  const out = { alerted: 0, skipped: 0 };
  const replies = (rows || []).filter((r) => r?.kind === 'reply' && r.at >= since && now - Date.parse(r.at) < RECENT_MS);
  if (!replies.length || !env.DB) return out;
  try {
    await ensureReplyAlertSchema(env.DB);
    let staff = null;
    for (const row of replies) {
      const applicant = await getApplicant(row.account_id);
      if (!applicant) { out.skipped++; continue; }
      // Claim it first: a second sweep, or the same event read twice, finds it taken
      const claim = await env.DB.prepare('INSERT OR IGNORE INTO applicant_reply_alerts (id, account_id, at, sent_at, name) VALUES (?, ?, ?, ?, ?)')
        .bind(row.id, row.account_id, row.at, new Date(now).toISOString(), applicant.name).run();
      if (!claim?.meta?.changes) { out.skipped++; continue; }
      const { card, email } = replyAlert(row, applicant);
      const test = isTest(applicant.name);
      if (!test && !staff) {
        try { staff = resolveForm((await getLiveForm(env.DB)).definition).staffEmails || []; } catch { staff = []; }
      }
      const to = test ? [...new Set([...ALERT_EMAILS, ...alertEmails(env)])] : staff;
      const [slack, sent] = await Promise.all([
        // One Slack thread per JobTread thread: the first reply posts, later ones reply under it
        slackIssue(env, `family-thread:${threadIdOf(row) || row.id}`, card, { title: `${applicant.name}: conversation`, kind: 'news', area: 'applications' }).catch((e) => ({ ok: false, error: e.message })),
        sendEmails(env, { to, ...email, tags: [{ name: 'type', value: 'applicant-reply' }] }).catch((e) => ({ sent: 0, errors: [e.message] })),
      ]);
      await env.DB.prepare('UPDATE applicant_reply_alerts SET slack = ?, email = ? WHERE id = ?')
        .bind(slack?.ok ? 'posted' : `not posted: ${slack?.error || 'unknown'}`.slice(0, 200), sent?.sent ? `sent to ${sent.sent}` : `not sent: ${sent?.errors?.[0] || 'no one to send to'}`.slice(0, 200), row.id).run();
      out.alerted++;
    }
  } catch (e) {
    out.error = e.message;
  }
  return out;
}

/**
 * Families waiting on us: their latest reply (since alerts began) that no one
 * has answered. Answered means, after it: a message from the site (a family
 * email, a reply, a status email or a correction), staff answering in a
 * JobTread conversation, or someone marking it "No reply needed". Archived
 * families and staff test runs are left out. Newest first:
 * [{ id, name, status, at, by, snippet, thread }]
 */
export async function waitingReplies(DB, { since = null } = {}) {
  let from = since;
  if (!from) {
    try { from = await DB.prepare("SELECT value FROM applicant_sync WHERE key = 'replies_since'").first('value'); } catch { from = null; }
  }
  if (!from) return [];
  const sql = (notTest) => `SELECT x.account_id, x.at, x.kind, x.by_name, x.title, x.body, x.data, a.name AS applicant, a.status
    FROM applicant_activity x JOIN applicants a ON a.account_id = x.account_id
    WHERE x.at >= ? AND a.archived_at IS NULL ${notTest}
      AND (x.kind IN ('reply', 'sent', 'handled')
        OR (x.kind = 'notify' AND (x.title LIKE 'Emailed the family%' OR x.title LIKE 'Correction sent%'))
        OR (x.kind = 'comment' AND json_extract(x.data, '$.parentCommentId') IS NOT NULL))
    ORDER BY x.at`;
  const notTest = 'AND NOT EXISTS (SELECT 1 FROM applications p WHERE p.jt_account_id = a.account_id AND p.is_test = 1)';
  let rows;
  try { rows = (await DB.prepare(sql(notTest)).bind(from).all()).results || []; } catch { rows = (await DB.prepare(sql('')).bind(from).all()).results || []; }
  const fam = new Map();
  for (const r of rows) {
    const f = fam.get(r.account_id) || { id: r.account_id, name: r.applicant, status: r.status || null, reply: null, answered: '' };
    if (r.kind === 'reply') f.reply = r;
    else if (r.at > f.answered) f.answered = r.at;
    fam.set(r.account_id, f);
  }
  return [...fam.values()]
    .filter((f) => f.reply && f.reply.at > f.answered)
    .map((f) => ({
      id: f.id, name: f.name, status: f.status, at: f.reply.at, by: f.reply.by_name || null,
      snippet: clip(replyText(f.reply.body).replace(/\s+/g, ' '), 140), thread: threadIdOf(f.reply),
    }))
    .sort((a, b) => b.at.localeCompare(a.at));
}

/** For Automations: when it last alerted, and whether that one reached Slack and email. No names or text */
export async function replyAlertFacts(DB) {
  await ensureReplyAlertSchema(DB);
  const last = await DB.prepare('SELECT at, sent_at, slack, email FROM applicant_reply_alerts ORDER BY sent_at DESC LIMIT 1').first();
  const n = await DB.prepare('SELECT count(*) AS n FROM applicant_reply_alerts').first();
  return { count: n?.n || 0, last: last ? { at: last.sent_at, slack: last.slack, email: last.email } : null };
}
