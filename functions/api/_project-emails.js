/**
 * Project Kickoff and Project Reveal, drafted in Kit by themselves, once each
 * per kid, for staff to review and send.
 *
 * - Kickoff: Set Start Date checked off in JobTread with a Demo date still
 *   ahead, and the kid's page published (./_demo-invites.js looks at the job;
 *   nothing is kept until it can be drafted, so it can't go stale waiting).
 * - Reveal: a Completed kid whose page has what the admin's checklist asks of a
 *   finished kid: at least 3 photos and a reveal video. Still missing a week
 *   later, the reviewer gets one reminder. Looked for hourly.
 *
 * The past stays out on purpose. The first look writes a 'skipped' row for
 * every kid already Completed, in one step, and a row is for good, so a finished
 * kid whose job later moves (a warranty repair) is never "newly complete". Only
 * a Completed kid with no row counts, so a missed moment is simply found on the
 * next look. A draft deleted in Kit stays deleted.
 *
 * Neither email says where the family lives, so both go to the newsletter list.
 * The site never sends them. The reviewer gets an email, never Slack; rehearsals
 * leave Kit alone. Off with the reveal invite email (site_config kitInvite).
 */

import { kitConfigured, kitCreateBroadcast, kitFindDraft } from './_kit.js';
import { sendEmails, emailConfigured } from './_broadcast-notify.js';
import { emailShell, facts as factRows, button, esc } from './_email-shell.js';
import { SITE_URL, TEAM_PICTURE } from './_reveal-invite-email.js';
import { projectKickoffEmail, projectRevealEmail, revealChecks } from './_project-email.js';
import { brokenLogos, kidPageReady, kitInviteSettings, kitDraftUrl } from './_reveal-invite-kit.js';
import { readConfig, alertList } from './_reveal-invites.js';

const KINDS = {
  kickoff: { what: 'kickoff email', render: projectKickoffEmail },
  reveal: { what: 'Project Reveal email', render: projectRevealEmail },
};
const DAY_MS = 24 * 60 * 60 * 1000;
const REMIND_AFTER_MS = 7 * DAY_MS;
// Months on, "complete" is no longer news
const GIVE_UP_AFTER_MS = 90 * DAY_MS;
// A worker that died mid-draft frees its claim after this
const CLAIM_MS = 10 * 60 * 1000;
const DRAFTS_PER_LOOK = 5;
const SEEDED = '__seeded__';
const KIDS_URL = `${SITE_URL}/admin/#kids`;
const isEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || ''));
const iso = (ms) => new Date(ms).toISOString();

const SCHEMA = `CREATE TABLE IF NOT EXISTS project_emails (
  slug TEXT NOT NULL, kind TEXT NOT NULL, job_id TEXT, broadcast_id TEXT, state TEXT, told TEXT, reminded TEXT,
  error TEXT, alarmed TEXT, queued_at TEXT, claimed_at TEXT, updated_at TEXT, PRIMARY KEY (slug, kind))`;
const _ready = new WeakSet();
export async function ensureProjectSchema(DB) {
  if (_ready.has(DB)) return;
  await DB.prepare(SCHEMA).run();
  _ready.add(DB);
}

export async function readProjectRow(DB, slug, kind) {
  await ensureProjectSchema(DB);
  return DB.prepare('SELECT * FROM project_emails WHERE slug = ? AND kind = ?').bind(slug, kind).first();
}

async function writeRow(DB, row) {
  await DB.prepare('UPDATE project_emails SET broadcast_id = ?, state = ?, told = ?, reminded = ?, error = ?, alarmed = ?, updated_at = ? WHERE slug = ? AND kind = ?')
    .bind(row.broadcast_id ?? null, row.state ?? null, row.told ?? null, row.reminded ?? null, row.error ?? null, row.alarmed ?? null, new Date().toISOString(), row.slug, row.kind)
    .run();
}

/** Its moment has come. Once per kid, ever: a second call changes nothing. → the row */
export async function queueProjectEmail(env, { slug, kind, jobId = null, now = Date.now(), state = 'waiting' }) {
  const { DB } = env;
  await ensureProjectSchema(DB);
  await DB.prepare('INSERT OR IGNORE INTO project_emails (slug, kind, job_id, state, queued_at) VALUES (?, ?, ?, ?, ?)')
    .bind(slug, kind, jobId, state, iso(now)).run();
  return readProjectRow(DB, slug, kind);
}

/**
 * Every kid already Completed the first time this runs goes down as 'skipped',
 * in one step with the mark that says it's done, so a look can never see the
 * past as new: a failure leaves neither, and reveal drafts stay off until it
 * has worked. Never runs again.
 */
async function seedOnce(DB, now) {
  if (await DB.prepare('SELECT slug FROM project_emails WHERE slug = ?').bind(SEEDED).first()) return;
  const at = iso(now);
  await DB.batch([
    DB.prepare(`INSERT OR IGNORE INTO project_emails (slug, kind, state, queued_at)
      SELECT slug, 'reveal', 'skipped', ? FROM kids
      WHERE status = 'completed' OR (json_valid(data) AND json_extract(data, '$.status') = 'completed')`).bind(at),
    DB.prepare('INSERT OR IGNORE INTO project_emails (slug, kind, state, queued_at) VALUES (?, ?, ?, ?)').bind(SEEDED, 'seed', 'done', at),
  ]);
}

/** One conditional write, so two looks at once can't both draft. → is it ours? */
async function claim(DB, row, now) {
  const r = await DB.prepare(`UPDATE project_emails SET state = 'claimed', claimed_at = ?
    WHERE slug = ? AND kind = ? AND broadcast_id IS NULL AND (state = 'waiting' OR (state = 'claimed' AND claimed_at < ?))`)
    .bind(iso(now), row.slug, row.kind, iso(now - CLAIM_MS)).run();
  return r?.meta?.changes > 0;
}

/** What the page still needs before the Project Reveal email, in words. The admin's own checklist for a finished kid. */
export function revealMissing(kid) {
  const missing = [];
  if (!kidPageReady(kid)) missing.push('publishing');
  if ((kid?.photos || []).filter((ph) => ph && ph.url).length < 3) missing.push('at least 3 photos');
  if (!kid?.streamVideoId && !kid?.videoUrl) missing.push('the reveal video');
  return missing;
}

/** The reviewer's note. An email only. */
export function projectNote(note, { kind, name, id, subject, missing = [] }) {
  const { what } = KINDS[kind];
  const t = note === 'waiting' ? {
    subject: `${name}’s ${what} is waiting on the page`,
    heading: `${name}’s ${what} is waiting`,
    intro: `${name}’s reveal is complete, but the kid’s page still needs ${missing.join(' and ')}. The email drafts itself as soon as that’s done.`,
  } : {
    subject: `Review ${name}’s ${what} in Kit`,
    heading: `${name}’s ${what} is ready to review`,
    intro: `${kind === 'kickoff' ? `JobTread’s Set Start Date is checked off for ${name}` : `${name}’s reveal is complete and the page has its photos and video`}, so the ${what} is drafted in Kit. Look it over, then send it from Kit. Nothing goes out until you do.`,
  };
  const rows = note === 'waiting' ? [] : [['Subject', esc(subject || '')], ['Goes to', 'The newsletter list in Kit']];
  const reminder = note === 'waiting' ? '' : 'Check the photo, the story and the giving link. Make any changes right in the draft: edits to the kid’s page don’t reach it.';
  const bodyHtml = (rows.length ? factRows(rows) : '')
    + `<div style="margin:18px 0 6px;">${id ? button('Open the draft in Kit', kitDraftUrl(id)) : button('Open Kids in the admin', KIDS_URL)}</div>`
    + (reminder ? `<p class="muted" style="margin:14px 0 0;font-size:13px;line-height:1.55;">${esc(reminder)}</p>` : '');
  const html = emailShell({ preheader: t.intro, eyebrow: 'Project email', heading: t.heading, intro: esc(t.intro), bodyHtml, footerHtml: 'Sent by the website when a kid’s project reaches this step.' });
  const text = [t.heading, '', t.intro, '', subject && note !== 'waiting' ? `Subject: ${subject}` : null, id ? `Kit: ${kitDraftUrl(id)}` : `Kids: ${KIDS_URL}`, reminder].filter((l) => l !== null).join('\n');
  return { subject: t.subject, html, text };
}

async function tell(env, settings, note, ctx) {
  const n = projectNote(note, ctx);
  const to = [settings.reviewer].filter(isEmail);
  if (!emailConfigured(env) || !to.length) return false;
  const out = await sendEmails(env, { to, subject: n.subject, html: n.html, text: n.text, tags: [{ name: 'category', value: 'project-email-review' }] }).catch(() => null);
  return (out?.sent || 0) > 0;
}

/** Tell staff once → did it really go? One that didn't is tried again on the next look. */
async function alarm(env, to, row, name, kind, error) {
  if (row.alarmed === error) return true;
  if (!emailConfigured(env) || !to.length) return false;
  const title = `${name}’s ${KINDS[kind].what} wasn’t drafted`;
  const out = await sendEmails(env, {
    to, subject: `[SOARD] ${title}`,
    html: `<p><strong>${esc(title)}</strong></p><p>${esc(error)}</p><p>The site tries again on its own.</p>`,
    text: `${title}\n\n${error}\n\nThe site tries again on its own.`,
    tags: [{ name: 'category', value: 'project-email-alert' }],
  }).catch(() => null);
  return (out?.sent || 0) > 0;
}

async function readKid(DB, slug) {
  const row = await DB.prepare('SELECT data FROM kids WHERE slug = ?').bind(slug).first();
  try { return row ? { ...JSON.parse(row.data), slug } : null; } catch { return null; }
}

/**
 * One look at one email: draft it if the kid is ready, and tell the reviewer.
 * Never throws.
 *
 * @returns {Promise<{project: string, reason?: string, id?: string, error?: string, kit?: string}>}
 */
export async function syncProjectEmail(env, row, { config = {}, alertTo = [], now = Date.now(), fetchImpl = fetch } = {}) {
  const { DB } = env;
  const s = kitInviteSettings(config);
  const { kind, slug } = row;
  if (!s.enabled || config.enabled === false) return { project: 'off' };
  if (!kitConfigured(env)) return { project: 'skip', reason: 'Kit is not connected' };
  const everyone = [...new Set([...alertTo, s.reviewer].filter(isEmail))];
  let name = 'A kid';
  // A blip isn't an alarm; still failing on the next look is. Back to waiting either way.
  const trouble = async (error) => {
    const heard = row.error === error ? await alarm(env, everyone, row, name, kind, error) : false;
    await writeRow(DB, { ...row, state: 'waiting', error, alarmed: heard ? error : row.alarmed });
    return { project: 'error', error };
  };
  try {
    const kid = await readKid(DB, slug);
    name = kid?.name || name;
    if (!kid) return { project: 'waiting', reason: 'no kid page' };
    const { render, what } = KINDS[kind];

    // Drafted, but the reviewer's email didn't go: only that is owed
    if (row.broadcast_id) {
      if (row.told) return { project: 'unchanged', id: row.broadcast_id };
      const heard = await tell(env, s, 'ready', { kind, name, id: row.broadcast_id, subject: render({ kid }).subject });
      if (heard) await writeRow(DB, { ...row, told: iso(now) });
      return { project: 'told', id: row.broadcast_id };
    }

    if (kind === 'kickoff') {
      // The makeover's over: "our next project" would be untrue
      if (kid.status === 'completed') {
        await writeRow(DB, { ...row, state: 'skipped', error: null });
        return { project: 'skip', reason: 'the makeover is finished' };
      }
      if (!kidPageReady(kid)) return { project: 'waiting', reason: 'the kid’s page isn’t published' };
    } else {
      if (now - Date.parse(row.queued_at) >= GIVE_UP_AFTER_MS) {
        await writeRow(DB, { ...row, state: 'skipped', error: null });
        return { project: 'skip', reason: 'too long after the reveal' };
      }
      // Back in progress (a job reopened): not "complete" until it says so again
      if (kid.status !== 'completed') return { project: 'waiting', reason: 'the kid isn’t Completed' };
      const missing = revealMissing(kid);
      if (missing.length) {
        if (!row.reminded && now - Date.parse(row.queued_at) >= REMIND_AFTER_MS) {
          const heard = await tell(env, s, 'waiting', { kind, name, missing });
          if (heard) await writeRow(DB, { ...row, reminded: iso(now) });
        }
        return { project: 'waiting', reason: missing.join(' and ') };
      }
    }

    if (!(await claim(DB, row, now))) return { project: 'unchanged', reason: 'another look has it' };

    // Kit may have taken a draft whose answer never arrived: never a second one
    const mark = `· ${slug} · ${kind}`;
    const lost = await kitFindDraft(env, mark);
    if (!lost.ok) return await trouble(`Kit couldn’t be reached, so ${name}’s ${what} wasn’t drafted.`);
    // Its before and after, and whether its Stream video still plays (the page shows no video when it won't)
    const broken = await brokenLogos(kid, { fetchImpl, extra: revealChecks(kid) });
    const email = render({ kid, brokenLogos: broken, teamPicture: !broken.has(TEAM_PICTURE) });
    let id = String(lost.broadcast?.id || '');
    if (!id) {
      const r = await kitCreateBroadcast(env, { subject: email.subject, previewText: email.preview, description: `[auto] ${name} ${what} ${mark}`, html: email.html });
      id = String(r.broadcast?.id || '');
      if (!r.ok || !id) return await trouble(`Kit didn’t take ${name}’s ${what}.`);
    }
    const drafted = { ...row, broadcast_id: id, state: 'drafted', error: null, alarmed: null };
    await writeRow(DB, drafted); // kept first: a draft Kit has is never made twice
    const heard = await tell(env, s, 'ready', { kind, name, id, subject: email.subject });
    if (heard) await writeRow(DB, { ...drafted, told: iso(now) });
    return { project: 'drafted', id, told: heard };
  } catch (err) {
    console.error('[project-emails]', err.message);
    try { return await trouble(`The site couldn’t draft ${name}’s ${KINDS[kind].what}.`); } catch { return { project: 'error', error: err.message }; }
  }
}

/**
 * The hourly look, from the kid status sweep: finds kids newly Completed, and
 * works through what's waiting. Only kids ready now use Kit, so a long list
 * still waiting on a video can't hold up the next kid. Never throws.
 */
export async function runProjectEmails(env, { now = Date.now(), fetchImpl = fetch } = {}) {
  try {
    const { DB } = env;
    if (!DB) return [];
    await ensureProjectSchema(DB);
    await seedOnce(DB, now);
    // Completed, with no row: only ever a kid who finished since the first look
    const { results: fresh } = await DB.prepare(`SELECT k.slug FROM kids k
      LEFT JOIN project_emails p ON p.slug = k.slug AND p.kind = 'reveal'
      WHERE p.slug IS NULL AND json_valid(k.data) AND json_extract(k.data, '$.status') = 'completed'`).all();
    for (const { slug } of fresh || []) await queueProjectEmail(env, { slug, kind: 'reveal', now });
    const { results } = await DB.prepare(`SELECT * FROM project_emails
      WHERE (kind = 'reveal' AND state IN ('waiting', 'claimed') AND broadcast_id IS NULL) OR (broadcast_id IS NOT NULL AND told IS NULL)
      ORDER BY queued_at`).all();
    if (!results?.length) return [];
    const config = await readConfig(DB);
    const out = [];
    let drafted = 0;
    for (const row of results) {
      if (drafted >= DRAFTS_PER_LOOK) break;
      const r = await syncProjectEmail(env, row, { config, alertTo: alertList(env, config), now, fetchImpl });
      if (r.project === 'drafted') drafted += 1;
      out.push({ slug: row.slug, kind: row.kind, ...r });
    }
    return out;
  } catch (err) {
    console.error('[project-emails]', err.message);
    return [];
  }
}

/**
 * Set Start Date is checked off with a Demo date ahead: the kickoff's moment.
 * Nothing is kept for a kid who isn't ready, so a page hidden for now is simply
 * looked at again while demo day is ahead. Never throws.
 */
export async function kickoffNow(env, { slug, jobId, now = Date.now(), fetchImpl = fetch }) {
  try {
    const { DB } = env;
    const have = await readProjectRow(DB, slug, 'kickoff');
    const open = have && (['waiting', 'claimed'].includes(have.state) || (have.broadcast_id && !have.told));
    if (have && !open) return { project: 'unchanged' };
    const kid = await readKid(DB, slug);
    if (!have && (!kidPageReady(kid) || kid.status === 'completed')) return { project: 'waiting', reason: 'not ready yet' };
    const row = have || await queueProjectEmail(env, { slug, kind: 'kickoff', jobId, now });
    const config = await readConfig(DB);
    return await syncProjectEmail(env, row, { config, alertTo: alertList(env, config), now, fetchImpl });
  } catch (err) {
    return { project: 'error', error: err.message };
  }
}
