/**
 * "Tell me when applications open": the waitlist and its one email
 * ===========================================================================
 * Families leave an email on the Apply page (or the closed form page) while
 * applications are closed. When staff switch applications on (Admin →
 * Applications → Settings), every family waiting gets one email saying it's
 * open, in the language they signed up in, with nobody pressing anything.
 *
 * Signup (POST /api/newsletter, source "application-waitlist"):
 *   - The address is saved here in D1 first (waitlist_signups), so a Kit
 *     outage never loses a family. Then Kit: subscriber, the "Application
 *     Waitlist" tag, and WAITLIST_ONLY_TAG for someone Kit didn't already
 *     have (so "all subscriber" sends leave them out; see _kit.js). A Kit
 *     failure is retried by the heartbeat until it lands.
 *   - The family gets a "you're on the list" email (Resend, once a season).
 *   - Applications already open? They're told on the spot and emailed the link.
 *
 * The opening (the heartbeat, every minute; ./broadcast-hooks.js):
 *   countdown  the switch went on with families waiting. The email goes
 *              COUNTDOWN_MS later, so a switch flipped by mistake can be
 *              turned off again (or "Don't send this time" in the admin)
 *              before anyone hears. Staff get an email and a Slack post.
 *   preparing  Kit's waitlist tag is read in (signups from before this
 *              existed), the families waiting are frozen into this opening,
 *              the form is checked to really be open, and each family is
 *              tagged into a tag made for this opening and language, so
 *              nobody is emailed twice and nobody signed up later is missed.
 *   sending    one Kit broadcast per language. Families Kit can't reach
 *              (it never accepted the address, or they asked again after
 *              unsubscribing) get the same email straight from the site.
 *   sent       Kit finished. Staff hear how many it went to.
 *   held / cancelled   staff said not this time / the switch went off first.
 * Anyone who signs up while applications are open is emailed right away.
 *
 * If Kit can't be used at all (no key, or it keeps refusing) staff are told
 * at once, and after KIT_GIVE_UP_MS the site emails each family itself
 * rather than let the opening pass them by.
 *
 * Tables: waitlist_signups, waitlist_openings, waitlist_runtime.
 * Env: KIT_API_KEY (the list), RESEND_API_KEY (one-off emails),
 * SLACK_BOT_TOKEN / SLACK_WEBHOOK_URL (staff posts, optional), DB.
 */

import {
  kitConfigured, kitTagId, kitUpsertSubscriber, kitTagSubscriberId, kitUntagSubscriber, kitBulkTag,
  kitTagSubscribersPage, kitCreateBroadcast, kitBroadcastStats, kitListBroadcasts, kitDeleteBroadcast, kitAccount, kitListAudiences,
  WAITLIST_ONLY_TAG,
} from './_kit.js';
import { sendEmails, escapeHtml, isEmail, SITE_ORIGIN, slackPost, emailConfigured, EMAIL_FROM } from './_broadcast-notify.js';
import { slackCard } from './_slack-cards.js';
import * as applications from './_applications.js';
import { formFor } from './_application-forms.js';
import { logAudit } from './_audit.js';
import { limit } from './_rate-limit.js';

export const WAITLIST_TAG = 'Application Waitlist';
const REHEARSAL_TAG = 'Application Waitlist rehearsal';
export const COUNTDOWN_MS = 10 * 60 * 1000;
const KIT_SEND_DELAY_MS = 60 * 1000;              // Kit wants a send time a moment ahead
const RESEND_API = 'https://api.resend.com';
const KIT_GIVE_UP_MS = 2 * 3600 * 1000;           // then the site emails the families itself
const TICK_EVERY_MS = 50 * 1000;                  // the hub beats about once a minute
const LOCK_MS = 45 * 1000;
const IMPORT_EVERY_MS = 6 * 3600 * 1000;          // Kit's waitlist tag → here, while closed
const SIGNUP_RETRY_MS = [60e3, 5 * 60e3, 15 * 60e3, 3600e3]; // then hourly
const SIGNUP_ALERT_AFTER = 6;                     // tries (about 3 hours) before staff hear
const OPENING_RETRY_MS = [60e3, 2 * 60e3, 5 * 60e3, 10 * 60e3, 30 * 60e3];
const OPENING_ALERT_AFTER = 3;
const STATS_EVERY_MS = 2 * 60 * 1000;
const UPSERTS_PER_TICK = 20;
const BULK_CALLS_PER_TICK = 4;
const FORM_CHECKS = 5;                            // minutes of "the form still says closed" before staff hear

export const LANGS = { en: 'English', es: 'Español' };
const BAD_KIT_STATES = ['cancelled', 'bounced', 'complained'];
const ACTIVE = ['countdown', 'held', 'preparing', 'sending'];
const ADMIN_URL = `${SITE_ORIGIN}/admin/#applications/settings`;
const TZ = 'America/New_York';

const iso = (ms) => new Date(ms).toISOString();
const parse = (s, fallback) => { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } };
export const cleanEmail = (s) => String(s || '').trim().toLowerCase();
export const cleanLang = (l) => (String(l || '').toLowerCase().startsWith('es') ? 'es' : 'en');

// ─── Schema ─────────────────────────────────────────────────────────

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS waitlist_signups (
    email TEXT PRIMARY KEY,
    lang TEXT NOT NULL DEFAULT 'en',
    page TEXT,                 -- apply | apply-form | admin | kit (read in from Kit's tag)
    created_at TEXT NOT NULL,  -- signed up (this season)
    updated_at TEXT NOT NULL,
    kit_id INTEGER,
    kit_state TEXT,            -- active | inactive | cancelled | bounced | complained
    kit_synced_at TEXT,
    kit_error TEXT,
    kit_tries INTEGER DEFAULT 0,
    next_try_at INTEGER,       -- ms; null = nothing to retry
    alerted_at TEXT,
    confirmed_at TEXT,         -- the "you're on the list" email went
    pending_opening TEXT,      -- frozen into this opening, not emailed yet
    kit_snapshot TEXT,         -- tagged into that opening's Kit tag
    fallback INTEGER DEFAULT 0,-- Kit can't reach them: the site emails them itself
    opening_id TEXT,           -- the opening that told them (null = still waiting)
    notified_at TEXT,
    notified_via TEXT,         -- kit | email
    removed_at TEXT,
    removed_by TEXT
  )`,
  'CREATE INDEX IF NOT EXISTS waitlist_signups_waiting ON waitlist_signups (opening_id, removed_at)',
  'CREATE INDEX IF NOT EXISTS waitlist_signups_pending ON waitlist_signups (pending_opening)',
  `CREATE TABLE IF NOT EXISTS waitlist_openings (
    id TEXT PRIMARY KEY,
    year TEXT,
    state TEXT NOT NULL,       -- countdown | held | preparing | sending | sent | cancelled
    opened_at TEXT NOT NULL,   -- the site first saw applications open
    send_at INTEGER,           -- ms: the end of the countdown
    total INTEGER DEFAULT 0,
    counts TEXT,               -- { en, es } frozen into this opening
    tags TEXT,                 -- { en: kitTagId, es: … }
    broadcasts TEXT,           -- { en: { id, sendAt, stats, statsAt }, … }
    direct TEXT,               -- { sent, failed, error } emailed by the site itself
    checks INTEGER DEFAULT 0,  -- times the form was checked and still said closed
    tries INTEGER DEFAULT 0,
    next_try_at INTEGER,
    error TEXT,
    error_since INTEGER,
    alerted TEXT,
    by TEXT,                   -- automatic, or who pressed Send now / Don't send
    note TEXT,
    sent_at TEXT,
    finished_at TEXT,
    updated_at TEXT NOT NULL
  )`,
  'CREATE TABLE IF NOT EXISTS waitlist_runtime (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)',
];

const _ready = new WeakSet();
export async function ensureWaitlistSchema(DB) {
  if (_ready.has(DB)) return;
  await DB.batch(SCHEMA.map(sql => DB.prepare(sql)));
  // Added after the first version (each is a no-op once there):
  //   staged_at  Kit (and Resend) hold the email for the send time
  //   stop       a cancel or hold still trying to reach Kit ({ mode, why, by, tries })
  for (const sql of ['ALTER TABLE waitlist_openings ADD COLUMN staged_at TEXT', 'ALTER TABLE waitlist_openings ADD COLUMN stop TEXT']) {
    try { await DB.prepare(sql).run(); } catch { /* already there */ }
  }
  _ready.add(DB);
}

async function runtimeGet(DB, key) {
  return (await DB.prepare('SELECT value FROM waitlist_runtime WHERE key = ?').bind(key).first())?.value ?? null;
}
async function runtimeSet(DB, key, value, now = Date.now()) {
  await DB.prepare('INSERT OR REPLACE INTO waitlist_runtime (key, value, updated_at) VALUES (?, ?, ?)').bind(key, value == null ? null : String(value), iso(now)).run();
}
/** Take `key` for `ms` unless someone holds it → true when this caller has it */
async function claim(DB, key, ms, now) {
  const until = String(now + ms);
  const ins = await DB.prepare('INSERT OR IGNORE INTO waitlist_runtime (key, value, updated_at) VALUES (?, ?, ?)').bind(key, until, iso(now)).run();
  if (ins?.meta?.changes > 0) return true;
  const upd = await DB.prepare('UPDATE waitlist_runtime SET value = ?, updated_at = ? WHERE key = ? AND CAST(value AS INTEGER) <= ?').bind(until, iso(now), key, now).run();
  return upd?.meta?.changes > 0;
}
const release = (DB, key) => DB.prepare("UPDATE waitlist_runtime SET value = '0' WHERE key = ?").bind(key).run().catch(() => {});

/** Run `fn` holding the opening lock (waiting a few seconds for a step already running) */
async function withLock(DB, fn) {
  for (let i = 0; i < 20; i++) {
    if (await claim(DB, 'lock', LOCK_MS, Date.now())) {
      try { return await fn(); } finally { await release(DB, 'lock'); }
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return { ok: false, error: 'The email is busy getting ready. Try again in a moment.' };
}

/** The admin's application settings (site_config "settings" → application) */
export async function readAppSettings(DB, now = Date.now()) {
  let app = {};
  let photos = {};
  try {
    const row = await DB.prepare("SELECT data FROM site_config WHERE key = 'settings'").first();
    const all = parse(row?.data, {}) || {};
    app = all.application || {};
    photos = all.applyPhotos || {};
  } catch { /* no settings yet */ }
  const formUrl = /^https:\/\//.test(String(app.formUrl || '').trim()) ? String(app.formUrl).trim() : '';
  const changedAt = Date.parse(app.openChangedAt || '');
  return {
    open: app.open === true, year: applications.cleanYear(app.year, now), formUrl, heroPhoto: photos.hero || 'kids/griffin/hero',
    // Who flipped the switch last, and when (written by every save and the schedule)
    openChangedAt: Number.isFinite(changedAt) ? changedAt : null, openChangedBy: app.openChangedBy || null,
  };
}

// ─── Words ──────────────────────────────────────────────────────────
// Staff can reword the opening email per language (Admin → Applications →
// Settings → the waitlist panel); {year} fills in. Blank = these.

export const DEFAULT_WORDING = {
  en: {
    subject: 'Applications are open: apply for a {year} room makeover',
    body: "You asked us to tell you when applications open, and they're open now: the {year} room makeover application is ready for your family.\n\nIt takes about 15 minutes and saves as you go, so you can stop and come back anytime. You'll be asked for a few photos of your child and the space, and a short video.",
  },
  es: {
    subject: 'Ya abrimos las solicitudes para las remodelaciones de {year}',
    body: 'Nos pidió que le avisáramos cuando abrieran las solicitudes, y ya están abiertas: la solicitud de remodelación de {year} está lista para su familia.\n\nToma unos 15 minutos y se guarda mientras avanza, así que puede detenerse y volver cuando quiera. Le pediremos algunas fotos de su hijo o hija y del espacio, y un video corto.',
  },
};

const WORDS = {
  en: {
    eyebrow: 'Sunshine on a Ranney Day',
    openHeading: 'Applications are open',
    openPreheader: 'You asked us to tell you. The {year} application is open now.',
    openCta: 'Start the application',
    listFooter: "You're getting this one email because you asked us to tell you when applications open.",
    unsubscribe: 'Unsubscribe',
    directFooter: 'You asked us to tell you when applications open at sunshineonaranneyday.com. This is the only email we send about it.',
    confirmSubject: "You're on the list",
    confirmHeading: "You're on the list",
    confirmPreheader: "We'll email you the moment applications open.",
    confirmBody: "Thank you for reaching out about a room makeover for your child. Applications are closed right now. The moment they open, we'll send one email to this address with the link to apply.\n\nWhile you wait, you can read how it works and what the application asks for, so you're ready when it opens.",
    confirmCta: 'See how it works',
    confirmFooter: "You signed up at sunshineonaranneyday.com. Didn't mean to? You can ignore this email. We'll only write once more, when applications open.",
  },
  es: {
    eyebrow: 'Sunshine on a Ranney Day',
    openHeading: 'Ya puede presentar su solicitud',
    openPreheader: 'Nos pidió que le avisáramos. La solicitud de {year} ya está abierta.',
    openCta: 'Comenzar la solicitud',
    listFooter: 'Recibe este único correo porque nos pidió avisarle cuando abrieran las solicitudes.',
    unsubscribe: 'Cancelar suscripción',
    directFooter: 'Nos pidió en sunshineonaranneyday.com que le avisáramos cuando abrieran las solicitudes. Es el único correo que le enviamos sobre esto.',
    confirmSubject: 'Ya está en la lista',
    confirmHeading: 'Ya está en la lista',
    confirmPreheader: 'Le escribiremos en cuanto abran las solicitudes.',
    confirmBody: 'Gracias por su interés en una remodelación para su hijo o hija. Las solicitudes están cerradas por ahora. En cuanto abran, le enviaremos un solo correo a esta dirección con el enlace para presentar la solicitud.\n\nMientras tanto, puede ver la página de la solicitud para saber qué le vamos a pedir y tener todo preparado.',
    confirmCta: 'Ver la página de la solicitud',
    confirmFooter: 'Se inscribió en sunshineonaranneyday.com. ¿No fue usted? Puede ignorar este correo. Solo le escribiremos una vez más, cuando abran las solicitudes.',
  },
};

const fill = (s, vars) => String(s || '').replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? vars[k] : m));

export async function readWording(DB) {
  const saved = parse(await runtimeGet(DB, 'wording'), {}) || {};
  const out = {};
  for (const l of Object.keys(LANGS)) {
    out[l] = {
      subject: String(saved[l]?.subject || '').trim(),
      body: String(saved[l]?.body || '').trim(),
    };
  }
  return out;
}

export async function saveWording(DB, wording, now = Date.now()) {
  const clean = {};
  for (const l of Object.keys(LANGS)) {
    const subject = String(wording?.[l]?.subject || '').trim().slice(0, 200);
    const body = String(wording?.[l]?.body || '').trim().slice(0, 4000);
    if (subject || body) clean[l] = { subject, body };
  }
  await runtimeSet(DB, 'wording', JSON.stringify(clean), now);
  return readWording(DB);
}

/** Where the email's button goes: the site's form in their language, or the outside form staff set */
export function applyLink(settings, lang) {
  if (settings.formUrl) return settings.formUrl;
  return `${SITE_ORIGIN}/apply/form/${lang === 'es' ? '?lang=es' : ''}`;
}

function photoUrl(id) {
  if (!id) return null;
  if (/^https:\/\//.test(id)) return id;
  return `${SITE_ORIGIN}/cdn-cgi/imagedelivery/ROYFuPmfN2vPS6mt5sCkZQ/${String(id).split('/').map(encodeURIComponent).join('/')}/w=1200,h=630,fit=cover,gravity=face,q=82`;
}

const Y = '#FFDA24';
const D = '#2D2E33';
const CREAM = '#FEFCF5';

function paragraphs(text) {
  return String(text || '').split(/\n{2,}/).map(p => p.trim()).filter(Boolean)
    .map(p => `<p style="margin:0 0 16px;">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('');
}

function shell({ lang, preheader, heading, bodyHtml, cta, ctaUrl, image, footerHtml }) {
  const w = WORDS[lang] || WORDS.en;
  const img = image
    ? `<tr><td style="padding:0;"><img src="${escapeHtml(image)}" width="600" alt="" style="display:block;width:100%;max-width:600px;height:auto;" /></td></tr>`
    : '';
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(heading)}</title></head>
<body style="margin:0;padding:0;background:#F5F4F0;font-family:Outfit,Helvetica,Arial,sans-serif;color:${D};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader || '')}</div>
<center style="width:100%;background:#F5F4F0;padding:32px 0;">
<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600" style="margin:0 auto;max-width:600px;background:${CREAM};border-radius:16px;overflow:hidden;">
${img}
<tr><td style="padding:32px 32px 8px;">
  <div style="font-size:12px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#8A7200;">${escapeHtml(w.eyebrow)}</div>
  <h1 style="font-family:'Libre Baskerville',Georgia,serif;font-size:28px;line-height:1.2;margin:12px 0 16px;">${escapeHtml(heading)}</h1>
  <div style="font-size:16px;line-height:1.6;">${bodyHtml}</div>
</td></tr>
<tr><td style="padding:8px 32px 32px;">
  <a href="${escapeHtml(ctaUrl)}" style="display:inline-block;background:${Y};color:${D};font-weight:700;text-decoration:none;padding:14px 24px;border-radius:10px;font-size:16px;">${escapeHtml(cta)}</a>
</td></tr>
<tr><td style="padding:16px 32px 28px;font-size:12px;line-height:1.5;color:#6B6C72;border-top:1px solid #E5E4E0;">${footerHtml}</td></tr>
</table></center></body></html>`;
}

/**
 * The email that says applications are open. `list` = sent through Kit (Kit
 * fills in the unsubscribe link); otherwise straight from the site.
 */
export function openingEmail({ lang = 'en', settings, wording = null, list = true }) {
  const l = LANGS[lang] ? lang : 'en';
  const w = WORDS[l];
  const own = wording?.[l] || {};
  const vars = { year: settings.year };
  const subject = fill(own.subject || DEFAULT_WORDING[l].subject, vars);
  const body = fill(own.body || DEFAULT_WORDING[l].body, vars);
  const ctaUrl = applyLink(settings, l);
  const footerHtml = list
    ? `${escapeHtml(w.listFooter)} <a href="{{ unsubscribe_url }}" style="color:#6B6C72;">${escapeHtml(w.unsubscribe)}</a>.`
    : escapeHtml(w.directFooter);
  const html = shell({
    lang: l, preheader: fill(w.openPreheader, vars), heading: w.openHeading, bodyHtml: paragraphs(body),
    cta: w.openCta, ctaUrl, image: photoUrl(settings.heroPhoto), footerHtml,
  });
  const text = `${w.openHeading}\n\n${body}\n\n${w.openCta}: ${ctaUrl}\n\n${list ? `${w.listFooter} ${w.unsubscribe}: {{ unsubscribe_url }}` : w.directFooter}`;
  return { subject, html, text, ctaUrl };
}

export function confirmationEmail({ lang = 'en' }) {
  const l = LANGS[lang] ? lang : 'en';
  const w = WORDS[l];
  const ctaUrl = l === 'es' ? `${SITE_ORIGIN}/apply/form/?lang=es` : `${SITE_ORIGIN}/apply/#how-it-works`;
  const html = shell({
    lang: l, preheader: w.confirmPreheader, heading: w.confirmHeading, bodyHtml: paragraphs(w.confirmBody),
    cta: w.confirmCta, ctaUrl, image: null, footerHtml: escapeHtml(w.confirmFooter),
  });
  return { subject: w.confirmSubject, html, text: `${w.confirmHeading}\n\n${w.confirmBody}\n\n${w.confirmCta}: ${ctaUrl}\n\n${w.confirmFooter}` };
}

// ─── Staff notices (email + Slack) ──────────────────────────────────

const when = (ms) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).format(new Date(ms));
const day = (ms) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'short', day: 'numeric' }).format(new Date(ms));
const families = (n) => `${n} ${n === 1 ? 'family' : 'families'}`;
const split = (counts) => Object.entries(counts || {}).filter(([, n]) => n > 0).map(([l, n]) => `${n} in ${l === 'es' ? 'Spanish' : 'English'}`).join(', ');

async function staffList(env, year, { problem = false } = {}) {
  let staff = [];
  try { staff = (await formFor(env.DB, { year })).staffEmails || []; } catch { /* the built-in list */ }
  return [...new Set([...(staff || []), ...(problem ? applications.ALERT_EMAILS : [])].filter(isEmail))];
}

/**
 * Tell staff by email and Slack. `links` [{ label, url }] go under the
 * waitlist button in both. `kind` 'news' is for the good news (the email is
 * going out, it went); everything else needs attention. Never throws.
 */
export function staffNoticeEmail({ title, detail, links = [] }) {
  const more = links.map(l => `<a href="${escapeHtml(l.url)}" style="color:#373A36">${escapeHtml(l.label)}</a>`).join(' &nbsp;·&nbsp; ');
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#373A36;max-width:560px">
<p><strong>${escapeHtml(title)}</strong></p><p>${escapeHtml(detail || '').replace(/\n/g, '<br>')}</p>
<p><a href="${ADMIN_URL}" style="display:inline-block;background:#FFDA24;color:#373A36;padding:10px 20px;border-radius:999px;text-decoration:none;font-weight:bold">Open the waitlist</a></p>${more ? `<p>${more}</p>` : ''}</div>`;
  const text = `${title}\n\n${detail || ''}\n\n${ADMIN_URL}${links.map(l => `\n${l.label}: ${l.url}`).join('')}`;
  return { subject: title, html, text };
}

export async function tellStaff(env, { year, level = 'info', title, detail, problem = false, links = [], kind = 'attention' }) {
  const to = await staffList(env, year, { problem });
  const { html, text } = staffNoticeEmail({ title, detail, links });
  await Promise.all([
    to.length && emailConfigured(env)
      ? sendEmails(env, { to, subject: title, html, text, tags: [{ name: 'type', value: 'application-waitlist' }] }).catch(() => null)
      : null,
    slackPost(env, slackCard({
      icon: level === 'warn' ? '⚠️' : '📨',
      title,
      lead: detail,
      buttons: [{ label: 'Open the waitlist', url: ADMIN_URL }, ...links],
      footer: 'Applications waitlist',
    }), { kind }).catch(() => null),
  ]);
}

// ─── Signups ────────────────────────────────────────────────────────

function signupRow(r) {
  if (!r) return null;
  return {
    email: r.email, lang: r.lang || 'en', page: r.page || null, createdAt: r.created_at, updatedAt: r.updated_at,
    kit: r.kit_id ? (r.kit_state || 'active') : (r.kit_error ? 'error' : 'pending'),
    kitError: r.kit_error || null, confirmedAt: r.confirmed_at || null,
    notifiedAt: r.notified_at || null, notifiedVia: r.notified_via || null, openingId: r.opening_id || null,
    removedAt: r.removed_at || null,
  };
}

const WAITING_SQL = `opening_id IS NULL AND removed_at IS NULL
  AND (fallback = 1 OR kit_state IS NULL OR kit_state NOT IN ('cancelled', 'bounced', 'complained'))`;

/** Put the address in Kit with the waitlist tags; records the outcome on the row. Never throws. */
async function syncToKit(env, email, { now = Date.now() } = {}) {
  const { DB } = env;
  const row = await DB.prepare('SELECT * FROM waitlist_signups WHERE email = ?').bind(email).first();
  if (!row || row.removed_at) return { ok: false };
  const fail = async (error) => {
    const tries = (Number(row.kit_tries) || 0) + 1;
    const wait = SIGNUP_RETRY_MS[Math.min(tries - 1, SIGNUP_RETRY_MS.length - 1)];
    await DB.prepare('UPDATE waitlist_signups SET kit_error = ?, kit_tries = ?, next_try_at = ?, updated_at = ? WHERE email = ?')
      .bind(String(error).slice(0, 300), tries, now + wait, iso(now), email).run();
    return { ok: false, error };
  };
  if (!kitConfigured(env)) return fail('KIT_API_KEY is not set');
  const sub = await kitUpsertSubscriber(env, email);
  if (!sub.ok) return fail(sub.error);
  const tagId = await kitTagId(env, WAITLIST_TAG);
  if (!tagId) return fail('Kit: could not find or make the Application Waitlist tag');
  if (!(await kitTagSubscriberId(env, tagId, sub.id))) return fail('Kit: could not tag the subscriber');
  if (sub.created) {
    // New to Kit: only here for the opening, so list mail leaves them out (best effort)
    const onlyId = await kitTagId(env, WAITLIST_ONLY_TAG);
    if (onlyId) await kitTagSubscriberId(env, onlyId, sub.id);
  }
  // Unsubscribed from Kit before but asked again just now: Kit won't email them, the site will
  const fallback = BAD_KIT_STATES.includes(sub.state) ? 1 : (Number(row.fallback) || 0);
  await DB.prepare(`UPDATE waitlist_signups SET kit_id = ?, kit_state = ?, kit_synced_at = ?, kit_error = NULL, kit_tries = 0,
      next_try_at = NULL, alerted_at = NULL, fallback = ?, updated_at = ? WHERE email = ?`)
    .bind(sub.id, sub.state, iso(now), fallback, iso(now), email).run();
  return { ok: true, id: sub.id, state: sub.state };
}

/**
 * A signup from the website sends at most one email to an address a day
 * (the confirmation, or the link when applications are open), so the form
 * can't be used to fill a stranger's inbox. Staff adding a family isn't capped.
 */
const SIGNUP_EMAILS_PER_DAY = 1;
async function mayEmailNow(DB, email, by, now) {
  if (by) return true;
  const key = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(email))))
    .slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('');
  return (await limit(DB, `waitlist-mail:${key}`, SIGNUP_EMAILS_PER_DAY, 86400, { now })).ok;
}

/**
 * A family asks to hear when applications open.
 * → { ok, status: 'added' | 'already' | 'open', formUrl?, emailed? }
 *   'open': applications are open right now; they were shown the link and
 *   emailed it. Throws only when D1 itself fails (the caller falls back to Kit).
 */
export async function recordSignup(env, { email, lang = 'en', page = 'apply', confirm = true, now = Date.now(), by = null }) {
  const { DB } = env;
  email = cleanEmail(email);
  lang = cleanLang(lang);
  if (!isEmail(email)) return { ok: false, error: 'invalid email' };
  await ensureWaitlistSchema(DB);
  const settings = await readAppSettings(DB, now);
  const existing = await DB.prepare('SELECT * FROM waitlist_signups WHERE email = ?').bind(email).first();

  if (settings.open) {
    // Nothing to wait for: show the link and send it, once per opening
    const op = await latestOpening(DB);
    const openingId = op && ACTIVE.concat('sent').includes(op.state) ? op.id : `open-${iso(now).slice(0, 10)}`;
    const told = existing && existing.opening_id === openingId && !existing.removed_at;
    let emailed = false;
    if (!told) {
      const msg = openingEmail({ lang, settings, wording: await readWording(DB), list: false });
      const r = emailConfigured(env) && await mayEmailNow(DB, email, by, now)
        ? await sendEmails(env, { to: [email], subject: msg.subject, html: msg.html, text: msg.text, tags: [{ name: 'type', value: 'application-open' }] })
        : { sent: 0 };
      emailed = r.sent > 0;
      await DB.prepare(`INSERT INTO waitlist_signups (email, lang, page, created_at, updated_at, opening_id, notified_at, notified_via)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(email) DO UPDATE SET lang = excluded.lang, page = excluded.page, updated_at = excluded.updated_at,
            opening_id = excluded.opening_id, notified_at = excluded.notified_at, notified_via = excluded.notified_via,
            pending_opening = NULL, removed_at = NULL, removed_by = NULL`)
        .bind(email, lang, page, iso(now), iso(now), emailed ? openingId : null, emailed ? iso(now) : null, emailed ? 'email' : null).run();
    }
    return { ok: true, status: 'open', formUrl: applyLink(settings, lang), emailed };
  }

  const waiting = existing && !existing.opening_id && !existing.removed_at;
  if (waiting) {
    await DB.prepare('UPDATE waitlist_signups SET lang = ?, updated_at = ? WHERE email = ?').bind(lang, iso(now), email).run();
  } else {
    // New, or told about an earlier opening / removed: waiting again from today
    await DB.prepare(`INSERT INTO waitlist_signups (email, lang, page, created_at, updated_at, next_try_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(email) DO UPDATE SET lang = excluded.lang, page = excluded.page, created_at = excluded.created_at,
          updated_at = excluded.updated_at, opening_id = NULL, notified_at = NULL, notified_via = NULL,
          pending_opening = NULL, kit_snapshot = NULL, confirmed_at = NULL, removed_at = NULL, removed_by = NULL,
          kit_tries = 0, next_try_at = excluded.next_try_at`)
      .bind(email, lang, page, iso(now), iso(now), now).run();
  }

  // Kit now (retried by the heartbeat if it fails), then the confirmation, side by side
  const row = await DB.prepare('SELECT * FROM waitlist_signups WHERE email = ?').bind(email).first();
  let confirmed = !!row.confirmed_at;
  const [kit] = await Promise.all([
    row.kit_id && row.kit_state === 'active' && !row.kit_error ? { ok: true } : syncToKit(env, email, { now }),
    confirm && !row.confirmed_at && emailConfigured(env)
      ? (async () => {
        if (!(await mayEmailNow(DB, email, by, now))) return;
        const msg = confirmationEmail({ lang });
        const r = await sendEmails(env, { to: [email], ...msg, tags: [{ name: 'type', value: 'application-waitlist' }] });
        await noteResend(DB, { ok: r.sent > 0, error: r.errors?.[0] }, now);
        if (r.sent) {
          confirmed = true;
          await DB.prepare('UPDATE waitlist_signups SET confirmed_at = ? WHERE email = ?').bind(iso(now), email).run();
        }
      })().catch(() => {})
      : null,
  ]);
  if (by) await logAction(DB, by, `added ${email} to the waitlist`);
  return { ok: true, status: waiting ? 'already' : 'added', kit: !!kit?.ok, confirmed };
}

/** Staff take an address off the waitlist (and its Kit waitlist tag). */
export async function removeSignup(env, email, { by = 'admin', now = Date.now() } = {}) {
  const { DB } = env;
  email = cleanEmail(email);
  await ensureWaitlistSchema(DB);
  const row = await DB.prepare('SELECT * FROM waitlist_signups WHERE email = ?').bind(email).first();
  if (!row) return { ok: false, error: 'Not on the waitlist' };
  await DB.prepare('UPDATE waitlist_signups SET removed_at = ?, removed_by = ?, pending_opening = NULL, next_try_at = NULL, updated_at = ? WHERE email = ?')
    .bind(iso(now), by, iso(now), email).run();
  if (row.kit_id && kitConfigured(env)) {
    const tagId = await kitTagId(env, WAITLIST_TAG, { create: false });
    if (tagId) await kitUntagSubscriber(env, tagId, row.kit_id);
  }
  await logAction(DB, by, `removed ${email} from the waitlist`);
  return { ok: true };
}

/** Signups whose Kit step failed, retried with backoff. Staff hear once a day if some stay stuck. */
async function retrySignups(env, now) {
  const { DB } = env;
  const { results } = await DB.prepare(`SELECT email FROM waitlist_signups
      WHERE removed_at IS NULL AND opening_id IS NULL AND next_try_at IS NOT NULL AND next_try_at <= ?
      ORDER BY next_try_at LIMIT 5`).bind(now).all();
  for (const r of results || []) await syncToKit(env, r.email, { now });
  const stuck = await DB.prepare(`SELECT COUNT(*) AS n, MIN(kit_error) AS error FROM waitlist_signups
      WHERE removed_at IS NULL AND opening_id IS NULL AND kit_error IS NOT NULL AND kit_tries >= ?
        AND (alerted_at IS NULL OR alerted_at < ?)`).bind(SIGNUP_ALERT_AFTER, iso(now - 24 * 3600e3)).first();
  if (stuck?.n > 0) {
    const settings = await readAppSettings(DB, now);
    await tellStaff(env, {
      year: settings.year, level: 'warn', problem: true,
      title: `${families(stuck.n)} on the waitlist couldn't be added to Kit`,
      detail: `${stuck.error}. Their emails are saved on the site and it keeps trying. When applications open they still get the email: the site sends it to them itself if Kit can't.`,
    });
    await DB.prepare('UPDATE waitlist_signups SET alerted_at = ? WHERE removed_at IS NULL AND opening_id IS NULL AND kit_error IS NOT NULL AND kit_tries >= ?')
      .bind(iso(now), SIGNUP_ALERT_AFTER).run();
  }
}

/**
 * Read Kit's waitlist tag in: signups from before this existed, and anyone
 * who unsubscribed in Kit since (so they're left out). Never throws.
 */
export async function importFromKit(env, { now = Date.now(), pages = 3 } = {}) {
  const { DB } = env;
  if (!kitConfigured(env)) return { ok: false, error: 'KIT_API_KEY is not set' };
  const tagId = await kitTagId(env, WAITLIST_TAG, { create: false });
  if (!tagId) { await runtimeSet(DB, 'imported', now, now); return { ok: true, added: 0, seen: 0 }; }
  let after = null;
  let added = 0;
  let seen = 0;
  for (let p = 0; p < pages; p++) {
    const page = await kitTagSubscribersPage(env, tagId, { after });
    if (!page.ok) return { ok: false, error: page.error, added, seen };
    const stmts = [];
    for (const s of page.subscribers) {
      if (!isEmail(s.email)) continue;
      seen++;
      const at = s.taggedAt && !Number.isNaN(Date.parse(s.taggedAt)) ? iso(Date.parse(s.taggedAt)) : iso(now);
      stmts.push(DB.prepare(`INSERT INTO waitlist_signups (email, lang, page, created_at, updated_at, kit_id, kit_state, kit_synced_at)
          VALUES (?, 'en', 'kit', ?, ?, ?, ?, ?)
          ON CONFLICT(email) DO UPDATE SET kit_id = COALESCE(waitlist_signups.kit_id, excluded.kit_id),
            kit_state = CASE WHEN waitlist_signups.fallback = 1 THEN waitlist_signups.kit_state ELSE excluded.kit_state END,
            kit_synced_at = excluded.kit_synced_at`)
        .bind(s.email, at, iso(now), s.id, s.state || 'active', iso(now)));
    }
    if (stmts.length) {
      const before = (await DB.prepare('SELECT COUNT(*) AS n FROM waitlist_signups').first())?.n || 0;
      await DB.batch(stmts);
      added += ((await DB.prepare('SELECT COUNT(*) AS n FROM waitlist_signups').first())?.n || 0) - before;
    }
    if (!page.next) break;
    after = page.next;
  }
  await runtimeSet(DB, 'imported', now, now);
  return { ok: true, added, seen };
}

// ─── Is everything it needs connected? ──────────────────────────────

const HEALTH_EVERY_MS = 6 * 3600 * 1000;

/**
 * Ask Kit directly: is the key good, can the account send, how many are on
 * its waitlist tag. Saved for the admin panel. While families are waiting,
 * a failure is told to staff at once (then daily), not found on opening day.
 */
export async function checkKit(env, { now = Date.now(), alert = true } = {}) {
  const { DB } = env;
  const acct = await kitAccount(env);
  let tagCount = null;
  if (acct.ok) {
    const aud = await kitListAudiences(env).catch(() => null);
    tagCount = aud?.ok ? (aud.tags.find(t => t.name === WAITLIST_TAG)?.count ?? 0) : null;
  }
  const health = { ok: acct.ok && acct.from?.verified !== false, at: iso(now), name: acct.name || null, from: acct.from || null, tagCount, error: acct.ok ? (acct.from?.verified === false ? `Kit's sending address ${acct.from.email} isn't verified` : null) : acct.error };
  const prev = parse(await runtimeGet(DB, 'kit_health'), null);
  await runtimeSet(DB, 'kit_health', JSON.stringify({ ...health, alertedAt: health.ok ? null : prev?.alertedAt || null }), now);
  if (alert && !health.ok) {
    const waiting = (await waitingCounts(DB)).total;
    const last = Date.parse(prev?.alertedAt || '') || 0;
    if (waiting > 0 && now - last > 24 * 3600e3) {
      const settings = await readAppSettings(DB, now);
      await tellStaff(env, {
        year: settings.year, level: 'warn', problem: true,
        title: "Kit isn't working, and families are waiting to hear applications are open",
        detail: `${health.error}. ${families(waiting)} are on the waitlist. Their emails are saved on the site; fix Kit before applications open so the email goes through Kit (if it isn't fixed, the site emails them itself two hours after opening).`,
      });
      await runtimeSet(DB, 'kit_health', JSON.stringify({ ...health, alertedAt: iso(now) }), now);
    }
  }
  return health;
}

async function noteResend(DB, result, now) {
  await runtimeSet(DB, 'resend_last', JSON.stringify({ ok: !!result.ok, at: iso(now), error: result.ok ? null : String(result.error || '').slice(0, 200) }), now).catch(() => {});
}

// ─── Openings ───────────────────────────────────────────────────────

function openingRow(r) {
  if (!r) return null;
  return {
    ...r,
    counts: parse(r.counts, {}) || {},
    tags: parse(r.tags, {}) || {},
    broadcasts: parse(r.broadcasts, {}) || {},
    direct: parse(r.direct, null),
    stop: parse(r.stop, null),
  };
}

export async function latestOpening(DB) {
  return openingRow(await DB.prepare('SELECT * FROM waitlist_openings ORDER BY opened_at DESC, rowid DESC LIMIT 1').first());
}

async function saveOpening(DB, op, now) {
  await DB.prepare(`UPDATE waitlist_openings SET year = ?, state = ?, send_at = ?, total = ?, counts = ?, tags = ?, broadcasts = ?,
      direct = ?, checks = ?, tries = ?, next_try_at = ?, error = ?, error_since = ?, alerted = ?, by = ?, note = ?,
      sent_at = ?, finished_at = ?, staged_at = ?, stop = ?, updated_at = ? WHERE id = ?`)
    .bind(op.year, op.state, op.send_at ?? null, op.total || 0, JSON.stringify(op.counts || {}), JSON.stringify(op.tags || {}),
      JSON.stringify(op.broadcasts || {}), op.direct ? JSON.stringify(op.direct) : null, op.checks || 0, op.tries || 0,
      op.next_try_at ?? null, op.error ?? null, op.error_since ?? null, op.alerted ?? null, op.by ?? null, op.note ?? null,
      op.sent_at ?? null, op.finished_at ?? null, op.staged_at ?? null, op.stop ? JSON.stringify(op.stop) : null, iso(now), op.id).run();
}

async function waitingCounts(DB) {
  const { results } = await DB.prepare(`SELECT lang, COUNT(*) AS n FROM waitlist_signups WHERE ${WAITING_SQL} GROUP BY lang`).all();
  const counts = { en: 0, es: 0 };
  for (const r of results || []) counts[cleanLang(r.lang)] += r.n;
  return { total: counts.en + counts.es, counts };
}

/**
 * When the email goes: COUNTDOWN_MS after the switch was saved on (in case it
 * was a mistake), or right away when the schedule opened applications, since
 * a scheduled opening is nobody's slip.
 */
export function countdownEnd(settings, now) {
  if (settings.openChangedBy === 'schedule') return now;
  const from = settings.openChangedAt && settings.openChangedAt <= now && now - settings.openChangedAt < COUNTDOWN_MS ? settings.openChangedAt : now;
  return from + COUNTDOWN_MS;
}

async function createOpening(env, { settings, now, sendAt, by = 'automatic' }) {
  const { DB } = env;
  const w = await waitingCounts(DB);
  const id = `op_${now.toString(36)}`;
  await DB.prepare(`INSERT INTO waitlist_openings (id, year, state, opened_at, send_at, total, counts, tags, broadcasts, by, updated_at)
      VALUES (?, ?, 'countdown', ?, ?, ?, ?, '{}', '{}', ?, ?)`)
    .bind(id, settings.year, iso(now), sendAt, w.total, JSON.stringify(w.counts), by, iso(now)).run();
  const op = await latestOpening(DB);
  if (sendAt > now) {
    await tellStaff(env, {
      year: settings.year,
      title: `Applications are open: the waitlist email goes out at ${when(sendAt)}`,
      detail: `${families(w.total)} asked to hear when ${settings.year} applications open (${split(w.counts)}). They get the email at ${when(sendAt)}. Turned it on by mistake? Turn applications off before then, or press "Don't send this time" in the admin, and nobody is emailed.`,
    });
  }
  return op;
}

/**
 * Take back everything staged for this opening: delete its Kit emails and
 * cancel the site's scheduled ones. → { ok } when nothing is left to go out,
 * { ok: false, tooLate } when Kit already started sending, or a transient error.
 */
async function unstage(env, op, now) {
  const { DB } = env;
  for (const lang of Object.keys(LANGS)) {
    const b = op.broadcasts?.[lang];
    if (!b?.id) continue;
    const r = await kitDeleteBroadcast(env, b.id);
    if (!r.ok) return { ok: false, tooLate: !!r.tooLate, error: r.error };
    op.broadcasts = { ...op.broadcasts, [lang]: {} };
    await saveOpening(DB, op, now);
  }
  const scheduled = op.direct?.scheduled || [];
  const left = [];
  for (const x of scheduled) {
    const r = await cancelScheduledEmail(env, x.id);
    if (!r.ok) left.push(x);
  }
  op.direct = { ...(op.direct || {}), scheduled: left, sent: Math.max(0, (op.direct?.sent || 0) - (scheduled.length - left.length)) };
  if (left.length) { await saveOpening(DB, op, now); return { ok: false, error: `Resend: ${left.length} scheduled ${left.length === 1 ? 'email' : 'emails'} couldn't be cancelled` }; }
  // Nobody has been told after all: back to waiting for this opening
  await DB.prepare(`UPDATE waitlist_signups SET opening_id = NULL, notified_at = NULL, notified_via = NULL, pending_opening = ?
      WHERE opening_id = ?`).bind(op.id, op.id).run();
  op.staged_at = null;
  op.broadcasts = { ...(op.broadcasts || {}), checked: op.broadcasts?.checked || false };
  await saveOpening(DB, op, now);
  return { ok: true };
}

/**
 * Stop an opening that hasn't gone out: 'cancel' (applications closed again)
 * or 'hold' (staff: not this time). If Kit can't be reached it keeps trying
 * every minute until the send time, and staff hear how to stop it in Kit.
 */
async function stopOpening(env, op, { now, mode, why, by = null }) {
  const { DB } = env;
  const r = await unstage(env, op, now);
  if (!r.ok && r.tooLate) {
    await finishSending(env, op, now, { note: `${mode === 'hold' ? 'Put on hold' : 'Applications closed'} after Kit had started sending, so it went out.` });
    return { ok: false, error: 'Too late: Kit had already started sending it.' };
  }
  if (!r.ok) {
    op.stop = { mode, why, by, tries: (op.stop?.tries || 0) + 1 };
    op.error = `Couldn't take the scheduled email back yet (${r.error}). Trying again every minute`;
    op.next_try_at = null;
    if (op.stop.tries === 2) {
      const kit = Object.entries(op.broadcasts || {}).filter(([, b]) => b?.id).map(([lang, b]) => ({ lang, url: `https://app.kit.com/campaigns/${b.id}` }));
      await tellStaff(env, {
        year: op.year, level: 'warn', problem: true, title: 'The applications-open email may still go out',
        detail: `It was ${mode === 'hold' ? 'put on hold' : 'stopped because applications closed'}, but the site can't reach Kit to take it back (${r.error}). It keeps trying. To be sure, delete it in Kit before ${when(op.send_at)}.`,
        links: kit.map(k => ({ label: kit.length > 1 ? `Open in Kit (${k.lang === 'es' ? 'Spanish' : 'English'})` : 'Open in Kit', url: k.url })),
      });
    }
    await saveOpening(DB, op, now);
    return { ok: false, error: op.error };
  }
  op.stop = null;
  op.error = null;
  op.error_since = null;
  op.tries = 0;
  if (mode === 'hold') {
    op.state = 'held';
    op.by = by || op.by;
    await saveOpening(DB, op, now);
    await tellStaff(env, { year: op.year, title: 'The applications-open email is on hold', detail: `${by || 'Someone'} chose not to send it this time. The ${families(op.total)} waiting stay on the list. Press Send now in the admin to send it after all.` });
    return { ok: true };
  }
  op.state = 'cancelled';
  op.note = why;
  op.finished_at = iso(now);
  op.next_try_at = null;
  await saveOpening(DB, op, now);
  await DB.prepare('UPDATE waitlist_signups SET pending_opening = NULL, kit_snapshot = NULL WHERE pending_opening = ? AND opening_id IS NULL').bind(op.id).run();
  await tellStaff(env, { year: op.year, title: 'The applications-open email was not sent', detail: `${why} The ${families(op.total)} waiting are still on the list for when applications open.` });
  return { ok: true };
}

/** A step failed: try again later, tell staff after a few tries (once per problem) */
async function openingProblem(env, op, error, now) {
  op.tries = (op.tries || 0) + 1;
  op.error = String(error).slice(0, 400);
  op.error_since ||= now;
  op.next_try_at = now + OPENING_RETRY_MS[Math.min(op.tries - 1, OPENING_RETRY_MS.length - 1)];
  const key = op.error.slice(0, 120);
  if (op.tries >= OPENING_ALERT_AFTER && op.alerted !== key) {
    op.alerted = key;
    await tellStaff(env, {
      year: op.year, level: 'warn', problem: true,
      title: "The applications-open email isn't ready yet",
      detail: `${op.error}. The site keeps trying on its own${kitConfigured(env) ? '' : '; add KIT_API_KEY in Cloudflare → soard-site → Settings → Variables'}. If Kit still can't take it by ${when((op.error_since || now) + KIT_GIVE_UP_MS)}, the site emails each family itself.`,
    });
  }
  await saveOpening(env.DB, op, now);
}

async function formSaysOpen(env, fetchImpl) {
  try {
    const res = await fetchImpl(`${env.SITE_ORIGIN || SITE_ORIGIN}/apply/form/`, { headers: { 'user-agent': 'soard-waitlist-check' }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const htmlText = await res.text();
    const m = htmlText.match(/id="af-config">([\s\S]*?)<\/script>/);
    if (!m) return null; // can't tell from here (the page asks the API itself): trust the setting
    return parse(m[1].replace(/\\u003c/g, '<'), {})?.open === true;
  } catch {
    return null;
  }
}

// ─── The site's own sends (Resend), now or at the send time ────────

/** One email at `at` (ISO), held by Resend until then → { ok, id } */
async function scheduleEmail(env, { to, subject, html, text, at }) {
  try {
    const res = await fetch(`${RESEND_API}/emails`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: EMAIL_FROM, to: [to], subject, html, text, scheduled_at: at, tags: [{ name: 'type', value: 'application-open' }] }),
      signal: AbortSignal.timeout(15000),
    });
    const body = await res.json().catch(() => ({}));
    return res.ok && body.id ? { ok: true, id: body.id } : { ok: false, error: `Resend ${res.status}: ${JSON.stringify(body).slice(0, 160)}` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function cancelScheduledEmail(env, id) {
  try {
    const res = await fetch(`${RESEND_API}/emails/${encodeURIComponent(id)}/cancel`, {
      method: 'POST', headers: { Authorization: `Bearer ${env.RESEND_API_KEY}` }, signal: AbortSignal.timeout(15000),
    });
    return { ok: res.ok || res.status === 404 };
  } catch {
    return { ok: false };
  }
}

/**
 * Email families straight from the site (Kit can't reach them): held by
 * Resend until `sendAt` when that's still ahead (so a cancel can take it
 * back), else right now. Marks who's covered.
 */
async function sendDirect(env, op, rows, settings, now, { sendAt = now } = {}) {
  const { DB } = env;
  if (!rows.length) return { sent: 0, failed: 0 };
  const wording = await readWording(DB);
  const out = { sent: 0, failed: 0, errors: [] };
  const later = sendAt - now > KIT_SEND_DELAY_MS && emailConfigured(env);
  const scheduled = [...(op.direct?.scheduled || [])];
  for (const lang of Object.keys(LANGS)) {
    const group = rows.filter(r => cleanLang(r.lang) === lang);
    if (!group.length) continue;
    const msg = openingEmail({ lang, settings, wording, list: false });
    if (later) {
      for (const x of group.slice(0, 25)) { // the rest next tick
        const r = await scheduleEmail(env, { to: x.email, subject: msg.subject, html: msg.html, text: msg.text, at: iso(sendAt) });
        if (r.ok) {
          out.sent++;
          scheduled.push({ email: x.email, id: r.id });
          await DB.prepare(`UPDATE waitlist_signups SET opening_id = ?, notified_at = ?, notified_via = 'email', pending_opening = NULL WHERE email = ?`).bind(op.id, iso(sendAt), x.email).run();
        } else { out.failed++; out.errors.push(r.error); }
      }
      continue;
    }
    for (let i = 0; i < group.length; i += 50) {
      const chunk = group.slice(i, i + 50);
      const r = await sendEmails(env, { to: chunk.map(x => x.email), subject: msg.subject, html: msg.html, text: msg.text, tags: [{ name: 'type', value: 'application-open' }] });
      out.sent += r.sent;
      out.failed += r.failed;
      if (r.errors?.length) out.errors.push(r.errors[0]);
      if (r.sent) {
        await DB.batch(chunk.map(x => DB.prepare(`UPDATE waitlist_signups SET opening_id = ?, notified_at = ?, notified_via = 'email', pending_opening = NULL WHERE email = ?`).bind(op.id, iso(now), x.email)));
      }
    }
  }
  const prev = op.direct || { sent: 0, failed: 0 };
  op.direct = { ...prev, scheduled, sent: (prev.sent || 0) + out.sent, failed: out.failed, error: out.errors[0] || null };
  return out;
}

const pendingRows = async (DB, op, extra = '', binds = []) =>
  (await DB.prepare(`SELECT * FROM waitlist_signups WHERE pending_opening = ? AND opening_id IS NULL AND removed_at IS NULL ${extra}`).bind(op.id, ...binds).all()).results || [];

/**
 * Get the email ready, as far as this call allows: freeze who's waiting,
 * check the form, get everyone into Kit and this opening's tag, then hand Kit
 * one email per language scheduled for the send time (and Resend the ones
 * Kit can't reach). Runs from the moment applications open, so by the end of
 * the countdown Kit already holds the email and sends it on its own, even if
 * nothing here runs again. Every step is remembered; the next call carries on.
 * → true once everything is staged.
 */
async function stage(env, op, { now, fetchImpl }) {
  const { DB } = env;
  const settings = await readAppSettings(DB, now);
  op.year = settings.year;
  // Kit wants a send time a moment ahead; past the countdown, that's now
  const sendAtMs = Math.max(op.send_at || now, now + KIT_SEND_DELAY_MS);

  if (!op.counts?.frozen) {
    // Kit's tag first, so families who signed up before the site kept its own list are in
    if (kitConfigured(env)) await importFromKit(env, { now });
    // (anyone an earlier opening couldn't reach is still waiting, so they're in this one too)
    await DB.prepare(`UPDATE waitlist_signups SET pending_opening = ? WHERE ${WAITING_SQL}`).bind(op.id).run();
    const { results } = await DB.prepare('SELECT lang, COUNT(*) AS n FROM waitlist_signups WHERE pending_opening = ? GROUP BY lang').bind(op.id).all();
    const counts = { en: 0, es: 0 };
    for (const r of results || []) counts[cleanLang(r.lang)] += r.n;
    op.counts = { ...counts, frozen: true };
    op.total = counts.en + counts.es;
    await saveOpening(DB, op, now);
  }
  if (!op.total) {
    op.state = 'sent';
    op.note = 'Nobody was waiting.';
    op.finished_at = iso(now);
    await saveOpening(DB, op, now);
    return false;
  }

  // The link has to work: the form must really be open
  if (!op.broadcasts?.checked) {
    const open = await formSaysOpen(env, fetchImpl);
    if (open === false) {
      op.checks = (op.checks || 0) + 1;
      op.error = 'The application form still shows closed, so the email is waiting for it';
      if (op.checks === FORM_CHECKS) {
        await tellStaff(env, { year: op.year, level: 'warn', problem: true, title: 'The applications-open email is waiting on the form', detail: `Applications are switched on, but the application form still shows the closed message after ${FORM_CHECKS} minutes. The email goes as soon as the form opens.`, links: [{ label: 'See the form', url: `${SITE_ORIGIN}/apply/form/` }] });
      }
      op.next_try_at = now + 60e3;
      await saveOpening(DB, op, now);
      return false;
    }
    op.broadcasts = { ...(op.broadcasts || {}), checked: true };
    op.error = null;
    op.checks = 0;
  }

  const kitGaveUp = op.error_since && now - op.error_since >= KIT_GIVE_UP_MS;
  if (!kitConfigured(env) || kitGaveUp) {
    if (!kitGaveUp) { await openingProblem(env, op, 'Kit is not connected (KIT_API_KEY is not set)', now); return false; }
    // Kit has had its chance: the families get their email from the site
    const r = await sendDirect(env, op, await pendingRows(DB, op), settings, now, { sendAt: sendAtMs });
    if (r.failed && !r.sent) { await openingProblem(env, op, `The site couldn't email the families either: ${op.direct?.error || 'unknown error'}`, now); return false; }
    if ((await pendingRows(DB, op)).length) { await saveOpening(DB, op, now); return false; }
    op.note = 'Kit could not take it, so the site emails each family itself.';
    return markStaged(env, op, now);
  }

  // Everyone in Kit (most already are from signup; anyone whose Kit step failed tries again)
  const missing = await pendingRows(DB, op, 'AND kit_id IS NULL AND fallback = 0 LIMIT ?', [UPSERTS_PER_TICK]);
  for (const r of missing) {
    const out = await syncToKit(env, r.email, { now });
    if (!out.ok) {
      const row = await DB.prepare('SELECT kit_tries FROM waitlist_signups WHERE email = ?').bind(r.email).first();
      if ((row?.kit_tries || 0) >= 3) await DB.prepare('UPDATE waitlist_signups SET fallback = 1 WHERE email = ?').bind(r.email).run();
    }
  }
  if (missing.length === UPSERTS_PER_TICK) { await saveOpening(DB, op, now); return false; } // more next time

  // This opening's tag per language, then everyone into it (100 a call)
  const date = day(Date.parse(op.opened_at));
  let calls = 0;
  for (const lang of Object.keys(LANGS)) {
    if (!(op.counts?.[lang] > 0)) continue;
    if (!op.tags?.[lang]) {
      const id = await kitTagId(env, `Applications open email ${op.year} ${LANGS[lang]} (${date}, ${op.id.slice(-5)})`);
      if (!id) { await openingProblem(env, op, "Kit: couldn't make the tag for this email", now); return false; }
      op.tags = { ...(op.tags || {}), [lang]: id };
      await saveOpening(DB, op, now);
    }
    for (;;) {
      if (calls >= BULK_CALLS_PER_TICK) { await saveOpening(DB, op, now); return false; }
      const batch = await pendingRows(DB, op, `AND lang = ? AND kit_id IS NOT NULL AND fallback = 0
          AND (kit_snapshot IS NULL OR kit_snapshot != ?) AND (kit_state IS NULL OR kit_state = 'active') LIMIT 100`, [lang, op.id]);
      if (!batch.length) break;
      calls++;
      const r = await kitBulkTag(env, op.tags[lang], batch.map(x => x.kit_id));
      if (!r.ok) { await openingProblem(env, op, r.error, now); return false; }
      const byId = new Map(batch.map(x => [Number(x.kit_id), x.email]));
      const stmts = [
        ...r.tagged.map(id => DB.prepare('UPDATE waitlist_signups SET kit_snapshot = ? WHERE email = ?').bind(op.id, byId.get(id))),
        ...r.failed.map(id => DB.prepare('UPDATE waitlist_signups SET fallback = 1 WHERE email = ?').bind(byId.get(id))),
      ].filter(Boolean);
      if (stmts.length) await DB.batch(stmts);
    }
  }

  // One broadcast per language, to exactly this opening's tag, scheduled for
  // the send time, once nobody in that language is still on the way into it
  // (a failed Kit step gets three tries before the site takes that family over)
  const wording = await readWording(DB);
  let waitingOnKit = false;
  for (const lang of Object.keys(LANGS)) {
    const b = op.broadcasts?.[lang] || {};
    if (b.id) continue;
    const onTheWay = (await DB.prepare(`SELECT COUNT(*) AS n FROM waitlist_signups WHERE pending_opening = ? AND opening_id IS NULL AND removed_at IS NULL
        AND lang = ? AND fallback = 0 AND (kit_state IS NULL OR kit_state = 'active') AND (kit_id IS NULL OR kit_snapshot IS NULL OR kit_snapshot != ?)`)
      .bind(op.id, lang, op.id).first())?.n || 0;
    if (onTheWay) { waitingOnKit = true; continue; }
    const tagged = (await DB.prepare('SELECT COUNT(*) AS n FROM waitlist_signups WHERE pending_opening = ? AND kit_snapshot = ? AND lang = ? AND opening_id IS NULL')
      .bind(op.id, op.id, lang).first())?.n || 0;
    if (!tagged) continue;
    const description = `[auto] Applications open ${op.year} (${LANGS[lang]}) #${op.id}`;
    if (b.pendingAt) {
      // A create that may have reached Kit without our hearing back: adopt it rather than send twice
      const list = await kitListBroadcasts(env).catch(() => null);
      const hit = list?.ok ? list.broadcasts.find(x => x.name === description && x.status !== 'cancelled') : null;
      if (hit) {
        op.broadcasts = { ...op.broadcasts, [lang]: { id: hit.id, sendAt: b.sendAt || iso(sendAtMs), recipients: tagged } };
        await markNotified(DB, op, lang, op.broadcasts[lang].sendAt);
        continue;
      }
    }
    const msg = openingEmail({ lang, settings, wording, list: true });
    const sendAt = iso(sendAtMs);
    op.broadcasts = { ...op.broadcasts, [lang]: { pendingAt: now, sendAt } };
    await saveOpening(DB, op, now);
    const r = await kitCreateBroadcast(env, {
      subject: msg.subject, previewText: fill(WORDS[lang].openPreheader, { year: op.year }), description,
      html: msg.html, sendAt, audience: { type: 'tag', id: op.tags[lang], name: description },
    });
    if (!r.ok) {
      op.broadcasts = { ...op.broadcasts, [lang]: { pendingAt: r.status ? null : now, sendAt: null } };
      await openingProblem(env, op, `Kit didn't take the ${LANGS[lang]} email: ${r.error}`, now);
      return false;
    }
    op.broadcasts = { ...op.broadcasts, [lang]: { id: r.broadcast?.id || null, sendAt, recipients: tagged } };
    await markNotified(DB, op, lang, sendAt);
    await saveOpening(DB, op, now);
  }
  if (waitingOnKit) { await saveOpening(DB, op, now); return false; }

  // Whoever Kit can't reach gets it from the site, at the same time
  await sendDirect(env, op, await pendingRows(DB, op), settings, now, { sendAt: sendAtMs });
  if ((await pendingRows(DB, op)).length && op.direct?.scheduled?.length) { await saveOpening(DB, op, now); return false; } // more to schedule
  return markStaged(env, op, now);
}

async function markStaged(env, op, now) {
  if (!op.staged_at) {
    op.staged_at = iso(now);
    op.error = null;
    op.error_since = null;
    op.tries = 0;
    op.next_try_at = null;
    await saveOpening(env.DB, op, now);
  }
  return true;
}

/**
 * Everyone frozen into this opening that no email covers yet (a send that
 * failed): the site emails them now.
 */
async function sendLeftovers(env, op, settings, now) {
  const rows = await pendingRows(env.DB, op);
  if (!rows.length) return { sent: 0, failed: 0 };
  op.direct = { ...(op.direct || {}), at: now };
  return sendDirect(env, op, rows, settings, now);
}

async function markNotified(DB, op, lang, sendAt) {
  await DB.prepare(`UPDATE waitlist_signups SET opening_id = ?, notified_at = ?, notified_via = 'kit', pending_opening = NULL
      WHERE pending_opening = ? AND kit_snapshot = ? AND lang = ? AND opening_id IS NULL`).bind(op.id, sendAt, op.id, op.id, lang).run();
}

/** The send time came: from here Kit (and Resend) are sending; staff hear who's getting it */
async function finishSending(env, op, now, { note = null } = {}) {
  op.state = 'sending';
  op.error = null;
  op.error_since = null;
  op.tries = 0;
  op.next_try_at = null;
  op.sent_at = iso(Math.min(now, Math.max(op.send_at || now, Date.parse(op.staged_at || '') || 0)));
  if (note) op.note = note;
  await saveOpening(env.DB, op, now);
  const kitN = Object.entries(op.broadcasts || {}).filter(([k, b]) => LANGS[k] && b?.id).reduce((n, [, b]) => n + (b.recipients || 0), 0);
  const directN = op.direct?.sent || 0;
  await tellStaff(env, {
    year: op.year,
    kind: 'news',
    title: `The applications-open email is going out to ${families(kitN + directN)}`,
    detail: [
      `${op.year} applications are open and the families who asked are being told (${split(op.counts)}).`,
      kitN ? `${families(kitN)} through Kit.` : null,
      directN ? `${families(directN)} straight from the site${op.note ? '' : " (Kit couldn't reach them)"}.` : null,
      op.direct?.failed ? `${families(op.direct.failed)} couldn't be emailed: ${op.direct.error}.` : null,
      op.note,
    ].filter(Boolean).join(' '),
  });
}

/** Kit's numbers for each broadcast; the opening is done once every one finished. */
async function followSending(env, op, now, { force = false } = {}) {
  const langs = Object.keys(LANGS).filter(l => op.broadcasts?.[l]?.id);
  let done = true;
  let changed = false;
  // A family the site couldn't email yet gets another try every 10 minutes for a day
  if (op.direct?.failed && now - (op.direct.at || 0) >= 10 * 60e3 && op.sent_at && now - Date.parse(op.sent_at) < 24 * 3600e3) {
    await sendLeftovers(env, op, await readAppSettings(env.DB, now), now);
    changed = true;
  }
  for (const l of langs) {
    const b = op.broadcasts[l];
    if (!force && b.statsAt && now - b.statsAt < STATS_EVERY_MS) { done &&= b.stats?.status === 'completed'; continue; }
    const s = await kitBroadcastStats(env, b.id);
    if (s.ok) { op.broadcasts[l] = { ...b, stats: s, statsAt: now }; changed = true; }
    done &&= (s.ok ? s.status : b.stats?.status) === 'completed';
  }
  // Kit has had it an hour and still won't say: it's sent as far as anyone here can tell
  const stale = op.sent_at && now - Date.parse(op.sent_at) > 3600e3;
  if (op.state === 'sending' && (done || stale)) {
    op.state = 'sent';
    op.finished_at = iso(now);
    changed = true;
    if (langs.length) {
      const got = langs.reduce((n, l) => n + (op.broadcasts[l].stats?.recipients ?? op.broadcasts[l].recipients ?? 0), 0) + (op.direct?.sent || 0);
      await tellStaff(env, { year: op.year, kind: 'news', title: `The applications-open email was sent to ${families(got)}`, detail: `Every family who asked to hear when ${op.year} applications open has been emailed. Opens and clicks are in the admin.` });
    }
  }
  if (changed) await saveOpening(env.DB, op, now);
}

/**
 * One step of the opening, from the live switch. Safe to call any time (the
 * heartbeat, the save that flips the switch, the admin panel): a lock keeps
 * two from running at once.
 */
export async function advanceOpening(env, { now = Date.now(), fetchImpl = fetch, force = false } = {}) {
  const { DB } = env;
  await ensureWaitlistSchema(DB);
  if (!(await claim(DB, 'lock', LOCK_MS, now))) return { busy: true };
  try {
    const settings = await readAppSettings(DB, now);
    const op = await latestOpening(DB);
    let active = op && ACTIVE.includes(op.state) ? op : null;

    // A stop that couldn't reach Kit yet: keep at it until the send time
    if (active?.stop && ['countdown', 'preparing'].includes(active.state)) {
      if (now < (active.send_at || 0) + KIT_SEND_DELAY_MS) {
        await stopOpening(env, active, { now, ...active.stop });
        return { state: (await latestOpening(DB))?.state };
      }
      active.stop = null;
      await finishSending(env, active, now, { note: "Couldn't be taken back in Kit before its send time, so it went out." });
      return { state: 'sending' };
    }

    if (!settings.open) {
      if (await runtimeGet(DB, 'open_since')) await runtimeSet(DB, 'open_since', null, now);
      if (active && (active.state === 'countdown' || active.state === 'held')) {
        if (active.state === 'held') {
          active.state = 'cancelled';
          active.note = 'Applications were switched off while the email was on hold.';
          active.finished_at = iso(now);
          await saveOpening(DB, active, now);
          await DB.prepare('UPDATE waitlist_signups SET pending_opening = NULL, kit_snapshot = NULL WHERE pending_opening = ? AND opening_id IS NULL').bind(active.id).run();
          return { state: 'cancelled' };
        }
        const r = await stopOpening(env, active, { now, mode: 'cancel', why: 'Applications were switched off again before the email went out.' });
        return { state: r.ok ? 'cancelled' : (await latestOpening(DB))?.state };
      }
      if (active?.state === 'preparing') {
        const anyOut = Object.keys(LANGS).some(l => active.broadcasts?.[l]?.id) || active.direct?.sent > 0;
        if (!anyOut) {
          // Nothing had gone out yet: nobody was told, so it's a cancel like any other
          const r = await stopOpening(env, active, { now, mode: 'cancel', why: 'Applications were switched off again before the email went out.' });
          return { state: r.ok ? 'cancelled' : (await latestOpening(DB))?.state };
        }
        // Switched off part way: what went out went; the rest wait for the next opening
        await DB.prepare('UPDATE waitlist_signups SET pending_opening = NULL WHERE pending_opening = ? AND opening_id IS NULL').bind(active.id).run();
        await finishSending(env, active, now, { note: 'Applications were switched off while the email was going out, so the families not emailed yet will hear at the next opening.' });
        return { state: 'sending' };
      }
      if (active?.state === 'sending') await followSending(env, active, now, { force });
      return { state: active?.state || null };
    }

    let since = Number(await runtimeGet(DB, 'open_since')) || 0;
    if (!since) { since = now; await runtimeSet(DB, 'open_since', now, now); }

    if (!active) {
      const w = await waitingCounts(DB);
      if (!w.total) return { state: op?.state || null };
      const sameOpening = op && op.state === 'sent' && Date.parse(op.opened_at) >= since - 1000;
      if (sameOpening) {
        // Still the same opening: anyone who joined since (read in from Kit, say) is told directly
        const rows = (await DB.prepare(`SELECT * FROM waitlist_signups WHERE ${WAITING_SQL} LIMIT 50`).all()).results || [];
        await sendDirect(env, op, rows, settings, now);
        await saveOpening(DB, op, now);
        return { state: 'sent', direct: rows.length };
      }
      active = await createOpening(env, { settings, now, sendAt: countdownEnd(settings, now) });
    }

    if (active.state === 'held') return { state: 'held' };
    if (active.state === 'sending') { await followSending(env, active, now, { force }); return { state: (await latestOpening(DB))?.state }; }
    const due = now >= active.send_at;
    if (active.state === 'countdown' && !active.staged_at && !(active.next_try_at && now < active.next_try_at && !force)) {
      // Stage during the countdown, so Kit holds the email before the send time comes
      await stage(env, active, { now, fetchImpl });
    }
    if (due && active.state === 'countdown') {
      if (active.staged_at) { await finishSending(env, active, now); return { state: 'sending' }; }
      active.state = 'preparing'; // past the send time and not ready: keep going, sending as soon as it's ready
      await saveOpening(DB, active, now);
    }
    if (active.state === 'preparing' && !(active.next_try_at && now < active.next_try_at && !force)) {
      if (await stage(env, active, { now, fetchImpl })) await finishSending(env, active, now);
    }
    return { state: (await latestOpening(DB))?.state };
  } catch (err) {
    console.error('Waitlist opening step failed:', err);
    return { error: err.message };
  } finally {
    await release(DB, 'lock');
  }
}

/** The heartbeat's call (./broadcast-hooks.js): at most once every TICK_EVERY_MS. Never throws. */
export async function maybeRunWaitlist(env, { now = Date.now(), fetchImpl = fetch, force = false } = {}) {
  try {
    const { DB } = env;
    if (!DB) return null;
    await ensureWaitlistSchema(DB);
    if (!force && !(await claim(DB, 'tick', TICK_EVERY_MS, now))) return null;
    // A scheduled open or close first (Applications → Settings), so the email goes the same minute
    // (looked up on the module: the schedule ships separately, and its absence is fine)
    if (typeof applications.applyApplicationSchedule === 'function') await applications.applyApplicationSchedule(env, { now }).catch(() => null);
    await retrySignups(env, now);
    const settings = await readAppSettings(DB, now);
    const lastImport = Number(await runtimeGet(DB, 'imported')) || 0;
    if (!settings.open && kitConfigured(env) && now - lastImport >= IMPORT_EVERY_MS) await importFromKit(env, { now });
    const lastCheck = Date.parse(parse(await runtimeGet(DB, 'kit_health'), null)?.at || '') || 0;
    if (now - lastCheck >= HEALTH_EVERY_MS) await checkKit(env, { now });
    return await advanceOpening(env, { now, fetchImpl });
  } catch (err) {
    console.error('Waitlist tick failed:', err);
    return null;
  }
}

// ─── Admin ──────────────────────────────────────────────────────────

// Logged as 'newsletter', one of pending-changes' runtime types: nothing here waits for a Publish
async function logAction(DB, user, what) {
  await logAudit(DB, { userEmail: user || 'admin', action: 'updated', entityType: 'newsletter', entitySlug: 'application-waitlist', entityName: `Waitlist: ${what}`, gitStatus: 'ok' }).catch(() => {});
}

function publicOpening(op, now) {
  if (!op) return null;
  const broadcasts = {};
  for (const l of Object.keys(LANGS)) {
    const b = op.broadcasts?.[l];
    if (b?.id || b?.recipients) broadcasts[l] = { id: b.id || null, sendAt: b.sendAt || null, recipients: b.recipients || 0, stats: b.stats || null };
  }
  return {
    id: op.id, year: op.year, state: op.state, openedAt: op.opened_at, sendAt: op.send_at ? iso(op.send_at) : null,
    secondsLeft: op.state === 'countdown' && op.send_at ? Math.max(0, Math.round((op.send_at - now) / 1000)) : null,
    total: op.total || 0, counts: { en: op.counts?.en || 0, es: op.counts?.es || 0 },
    broadcasts, direct: op.direct || null, error: op.error || null, retryAt: op.next_try_at ? iso(op.next_try_at) : null,
    by: op.by || null, note: op.note || null, sentAt: op.sent_at || null, finishedAt: op.finished_at || null,
    staged: !!op.staged_at, stagedAt: op.staged_at || null, stopping: op.stop ? op.stop.mode : null,
    kitBroadcastUrls: Object.fromEntries(Object.entries(broadcasts).filter(([, b]) => b.id).map(([l, b]) => [l, `https://app.kit.com/campaigns/${b.id}`])),
  };
}

/** Everything the admin panel shows. Moves the opening along first, so it's never a minute behind. */
export async function waitlistStatus(env, { now = Date.now(), fetchImpl = fetch, list = true } = {}) {
  const { DB } = env;
  await ensureWaitlistSchema(DB);
  await advanceOpening(env, { now, fetchImpl });
  const settings = await readAppSettings(DB, now);
  const op = await latestOpening(DB);
  if (op && ['sending', 'sent'].includes(op.state) && op.sent_at && now - Date.parse(op.sent_at) < 30 * 24 * 3600e3) {
    await followSending(env, op, now).catch(() => {});
  }
  const waiting = await waitingCounts(DB);
  // Families an opening is counting down to still count as waiting until it goes
  if (op && ['countdown', 'preparing'].includes(op.state)) {
    const { results } = await DB.prepare("SELECT lang, COUNT(*) AS n FROM waitlist_signups WHERE opening_id = ? AND removed_at IS NULL GROUP BY lang").bind(op.id).all();
    for (const r of results || []) { waiting.counts[cleanLang(r.lang)] += r.n; waiting.total += r.n; }
  }
  // Kit, asked directly (at most every 10 minutes from here)
  let kitHealth = parse(await runtimeGet(DB, 'kit_health'), null);
  if (kitConfigured(env) && (!kitHealth || now - (Date.parse(kitHealth.at) || 0) > 10 * 60e3)) kitHealth = await checkKit(env, { now, alert: false });
  const stats = await DB.prepare(`SELECT
      SUM(CASE WHEN ${WAITING_SQL} AND kit_error IS NOT NULL THEN 1 ELSE 0 END) AS kitProblems,
      SUM(CASE WHEN removed_at IS NULL AND opening_id IS NULL AND kit_state IN ('cancelled', 'bounced', 'complained') AND fallback = 0 THEN 1 ELSE 0 END) AS unsubscribed,
      MAX(CASE WHEN removed_at IS NULL AND page != 'kit' THEN created_at END) AS lastSignupAt,
      SUM(CASE WHEN removed_at IS NULL THEN 1 ELSE 0 END) AS everyone
    FROM waitlist_signups`).first();
  const rows = list
    ? ((await DB.prepare(`SELECT * FROM waitlist_signups WHERE removed_at IS NULL ORDER BY (opening_id IS NULL) DESC, created_at DESC LIMIT 2000`).all()).results || []).map(signupRow)
    : null;
  const { results: history } = await DB.prepare('SELECT * FROM waitlist_openings ORDER BY opened_at DESC LIMIT 10').all();
  return {
    open: settings.open, year: settings.year, formUrl: applyLink(settings, 'en'),
    kit: kitConfigured(env), email: emailConfigured(env),
    kitHealth: kitConfigured(env) ? kitHealth : null,
    resendLast: parse(await runtimeGet(DB, 'resend_last'), null),
    countdownMinutes: COUNTDOWN_MS / 60000,
    waiting: waiting.total, waitingByLang: waiting.counts,
    kitProblems: stats?.kitProblems || 0, unsubscribed: stats?.unsubscribed || 0,
    lastSignupAt: stats?.lastSignupAt || null, everyone: stats?.everyone || 0,
    lastImportAt: Number(await runtimeGet(DB, 'imported')) ? iso(Number(await runtimeGet(DB, 'imported'))) : null,
    opening: publicOpening(op && (ACTIVE.includes(op.state) || now - Date.parse(op.opened_at) < 60 * 24 * 3600e3) ? op : null, now),
    history: (history || []).map(r => publicOpening(openingRow(r), now)),
    wording: await readWording(DB), defaults: DEFAULT_WORDING,
    signups: rows,
  };
}

/** Staff overrides. Each answers { ok, … } or { ok: false, error }. */
export async function waitlistAction(env, action, body = {}, { user = 'admin', now = Date.now(), fetchImpl = fetch } = {}) {
  const { DB } = env;
  await ensureWaitlistSchema(DB);
  const settings = await readAppSettings(DB, now);
  const op = await latestOpening(DB);
  const active = op && ACTIVE.includes(op.state) ? op : null;

  if (action === 'send-now') {
    if (!settings.open) return { ok: false, error: 'Applications are closed. Open them first, then the email can go.' };
    if (active?.state === 'sending') return { ok: false, error: 'The email is already on its way.' };
    const r = await withLock(DB, async () => {
      if (active) {
        // Whatever Kit holds for later comes back first, then it goes again for now
        if (active.staged_at || Object.keys(LANGS).some(l => active.broadcasts?.[l]?.id)) {
          const u = await unstage(env, active, now);
          if (!u.ok) return { ok: false, error: u.tooLate ? 'It is already going out.' : `Couldn't move it in Kit: ${u.error}` };
        }
        active.state = 'countdown';
        active.send_at = now;
        active.by = user;
        active.next_try_at = null;
        await saveOpening(DB, active, now);
      } else {
        if (!(await waitingCounts(DB)).total) return { ok: false, error: 'Nobody is waiting for the email.' };
        await createOpening(env, { settings, now, sendAt: now, by: user });
      }
      return { ok: true };
    });
    if (!r.ok) return r;
    await logAction(DB, user, 'sent the applications-open email now');
    await advanceOpening(env, { now, fetchImpl, force: true });
    return { ok: true };
  }
  if (action === 'hold') {
    if (!['countdown', 'preparing'].includes(active?.state)) return { ok: false, error: 'There is no countdown to stop.' };
    const r = await withLock(DB, () => stopOpening(env, active, { now, mode: 'hold', by: user }));
    if (!r.ok) return r;
    await logAction(DB, user, 'chose not to send the applications-open email this time');
    return { ok: true };
  }
  if (action === 'retry') {
    if (!active) return { ok: false, error: 'Nothing to retry.' };
    active.next_try_at = null;
    active.tries = 0;
    active.alerted = null;
    await saveOpening(DB, active, now);
    await DB.prepare('UPDATE waitlist_signups SET next_try_at = ? WHERE kit_error IS NOT NULL AND opening_id IS NULL AND removed_at IS NULL').bind(now).run();
    await advanceOpening(env, { now, fetchImpl, force: true });
    return { ok: true };
  }
  if (action === 'retry-signups') {
    await DB.prepare('UPDATE waitlist_signups SET next_try_at = ?, kit_tries = 0 WHERE kit_error IS NOT NULL AND opening_id IS NULL AND removed_at IS NULL').bind(now).run();
    await retrySignups(env, now);
    return { ok: true };
  }
  if (action === 'add') {
    const r = await recordSignup(env, { email: body.email, lang: body.lang, page: 'admin', confirm: body.confirm !== false, now, by: user });
    return r.ok ? { ok: true, status: r.status } : { ok: false, error: 'Enter a valid email address.' };
  }
  if (action === 'remove') return removeSignup(env, body.email, { by: user, now });
  if (action === 'wording') {
    const wording = await saveWording(DB, body.wording || {}, now);
    await logAction(DB, user, 'changed the applications-open email wording');
    return { ok: true, wording };
  }
  if (action === 'test') {
    const to = isEmail(body.to) ? body.to : (isEmail(user) ? user : null);
    if (!to) return { ok: false, error: 'No email address to send the test to.' };
    if (!emailConfigured(env)) return { ok: false, error: 'RESEND_API_KEY is not set, so test emails cannot go out.' };
    const lang = cleanLang(body.lang);
    const msg = openingEmail({ lang, settings, wording: body.wording || await readWording(DB), list: false });
    const r = await sendEmails(env, { to: [to], subject: `[Test] ${msg.subject}`, html: msg.html, text: msg.text, tags: [{ name: 'type', value: 'application-waitlist-test' }] });
    return r.sent ? { ok: true, to } : { ok: false, error: r.errors?.[0] || 'The test email did not send.' };
  }
  if (action === 'rehearse') {
    // The real thing through Kit, to one person: proves the key, the sender and how Kit shows it
    const to = cleanEmail(isEmail(body.to) ? body.to : user);
    if (!isEmail(to)) return { ok: false, error: 'No email address to send the rehearsal to.' };
    if (!kitConfigured(env)) return { ok: false, error: 'Kit isn\'t connected (KIT_API_KEY is not set).' };
    const lang = cleanLang(body.lang);
    const sub = await kitUpsertSubscriber(env, to);
    if (!sub.ok) return { ok: false, error: sub.error };
    if (BAD_KIT_STATES.includes(sub.state)) return { ok: false, error: `${to} is unsubscribed in Kit, so Kit won't email it. Use another address.` };
    const tagId = await kitTagId(env, REHEARSAL_TAG);
    if (!tagId) return { ok: false, error: "Kit: couldn't make the rehearsal tag" };
    // Only this person: anyone left on the rehearsal tag from an earlier rehearsal comes off first
    let after = null;
    for (let p = 0; p < 5; p++) {
      const page = await kitTagSubscribersPage(env, tagId, { after, perPage: 100 });
      if (!page.ok) return { ok: false, error: page.error };
      for (const x of page.subscribers) if (x.id !== sub.id) await kitUntagSubscriber(env, tagId, x.id);
      if (!page.next) break;
      after = page.next;
    }
    if (!(await kitTagSubscriberId(env, tagId, sub.id))) return { ok: false, error: "Kit: couldn't tag you for the rehearsal" };
    const msg = openingEmail({ lang, settings, wording: body.wording || await readWording(DB), list: true });
    const r = await kitCreateBroadcast(env, {
      subject: `[Rehearsal] ${msg.subject}`, previewText: fill(WORDS[lang].openPreheader, { year: settings.year }),
      description: `[auto] Applications open rehearsal (${LANGS[lang]}) for ${to}`,
      html: msg.html, sendAt: iso(now + KIT_SEND_DELAY_MS), audience: { type: 'tag', id: tagId, name: REHEARSAL_TAG },
    });
    if (!r.ok) return { ok: false, error: `Kit didn't take it: ${r.error}` };
    await logAction(DB, user, `rehearsed the applications-open email through Kit to ${to}`);
    return { ok: true, to, broadcastId: r.broadcast?.id || null, url: r.broadcast?.id ? `https://app.kit.com/campaigns/${r.broadcast.id}` : null };
  }
  if (action === 'import') {
    const r = await importFromKit(env, { now, pages: 20 });
    return r.ok ? { ok: true, added: r.added, seen: r.seen } : { ok: false, error: r.error };
  }
  return { ok: false, error: `Unknown action "${action}"` };
}

/** What the email looks like, for the admin preview (with Kit's unsubscribe link shown as a stand-in) */
export async function previewOpening(env, { lang = 'en', wording = null, now = Date.now() } = {}) {
  const settings = await readAppSettings(env.DB, now);
  const msg = openingEmail({ lang: cleanLang(lang), settings, wording: wording || await readWording(env.DB), list: true });
  return { subject: msg.subject, html: msg.html.replace(/\{\{ unsubscribe_url \}\}/g, '#') };
}
