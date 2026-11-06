/**
 * Emails for the Advisory Board
 * ===========================================================================
 * To advisors (people outside SOARD): off until settings.emails is on, the switch
 * on Members. The monthly ask, an update on an introduction or a hosted fundraiser,
 * a note when a gift lands on their page, the welcome. Nothing else starts them:
 * filling in data never sends anything.
 *
 * To whoever runs the group: on from the start, because an introduction that nobody
 * sees is worse than none. A notice names what came in and links to Run it, never a
 * contact's email or phone, which stay on the page.
 *
 * Replies go to info@, never to someone's private address. No email ever names a kid
 * or a gift amount beside a reveal; the kid is theirs to hear about at the meeting.
 * The ask's buttons carry a token for one ask and one advisor (D1 keeps only its hash), and GET only shows
 * the question, because mail scanners open links: a person's press is a POST.
 */

import { sendEmails, sendEmailItems, EMAIL_FROM, SITE_ORIGIN, isEmail } from './_broadcast-notify.js';
import * as shell from './_email-shell.js';
import { activeAdvisors, peopleRows, privateEmails, readState, writeState, boardAdmins } from './_board-roles.js';
import { ensureAdvisory, getSettings, INTRO_STATUSES, HOSTED_STATUSES, answerAsk } from './_advisory.js';

const LOG = 'advisory-mail';
const FROM = EMAIL_FROM.replace(/^[^<]*/, 'SOARD Advisory Board ');
const PAGE = `${SITE_ORIGIN}/admin/advisory/`;
// Run it, by a link that survives the sign-in (a #/ link lands on Home)
const RUN = `${SITE_ORIGIN}/advisory/run`;
const FALLBACK = 'info@soardcharity.com';
const LINK_DAYS = 30;
const NUDGE_EVERY_MS = 7 * 86_400_000;
const longDay = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(d || '') ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '');
const firstOf = (name) => String(name || '').trim().split(/\s+/)[0] || '';
const tag = (value) => [{ name: 'kind', value }];

async function leadOf(env, settings) {
  const [people, emails] = await Promise.all([peopleRows(env.DB), privateEmails(env.DB)]);
  const p = people.find((x) => x.slug === settings.lead);
  const email = p ? emails[p.slug] : '';
  return { name: p?.name || '', email: isEmail(email) ? email : FALLBACK };
}
const REPLY_TO = FALLBACK;

async function remember(DB, entry, now = Date.now()) {
  const log = await readState(DB, LOG);
  const what = { ask: `This month’s ask: ${entry.title || ''}`, welcome: 'Your page is ready', goal: 'The goal was reached', 'goal-note': 'You reached the goal', 'advisory-update': 'An update to an advisor' }[entry.kind] || (String(entry.kind).startsWith('notice-') ? 'A notice to whoever runs the group' : entry.kind);
  await writeState(DB, LOG, { ...log, list: [{ at: new Date(now).toISOString(), what, ...entry }, ...(log.list || [])].slice(0, 40) });
}
export const mailLog = async (DB) => (await readState(DB, LOG)).list || [];
export const welcomedSlugs = async (DB) => (await readState(DB, LOG)).welcomed || {};

const para = (text) => shell.paragraphs(text);

// ─── To whoever runs the group ──────────────────────────────────────

/** What came in, for the person running the group. Never throws */
export async function noticeLead(env, { kind, who, intro, hosted, note, term }) {
  try {
    const settings = await getSettings(env.DB);
    const lead = await leadOf(env, settings);
    const name = who?.name || 'An advisor';
    const words = {
      intro: { subject: `${firstOf(name)} made an introduction`, line: `${name} introduced ${intro?.name || 'someone'}${intro?.company ? ` at ${intro.company}` : ''}.` },
      host: { subject: `${firstOf(name)} wants to host a fundraiser`, line: `${name} asked to host: ${hosted?.title || ''}. It needs a yes or a not now.` },
      answer: { subject: `${firstOf(name)} can help with this month’s ask`, line: `${name} said yes to this month’s ask.${note ? ` They wrote: “${note}”` : ''}` },
      renew: { subject: `${firstOf(name)} renewed`, line: `${name} renewed for another year, through ${longDay(term?.ends) || 'next year'}.` },
    }[kind];
    if (!words) return;
    const html = shell.emailShell({
      preheader: words.line, eyebrow: 'Advisory Board', heading: words.subject, bodyHtml: para(words.line) + shell.button('Open Run it', RUN, 'primary', { big: true }),
    });
    const r = await sendEmails(env, { to: [lead.email], from: FROM, subject: words.subject, html, text: `${words.line}\n\n${RUN}`, tags: tag('advisory-lead') });
    await remember(env.DB, { kind: `notice-${kind}`, to: 'lead', sent: r.sent, error: r.errors?.[0] || null });
  } catch (e) { console.error('[advisory-mail] notice', e.message); }
}

/** The group reached its goal: what to do next, for whoever runs it and the admins */
export async function noticeGoal(env, settings, { raised }) {
  const lead = await leadOf(env, settings);
  const admins = await boardAdmins(env.DB);
  const to = [...new Set([lead.email, ...admins])];
  const subject = 'The Advisory Board reached its goal';
  const line = settings.kid
    ? 'The group has raised its goal. Next, move their makeover’s job forward in JobTread, because the site never changes a job’s status.'
    : 'The group has raised its goal. Next, pick the kid the group will sponsor on Members, then move that job forward in JobTread.';
  const html = shell.emailShell({ preheader: line, eyebrow: 'Advisory Board', heading: subject, bodyHtml: para(line) + shell.button('Open Members', RUN, 'primary', { big: true }) });
  await sendEmails(env, { to, from: FROM, subject, html, text: `${line}\n\n${RUN}`, tags: tag('advisory-lead') });
  await remember(env.DB, { kind: 'goal', to: 'lead and admins', raised });
}

/** Once a week at most, when something has been waiting a week, or no ask has gone out in a month. Never throws */
export async function maybeNudgeLead(env, { now = Date.now() } = {}) {
  try {
    await ensureAdvisory(env.DB);
    const log = await readState(env.DB, LOG);
    if (log.nudgedAt && now - Date.parse(log.nudgedAt) < NUDGE_EVERY_MS) return null;
    const week = new Date(now - NUDGE_EVERY_MS).toISOString();
    const month = new Date(now - 30 * 86_400_000).toISOString();
    const intros = (await env.DB.prepare("SELECT COUNT(*) AS n FROM advisory_intros WHERE status = 'thanks' AND at < ?").bind(week).first())?.n || 0;
    const hosted = (await env.DB.prepare("SELECT COUNT(*) AS n FROM advisory_hosted WHERE status = 'new' AND at < ?").bind(week).first())?.n || 0;
    const advisors = (await activeAdvisors(env.DB)).length;
    const lastAsk = (await env.DB.prepare('SELECT MAX(sent_at) AS at FROM advisory_asks').first())?.at;
    const noAsk = advisors > 0 && (await getSettings(env.DB)).emails && (!lastAsk || lastAsk < month);
    if (!intros && !hosted && !noAsk) return null;
    const settings = await getSettings(env.DB);
    const lead = await leadOf(env, settings);
    const lines = [
      intros ? `${intros} ${intros === 1 ? 'introduction is' : 'introductions are'} waiting for an answer.` : '',
      hosted ? `${hosted} ${hosted === 1 ? 'fundraiser request is' : 'fundraiser requests are'} waiting for a yes or a not now.` : '',
      noAsk ? 'It’s been a month since the last ask went out.' : '',
    ].filter(Boolean);
    const subject = 'The Advisory Board has things waiting';
    const html = shell.emailShell({ preheader: lines[0], eyebrow: 'Advisory Board', heading: subject, bodyHtml: para(lines.join('\n\n')) + shell.button('Open Run it', RUN, 'primary', { big: true }) });
    await sendEmails(env, { to: [lead.email], from: FROM, subject, html, text: `${lines.join('\n')}\n\n${RUN}`, tags: tag('advisory-lead') });
    await writeState(env.DB, LOG, { ...(await readState(env.DB, LOG)), nudgedAt: new Date(now).toISOString() });
    return lines;
  } catch (e) { console.error('[advisory-mail] nudge', e.message); return null; }
}

// ─── To advisors (only with the switch on) ──────────────────────────

const LINKS = 'CREATE TABLE IF NOT EXISTS advisory_links (hash TEXT PRIMARY KEY, ask_id TEXT NOT NULL, slug TEXT NOT NULL, expires TEXT NOT NULL)';
const hashOf = async (t) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)))].map((b) => b.toString(16).padStart(2, '0')).join('');
const tokenOf = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function linkFor(DB, askId, slug, now) {
  await DB.prepare(LINKS).run();
  const t = tokenOf();
  await DB.prepare('INSERT INTO advisory_links (hash, ask_id, slug, expires) VALUES (?, ?, ?, ?)').bind(await hashOf(t), askId, slug, new Date(now + LINK_DAYS * 86_400_000).toISOString()).run();
  return t;
}
/** What a link in an email stands for: { askId, slug }, or null when it's unknown or old */
export async function linkFrom(DB, token, { now = Date.now() } = {}) {
  await DB.prepare(LINKS).run();
  const row = await DB.prepare('SELECT ask_id, slug, expires FROM advisory_links WHERE hash = ?').bind(await hashOf(String(token || ''))).first();
  if (!row || row.expires <= new Date(now).toISOString()) return null;
  // Someone who has left the group can't answer from an old email
  return (await activeAdvisors(DB)).some((a) => a.slug === row.slug) ? { askId: row.ask_id, slug: row.slug } : null;
}
export async function answerFromLink(DB, token, { answer, note = '' }, { now = Date.now() } = {}) {
  const link = await linkFrom(DB, token, { now });
  if (!link) throw Object.assign(new Error('This link has expired. Open the Advisory Board page to answer.'), { status: 410 });
  return { ...link, ...(await answerAsk(DB, link.askId, link.slug, { answer, note, via: 'email' }, { now })) };
}

export function askEmail(ask, first, { yes, no }) {
  const heading = ask.title;
  const html = shell.emailShell({
    preheader: ask.body || 'This month’s ask from the Advisory Board.', eyebrow: 'This month’s ask', heading,
    bodyHtml: para(`Hi ${first},\n\n${ask.body || 'Can you help with this one?'}${ask.link ? `\n\nMore here: ${ask.link}` : ''}`) + shell.buttonRow([shell.button('I can help', yes, 'primary'), shell.button('Not this time', no, 'outline')]),
    footerHtml: 'Questions? Just reply to this email.',
  });
  return { subject: `This month’s ask: ${ask.title}`, html, text: `Hi ${first},\n\n${ask.title}\n\n${ask.body || ''}${ask.link ? `\n\nMore here: ${ask.link}` : ''}\n\nI can help: ${yes}\nNot this time: ${no}` };
}

export async function sendAsk(env, ask, { now = Date.now() } = {}) {
  const settings = await getSettings(env.DB);
  if (!settings.emails) return { off: true };
  const log = await mailLog(env.DB);
  if (log.some((l) => l.kind === 'ask' && l.id === ask.id && l.sent > 0)) return { already: true };
  const advisors = (await activeAdvisors(env.DB)).filter((a) => isEmail(a.email));
  const items = [];
  for (const a of advisors) {
    const t = await linkFor(env.DB, ask.id, a.slug, now);
    const at = (d) => `${SITE_ORIGIN}/api/advisory-action?t=${encodeURIComponent(t)}&do=${d}`;
    items.push({ to: a.email, ...askEmail(ask, firstOf(a.name), { yes: at('yes'), no: at('no') }) });
  }
  const r = await sendEmailItems(env, items, { from: FROM, replyTo: REPLY_TO, tags: tag('advisory-ask') });
  await remember(env.DB, { kind: r.sent ? 'ask' : 'ask-failed', id: ask.id, title: ask.title, sent: r.sent, failed: r.failed, ...(r.sent ? {} : { what: `This month’s ask didn’t send: ${ask.title}` }) }, now);
  return { sent: r.sent, failed: r.failed };
}

async function toOne(env, slug, { subject, heading, line, kind }) {
  const settings = await getSettings(env.DB);
  if (!settings.emails) return { off: true };
  const a = (await activeAdvisors(env.DB)).find((x) => x.slug === slug);
  if (!a || !isEmail(a.email)) return { sent: 0 };
  const html = shell.emailShell({ preheader: line, eyebrow: 'Advisory Board', heading, bodyHtml: para(line) + shell.button('Open your page', PAGE, 'primary', { big: true }) });
  const r = await sendEmails(env, { to: [a.email], from: FROM, subject, html, text: `${line}\n\n${PAGE}`, replyTo: REPLY_TO, tags: tag(kind) });
  await remember(env.DB, { kind, sent: r.sent });
  return { sent: r.sent };
}
export function sendIntroUpdate(env, intro) {
  const label = INTRO_STATUSES.find((s) => s.id === intro.status);
  return toOne(env, intro.slug, { kind: 'advisory-update', subject: `An update on ${intro.name}`, heading: `${intro.name}: ${label?.label || intro.status}`, line: `An update on your introduction: ${label?.sub || label?.label || ''}.${intro.note ? `\n\n${intro.note}` : ''}` });
}
export function sendHostUpdate(env, hosted) {
  const label = HOSTED_STATUSES.find((s) => s.id === hosted.status);
  return toOne(env, hosted.slug, { kind: 'advisory-update', subject: `Your fundraiser: ${hosted.title}`, heading: `${hosted.title}: ${label?.label || hosted.status}`, line: hosted.note || `Your request to host is now marked ${String(label?.label || hosted.status).toLowerCase()}.` });
}
export const sendGiftNote = (env, slug, n) => toOne(env, slug, { kind: 'advisory-update', subject: 'A gift came through your page', heading: 'A gift came through your page', line: `${n === 1 ? 'Someone' : `${n} people`} gave through your page. Thank you for sharing it.` });

/** The group reached the goal: a thank-you to everyone, with no kid named */
export async function sendGoalNote(env, settings) {
  if (!settings.emails) return { off: true };
  const advisors = (await activeAdvisors(env.DB)).filter((a) => isEmail(a.email));
  const line = 'You did it. Together you have raised enough to fund a makeover. There’s more to come at the next meeting.';
  const html = shell.emailShell({ preheader: line, eyebrow: 'Advisory Board', heading: 'You reached the goal', bodyHtml: para(line) + shell.button('Open your page', PAGE, 'primary', { big: true }) });
  const r = await sendEmails(env, { to: advisors.map((a) => a.email), from: FROM, subject: 'You reached the goal', html, text: `${line}\n\n${PAGE}`, replyTo: REPLY_TO, tags: tag('advisory-update') });
  await remember(env.DB, { kind: 'goal-note', sent: r.sent });
  return r;
}

export function welcomeMessage(first, leadName = '') {
  const line = `Your Advisory Board page is ready. It has the next meeting, this month’s ask, how to help with the goal, and everyone in the group. Sign in with this email address: you’ll get a code, and there’s no password to remember.${leadName ? `\n\n${firstOf(leadName)} runs the group. If you have a question, just reply to this email.` : ''}`;
  return {
    subject: 'Your Advisory Board page is ready', text: `Hi ${first},\n\n${line}\n\n${PAGE}`,
    html: shell.emailShell({ preheader: 'Your Advisory Board page is ready.', eyebrow: 'Advisory Board', heading: `Welcome, ${first}`, bodyHtml: para(line) + shell.button('Open your page', PAGE, 'primary', { big: true }) }),
  };
}

/** Your page is ready: to those named, once each, who haven't had it */
export async function sendWelcome(env, { by = '', slugs = null, now = Date.now() } = {}) {
  const settings = await getSettings(env.DB);
  if (!settings.emails) return { off: true, sent: 0 };
  const had = (await readState(env.DB, LOG)).welcomed || {};
  const advisors = (await activeAdvisors(env.DB)).filter((a) => isEmail(a.email) && !had[a.slug] && (!slugs || slugs.includes(a.slug)));
  const lead = await leadOf(env, settings);
  const items = advisors.map((a) => ({ to: a.email, ...welcomeMessage(firstOf(a.name), lead.name) }));
  const r = await sendEmailItems(env, items, { from: FROM, replyTo: REPLY_TO, tags: tag('advisory-welcome') });
  const at = new Date(now).toISOString();
  // (a send that failed whole stays unmarked, so pressing it again works)
  if (r.sent) await writeState(env.DB, LOG, { ...(await readState(env.DB, LOG)), welcomed: { ...had, ...Object.fromEntries(advisors.map((a) => [a.slug, at])) } });
  await remember(env.DB, { kind: 'welcome', by, sent: r.sent, failed: r.failed }, now);
  return { sent: r.sent, failed: r.failed };
}
