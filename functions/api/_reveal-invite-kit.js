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
 * - Never sent by the site. The reviewer (Linzi by default) gets an email with
 *   a link to the draft. Only an email: no Slack (Peter, Nov 4 2026).
 * - Every look starts from Kit's own copy, because staff work there and the
 *   site isn't told: scheduled, sent, deleted, edited or re-aimed all show.
 * - It must go only to that group and stay off the newsletter site. If it
 *   doesn't, staff and the reviewer are told before anything else, until that
 *   email has really gone.
 * - The reveal changes (day, time, address, notes) while it's an unedited
 *   draft: the draft is rewritten. Edited in Kit: it's left alone. Scheduled or
 *   sent: it's never touched. Deleted in Kit: it stays deleted.
 * - The reviewer's note comes from where things stand now, not from what just
 *   happened: `told` holds the last one that really went, so a note that
 *   didn't go is simply worked out again on the next look.
 * - Rehearsals (TEST jobs, the office sandbox) leave Kit alone.
 * - site_config 'reveal-invites' → kitInvite turns it off or names another
 *   reviewer (no admin control yet).
 */

import { kitConfigured, kitCreateBroadcast, kitUpdateDraft, kitListAudiences, kitReadBroadcast, kitFindDraft } from './_kit.js';
import { sendEmails, emailConfigured } from './_broadcast-notify.js';
import { emailShell, facts as factRows, button, esc } from './_email-shell.js';
import { revealInviteEmail, revealWhen, partnerLogoUrls, kidPhotoUrls, cleanAddress, TEAM_PICTURE, TIME_LATER, SITE_URL, EMAIL_DESIGN } from './_reveal-invite-email.js';

export const KIT_INVITE_DEFAULTS = Object.freeze({ enabled: true, reviewer: 'linzi@soardcharity.com', audience: 'Reveal Emails' });
export const kitInviteSettings = (config) => ({ ...KIT_INVITE_DEFAULTS, ...(config?.kitInvite || {}) });
export const kitDraftUrl = (id) => `https://app.kit.com/campaigns/${encodeURIComponent(id)}`;
const ADMIN_URL = `${SITE_URL}/admin/#broadcast/invites`;
const isEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || ''));

const SCHEMA = `CREATE TABLE IF NOT EXISTS reveal_invite_kit (
  job_id TEXT PRIMARY KEY, broadcast_id TEXT, slug TEXT, reveal_date TEXT, hash TEXT,
  state TEXT, audience TEXT, reviewer TEXT, notified TEXT, error TEXT, updated_at TEXT,
  content_hash TEXT, audience_ref TEXT, told TEXT, alarmed TEXT, held TEXT)`;
// hash: the facts the site last put in Kit. content_hash: Kit's copy then, to tell when someone has edited it.
// audience_ref: the group as Kit knows it (a name can change). told: the last note that really reached the
// reviewer (see noteFor). alarmed: the problem staff really heard about. held: why JobTread says it may be off.
// design: the EMAIL_DESIGN the site last wrote, so a new design reaches an untouched draft by itself.
const ADDED = ['content_hash', 'audience_ref', 'told', 'alarmed', 'held', 'design'];
const _ready = new WeakSet();
export async function ensureKitSchema(DB) {
  if (_ready.has(DB)) return;
  await DB.prepare(SCHEMA).run();
  for (const col of ADDED) await DB.prepare(`ALTER TABLE reveal_invite_kit ADD COLUMN ${col} TEXT`).run().catch(() => {});
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
    (job_id, broadcast_id, slug, reveal_date, hash, state, audience, reviewer, notified, error, updated_at, content_hash, audience_ref, told, alarmed, held, design)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(row.job_id, row.broadcast_id ?? null, row.slug ?? null, row.reveal_date ?? null, row.hash ?? null, row.state ?? null,
      row.audience ?? null, row.reviewer ?? null, row.notified ?? null, row.error ?? null, new Date().toISOString(), row.content_hash ?? null,
      row.audience_ref ?? null, row.told ?? null, row.alarmed ?? null, row.held ?? null, row.design ?? null)
    .run();
}

/** Kit's "Reveal Emails" group: a segment by that name first, else a tag */
export async function findAudience(env, name) {
  const got = await kitListAudiences(env);
  if (!got.ok) throw new Error(got.error || 'Kit didn’t list its groups');
  // Without its segments a tag of the same name would quietly take over
  if (got.segmentsFailed) throw new Error('Kit didn’t list its segments');
  const want = String(name || '').trim().toLowerCase();
  const usable = (x) => String(x.name || '').trim().toLowerCase() === want && Number.isFinite(parseInt(x.id, 10));
  const seg = (got.segments || []).find(usable);
  const tag = (got.tags || []).find(usable);
  // Kit doesn't count a segment's people; a tag by the same name is how big it is
  if (seg) return { type: 'segment', id: seg.id, name: seg.name, count: tag?.count ?? null };
  if (tag) return { type: 'tag', id: tag.id, name: tag.name, count: tag.count ?? null };
  return null;
}

/**
 * Pictures that don't load (a deleted image, a bad upload), by their email-size
 * URL: a partner's logo becomes its name, a kid's photo gives way to the next,
 * and the team picture is left out, never a broken picture. One that can't be checked in time counts as loading.
 */
export async function brokenLogos(kid, { fetchImpl = fetch, timeoutMs = 5000, extra = [] } = {}) {
  const urls = [...new Set([...partnerLogoUrls(kid), ...kidPhotoUrls(kid), TEAM_PICTURE, ...extra])];
  const broken = new Set();
  // 'ok', 'broken', or 'unsure' (a timeout: the picture is likely just slow, so it isn't left out)
  const look = async (url) => {
    try {
      const res = await fetchImpl(url, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) });
      const type = res.headers.get('content-type') || '';
      res.body?.cancel?.();
      // A picture must come back as one; a Stream video's playlist (…/manifest/video.m3u8) as a playlist.
      // An SVG counts as broken: Gmail and Outlook show nothing for one, and Cloudflare can't resize it to a picture they do.
      const fits = /\.m3u8$/.test(url) ? /mpegurl/i.test(type) : /^image\//i.test(type) && !/svg/i.test(type);
      return res.ok && fits ? 'ok' : 'broken';
    } catch (err) {
      return err?.name === 'TimeoutError' ? 'unsure' : 'broken';
    }
  };
  // Asked twice before it's left out, so one dropped connection never turns a logo into a name card
  await Promise.all(urls.map(async (url) => {
    if ((await look(url)) === 'broken' && (await look(url)) === 'broken') broken.add(url);
  }));
  return broken;
}

/** Kit's own copy goes only to this group and stays off the newsletter site */
export function draftIsSafe(b, audience) {
  if (!b || b.public === true) return false;
  const want = Number(audience?.id);
  const entries = (b.subscriber_filter || []).flatMap((g) => [...(g?.all || []), ...(g?.any || [])]);
  const ids = entries[0]?.ids || [];
  return entries.length === 1 && entries[0]?.type === audience?.type && ids.length === 1 && Number(ids[0]) === want;
}

/** What the email says, as facts: a change to any of these rewrites the draft */
export function inviteFacts(plan, who, room = '') {
  return {
    name: who?.name || '', slug: who?.slug || '',
    date: plan?.facts?.date || plan?.date || '', start: plan?.facts?.start || '',
    address: plan?.facts?.address || '', details: plan?.facts?.details || '', room: String(room || ''),
  };
}

/** A kid page the email can be filled from */
export const kidPageReady = (kid) => !!kid && (!kid.publishStatus || kid.publishStatus === 'published');

const PAGE_FIX = 'Publish the kid’s page under Kids in the admin, and check the JobTread job’s name and year match it. The site tries again within minutes.';
const DELETED = 'deleted in Kit';
const CHECK = 'check audience';
// A draft from before the site kept its copy: nobody can say it wasn't edited
const NO_BASELINE = 'unknown';

// The draft's description says which job it's for and which facts the site last
// wrote, so a write whose answer never arrived can be told from someone's edit
const short = (hash) => String(hash || '').slice(0, 12);
const jobMark = (jobId) => `· ${jobId} ·`;
const describe = (name, jobId, hash) => `[auto] ${name} reveal invite ${jobMark(jobId)} ${short(hash)}`;
const writtenFacts = (b) => /· ([0-9a-f]{12})$/.exec(String(b?.description || ''))?.[1] || null;
/** What a person can change in Kit that a rewrite would lose. Who it goes to is checked on its own (draftIsSafe). */
export const copyHash = (b) => sha([b.subject ?? '', b.preview_text ?? '', b.content ?? '', (b.subscriber_filter || []).flatMap((g) => g?.none || [])]);
const audienceRef = (a) => `${a.type}:${a.id}`;
function audienceOf(row) {
  const m = /^(segment|tag):(\d+)$/.exec(row?.audience_ref || '');
  return m ? { type: m[1], id: Number(m[2]), name: row.audience } : null;
}
/** Has it left the site's hands? → 'scheduled', 'sent' or null (a draft) */
export function wentOut(b, now = Date.now()) {
  if (b.status === 'scheduled' || (!b.status && b.send_at && Date.parse(b.send_at) > now)) return 'scheduled';
  return (b.status && b.status !== 'draft') || b.send_at || b.published_at ? 'sent' : null;
}

/**
 * Which note, going from what she last heard to where things stand now.
 * Levels: `ready` a confirmed draft that says what JobTread says, `early` the
 * same before it's confirmed, `edited` a draft someone changed, so the site
 * can't say what it says, `queued` scheduled, `sent` gone, `held` JobTread says
 * it may be off. Each ends in the facts she was told. Once she has those, a
 * step she takes herself (scheduling, sending) needs no note: only JobTread
 * moving on from what she was told does.
 */
export function noteFor(level, told, hash, behind = false) {
  if (level === told) return null;
  const [now] = level.split(':');
  const [was] = String(told || '').split(':');
  const knows = !!told && told.endsWith(`:${hash}`);
  if (now === 'held') return 'held';
  if (was === 'held') return 'back-on';
  if (now === 'sent') return knows || (!told && !behind) ? null : 'after-send';
  if (now === 'queued') return knows || (!told && !behind) ? null : 'scheduled';
  if (now === 'edited') return knows ? null : 'edited';
  if (!told) return now === 'ready' ? 'created' : 'early';
  if (now === 'ready' && was === 'early') return 'confirmed';
  return knows ? null : 'updated';
}

/**
 * The facts that decide whether the email is out of date. Not the kid's name or
 * page: a page hidden for a moment, or the kids failing to load, isn't JobTread
 * changing the reveal.
 */
const factsHash = (f) => sha([f.date, f.start, f.address, f.details, f.room]);

/** The reviewer's note, for each thing that can happen to a draft. An email only. */
export function reviewNote(kind, { name, f = {}, id, audienceName, count, reason, went = null, firm = true, noTime = false, edited = false }) {
  const when = revealWhen(f.date, f.start);
  const url = id ? kitDraftUrl(id) : null;
  const group = audienceName || 'Reveal Emails';
  const goesTo = audienceName ? `${group}${count ? ` (${count.toLocaleString('en-US')} people)` : ''} in Kit` : null;
  const keepHolding = noTime ? 'The time isn’t in JobTread yet, so please keep holding it.' : 'It isn’t confirmed yet, so please keep holding it until JobTread confirms.';
  const t = {
    created: {
      subject: `Review ${name}’s reveal invite in Kit`,
      heading: `${name}’s reveal invite is ready to review`,
      intro: `JobTread confirmed ${name}’s reveal, so the invite email is drafted in Kit. Look it over, then send it from Kit. Nothing goes out until you do.`,
    },
    early: {
      subject: `Review ${name}’s reveal invite in Kit`,
      heading: `${name}’s reveal invite is ready to review`,
      intro: noTime
        ? `JobTread confirmed ${name}’s reveal, but the Reveal task has no time yet, so the draft in Kit says “Time to be confirmed”. Please hold it until the time is in JobTread: that fills it in, turns on the calendar buttons, and you’ll hear again. Nothing goes out until you send it.`
        : `It’s drafted in Kit ahead of JobTread’s confirmation, with the date JobTread has now. Please hold it until JobTread confirms: that fills in the time, turns on the calendar buttons, and you’ll hear again. Nothing goes out until you send it.`,
    },
    confirmed: {
      subject: `Review ${name}’s reveal invite in Kit`,
      heading: `${name}’s reveal is confirmed, and the invite is ready`,
      intro: `JobTread confirmed ${name}’s reveal. The draft in Kit now has the time and the calendar buttons. Look it over, then send it from Kit. Nothing goes out until you do.`,
    },
    updated: {
      subject: `${name}’s reveal invite draft changed`,
      heading: `${name}’s reveal changed, so the draft did too`,
      intro: `JobTread changed ${name}’s reveal. The draft in Kit now says what JobTread says. ${firm ? 'Look it over before you send it.' : keepHolding}`,
    },
    edited: {
      subject: `${name}’s reveal changed: please update your draft`,
      heading: `${name}’s reveal changed, and the draft needs updating`,
      intro: `JobTread changed ${name}’s reveal. The draft in Kit was edited after the site wrote it, so the site left it alone to keep those edits. Please make the change in the draft yourself. Here’s what JobTread says now.`,
    },
    scheduled: {
      subject: `${name}’s reveal changed, and its invite is scheduled`,
      heading: `${name}’s invite is scheduled, and the reveal changed`,
      intro: `The invite email is scheduled in Kit, and JobTread has changed the reveal. Check it says what’s below. If it doesn’t, unschedule it in Kit, fix it, then schedule it again.`,
    },
    'after-send': {
      subject: `${name}’s reveal changed after the invite went out`,
      heading: `${name}’s reveal changed after the invite email went out`,
      intro: `The invite email already went out from Kit, and JobTread has changed the reveal. If what went out doesn’t match what’s below, send the ${group} group a short update from Kit.`,
    },
    held: went === 'sent' ? {
      subject: `${name}’s reveal may be off, after the invite went out`,
      heading: `${name}’s reveal may be off, and the invite went out`,
      intro: `JobTread says this reveal may be off, and the invite email already went out from Kit. If the reveal is off, send the ${group} group a short update from Kit.`,
    } : went === 'scheduled' ? {
      subject: `Unschedule ${name}’s reveal invite`,
      heading: `${name}’s reveal may be off, and its invite is scheduled`,
      intro: `JobTread says this reveal may be off, and the invite email is scheduled in Kit. Please unschedule it until that’s sorted out.`,
    } : {
      subject: `Hold ${name}’s reveal invite`,
      heading: `Please hold ${name}’s reveal invite`,
      intro: `JobTread says this reveal may be off. Please don’t send the draft in Kit until that’s sorted out.`,
    },
    'back-on': {
      subject: `${name}’s reveal invite is back on`,
      heading: `${name}’s reveal invite is back on`,
      intro: went === 'sent' ? `JobTread says this reveal is back on. The invite email already went out: if you told people it was off, or it doesn’t match what’s below, send the ${group} group a short update from Kit.`
        : went === 'scheduled' ? `JobTread says this reveal is back on, and the invite email is still scheduled in Kit. Check it says what’s below.`
          : edited ? `JobTread says this reveal is back on. The draft in Kit was edited, so the site left it alone. Check it says what’s below before you send it.`
            : firm ? `JobTread says this reveal is back on. The draft in Kit is ready for you to look over and send.`
              : `JobTread says this reveal is back on. ${keepHolding}`,
    },
  }[kind];
  const facts = kind === 'held' ? [['JobTread says', reason || 'the reveal may be off']] : [
    ['When', when],
    ['Where', cleanAddress(f.address) || 'No address in JobTread yet'],
    ['Room', f.room],
    ['Notes', f.details],
    ['Goes to', goesTo],
  ];
  const rows = facts.map(([k, v]) => [k, v ? esc(v).replace(/\n/g, '<br>') : null]);
  const reminder = ['created', 'early', 'confirmed', 'updated', 'back-on'].includes(kind) && !went && !edited
    ? `It has the family’s address, so it only goes to the ${group} group. Check the photo, the story and the partners. Make any changes right in the draft: edits to ${name}’s page don’t reach it.`
    : '';
  const bodyHtml = factRows(rows)
    + (url ? `<div style="margin:18px 0 6px;">${button(kind === 'after-send' || went === 'sent' ? 'Open Kit' : 'Open the draft in Kit', url)}</div>` : '')
    + (reminder ? `<p class="muted" style="margin:14px 0 0;font-size:13px;line-height:1.55;">${esc(reminder)}</p>` : '');
  const html = emailShell({ preheader: t.intro, eyebrow: 'Reveal invite', heading: t.heading, intro: esc(t.intro), bodyHtml, footerHtml: `Sent by the website when JobTread changes a reveal. <a href="${esc(ADMIN_URL)}" style="color:inherit;">Reveals in the admin</a>` });
  const text = [t.heading, '', t.intro, '', ...facts.filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`), '', url && `Kit: ${url}`, reminder].filter((l) => l !== null && l !== undefined).join('\n');
  return { subject: t.subject, html, text };
}

async function notify(env, kind, settings, ctx) {
  // An email to the reviewer, and nothing else (Peter, Nov 4 2026: "an email to linzi ... not slack")
  const note = reviewNote(kind, ctx);
  const to = [settings.reviewer].filter(isEmail);
  if (!emailConfigured(env) || !to.length) return false;
  const out = await sendEmails(env, { to, subject: note.subject, html: note.html, text: note.text, tags: [{ name: 'category', value: 'reveal-invite-review' }] }).catch(() => null);
  return (out?.sent || 0) > 0;
}

/** Tell staff of a problem, once. → did it really go? One that didn't is tried again on the next look. */
async function problem(env, alertTo, row, { name, error, check = false, fix = null }) {
  if (row?.alarmed === error) return true;
  const who = name ? `${name}’s` : 'A';
  const title = check ? `Check who ${who} reveal invite goes to before sending it`
    : row?.broadcast_id ? `${who} reveal invite draft needs a look` : `${who} reveal invite email wasn’t drafted`;
  const how = fix || (check
    ? 'Open the draft in Kit and press Continue: it must say Reveal Emails, with "Add to your Newsletter site" off. Nothing has been sent.'
    : /group/i.test(error)
      ? 'In Kit, make sure a segment or tag is named “Reveal Emails” (the people who get reveal invites). The site tries again within minutes.'
      : 'The site tries again within minutes. If this keeps happening, check the Kit connection under Site Config → Newsletter in the admin.');
  if (!emailConfigured(env) || !alertTo.length) return false;
  const out = await sendEmails(env, {
    to: alertTo, subject: `[SOARD] ${title}`,
    html: `<p><strong>${esc(title)}</strong></p><p>${esc(error)}</p><p>${esc(how)}</p><p><a href="${esc(ADMIN_URL)}">Open Reveals in the admin</a></p>`,
    text: `${title}\n\n${error}\n\n${how}\n\n${ADMIN_URL}`,
    tags: [{ name: 'category', value: 'reveal-invite-alert' }],
  }).catch(() => null);
  return (out?.sent || 0) > 0;
}

/**
 * JobTread says the reveal may be off (closed, denied, awaiting funding, no
 * date, or its calendar invite was deleted). A draft, or an email scheduled or
 * already out, has the family's address, so the reviewer hears once, in words
 * that fit where it stands in Kit. Never throws.
 */
export const holdKitInvite = (env, { jobId, reason, name, config = {}, sandbox = false, alertTo = [] }) =>
  syncKitInvite(env, { jobId, hold: reason, who: { name }, config, sandbox, alertTo });

/**
 * Called on every look at a job (JobTread change, the 5-minute check, the
 * sweep). Reads Kit's copy, brings it up to date if it can, then tells whoever
 * needs telling. Quiet when nothing's changed. Never throws.
 *
 * @returns {Promise<{kit: string, reason?: string, id?: string, error?: string, told?: boolean}>}
 */
export async function syncKitInvite(env, { jobId, plan = null, hold = null, who, room = '', config = {}, sandbox = false, alertTo = [], early = false, rewrite = false, fetchImpl = fetch }) {
  const s = kitInviteSettings(config);
  if (!s.enabled) return { kit: 'off' };
  if (sandbox) return { kit: 'skip', reason: 'a rehearsal leaves Kit alone' };
  if (!hold && plan?.action !== 'upsert') return { kit: 'skip', reason: plan?.reason || 'no reveal to invite to' };
  if (!kitConfigured(env)) return { kit: 'skip', reason: 'Kit is not connected' };
  if (who?.project || (who && !who.slug && who.url)) return { kit: 'skip', reason: 'a community project has no kid page to fill it from' };
  const { DB } = env;
  const name = who?.name || 'A kid';
  const everyone = [...new Set([...alertTo, s.reviewer].filter(isEmail))];
  let row = null;
  let wrongAim = null; // once Kit's copy is read: why it isn't safe. That comes before any other news.
  // Told or not, the next look tries again; once told, staff aren't told again
  const trouble = async (error, opts = {}) => {
    const text = wrongAim ? `${wrongAim} ${error}` : error;
    const heard = await problem(env, everyone, row, { name, error: text, ...(wrongAim ? { check: true } : opts) });
    const keep = row || { job_id: jobId, state: 'waiting' };
    row = { ...keep, ...(wrongAim ? { state: CHECK } : {}), error: text, alarmed: heard ? text : keep.alarmed ?? null };
    await writeKitRow(DB, row);
    return { kit: wrongAim ? 'check' : 'error', error: text, ...(row.broadcast_id ? { id: row.broadcast_id } : {}) };
  };
  try {
    row = await readKitRow(DB, jobId);
    if (hold && !row?.broadcast_id) return { kit: 'skip', reason: 'no draft waiting' };
    if (row?.state === DELETED && !early) return { kit: 'skip', reason: 'the draft was deleted in Kit' };
    if (row?.broadcast_id) row = { ...row, held: hold };
    const f = hold ? {} : inviteFacts(plan, who, room);
    const hash = hold ? row.hash : await factsHash(f);
    const firm = !hold && !!(plan.confirmed && f.start);
    const noTime = !hold && !!plan.confirmed && !f.start;
    // Drafts from when the kid's name and page counted as facts
    if (!hold && row?.hash && row.hash === await sha(f)) row = { ...row, hash };
    // JobTread's confirmation (with a time) drafts it. Staff can draft it sooner
    // from the admin; a draft made early then follows JobTread.
    if (!row?.broadcast_id && !early && !firm) return { kit: 'skip', reason: 'not confirmed with a time' };

    const base = { job_id: jobId, slug: who?.slug || row?.slug || null, reveal_date: f.date || row?.reveal_date || null, reviewer: s.reviewer };
    const render = async () => {
      if (!who?.slug) return { error: `JobTread confirmed ${name}’s reveal, but no published kid page matches the job, so the invite email can’t be filled in.` };
      const kidRow = await DB.prepare('SELECT data FROM kids WHERE slug = ?').bind(who.slug).first();
      let kid = null;
      try { kid = kidRow ? JSON.parse(kidRow.data) : null; } catch { /* unreadable */ }
      if (!kidPageReady(kid)) return { error: `${name}’s kid page isn’t published, so the invite email can’t be filled in.` };
      const broken = await brokenLogos(kid, { fetchImpl });
      return { email: revealInviteEmail({ kid: { ...kid, slug: who.slug }, date: f.date, time: f.start, address: f.address, notes: f.details, room: f.room, brokenLogos: broken, teamPicture: !broken.has(TEAM_PICTURE) }) };
    };
    const body = (email) => ({ subject: email.subject, previewText: email.preview, description: describe(name, jobId, hash), html: email.html });

    // Where it stands in Kit. A send cancelled there is as good as deleted.
    let seen = row?.broadcast_id && row.state !== DELETED ? await kitReadBroadcast(env, row.broadcast_id) : null;
    if (seen && (/HTTP 404/.test(seen.error || '') || seen.broadcast?.status === 'aborted')) {
      row = { ...row, state: DELETED, error: null, alarmed: null };
      await writeKitRow(DB, row);
      if (!early) return { kit: 'skip', reason: 'the draft was deleted in Kit' };
      seen = null;
    }
    if (early && row?.state === DELETED) {
      await DB.prepare('DELETE FROM reveal_invite_kit WHERE job_id = ?').bind(jobId).run();
      row = null;
    }
    if (seen && !seen.ok) {
      // Kit not answering only matters if something is waiting on it
      const heard = row.told ?? (row.notified && row.hash ? `:${row.hash}` : '');
      const waiting = hold ? !(heard.startsWith('held:') && heard.endsWith(`:${hold}`)) : !heard.endsWith(`:${hash}`);
      if (!waiting) return { kit: 'unchanged', id: row.broadcast_id };
      const text = hold
        ? `JobTread says ${name}’s reveal may be off (${hold}), and Kit couldn’t be reached to check its invite email. Please check it in Kit.`
        : `Kit couldn’t be reached (${seen.error}), so ${name}’s invite email may still have the old details.`;
      // A blip isn't an alarm; still failing on the next look is
      if (row.error === text) return await trouble(text);
      row = { ...row, error: text };
      await writeKitRow(DB, row);
      return { kit: 'error', error: text, id: row.broadcast_id };
    }

    let made = false;
    let found = false;
    if (!row?.broadcast_id) {
      // Kit may have taken a draft whose answer never arrived: never a second one
      const lost = await kitFindDraft(env, jobMark(jobId));
      if (!lost.ok) return await trouble(`Kit couldn’t be reached (${lost.error}), so ${name}’s invite email wasn’t drafted.`);
      const group = await findAudience(env, s.audience);
      if (!group) return await trouble(`Kit has no group named “${s.audience}”, so there’s no draft: the email has the family’s address and Kit would send it to everyone.`);
      let id = String(lost.broadcast?.id || '');
      found = !!id;
      if (!id) {
        const r = await render();
        if (r.error) return await trouble(r.error, { fix: PAGE_FIX });
        const c = await kitCreateBroadcast(env, { ...body(r.email), audience: group });
        id = String(c.broadcast?.id || '');
        if (!c.ok || !id) return await trouble(`Kit didn’t take the draft: ${c.error || `HTTP ${c.status}`}`);
        made = true;
      }
      row = { ...base, broadcast_id: id, hash: made ? hash : null, state: 'draft', audience: group.name, audience_ref: audienceRef(group), design: made ? EMAIL_DESIGN : null };
      await writeKitRow(DB, row); // kept first: a draft Kit has is never made twice
      seen = await kitReadBroadcast(env, id);
      if (!seen.ok) seen = await kitReadBroadcast(env, id); // a blip isn't an alarm
      // Nobody hears until Kit's copy has been read; the next look does it
      if (!seen.ok) return { kit: 'check', id, error: `Kit’s copy couldn’t be read yet (${seen.error})` };
    }

    let b = seen.broadcast;
    let went = wentOut(b);
    let audience = audienceOf(row);
    if (!audience) audience = await findAudience(env, row.audience || s.audience).catch((err) => { if (went === 'sent') return null; throw err; });
    if (!audience && went !== 'sent') return await trouble(`Kit has no group named “${row.audience || s.audience}” any more, so the site can’t check who ${name}’s invite goes to.`);
    if (audience && !row.audience_ref) row = { ...row, audience: audience.name, audience_ref: audienceRef(audience) };
    // Who it's aimed at is checked on every look that has Kit's copy, whatever else happens
    const aimedWrong = (copy) => {
      if (!audience || draftIsSafe(copy, audience)) return null;
      return went === 'sent' ? `Kit shows ${name}’s invite email went out to more than ${audience.name}, and it has the family’s address.`
        : `Kit’s copy of the draft isn’t set to go only to ${audience.name}, and it has the family’s address.`;
    };
    wrongAim = aimedWrong(b);
    // Drafts from before the site kept track: what she last heard, from what the draft says
    const legacy = !row.told && !!row.notified;
    const told = row.told ?? (legacy && row.hash ? `${String(b.content || '').includes(TIME_LATER) ? 'early' : 'ready'}:${row.hash}` : null);

    // The site's own write that it never heard back about isn't someone's edit
    const copy = await copyHash(b);
    const wroteFacts = writtenFacts(b);
    if (!hold && wroteFacts && wroteFacts !== short(row.hash)) row = { ...row, hash: wroteFacts === short(hash) ? hash : null, content_hash: copy };
    if (!row.content_hash) row = { ...row, content_hash: legacy ? NO_BASELINE : copy };
    const edited = copy !== row.content_hash;

    const changed = !hold && row.hash !== hash;
    // Asked for by hand on a draft from before the site kept its copy
    const forced = rewrite && row.content_hash === NO_BASELINE;
    // A new design reaches a draft nobody has touched by itself, like a JobTread change does
    const stale = row.design !== EMAIL_DESIGN;
    let wrote = false;
    if (!hold && !went && (!edited || forced) && !made && (changed || rewrite || stale)) {
      const r = await render();
      if (r.error) return await trouble(`${r.error} The draft in Kit still has the old details.`, { fix: PAGE_FIX });
      // Kit resets what an update leaves out, so the audience is sent every time
      const u = await kitUpdateDraft(env, row.broadcast_id, { ...body(r.email), audience });
      if (u.status) {
        went = u.status === 'scheduled' ? 'scheduled' : 'sent';
        wrongAim = aimedWrong(b);
      } else {
        // Read back either way: a write whose answer was lost may have landed all the same
        const after = await kitReadBroadcast(env, row.broadcast_id);
        const landed = after.ok && (u.ok || (changed && writtenFacts(after.broadcast) === short(hash)));
        if (!u.ok && !landed) {
          return await trouble(after.ok ? `Kit didn’t take the change to the draft (${u.error || 'no answer'}), so it still has the old details.`
            : `Kit didn’t answer (${u.error || 'no answer'}), so the draft may still have the old details.`);
        }
        if (!landed) {
          row = { ...row, ...base, hash, content_hash: null };
          await writeKitRow(DB, row);
          return { kit: 'check', id: row.broadcast_id, error: `Kit’s copy couldn’t be read yet (${after.error})` };
        }
        b = after.broadcast;
        row = { ...row, hash, content_hash: await copyHash(b), design: EMAIL_DESIGN };
        wrote = true;
        wrongAim = aimedWrong(b);
      }
    }

    // Once someone has edited it, a matching hash says nothing about what it says
    const handEdited = edited && !wrote;
    const behind = !hold && row.hash !== hash;
    const level = hold ? `held:${went || 'draft'}:${hold}`
      : went === 'sent' ? `sent:${hash}`
        : went === 'scheduled' ? `queued:${hash}`
          : behind || (handEdited && String(told || '').startsWith('edited:')) ? `edited:${hash}`
            : `${firm ? 'ready' : 'early'}:${hash}`;
    const ready = /^(ready|early):/.test(level);
    // "Ready" is only said of a draft aimed right; every other note still needs saying
    const kind = wrongAim && ready ? null : noteFor(level, told, hash, behind);
    let delivered = false;
    if (kind) {
      const count = hold ? null : await findAudience(env, row.audience).then((a) => a?.count ?? null).catch(() => null);
      delivered = await notify(env, kind, s, { name, f, id: row.broadcast_id, audienceName: audience && draftIsSafe(b, audience) ? row.audience : null, count, reason: hold, went, firm, noTime, edited: handEdited });
    }
    const alarmed = wrongAim ? await problem(env, everyone, row, { name, error: wrongAim, check: true, ...(went === 'sent' ? { fix: 'It has already gone out, so check in Kit who received it.' } : {}) }) : false;
    const settled = kind ? delivered : !(wrongAim && ready);
    row = {
      ...row, ...base,
      state: wrongAim ? CHECK : went || 'draft',
      error: wrongAim, alarmed: alarmed ? wrongAim : null,
      told: settled ? level : told,
      notified: delivered ? new Date().toISOString() : row.notified,
    };
    await writeKitRow(DB, row);

    const id = row.broadcast_id;
    if (wrongAim) return { kit: 'check', id, error: wrongAim };
    if (made || found) return { kit: 'drafted', id, told: delivered };
    if (hold) return { kit: kind ? 'held' : 'unchanged', id };
    if (wrote) return { kit: changed ? 'updated' : 'redesigned', id };
    if (handEdited && (rewrite || kind === 'edited')) return { kit: 'edited', id };
    if (kind === 'scheduled' || kind === 'after-send') return { kit: kind, id };
    return { kit: 'unchanged', id };
  } catch (err) {
    const error = `Kit couldn’t be reached: ${err.message}`;
    try { return await trouble(error); } catch { return { kit: 'error', error }; }
  }
}

/**
 * Where each job's invite email stands, for its row on Reveals → Now. Read from
 * Kit each time, because the site isn't told when staff send or delete a draft.
 * Read only. A job with no entry has had no draft. Never throws for one job.
 *
 * @returns {Promise<Record<string, {state: 'waiting'|'draft'|'scheduled'|'sent'|'deleted'|'check', id?: string, at?: string, held?: string, edited?: boolean, error?: string}>>}
 */
export async function kitInviteStatus(env, jobIds) {
  const { DB } = env;
  if (!jobIds.length) return {};
  await ensureKitSchema(DB);
  const { results } = await DB.prepare(`SELECT * FROM reveal_invite_kit WHERE job_id IN (${jobIds.map(() => '?').join(', ')})`).bind(...jobIds).all();
  const out = {};
  await Promise.all((results || []).map(async (row) => {
    const id = row.broadcast_id || null;
    const error = row.error || null;
    if (!id) { out[row.job_id] = { state: 'waiting', error }; return; }
    if (row.state === DELETED) { out[row.job_id] = { state: 'deleted', id }; return; }
    const held = row.held || null;
    const got = kitConfigured(env) ? await kitReadBroadcast(env, id) : { ok: false };
    if (/HTTP 404/.test(got.error || '') || got.broadcast?.status === 'aborted') { out[row.job_id] = { state: 'deleted', id }; return; }
    if (!got.ok) { out[row.job_id] = { state: row.state === CHECK ? 'check' : ['scheduled', 'sent'].includes(row.state) ? row.state : 'draft', id, held, error }; return; }
    const b = got.broadcast;
    const went = wentOut(b);
    const audience = audienceOf(row);
    const aimedWrong = !!audience && !draftIsSafe(b, audience);
    const edited = !!row.content_hash && (await copyHash(b)) !== row.content_hash;
    out[row.job_id] = went === 'sent' ? { state: 'sent', id, held, at: b.published_at || b.send_at || null, error: aimedWrong ? error : null }
      : aimedWrong ? { state: 'check', id, held, error }
        : went ? { state: 'scheduled', id, held, at: b.send_at || null }
          : { state: 'draft', id, held, edited, error };
  }));
  return out;
}
