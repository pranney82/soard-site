/**
 * The room's design, in on time for each reveal, by itself
 * =========================================================
 * Peter, Nov 10 2026: "what about the timing of getting the design docs on to
 * kids admin to be ready for their reveal?" Until now someone had to remember
 * Admin → Kids → Bring in from JobTread before every reveal, and nothing said
 * when they hadn't. Now the site brings in what the kid's profile doesn't have
 * yet from the kid's JobTread job, the way that button does (designSources in
 * ./reveal-design-admin.js, and the same picks):
 *   - before photos (tagged Before), into Photos → Before photos
 *     (kid.beforePhotos). Peter, Nov 12 2026: "when a reveal is marked as
 *     confirmed, can you put the before pictures of the project in admin? and
 *     they should go into photos, not the before and after section". So from
 *     the moment JobTread says Reveal Date Confirmed, however far ahead the
 *     reveal is, every before photo on the job comes in, a hidden profile's
 *     too: the reveal screen's places still free (it plays the first
 *     BEFORE_SHOWN, ./reveal-design.js) go to ones spread across the visit,
 *     then the rest in the order they were taken. One tagged Before later
 *     joins at the end, until the reveal. A run brings BEFORES_A_RUN at most,
 *     within RUN_BUDGET_MS of its start; while any are still to come, the next
 *     run starts a minute later. A photo JobTread won't give is tried again
 *     later (RETRY_AFTER_MS), then left out and said in Slack; when Cloudflare
 *     Images refuses, the run stops and nothing is counted against a photo.
 *     JobTread is asked for the Before-tagged files only. Then the site looks
 *     at each one (./_photo-screen.js; Peter, Nov 12 2026: "you can review
 *     those photos and leave off the ones you think arent good to publish?"):
 *     a person, family photos, a screen, papers, boxes, a tape measure, the
 *     panel or a close-up keeps it off the page and the reveal screen, with
 *     why. Until it's been looked at, a photo shows nowhere (onPage in
 *     ../../public/admin/reveal-design.js), and staff can switch any one on
 *     or off (Photos → Before photos → On the page); theirs is never changed.
 *     The same look goes over any profile's before photos nobody has looked
 *     at (brought in with the button, or moved here once). A run looks first
 *     (it needs nothing from JobTread), the nearest reveal's photos first.
 *   - the existing and proposed drawings, from the confirm too (Peter, Nov
 *     12 2026: "as reveal is confirmed we should show the before pictures (a
 *     curated section) and the existing plans and the proposed plans"), each
 *     plan set's pages sorted by their titles and drawn by pdf.js in
 *     Cloudflare's Browser Rendering, the family's address painted out
 *     wherever its words are and the title block cut off
 *     (public/admin/reveal-design-draw.js, the code the button runs)
 *   - and the design board.
 * It only ever adds. A before photo the profile has ever had (the ledger, the
 * profile, its History) never comes in again, and a drawing part comes in once
 * (the drawings and board), so what staff take out stays out; nothing in
 * JobTread is changed. What staff saved is never touched. A drawing whose
 * street wasn't found among its words (a scan, or the street drawn as lines)
 * is saved without an address check, so the reveal screen and live page leave
 * it out, and staff are asked in Slack to cover it or tick that it has none.
 * Slack hears when a kid's before photos or design come in, and 3 days and 1
 * day before each reveal whether it's ready or what's missing.
 *
 * Which reveals: JobTread's own, read fresh each run (every job, every
 * profile, hidden ones too: buildAdminView in ./reveals-admin.js), and only on
 * a current job: open and being built (Design to Build), never a closed job,
 * an earlier makeover's or a TEST job (currentReveals). The confirm itself wakes a run at once (POST /api/reveal-invites
 * → wakeRevealDesigns); otherwise each heartbeat (./broadcast-hooks.js) may
 * start one every 10 minutes. One conditional write claims a run, so two never
 * overlap; a run does one part for one kid, soonest reveal first (Cloudflare
 * gives it about 30 seconds). Each change is a version in the kid's history
 * (Admin → Kids → History) and the audit log, as "Automatic design import".
 * A run that fails says why on Site → Automations. Never throws.
 */
import { isRehearsalJob, BUILDING_STATUSES, getReveals } from './_reveals.js';
import { fetchAllJobs, buildAdminView } from './reveals-admin.js';
import { loadAllKids, loadAllProjects, FIELD_STATUS, requestDeploy } from './_kid-status.js';
import { designSources } from './reveal-design-admin.js';
import { readConfig } from './_broadcast.js';
import { alertAdmins, adminCard, slackPost, sendEmails, emailConfigured, SITE_ORIGIN } from './_broadcast-notify.js';
import { emailShell, button, esc } from './_email-shell.js';
import { recordVersion } from './_content-history.js';
import { logAudit } from './_audit.js';
import { uploadImage, publicUrl } from './_cf-images.js';
import { screenPhoto, screenUrl, QUESTIONS, AiDown, Refused, UNCHECKED } from './_photo-screen.js';
import { aiCapped, AI_REST_MS, AI_WAIT_NOTE } from './_ai.js';
import { PLAN_KINDS, planKind, suggestBefores, addressWords, addressChecked, looksLikeFileName, isRevealed, kindFromText, beforePhotosOf, freeBeforePlaces, pagePlans, pageBefores, onPage, keptOff, BEFORE_SHOWN } from '../../public/admin/reveal-design.js';
import { isDocumentName, captionOf, kindFromSheet } from '../../public/admin/reveal-design-draw.js';

export const AUTO_KEY = 'reveal-design-auto';   // what it has done for each kid, and what Slack has been told
const CLAIM_KEY = 'reveal-design-auto-next';    // when the next run may start (data), and when the last one did (updated_at)
const WOKE_KEY = 'reveal-design-auto-woke';     // when JobTread's confirm last woke a run (data, ms): reveals read before it are old
const RUN_EVERY_MS = 10 * 60_000;
const SOON_MS = 60_000;                         // the next run, while a kid's before photos are still coming in
const LEASE_MS = 45_000;                        // a run started this recently is still going: no other starts
const RETRY_MS = 6 * 3600e3;                    // a part with nothing to bring in is looked for again this long after
const DAY_MS = 24 * 3600e3;
const BEFORES_A_RUN = 12;                       // before photos one run brings, at most
const RUN_BUDGET_MS = 20_000;                   // from a run's start; Cloudflare gives a heartbeat's work about 30 s
// A before photo JobTread won't give is tried again this long after each failure, then left out (and said)
const RETRY_AFTER_MS = [30 * 60_000, 3 * 3600e3, 12 * 3600e3];
const MAX_EDGE = 2400;                          // a drawing's long side, as the button draws it
const PDF_BASE = '/trade-partners/pdf/';        // the site's public copy of pdf.js (as ./_coi-backfill.js draws W-9s)
const PDFS_A_RUN = 2;
const DRAW_MIN_MS = 10_000;                     // a plan set isn't started with less of the run left than this
const DRAW_UPLOAD_MS = 3_000;                   // ...and its drawing stops this long before the deadline, for the uploads
const DRAW_RETRY_MS = 30 * 60_000;              // drawings that got no time, or ran out of it, are looked for again this soon (doubling)
const AFTER_MS = 8_000;                         // the notes and the publish after a run's work are done by this long past its deadline
const SAVE_MS = 1_500;                          // ...less this, for the ledger's save at the very end
const NOTE_MS = 2_500;                          // a note to Slack isn't started with less left than this
const PUBLISH_MS = 5_000;                       // nor the publish (JobTread's schedule read fresh, then the deploy hook)
const ADD_MS = 1_000;                           // drawings stop this long early too, for the plans' save before their note
const DEPLOY_MS = 2_000;                        // ...whose deploy hook isn't asked with less left than this
const REVEALS_FRESH_MS = 5 * 60_000;            // JobTread's reveals, read this lately, aren't read again (a confirm's wake reads them)
const LOOKS_AT_ONCE = 3;                         // before photos looked at side by side
// Each call has its own limit, and none is started without that much of the run left: so one that runs out of time
// was slow on its own (a service down or stuck), never cut short by the run, and is rested and counted as such
const FILE_MS = 5_000;                          // a JobTread file's download
const UPLOAD_MS = 5_000;                        // an upload to Cloudflare Images
const LOOK_FETCH_MS = 4_000;                    // the resized picture the site looks at
const LOOK_TRY_MS = 8_000;                      // each of Workers AI's tries at it
const LOOK_POST_MS = 2_000;                     // the looks stop this long before the run's deadline: saving them
const LOOK_REST_MS = 15 * 60_000;               // a photo whose look couldn't happen (a service down) rests this long
const LOOK_OUTS = 8;                            // ...and this many of those in a row count as one failed look
const BY = 'Automatic design import';
// Who's emailed to look over a reveal's before photos once they're in and checked (Peter, Nov 13 2026: "when the
// befores are imported, can you send an email to linzi to go review them?")
export const BEFORE_REVIEWERS = ['linzi@soardcharity.com'];
const KIND = Object.fromEntries(PLAN_KINDS.map((k) => [k.id, k]));
const DRAWING_PARTS = ['as-built', 'proposed', 'board'];

const possessive = (n) => (/s$/i.test(n) ? `${n}’` : `${n}’s`);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
// A random part in every picture's address: Cloudflare Images serves any address to anyone, so a kept-off photo (or a
// drawing waiting on its address check) must never be found by guessing from one that's on the page
const unguessable = () => crypto.randomUUID().replace(/-/g, '');
const slugOf = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'drawing';
const isPdf = (f) => /pdf/i.test(f?.type || '') || /\.pdf$/i.test(f?.name || '');
const isImage = (f) => /^image\//i.test(f?.type || '') || /\.(jpe?g|png|webp|heic|heif|gif)$/i.test(f?.name || '');
const isHeic = (f) => /hei[cf]/i.test(`${f?.type || ''} ${f?.name || ''}`);
const toBase64 = (bytes) => { let s = ''; const u = new Uint8Array(bytes); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
const fromBase64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

// ── What a kid has ──────────────────────────────────────────────────

/** Which parts of the design a profile already has (staff's or brought in): { befores, as-built, proposed, board } */
export function partsOf(kid) {
  const plans = kid?.plans || [];
  return {
    befores: beforePhotosOf(kid).length > 0,
    'as-built': plans.some((p) => p?.url && planKind(p) === 'as-built'),
    proposed: plans.some((p) => p?.url && planKind(p) === 'proposed'),
    board: plans.some((p) => p?.url && planKind(p) === 'board'),
  };
}

/** Every JobTread file already on the profile ("jt:<id>" or "jt:<id>#<page>"), so nothing comes in twice */
const sourcesOf = (kid) => new Set([...(kid?.plans || []), ...(kid?.beforePhotos || []), ...(kid?.beforeAfterPhotos || []), ...(kid?.photos || [])].map((x) => x?.source).filter(Boolean));

/**
 * What's next to do, soonest reveal first: { slug, name, startsAt, jobId, work: 'befores' | 'drawings', want } or null.
 * reveals: JobTread's confirmed reveals still ahead (revealsAhead); kids: slug → profile; ledger: AUTO_KEY's kids.
 *   - before photos, for any profile whose room isn't revealed yet: never looked at, some still to come, one to try
 *     again now due, or last looked at RETRY_MS ago (a photo tagged Before since)
   (The site's look at before photos nobody has looked at comes before all of this, with no JobTread read: nextLook)
 *   - then the drawings and board: a part is wanted when the profile has none, it was never brought in for this
 *     kid, and it wasn't looked for in the last RETRY_MS
 */
export function nextWork(reveals, kids, ledger, now = Date.now()) {
  for (const r of reveals) {
    const kid = kids[r.slug];
    if (!kid || isRevealed(kid)) continue;
    const mine = ledger?.[r.slug] || {};
    const job = { slug: r.slug, name: kid.name || r.name || '', startsAt: r.startsAt, jobId: r.jobId || '' };
    const b = mine.befores || {};
    // (Resting after JobTread or Cloudflare was down: the kid's other work, and other kids', go first meanwhile)
    const resting = Number(b.restUntil) > now;
    if (!resting && (!b.checked || b.owed > 0 || Number(b.checked) <= now - RETRY_MS || (b.retryAt && Number(b.retryAt) <= now))) return { ...job, work: 'befores', want: ['befores'] };
    const has = partsOf(kid);
    const open = (part) => !has[part] && !mine.done?.[part] && !(Number(mine.tried?.[part]) > now - RETRY_MS);
    const want = DRAWING_PARTS.filter(open);
    if (want.length) return { ...job, work: 'drawings', want };
  }
  return null;
}

/** JobTread's confirmed reveals that haven't started, soonest first */
export function revealsAhead(list, now = Date.now()) {
  return (list || [])
    .filter((r) => r?.slug && r.confirmed !== false && r.startsAt && Date.parse(r.startsAt) > now)
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
}

/**
 * Every reveal JobTread has on a current job, for every profile (hidden ones too): { slug, name, startsAt, confirmed,
 * jobId }. A current job is open and being built (Design to Build; Peter, Nov 12 2026: "make sure you are looking at
 * current jobs since some kids might have more than 1 makeover, it should be active and likely in the build stage"):
 * never a closed job, an earlier makeover's or a TEST job.
 */
export function currentReveals(jobs, kids, now, projects = []) {
  const statusOf = (j) => String((j.customFieldValues?.nodes || []).find((v) => v.customField?.id === FIELD_STATUS)?.value || '').trim();
  // (The jobs are narrowed first, so another job's reveal can never stand in for the current one's)
  const current = jobs.filter((j) => !j.closedOn && !isRehearsalJob(j) && BUILDING_STATUSES.has(statusOf(j)));
  return buildAdminView(current, kids, now, projects).reveals;
}
async function jobTreadReveals(env, fetchImpl, now) {
  const [jobs, kids, projects] = await Promise.all([fetchAllJobs(env.JOBTREAD_GRANT_KEY, fetchImpl), loadAllKids(env.DB), loadAllProjects(env.DB)]);
  return currentReveals(jobs, kids, now, projects);
}

// ── Cloudflare Images ───────────────────────────────────────────────

/**
 * Cloudflare Images or JobTread's files couldn't be reached, or refused for their own reasons (down, busy, the token
 * gone): no fault of the photo, so it's never counted against it, and the run stops. A picture refused for itself
 * (a 4xx: one Cloudflare can't read, too big; a file JobTread no longer has) is that photo's, and counts.
 */
class Outage extends Error {}
const isOutageStatus = (status) => !status || status >= 500 || status === 401 || status === 403 || status === 408 || status === 429;

/** p, or a throw (TookTooLong) once ms have passed (the work itself may go on; nothing waits for it) */
class TookTooLong extends Error {}
function withDeadline(p, ms, what) {
  let timer;
  return Promise.race([p, new Promise((_, reject) => { timer = setTimeout(() => reject(new TookTooLong(`${what} took too long`)), Math.max(0, ms)); })]).finally(() => clearTimeout(timer));
}

/** Bytes up to Cloudflare Images under an id, as the editor's uploads are named → the picture's /public address. timeoutMs: at most */
async function uploadPicture(env, bytes, type, id, fetchImpl, { timeoutMs = 0 } = {}) {
  if (!env.CF_ACCOUNT_ID || !env.CF_IMAGES_TOKEN) throw new Outage('Cloudflare Images isn’t set up (CF_ACCOUNT_ID, CF_IMAGES_TOKEN)');
  if (bytes.byteLength > 10 * 1024 * 1024) throw new Error('over Cloudflare Images’ 10 MB');
  let j;
  try { j = await uploadImage(env, { bytes, type, filename: id.split('/').pop(), id, ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}) }, fetchImpl); } catch (e) { throw new Outage(`Cloudflare Images couldn’t be reached (${e.message})`); }
  if (j?.success) return publicUrl(j.result);
  const why = j?.errors?.[0]?.message || `Cloudflare Images answered ${j?.status || 'nothing'}`;
  throw isOutageStatus(j?.status) ? new Outage(`Cloudflare Images refused: ${why}`) : new Error(why);
}

/**
 * A file's bytes and type. whose: whose files they are, for what's said when they can't be had; timeoutMs: at most.
 * These addresses carry no token, so a 4xx (gone, forbidden, not found) is the file's own; only the service being
 * down, slow or busy (5xx, 408, 429, no answer) is an Outage
 */
async function fileBytes(url, fetchImpl, whose = 'JobTread’s files', { timeoutMs = 0 } = {}) {
  let r;
  try { r = await fetchImpl(url, timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : undefined); } catch (e) { throw new Outage(`${whose} couldn’t be reached (${e.message})`); }
  const own = r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429;
  if (!r.ok) throw own ? new Error(`${whose} answered ${r.status}`) : new Outage(`${whose} answered ${r.status}`);
  // (The body comes after the headers: one that stops coming, or comes too slowly for the limit, is the service's too)
  let body;
  try { body = await r.arrayBuffer(); } catch (e) { throw new Outage(`${whose} stopped sending it (${e.message})`); }
  return { bytes: new Uint8Array(body), type: (r.headers.get('content-type') || '').split(';')[0].trim() };
}

// ── The before photos ───────────────────────────────────────────────

/**
 * Every JobTread file this kid's profile has ever had (each comes in once, so one staff took out stays out): what the
 * ledger remembers, what's on the profile now (before photos, pairs, the gallery), and what History still holds (one added with
 * Bring in from JobTread and taken out between two looks). → Set of file ids
 */
export async function everHad(env, slug, kid, b) {
  const ids = new Set(b.brought || []);
  for (const s of sourcesOf(kid)) { const id = String(s).match(/^jt:([^#]+)$/)?.[1]; if (id) ids.add(id); }
  // (Only photo objects: an old version may hold a list of anything, and json_each on a plain string throws)
  // (Valid versions first, so a broken one is passed over rather than stopping the read)
  const { results } = await env.DB.prepare(`WITH v AS (SELECT data FROM content_versions WHERE collection = 'kids' AND slug = ? AND json_valid(data))
    SELECT DISTINCT json_extract(p.value, '$.source') AS s FROM v, json_each(v.data, '$.beforePhotos') p
      WHERE p.type = 'object' AND json_extract(p.value, '$.source') LIKE 'jt:%'
    UNION SELECT DISTINCT json_extract(p.value, '$.source') FROM v, json_each(v.data, '$.beforeAfterPhotos') p
      WHERE p.type = 'object' AND json_extract(p.value, '$.source') LIKE 'jt:%'
    UNION SELECT DISTINCT json_extract(p.value, '$.source') FROM v, json_each(v.data, '$.photos') p
      WHERE p.type = 'object' AND json_extract(p.value, '$.source') LIKE 'jt:%'`).bind(slug).all()
    .catch((e) => (/no such table/i.test(String(e?.message || e)) ? { results: [] } : Promise.reject(e)));
  for (const r of results || []) { const id = String(r.s).match(/^jt:([^#]+)$/)?.[1]; if (id) ids.add(id); }
  return ids;
}

/**
 * The same photo on a job twice (CompanyCam copied Max's home visit into JobTread twice, so his 42 Before photos are
 * 21): two taken at the same second, as the photo sorter read them (./_photo-stages.js, D1 photo_stages), are one.
 * The one the profile has, else the first, stands; the others → a Set of file ids never brought in.
 */
async function sameTaken(env, jobId, befores, ever) {
  const { results } = await env.DB.prepare('SELECT file_id, taken FROM photo_stages WHERE job_id = ? AND taken IS NOT NULL').bind(jobId).all()
    .catch((e) => (/no such table/i.test(String(e?.message || e)) ? { results: [] } : Promise.reject(e)));
  const takenOf = new Map((results || []).map((r) => [r.file_id, r.taken]));
  const first = new Map();
  for (const f of befores) { const t = takenOf.get(f.id); if (t && ever.has(f.id) && !first.has(t)) first.set(t, f.id); }
  for (const f of befores) { const t = takenOf.get(f.id); if (t && !first.has(t)) first.set(t, f.id); }
  return new Set(befores.filter((f) => { const t = takenOf.get(f.id); return t && first.get(t) !== f.id; }).map((f) => f.id));
}

/**
 * The job's before photos the profile hasn't had, up to BEFORES_A_RUN and until the run's deadline, as JobTread's own
 * 2048px JPEGs (an iPhone's HEIC comes out as a JPEG this way). One JobTread won't give is tried again later
 * (RETRY_AFTER_MS), then left out and said; JobTread or Cloudflare being down stops the run uncounted (Outage). b:
 * this kid's befores ledger (its `failed`: { fileId: { n, at } }). ever: everHad.
 * → { photos: [{ url, alt, room, source }], owed: due now and not reached, waiting: to try again later, nextAt,
 *     gaveUp: [{ id, name }], failedNow, lastError, outage }
 */
async function bringBefores(env, job, src, kid, b, ever, fetchImpl, now, deadline, clock) {
  b.failed ||= {};
  const tries = (f) => b.failed[f.id]?.n || 0;
  const givenUp = (f) => tries(f) > RETRY_AFTER_MS.length;
  const dueAt = (f) => (tries(f) ? Number(b.failed[f.id].at) + RETRY_AFTER_MS[tries(f) - 1] : now);
  // A HEIC JobTread has no JPEG of can't be shown anywhere, so it's no before photo of ours; nor a copy of one (sameTaken)
  const copies = await sameTaken(env, src.job.id, src.befores, ever);
  const usable = src.befores.filter((f) => (f.big || !isHeic(f)) && !copies.has(f.id));
  const owed = usable.filter((f) => !ever.has(f.id) && !givenUp(f));
  const due = owed.filter((f) => dueAt(f) <= now);
  // The reveal screen's places still free go to ones spread across the visit; the rest as taken
  // (Ones a service was down for last time go last, so one that never loads can't hold up the rest)
  const outsOf = (f) => b.failed[f.id]?.outs || 0;
  const fresh = due.filter((f) => !outsOf(f));
  const first = suggestBefores(fresh, freeBeforePlaces(kid));
  const order = [...first, ...fresh.filter((f) => !first.includes(f)), ...due.filter((f) => outsOf(f))];
  const photos = [];
  const reached = new Set();
  let failedNow = 0;
  let lastError = '';
  let outage = '';
  let starved = false;
  for (const f of order) {
    if (photos.length >= BEFORES_A_RUN) break;
    // (None started without the time for its download and upload; none at all: the run's time went on JobTread)
    if (deadline - clock() < FILE_MS + UPLOAD_MS) { starved = !reached.size; break; }
    try {
      const got = await fileBytes(f.big || f.url, fetchImpl, 'JobTread’s files', { timeoutMs: FILE_MS });
      const type = /^image\/(jpeg|png|webp|gif)$/.test(got.type) ? got.type : 'image/jpeg';
      const ext = type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg';
      const url = await uploadPicture(env, got.bytes, type, `kids/${job.slug}/before-${now + photos.length}-${unguessable()}-${slugOf(String(f.name).replace(/\.\w+$/, ''))}.${ext}`, fetchImpl, { timeoutMs: UPLOAD_MS });
      reached.add(f.id);
      photos.push({ url, alt: `${possessive(job.name || 'The child')} room before the makeover`, room: '', source: `jt:${f.id}` });
    } catch (e) {
      // JobTread or Cloudflare down: stop, count nothing against any photo. Anything else is this photo's own
      // JobTread or Cloudflare down: stop, and this photo rests (the run's other work and other kids go on); after
      // LOOK_OUTS of those in a row it counts as a failed try, so one that never loads is in the end left out. It
      // was reached: it waits for another try (it isn't owed), so the page and the note don't wait on it
      if (e instanceof Outage) {
        outage = e.message;
        reached.add(f.id);
        const outs = outsOf(f) + 1;
        if (outs >= LOOK_OUTS) { b.failed[f.id] = { n: tries(f) + 1, at: now }; failedNow++; lastError = e.message; } else b.failed[f.id] = { ...(b.failed[f.id] || {}), outs };
        break;
      }
      reached.add(f.id);
      failedNow++;
      lastError = e.message;
      b.failed[f.id] = { n: tries(f) + 1, at: now };
      console.error('[design-auto] before photo', f.id, e.message);
    }
  }
  const waitingList = owed.filter((f) => !reached.has(f.id) ? dueAt(f) > now : !photos.some((p) => p.source === `jt:${f.id}`) && !givenUp(f));
  const nextAt = waitingList.length ? Math.min(...waitingList.map(dueAt)) : null;
  return {
    photos, owed: order.filter((f) => !reached.has(f.id)).length,
    waiting: waitingList.length, nextAt, failedNow, lastError, outage, starved,
    gaveUp: usable.filter((f) => givenUp(f) && !ever.has(f.id)).map((f) => ({ id: f.id, name: f.name || f.id })),
  };
}

// ── The site's look at each before photo ────────────────────────────

const lookTries = (looks, p) => looks?.[p.url]?.n || 0;
const notLooked = (p) => !!p?.url && !p.looked && !/^(blob|data):/.test(p.url);

/**
 * A profile's before photos nobody has looked at that are due the site's look now. looks: the kid's ledger,
 * { url: { n, at, outs, wait } }: n failed looks (the model's answer unusable, the picture gone), each tried again
 * RETRY_AFTER_MS after (the last failure keeps it off for good, saveLooks); outs, looks that couldn't happen (Cloudflare
 * or Workers AI down, no time left), each resting the photo until `wait` so a stuck one never holds up the rest
 */
export function dueLooks(kid, looks = {}, now = Date.now()) {
  return (kid?.beforePhotos || []).filter((p) => {
    if (!notLooked(p)) return false;
    const l = looks?.[p.url];
    if (Number(l?.wait) > now) return false;
    const n = lookTries(looks, p);
    return !n || Number(l.at) + RETRY_AFTER_MS[Math.min(n, RETRY_AFTER_MS.length) - 1] <= now;
  });
}
/** Ones the site hasn't yet really tried to look at (only rested, or not at all): Slack's note waits for them */
const neverLooked = (kid, looks = {}) => (kid?.beforePhotos || []).filter((p) => notLooked(p) && !lookTries(looks, p));

/**
 * The site's look (./_photo-screen.js) at a profile's before photos due one, LOOKS_AT_ONCE side by side, until the
 * look's deadline (the run's, less LOOK_POST_MS for the note, the publish and the ledger after it): each is on the
 * page or kept off, with why.
 *   - The model's answer unusable, or the picture gone (a 404): the photo's own. Tried again later (RETRY_AFTER_MS);
 *     after the last, kept off for good as UNCHECKED (gaveUp), for staff to switch on.
 *   - Cloudflare Images or Workers AI down, slow or unbound, or no time left: no fault of the photo's. It rests
 *     LOOK_REST_MS (so the run goes on to other work and other kids), and after LOOK_OUTS of those in a row it counts
 *     as a failed look, so one picture that never loads can't wait forever.
 *   - Workers AI's spending cap (capped): stops, nothing counted at all; the whole look rests (AI_REST_MS, the run).
 * looks: changed in place. → { seen: [{ url, show, why }], gaveUp: [url], failedNow, lastError, outage, capped,
 * widely, rested }; widely: the trouble is the service's, not one picture's (two photos hit by Workers AI or Cloudflare
 * Images not answering, Workers AI not set up, or no time at all), so with nothing looked at the whole look rests (the
 * run); rested: the photos that only wait
 */
async function lookAtBefores(env, kid, looks, fetchImpl, now, until, clock, recent = {}) {
  const out = { seen: [], gaveUp: [], failedNow: 0, lastError: '', outage: '', capped: false, widely: false };
  const lately = LOOK_REST_MS * 8;
  // (Another photo hit by trouble lately, any profile's: this one's is likely the service's too)
  const otherLately = (url) => recent?.lastDown?.url && recent.lastDown.url !== url && now - Number(recent.lastDown.at) < lately;
  // (Workers AI has answered another photo since this one's trouble began: in this run, or since its first refusal or
  // rest. Never only "lately": a setup that breaks just after a good look must count against no photo)
  const answeredSince = (p) => out.seen.length > 0 || (Number(looks[p.url]?.since) > 0 && Number(recent?.answeredAt || 0) >= Number(looks[p.url].since));
  let downs = 0;
  const due = dueLooks(kid, looks, now);
  const failed = (p, why) => {
    const n = lookTries(looks, p) + 1;
    out.failedNow++;
    out.lastError = why;
    if (n > RETRY_AFTER_MS.length) { out.gaveUp.push(p.url); delete looks[p.url]; } else looks[p.url] = { n, at: now };
  };
  // A picture that wouldn't load rests, and LOOK_OUTS of those in a row count as one failed look. Trouble that's the
  // service's (widely) counts against no photo: they only wait, and the whole look rests (the run), unless Workers AI
  // has answered other photos since this one's trouble began, and it has waited twice since: then it's this picture's
  // (two that always fail together look like an outage, but aren't one)
  const downed = [];
  const rest = (p) => {
    const l = looks[p.url] || {};
    if (out.widely) {
      const since = Number(l.since) || now;
      const rests = (l.rests || 0) + 1;
      // (Answering others: in this run, or since this one's trouble began, the run it began in too. Once counted so, a
      // picture's trouble is its own: it goes on counting, and is given up on in the end)
      if (rests > 2 && (out.seen.length > 0 || Number(recent?.answeredAt || 0) >= since || lookTries(looks, p) > 0)) { failed(p, out.outage || 'it couldn’t be looked at'); return; }
      looks[p.url] = { ...l, wait: now + LOOK_REST_MS, since, rests };
      return;
    }
    const outs = (l.outs || 0) + 1;
    if (outs >= LOOK_OUTS) failed(p, out.outage || 'it couldn’t be looked at');
    else looks[p.url] = { ...l, outs, wait: now + LOOK_REST_MS };
  };
  // Turned away (by Workers AI, or a picture Cloudflare won't give): decided once the run knows whether Workers AI is
  // answering others. If it is, the photo's: counted, with what was said. If it answers none, the site's setup or the
  // service: nothing counted, they wait, and the whole look rests, saying why (Site → Automations)
  const refused = [];
  let i = 0;
  // (One picture that wouldn't load doesn't stop the others: only the service's trouble, or the cap, ends the look)
  for (; i < due.length && !out.widely && !out.capped; i += LOOKS_AT_ONCE) {
    if (until - clock() < LOOK_FETCH_MS + LOOK_TRY_MS) break;
    const batch = due.slice(i, i + LOOKS_AT_ONCE);
    const down = new Set();
    await Promise.all(batch.map(async (p) => {
      try {
        // (The picture, then the model: a second try in plain words only with time left for it)
        const got = await fileBytes(screenUrl(p.url), fetchImpl, 'Cloudflare Images', { timeoutMs: LOOK_FETCH_MS });
        const r = await screenPhoto(env, { bytes: got.bytes, type: got.type || 'image/jpeg' }, { timeoutMs: LOOK_TRY_MS, canRetry: () => !out.capped && until - clock() >= LOOK_TRY_MS });
        if (!r) { failed(p, 'Workers AI’s answer couldn’t be read'); return; }
        out.seen.push({ url: p.url, show: r.show, why: r.why });
        delete looks[p.url];
      } catch (e) {
        if (aiCapped(e)) { out.capped = true; return; }
        if (e instanceof Outage || e instanceof AiDown) {
          out.outage ||= e.message;
          down.add(p);
          // (The service's when two photos hit it, in this run or lately, or certainly so: one picture alone, again and
          // again, is that picture's trouble, and counts against it in the end)
          if (e.wide || ++downs > 1 || otherLately(p.url)) out.widely = true;
          return;
        }
        console.error('[design-auto] look', e.message);
        refused.push([p, e instanceof Refused ? e.message : `${e.message}`]);
      }
    }));
    downed.push(...down);
  }
  // Turned away with nothing to go by (no other photo answered since): Workers AI is asked about a photo already looked
  // at, once. If it answers, it's working, and the refusals are the photos' own; if not, the setup's or the service's
  if (refused.length && !out.seen.length && !out.capped && refused.some(([p]) => !answeredSince(p)) && recent?.control && until - clock() >= LOOK_FETCH_MS + LOOK_TRY_MS) {
    try {
      const got = await fileBytes(screenUrl(recent.control), fetchImpl, 'Cloudflare Images', { timeoutMs: LOOK_FETCH_MS });
      if (await screenPhoto(env, { bytes: got.bytes, type: got.type || 'image/jpeg' }, { timeoutMs: LOOK_TRY_MS, canRetry: () => false })) out.probed = true;
    } catch (e) {
      if (aiCapped(e)) out.capped = true;
    }
  }
  const theirs = refused.filter(([p]) => out.probed || answeredSince(p));
  for (const [p, why] of theirs) failed(p, why);
  const waiting = refused.filter((x) => !theirs.includes(x));
  if (waiting.length) {
    out.outage ||= waiting[0][1];
    out.widely = true;
    downed.push(...waiting.map(([p]) => p));
  }
  // None could even start (the run's time went on JobTread): they rest, and it counts like a service being down, so
  // the run's other work comes next time and a run that's always short of time still ends, in the end, with staff
  if (i === 0 && due.length && !out.capped) {
    out.outage ||= 'the run had no time left for them';
    out.widely = true;
    downed.push(...due.slice(0, LOOKS_AT_ONCE));
  }
  // (Rested once the run knows whether the trouble was the service's)
  for (const p of downed) rest(p);
  out.rested = downed.map((p) => p.url);
  return out;
}

/**
 * What the site saw, onto the profile: seen, and gaveUp (kept off as UNCHECKED). A photo staff looked at meanwhile
 * keeps theirs. → changeKid's answer
 */
async function saveLooks(env, slug, seen, gaveUp, now) {
  const by = new Map([...gaveUp.map((url) => [url, { url, show: false, why: UNCHECKED }]), ...seen.map((x) => [x.url, x])]);
  return changeKid(env, slug, (before) => {
    let on = 0;
    let off = 0;
    const beforePhotos = (before.beforePhotos || []).map((p) => {
      const x = by.get(p?.url);
      if (!x || p.looked) return p;
      const { offPage, offWhy, ...rest } = p;
      if (x.show) { on++; return { ...rest, looked: 'site' }; }
      off++;
      return { ...rest, looked: 'site', offPage: true, offWhy: x.why };
    });
    if (!on && !off) return null;
    return {
      data: { ...before, beforePhotos },
      changes: [{ field: 'beforePhotos', from: null, to: `The site looked at ${plural(on + off, 'before photo')}: ${on} on the page, ${off} kept off` }],
    };
  }, now);
}

/**
 * The profile whose before photos are next due the site's look, any profile's (a reveal's, or brought in with the
 * button): the nearest reveal first, as JobTread last said (ledger kids[slug].reveal), then the latest changed.
 * → { next: { slug, kid } or null, waiting: whether any photo anywhere still waits on a look, control: a photo
 * already looked at (for asking Workers AI whether it answers at all) }. It needs nothing from JobTread, so a run looks
 * before reading JobTread at all
 */
export async function nextLook(env, ledgerKids, now) {
  // (A record is saved as compact JSON, so one with any before photo has this)
  const { results } = await env.DB.prepare(`SELECT slug, data FROM kids WHERE instr(data, '"beforePhotos":[{') > 0 ORDER BY updated_at DESC`).all();
  const due = [];
  let waiting = false;
  let control = null;
  for (const row of results || []) {
    let kid = null;
    try { kid = JSON.parse(row.data); } catch { continue; }
    waiting ||= (kid.beforePhotos || []).some(notLooked);
    // (One the site looked at itself and got an answer for: never one it gave up on, or only staff saw)
    control ||= (kid.beforePhotos || []).find((p) => p?.looked === 'site' && p.offWhy !== UNCHECKED && /^https:\/\/imagedelivery\.net\//.test(p.url || ''))?.url || null;
    // (A reveal that has started is no one's to hurry for: after every reveal still ahead)
    const at = Date.parse(ledgerKids[row.slug]?.reveal?.startsAt);
    if (dueLooks(kid, ledgerKids[row.slug]?.befores?.looks, now).length) due.push({ slug: row.slug, kid, at: at > now ? at : Infinity });
  }
  due.sort((a, b) => a.at - b.at);
  return { next: due[0] ? { slug: due[0].slug, kid: due[0].kid } : null, waiting, control };
}

// ── The drawings and board ──────────────────────────────────────────

/** The page's work, in Cloudflare's browser: sort a plan set's pages, draw the ones wanted, address painted out */
async function inBrowser(data, drawSrc, designSrc, base, opts) {
  const lib = await import(`${location.origin}${base}pdf.js`);
  lib.GlobalWorkerOptions.workerSrc = `${location.origin}${base}pdf.worker.js`;
  const asModule = (src) => import(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
  const [draw, rd] = await Promise.all([asModule(drawSrc), asModule(designSrc)]);
  const task = lib.getDocument({ data: Uint8Array.from(atob(data), (c) => c.charCodeAt(0)), standardFontDataUrl: `${base}standard_fonts/`, useWasm: false, enableXfa: false });
  try {
    const doc = await task.promise;
    const zeroBased = opts.sheets.some((s) => s.page === 0);
    const pages = [];
    for (let n = 1; n <= Math.min(doc.numPages, 40); n++) {
      const page = await doc.getPage(n);
      const scale = 360 / page.getViewport({ scale: 1 }).width;
      const viewport = page.getViewport({ scale });
      const content = await page.getTextContent().catch(() => ({ items: [] }));
      const title = draw.sheetTitle(content.items, viewport.transform, scale, opts.words);
      const body = content.items.map((i) => i.str || '').join(' ').replace(/\s+/g, ' ').trim();
      const sheet = opts.sheets.find((s) => s.page === (zeroBased ? n - 1 : n))?.name || '';
      const k = opts.document ? { kind: null, title: '' } : draw.kindFromSheet({ sheet, title, body }, rd.kindFromText);
      pages.push({ n, kind: k.kind, title: k.title, sheet });
    }
    // As the button starts its picks: the first existing and first proposed sheet; a file's board sheets
    const chosen = [];
    for (const kind of ['as-built', 'proposed']) {
      const p = opts.want.includes(kind) ? pages.find((x) => x.kind === kind) : null;
      if (p) chosen.push(p);
    }
    if (opts.want.includes('board')) chosen.push(...pages.filter((x) => x.kind === 'board'));
    const street = new Set(opts.streetWords);
    const out = [];
    for (const p of chosen) {
      const drawn = await draw.drawPdfPage(await doc.getPage(p.n), { longEdge: opts.maxEdge, words: opts.words });
      const done = draw.finishSheet(drawn.canvas);
      out.push({
        n: p.n, kind: p.kind, title: p.title, sheet: p.sheet, w: done.w, h: done.h, trimmed: done.trimmed,
        wiped: drawn.wiped, textLayer: drawn.textLayer, street: [...drawn.hits].some((w) => street.has(w)),
        png: done.canvas.toDataURL('image/png').split(',')[1],
      });
    }
    return { pages: pages.map(({ n, kind, title }) => ({ n, kind, title })), out };
  } finally {
    task.destroy();
  }
}

/** The design modules as text, for the browser page (from the site's own files; ctx.readAsset in tests) */
async function moduleSource(env, ctx, path) {
  if (ctx.readAsset) return ctx.readAsset(path);
  const r = await env.ASSETS.fetch(new Request(`${SITE_ORIGIN}${path}`));
  if (!r.ok) throw new Error(`${path} answered ${r.status}`);
  return r.text();
}

async function browserOf(env, ctx) {
  if (ctx.browser) return ctx.browser;
  if (ctx.launch) { ctx.browser = await ctx.launch(); return ctx.browser; }
  if (!env.BROWSER) return null;
  const { default: puppeteer } = await import('@cloudflare/puppeteer');
  ctx.browser = await puppeteer.launch(env.BROWSER, { keep_alive: 60000 });
  return ctx.browser;
}

/** One PDF's wanted sheets, drawn in the browser → { pages, out } */
async function drawSheets(env, ctx, bytes, opts) {
  const browser = await browserOf(env, ctx);
  if (!browser) throw new Error('Cloudflare’s browser isn’t available');
  const page = await browser.newPage();
  try {
    await page.setBypassCSP(true).catch(() => {});
    await page.goto(`${ctx.origin || SITE_ORIGIN}${PDF_BASE}pdf.js`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    const [drawSrc, designSrc] = await Promise.all([moduleSource(env, ctx, '/admin/reveal-design-draw.js'), moduleSource(env, ctx, '/admin/reveal-design.js')]);
    return await page.evaluate(inBrowser, toBase64(bytes), drawSrc, designSrc, PDF_BASE, opts);
  } finally {
    await page.close().catch(() => {});
  }
}

async function bringDrawings(env, ctx, job, src, kid, want, fetchImpl, now, deadline = Infinity, clock = () => Date.now()) {
  const have = sourcesOf(kid);
  const words = addressWords(src.address);
  const streetWords = src.address.street ? addressWords({ street: src.address.street }) : [];
  const plans = [];
  const still = new Set(want);
  let looked = 0;
  let starved = false;
  // cut: a plan set the run's time ran out on, or a service down (not a real look: tried again soon, DRAW_RETRY_MS)
  let cut = false;
  // Everything here is done by the run's deadline: a plan set's download, then its drawing (by DRAW_UPLOAD_MS
  // before), then the uploads, so the notes and the publish after it have their time (AFTER_MS)
  const drawBy = deadline - DRAW_UPLOAD_MS;
  // The plan sets, final plans first (sortFiles' order), a document (a scope of work, a letter) never
  for (const f of src.drawings.filter((x) => isPdf(x) && !isDocumentName(x.name))) {
    if (!still.size || looked >= PDFS_A_RUN) break;
    // (A plan set takes the browser several seconds: none is started without the time for it)
    if (deadline - clock() < DRAW_MIN_MS) { starved ||= looked === 0; cut ||= looked > 0; break; }
    looked++;
    try {
      const { bytes } = await fileBytes(f.url, fetchImpl, 'JobTread’s files', { timeoutMs: Math.max(2000, drawBy - 3000 - clock()) });
      if (drawBy - clock() < 3000) { cut = true; break; }
      const sheets = src.sheets.filter((s) => s.fileId === f.id);
      const got = await withDeadline(drawSheets(env, ctx, bytes, { words, streetWords, sheets, want: [...still], maxEdge: MAX_EDGE, document: false }), drawBy - clock(), 'drawing the plan set');
      const boards = [];
      for (const o of got.out) {
        const source = `jt:${f.id}#${o.n}`;
        if (have.has(source) || (o.kind !== 'board' && !still.has(o.kind))) continue;
        // (Out of the run's time: what's up so far is kept; the rest comes another time, soon)
        if (deadline - clock() < 1000) { cut = true; break; }
        const named = o.sheet && !looksLikeFileName(o.sheet) ? o.sheet : o.title;
        const label = captionOf(named) || KIND[o.kind].long;
        const url = await uploadPicture(env, fromBase64(o.png), 'image/png', `kids/${job.slug}/plan-${now + plans.length}-${unguessable()}-${slugOf(label)}-notitle.png`, fetchImpl, { timeoutMs: deadline - clock() });
        // Wiped: the street itself was found by its words and painted out (as the button marks it). A board has no address to check
        const addressCheck = o.kind === 'board' ? null : o.street ? 'wiped' : null;
        plans.push({ url, label, type: o.kind, source, w: o.w, h: o.h, ...(addressCheck ? { addressCheck } : {}) });
        if (o.kind === 'board') boards.push(o); else still.delete(o.kind);
      }
      if (boards.length) still.delete('board');
    } catch (e) {
      // (Slow or down, not the plan set's own fault: what's still wanted is looked for again soon)
      if (e instanceof TookTooLong || e instanceof Outage) cut = true;
      console.error('[design-auto] drawing', f.id, e.message);
    }
  }
  // A design board that's a picture (a PNG from the designer), as the button guesses one
  if (still.has('board')) {
    for (const f of src.drawings.filter((x) => isImage(x) && !isDocumentName(x.name))) {
      const label = String(f.name || '').replace(/\.\w+$/, '');
      const guess = kindFromSheet({ sheet: label }, kindFromText).kind || (/png|hei[cf]/i.test(`${f.type} ${f.name}`) ? 'board' : null);
      if (guess !== 'board' || have.has(`jt:${f.id}`)) continue;
      if (deadline - clock() < 3000) { cut = true; break; }
      try {
        const got = await fileBytes(/hei[cf]/i.test(`${f.type} ${f.name}`) ? (f.big || f.url) : f.url, fetchImpl, 'JobTread’s files', { timeoutMs: deadline - 1000 - clock() });
        if (deadline - clock() < 1000) { cut = true; break; }
        const type = /^image\/(jpeg|png|webp|gif)$/.test(got.type) ? got.type : 'image/jpeg';
        const ext = type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg';
        const url = await uploadPicture(env, got.bytes, type, `kids/${job.slug}/plan-${now + plans.length}-${unguessable()}-${slugOf(label)}.${ext}`, fetchImpl, { timeoutMs: deadline - clock() });
        plans.push({ url, label: looksLikeFileName(label) ? KIND.board.long : label.replace(/^.*?\d{4}[_\s-]+/, '') || KIND.board.long, type: 'board', source: `jt:${f.id}` });
        still.delete('board');
        break;
      } catch (e) {
        if (e instanceof Outage) cut = true;
        console.error('[design-auto] board', f.id, e.message);
      }
    }
  }
  // starved: no plan set could even start (the run's time went on JobTread): nothing was looked at, so nothing is known
  return { plans, missing: [...still], starved, cut: cut && !starved };
}


// ── The record ──────────────────────────────────────────────────────

/**
 * Changes a kid's profile, read again just before so an edit made meanwhile is kept: change(profile) → null (nothing
 * to do) or { data, changes } (the profile to save, and the audit lines). Saved only over exactly the record read (as
 * the admin's Save checks), else read again; with a version in the kid's history and an audit line.
 * → { data } saved, { none: true } nothing to do, or null (the profile went, or kept changing)
 */
async function changeKid(env, slug, change, now) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await env.DB.prepare('SELECT data FROM kids WHERE slug = ?').bind(slug).first();
    if (!row?.data) return null;
    const before = JSON.parse(row.data);
    const out = change(before);
    if (!out) return { none: true };
    const at = new Date(now).toISOString();
    const res = await env.DB.prepare('UPDATE kids SET data = ?, updated_at = ? WHERE slug = ? AND data = ?').bind(JSON.stringify(out.data), at, slug, row.data).run();
    if (!res.meta?.changes) continue; // someone saved meanwhile: read it again
    await recordVersion(env.DB, { collection: 'kids', slug, data: out.data, previous: before, userEmail: BY, now: at }).catch(() => {});
    await logAudit(env.DB, { userEmail: BY, action: 'updated', entityType: 'kid', entitySlug: slug, entityName: out.data.name || slug, changes: out.changes, gitStatus: 'ok' }).catch(() => {});
    return { data: out.data };
  }
  return null;
}

/** Adds drawings and before photos to the profile, leaving out any JobTread file it has had meanwhile → the saved profile, or null */
async function addToKid(env, slug, { plans = [], photos = [] }, now) {
  const r = await changeKid(env, slug, (before) => {
    const have = sourcesOf(before);
    const addPlans = plans.filter((p) => !have.has(p.source));
    const addPhotos = photos.filter((p) => !have.has(p.source));
    if (!addPlans.length && !addPhotos.length) return null;
    return {
      data: { ...before, plans: [...(before.plans || []), ...addPlans], beforePhotos: [...(before.beforePhotos || []), ...addPhotos] },
      changes: [
        ...(addPhotos.length ? [{ field: 'beforePhotos', from: null, to: `${plural(addPhotos.length, 'before photo')} from JobTread` }] : []),
        ...(addPlans.length ? [{ field: 'plans', from: null, to: addPlans.map((p) => KIND[p.type].long).join(', ') }] : []),
      ],
    };
  }, now);
  return r?.data || null;
}

/**
 * Once (Nov 12 2026): before photos this import (and staff) put in Before & after, waiting there for an after on a
 * room not yet revealed, move to Photos → Before photos, where before photos live now. Their JobTread files count as
 * brought in. Whole pairs, and every pair of a revealed room, stay as they are.
 */
async function moveWaitingBefores(env, ledger, now) {
  const { results } = await env.DB.prepare(`SELECT slug FROM kids WHERE instr(data, '"after":""') > 0`).all();
  let all = true;
  for (const { slug } of results || []) {
    let moved = [];
    const r = await changeKid(env, slug, (k) => {
      if (isRevealed(k)) return null;
      const waiting = (k.beforeAfterPhotos || []).filter((p) => p?.before && !p.after);
      if (!waiting.length) return null;
      const there = new Set((k.beforePhotos || []).map((p) => p.url));
      moved = waiting.filter((p) => !there.has(p.before)).map((p) => ({ url: p.before, alt: p.beforeAlt || '', room: p.room || '', ...(p.source ? { source: p.source } : {}) }));
      return {
        data: { ...k, beforePhotos: [...(k.beforePhotos || []), ...moved], beforeAfterPhotos: k.beforeAfterPhotos.filter((p) => !waiting.includes(p)) },
        changes: [{ field: 'beforePhotos', from: null, to: `${plural(waiting.length, 'before photo')} moved here from Before & after` }],
      };
    }, now);
    if (!r) { all = false; continue; } // not saved: tried again next run
    const ids = (r.data ? moved : []).map((p) => String(p.source || '').match(/^jt:([^#]+)$/)?.[1]).filter(Boolean);
    if (ids.length) {
      const b = ((ledger.kids[slug] ||= {}).befores ||= {});
      b.brought = [...new Set([...(b.brought || []), ...ids])];
    }
  }
  return all;
}

/** What it has done. A read that fails, or a ledger that won't parse, throws: an empty one would be written over it */
async function readLedger(DB) {
  const row = await DB.prepare('SELECT data FROM site_config WHERE key = ?').bind(AUTO_KEY).first();
  return row?.data ? JSON.parse(row.data) || {} : {};
}
async function writeLedger(DB, ledger, now) {
  await DB.prepare('INSERT INTO site_config (key, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at')
    .bind(AUTO_KEY, JSON.stringify(ledger), new Date(now).toISOString()).run();
}

/**
 * One run at a time: one conditional write wins it → when it started (the claim's updated_at), or null. A heartbeat's
 * run waits for the time the last one set (RUN_EVERY_MS, or SOON_MS while before photos are coming in); a wake-up
 * (JobTread's confirm) goes at once. Neither starts while a run that began in the last LEASE_MS may still be going.
 */
async function claim(DB, now, { wake = false } = {}) {
  const next = String(now + RUN_EVERY_MS);
  const at = new Date(now).toISOString();
  const lease = new Date(now - LEASE_MS).toISOString();
  const ins = await DB.prepare('INSERT OR IGNORE INTO site_config (key, data, updated_at) VALUES (?, ?, ?)').bind(CLAIM_KEY, next, at).run();
  if (ins.meta?.changes) return at;
  const upd = wake
    ? await DB.prepare('UPDATE site_config SET data = ?, updated_at = ? WHERE key = ? AND updated_at <= ?').bind(next, at, CLAIM_KEY, lease).run()
    : await DB.prepare('UPDATE site_config SET data = ?, updated_at = ? WHERE key = ? AND CAST(data AS INTEGER) <= ? AND updated_at <= ?').bind(next, at, CLAIM_KEY, now, lease).run();
  return upd.meta?.changes ? at : null;
}

/** Before photos still to come: the next run may start SOON_MS after this one did (unless another run claimed since) */
async function soonAgain(DB, startedAt, now) {
  await DB.prepare('UPDATE site_config SET data = ? WHERE key = ? AND updated_at = ?').bind(String(now + SOON_MS), CLAIM_KEY, startedAt).run();
}

// ── Telling staff ───────────────────────────────────────────────────

const adminLink = (slug) => `${SITE_ORIGIN}/admin/#kids/${encodeURIComponent(slug)}`;
const whenOf = (iso) => new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** Where a kid's design stands: what's in, what's missing, what waits on an address check */
export function standing(kid) {
  const has = partsOf(kid);
  const plans = kid?.plans || [];
  const befores = beforePhotosOf(kid).length;
  const unchecked = plans.filter((p) => p?.url && planKind(p) !== 'board' && !addressChecked(p));
  // What the live page plays: the before photos and the two plans (design boards wait for the kid page, after the reveal)
  // (Before photos count once they're on the page: looked at, and not kept off)
  const held = (kid?.beforePhotos || []).length;
  const missing = [!has.befores && (held ? `before photos on the page (${held === 1 ? 'the one there is' : `all ${held} are`} kept off or not looked at yet)` : 'before photos'),
    !has['as-built'] && 'the existing drawing', !has.proposed && 'the proposed drawing'].filter(Boolean);
  const inParts = [befores && plural(befores, 'before photo'), ...['as-built', 'proposed'].map((k) => { const n = plans.filter((p) => p?.url && planKind(p) === k).length; return n ? `${n === 1 ? 'the' : n} ${KIND[k].long.toLowerCase()}${n > 1 ? 's' : ''}` : ''; })].filter(Boolean);
  return { missing, unchecked, inParts, ready: !missing.length && !unchecked.length };
}

/**
 * Where a kid's before photos stand, once nothing is left to bring this time and the site has looked at each one
 * (tellWhenIn): n came since the last note, waiting are to be tried again later, gaveUp were left out (each said
 * once). How many are on the page and play on the reveal screen, and what was kept off and why, for staff to look
 * over. By email to the reviewer (BEFORE_REVIEWERS: Linzi), with a button to the profile.
 */
async function tellBefores(env, job, kid, { n, waiting, gaveUp, unchecked = 0, looks }) {
  const list = kid?.beforePhotos || [];
  const all = list.length;
  const on = list.filter(onPage).length;
  const off = list.filter(keptOff);
  // Tried and not looked at (Workers AI gave no answer): tried again over the next day (RETRY_AFTER_MS), off until then
  const unseen = list.filter(notLooked).length;
  const shown = Math.min(on, BEFORE_SHOWN);
  // Why, the commonest first (then in the look's own order; staff's own last)
  const reasons = new Map();
  for (const p of off) { const w = p.offWhy || ''; reasons.set(w, (reasons.get(w) || 0) + 1); }
  const rank = (w) => { const i = QUESTIONS.findIndex((q) => q.why === w); return i < 0 ? QUESTIONS.length : i; };
  const why = [...reasons].sort((a, b) => b[1] - a[1] || rank(a[0]) - rank(b[0]))
    .map(([w, c]) => { const said = w ? w.charAt(0).toLowerCase() + w.slice(1) : 'kept off by staff'; return c > 1 ? `${said} (${c})` : said; }).join(', ');
  // Fewer on the page than the reveal screen plays, while some aren't: staff should look them over
  const low = on < BEFORE_SHOWN && (off.length > 0 || unseen > 0);
  const short = low || gaveUp.length > 0 || unchecked > 0;
  const names = (x) => `${x.slice(0, 3).map((g) => g.name).join(', ')}${x.length > 3 ? '…' : ''}`;
  const it = (k, one, many) => (k === 1 ? one : many);
  // (Said as it stands, whoever decided: the site's check, or staff before it got there)
  const bySite = list.some((p) => p.looked === 'site');
  const where = on === all ? (all === 1 ? 'it’s on the page' : 'all are on the page') : `${on} on the page${off.length ? `, ${off.length} kept off${why ? ` (${why})` : ''}` : ''}`;
  const lines = [
    n ? `${n === all ? plural(n, 'before photo') : `${plural(n, 'more before photo')}, ${all} in all,`} from JobTread for ${possessive(job.name)} reveal on ${whenOf(job.startsAt)}, in Admin → Kids → Photos → Before photos.` : '',
    n || unchecked ? `${bySite ? 'After the site’s check' : 'As they stand'}${unseen ? ` (${all - unseen} of ${all} looked at)` : ''}: ${where}.` : '',
    unchecked ? `The site couldn’t check ${plural(unchecked, 'photo')} after a day of tries, so ${it(unchecked, 'it’s', 'they’re')} kept off the page.` : '',
    unseen ? `${plural(unseen, 'photo')} couldn’t be looked at, so ${it(unseen, 'it stays', 'they stay')} off the page while the site tries again over the next day; switch ${it(unseen, 'it', 'them')} on if ${it(unseen, 'it’s', 'they’re')} fine to show.` : '',
    off.length || unseen ? 'Open any one to switch it on the page if it’s fine to show, or off if it isn’t.' : '',
    !n ? '' : !on ? 'None is on the page yet, so the reveal screen has no before photos.'
      : kid.publishStatus === 'draft' ? 'They show nowhere while the profile is hidden.'
      : `${shown === 1 ? 'The first one on the page plays' : `The first ${shown} on the page play`} on the reveal screen from an hour before; move another into the first ${BEFORE_SHOWN} to show it instead.`,
    waiting ? `${plural(waiting, 'more')} couldn’t be brought in yet; the site tries again later.` : '',
    gaveUp.length ? `${plural(gaveUp.length, 'photo')} tagged Before couldn’t be brought in after several tries (${names(gaveUp)}); add ${it(gaveUp.length, 'it', 'them')} with Add before photos if ${it(gaveUp.length, 'it’s', 'they’re')} wanted.` : '',
  ].filter(Boolean);
  const title = !n && unchecked && !gaveUp.length ? `${possessive(job.name)} before photos: ${plural(unchecked, 'photo')} couldn’t be checked`
    : !n ? `${possessive(job.name)} before photos: ${plural(gaveUp.length, 'photo')} left out`
    : low ? `${possessive(job.name)} before photos are in: ${on} on the page, look over the rest` : `${possessive(job.name)} before photos are in`;
  // An email to the reviewer (Linzi), and nothing else: a task for one person goes to their inbox, not a channel
  if (!emailConfigured(env)) return;
  const link = adminLink(job.slug);
  const label = `Review ${possessive(job.name)} before photos`;
  const html = emailShell({
    preheader: lines[0] || title,
    eyebrow: 'Before photos',
    heading: title,
    intro: esc(lines[0] || ''),
    bodyHtml: lines.slice(1).map((l) => `<p style="margin:0 0 12px;font-size:15px;line-height:1.6;">${esc(l)}</p>`).join('')
      + `<div style="margin:18px 0 6px;">${button(label, link)}</div>`,
    footerHtml: `Sent by the website when a reveal’s before photos are in from JobTread and checked. <a href="${esc(link)}" style="color:inherit;">Open the profile in the admin</a>`,
  });
  const text = [title, '', ...lines, '', `${label}: ${link}`].join('\n');
  await sendEmails(env, { to: BEFORE_REVIEWERS, subject: title, html, text, tags: [{ name: 'category', value: 'before-photos-review' }] }).catch(() => null);
}

/**
 * The note, once the before photos brought in are all in and the site has tried to look at every one (or staff
 * decided first), or once the site gives up on checking one. Checked for every reveal on every run. What it says is
 * marked told, and the ledger saved (save), before it's posted, so a run cut short never posts it twice.
 */
async function tellWhenIn(env, job, kid, b, save) {
  if (!kid || !b || b.owed > 0 || !(b.news || b.leftOut?.length || b.unchecked) || neverLooked(kid, b.looks).length) return;
  const note = { n: b.news || 0, waiting: b.waiting || 0, gaveUp: b.leftOut || [], unchecked: b.unchecked || 0, looks: b.looks };
  const was = { news: b.news, unchecked: b.unchecked, toldGaveUp: b.toldGaveUp, leftOut: b.leftOut };
  b.news = 0;
  b.unchecked = 0;
  b.toldGaveUp = [...(b.toldGaveUp || []), ...(b.leftOut || []).map((g) => g.id)];
  b.leftOut = [];
  // (Not saved: not told, so the next run says it)
  try { await save(); } catch (e) { Object.assign(b, was); throw e; }
  await tellBefores(env, job, kid, note);
}

async function tellFilled(env, job, kid, added) {
  const s = standing(kid);
  const list = added.plans.map((p) => KIND[p.type].long.toLowerCase());
  const lines = [`Brought in from JobTread for ${possessive(job.name)} reveal on ${whenOf(job.startsAt)}: ${list.join(', ')}.`,
    s.unchecked.length ? `${plural(s.unchecked.length, 'drawing')} didn’t show the street in its words, so it stays off ${possessive(job.name)} page and the reveal screen until someone covers the address or ticks that it has none.` : '',
    `The existing and proposed plans show on ${possessive(job.name)} page now and play on the reveal screen from an hour before; a design board waits for the page until after the reveal. Look it over in Admin → Kids.`].filter(Boolean);
  await slackPost(env, adminCard({ level: 'info', icon: '🎨', title: `${possessive(job.name)} design is in`, detail: lines.join(' '), url: adminLink(job.slug), urlLabel: `Open ${possessive(job.name)} profile` }), { kind: s.unchecked.length ? 'attention' : 'news' }).catch(() => {});
  return true;
}

/**
 * 3 days and 1 day out, on a profile that's shown: ready, or exactly what's missing (to Needs attention, with the
 * alert emails, when something is). Each is marked told, and the ledger saved (save), before it's posted, so a run
 * cut short never posts it twice; none is marked without the time to post it (hasTime), so it goes next run instead
 */
async function tellStanding(env, reveals, kids, ledger, now, { save = async () => {}, hasTime = () => true } = {}) {
  let changed = false;
  for (const r of reveals) {
    const kid = kids[r.slug];
    if (!kid || kid.publishStatus === 'draft' || isRevealed(kid)) continue;
    const left = Date.parse(r.startsAt) - now;
    const mark = left <= DAY_MS ? 'd1' : left <= 3 * DAY_MS ? 'd3' : null;
    if (!mark) continue;
    const mine = (ledger[r.slug] ||= {});
    mine.told ||= {};
    if (mine.told[mark] === r.startsAt) continue;
    if (!hasTime()) break;
    const before = mine.told[mark];
    mine.told[mark] = r.startsAt;
    // (Not saved: not told, so the next run says it)
    try { await save(); } catch (e) { if (before === undefined) delete mine.told[mark]; else mine.told[mark] = before; throw e; }
    changed = true;
    const s = standing(kid);
    const name = kid.name || r.name || r.slug;
    if (s.ready) {
      await slackPost(env, adminCard({ level: 'info', icon: '✅', title: `${possessive(name)} design is ready`, detail: `For the reveal on ${whenOf(r.startsAt)}: ${s.inParts.join(', ')}. It shows on the reveal screen and live page from an hour before.`, url: adminLink(r.slug), urlLabel: `Open ${possessive(name)} profile` }), { kind: 'news' }).catch(() => {});
    } else {
      const parts = [s.missing.length && `Missing: ${s.missing.join(', ')}.`, s.unchecked.length && `${plural(s.unchecked.length, 'drawing')} still need${s.unchecked.length === 1 ? 's' : ''} the address covered, or a tick that it has none.`].filter(Boolean).join(' ');
      const config = await readConfig(env.DB).catch(() => ({}));
      await alertAdmins(env, config, {
        level: 'warn', icon: '🎨', title: `${possessive(name)} design isn’t ready for the reveal`,
        detail: `${name} is revealed ${whenOf(r.startsAt)}. ${parts}`,
        fix: 'Admin → Kids → their profile → Bring in from JobTread, or add the files by hand. The site keeps looking on JobTread on its own too.',
        url: adminLink(r.slug), urlLabel: `Open ${possessive(name)} profile`,
      }).catch(() => {});
    }
  }
  return changed;
}

// ── The kid page ────────────────────────────────────────────────────

/**
 * A kid's page shows its before photos on the page and the existing and proposed plans from the confirmed reveal
 * (pagePlans, pageBefores in ../../public/admin/reveal-design.js), as the build had the schedule. So once a shown
 * profile's job has been read and its before photos are all in and looked at, or what its page would show changes, the site's copy of the
 * schedule is read fresh and the site published (the deploy hook, with the kid status sync's 10-minute cooldown; one
 * held back goes with the next). A page published for a reveal that the schedule (what the page reads) no longer
 * has confirmed, and that hasn't started, is published again without them; one whose reveal has started needs
 * nothing (the room's status takes it from there). mine.page: "<startsAt>|<befores>|<plans>" last published for.
 */
async function publishPages(env, reveals, kids, ledger, now, fetchImpl, { canLook = true, hasTime = () => true, canDeploy = hasTime, left = () => Infinity } = {}) {
  const want = [];
  const marks = []; // [mine, page]: set only once the publish was asked for, so one there was no time for comes next run
  const unmark = []; // the same, for a page published for a reveal no longer confirmed
  const current = new Map(reveals.map((r) => [r.slug, r]));
  // (JobTread's schedule, read fresh, given only what's left of the run: null when it ran out)
  const fresh = () => (hasTime() ? withDeadline(getReveals(env, { fetchImpl, now }), left(), 'reading the schedule').catch(() => null) : null);
  for (const r of reveals) {
    const kid = kids[r.slug];
    const mine = ledger[r.slug];
    // Not until the job has been read, every before photo it gives is in, and the site has looked at each one (one
    // waiting to be tried again doesn't hold it, nor do looks resting after Workers AI's spending cap)
    if (!kid || !mine?.befores?.checked || mine.befores.owed > 0 || kid.publishStatus === 'draft' || isRevealed(kid)) continue;
    if (canLook && dueLooks(kid, mine.befores.looks, now).length) continue;
    const shows = { befores: pageBefores(kid, { confirmed: true }).length, plans: pagePlans(kid, { confirmed: true }).length };
    if (!shows.befores && !shows.plans) continue;
    const page = `${r.startsAt}|${shows.befores}|${shows.plans}`;
    if (mine.page === page) continue;
    marks.push([mine, page]);
    want.push(kid.name || r.slug);
  }
  // Published for a reveal not on the list now: started (nothing to do), or maybe no longer confirmed (ask the schedule)
  const gone = Object.entries(ledger).filter(([slug, mine]) => mine?.page && !current.has(slug));
  let schedule = null;
  for (const [slug, mine] of gone) {
    const startsAt = String(mine.page).split('|')[0];
    if (!(Date.parse(startsAt) > now)) { delete mine.page; continue; }
    schedule ||= await fresh();
    // The schedule couldn't be read (or no time for it): asked again next run
    if (!schedule || schedule.error) continue;
    if ((schedule.upcoming || []).some((u) => u.slug === slug && u.confirmed)) continue;
    const row = await env.DB.prepare('SELECT data FROM kids WHERE slug = ?').bind(slug).first().catch(() => null);
    const kid = row?.data ? JSON.parse(row.data) : null;
    if (kid && kid.publishStatus !== 'draft' && !isRevealed(kid)) { unmark.push(mine); want.push(kid.name || slug); } else delete mine.page;
  }
  if (!want.length) return;
  // The site's copy of the schedule fresh first (what the build reads), then the deploy; neither done (no time left,
  // too slow, or JobTread couldn't be read, so the copy is an old one that may not have this confirm): nothing
  // marked, so the next run asks again
  schedule ||= await fresh();
  if (!schedule || schedule.error || !canDeploy()) return;
  const asked = await withDeadline(requestDeploy(env, now, `Before photos and plans on ${want.join(', ')}${want.length === 1 ? '’s page' : '’ pages'}`), left(), 'the deploy hook').catch(() => null);
  if (!asked) return;
  for (const [mine, page] of marks) mine.page = page;
  for (const mine of unmark) delete mine.page;
}

// ── The run ─────────────────────────────────────────────────────────

/**
 * One run: the next part for the next kid, then the 3-day and 1-day notes. ctx (tests and scripts): { fetchImpl,
 * launch (a local Puppeteer), readAsset, origin, now, clock (the before photos' time budget), force (skip the
 * claim), wake (JobTread's confirm: don't wait for the next run's time), reveals (what JobTread's reveals would say),
 * sources ((slug, jobId, only) → what designSources would say) }.
 * → { did: null | { slug, work, added, missing, owed, waiting } }
 */
export async function runRevealDesigns(env, ctx = {}) {
  const fetchImpl = ctx.fetchImpl || fetch;
  const now = ctx.now || Date.now();
  const clock = ctx.clock || (() => Date.now());
  // Every part of a run's work stops by here, and the notes and the publish after it by AFTER_MS past it, so it's all
  // done (and saved) before Cloudflare stops the heartbeat's work
  const deadline = clock() + RUN_BUDGET_MS;
  const left = () => deadline + AFTER_MS - SAVE_MS - clock();
  /** fn's work, given only what's left of the run's time (none started with less than need left): null if it ran out */
  const inTime = async (fn, need) => (left() < need ? null : withDeadline(Promise.resolve().then(fn), left(), 'it').catch((e) => { if (!(e instanceof TookTooLong)) console.error('[design-auto] after', e.message); return null; }));
  if (!env.DB || !env.JOBTREAD_GRANT_KEY) return { did: null, skipped: 'not set up' };
  // (A confirm's wake makes the reveals read before it old, even when this run doesn't get to read them: the run then
  // going, or the next, reads them fresh)
  if (ctx.wake) await env.DB.prepare('INSERT INTO site_config (key, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at').bind(WOKE_KEY, String(now), new Date(now).toISOString()).run().catch(() => {});
  const started = ctx.force ? null : await claim(env.DB, now, { wake: !!ctx.wake });
  if (!ctx.force && !started) return { did: null, skipped: 'not yet' };
  let soon = false;
  // What this run took on (its turn without a look, or that nothing waits on one), kept even if it fails later on
  let tookYield = false;
  let noneWaiting = false;
  try {
    const ledger = await readLedger(env.DB);
    ledger.kids ||= {};
    if (!ledger.movedBefores) {
      if (await moveWaitingBefores(env, ledger, now)) ledger.movedBefores = new Date(now).toISOString();
      await writeLedger(env.DB, ledger, now);
    }
    // The site's look first: it needs nothing from JobTread, so it has the run's time to itself. Workers AI turned
    // the site away at its spending cap a while ago: the looks rest, and nothing waits on them
    // (A look that ran into the service's trouble, partly, gives the next run to everything else: yieldLook)
    const yielding = !!ledger.yieldLook;
    tookYield = yielding;
    delete ledger.yieldLook;
    const canLook = !(Number(ledger.lookRest) > now) && !yielding;
    const found = canLook ? await nextLook(env, ledger.kids, now) : null;
    const lk = found?.next;
    if (lk) {
      const kid = lk.kid;
      const name = kid.name || lk.slug;
      const b = ((ledger.kids[lk.slug] ||= {}).befores ||= {});
      b.looks ||= {};
      let problem = null;
      const got = await lookAtBefores(env, kid, b.looks, fetchImpl, now, deadline - LOOK_POST_MS, clock, { lastDown: ledger.lastDown, answeredAt: ledger.lastAnswered, control: ledger.lastAnsweredUrl || found.control });
      // (The last photo trouble came to, and the last time Workers AI answered one, for the next looks' judging; a look
      // that got through without any trouble clears the first)
      if (got.rested?.length) ledger.lastDown = { url: got.rested.at(-1), at: now };
      else if (got.seen.length) delete ledger.lastDown;
      if (got.seen.length || got.probed) ledger.lastAnswered = now;
      // (The last photo Workers AI answered for: the check's photo when one is needed)
      if (got.seen.length) ledger.lastAnsweredUrl = got.seen.at(-1).url;
      const saved = got.seen.length || got.gaveUp.length ? await saveLooks(env, lk.slug, got.seen, got.gaveUp, now) : null;
      const after = saved?.data || kid;
      // Given up on: said in the note (tellWhenIn)
      if (saved?.data) b.unchecked = (b.unchecked || 0) + got.gaveUp.filter((url) => saved.data.beforePhotos?.some((p) => p.url === url && p.offWhy === UNCHECKED)).length;
      // (A photo no longer on the profile has nothing left to look at)
      const here = new Set((after.beforePhotos || []).map((p) => p?.url));
      for (const url of Object.keys(b.looks)) if (!here.has(url)) delete b.looks[url];
      // Nothing at all could be looked at, and not for one picture's sake (Workers AI down or too slow, Cloudflare
      // Images down): the whole look rests, a quarter hour and twice that each time in a row (to 2 hours), as it does
      // at the spending cap, so the runs in between do everything else (every other kid's JobTread work, the notes,
      // the publish). Any photo looked at, or counted, ends the rest. One picture that won't load rests only itself,
      // so the photos after it, this kid's and other kids', are looked at meanwhile
      const stuck = !got.capped && got.widely && !got.seen.length && !got.gaveUp.length && !got.failedNow;
      if (stuck) {
        ledger.lookOuts = (ledger.lookOuts || 0) + 1;
        ledger.lookRest = now + LOOK_REST_MS * Math.min(2 ** (ledger.lookOuts - 1), 8);
        // (These wait a quarter hour past the rest, so other photos are looked at first when it's over)
        for (const url of got.rested || []) if (b.looks[url]) b.looks[url].wait = Math.max(Number(b.looks[url].wait) || 0, ledger.lookRest + LOOK_REST_MS);
      } else if (!got.capped) delete ledger.lookOuts;
      // Some looked at, but the service's trouble too (Workers AI failing on some): the next run goes to everything
      // else, so looks and JobTread's work take turns while it lasts
      if (!stuck && got.widely) ledger.yieldLook = true;
      // (Given up on after a day of tries: kept off, and said in Slack's note; not trouble of the run's)
      const retrying = got.failedNow - got.gaveUp.length;
      if (got.capped) {
        ledger.lookRest = now + AI_REST_MS;
        problem = `${possessive(name)} before photos are waiting to be looked at. ${AI_WAIT_NOTE}.`;
      } else if (got.outage) problem = `${possessive(name)} before photos are waiting to be looked at: ${got.outage}.${got.failedNow ? '' : ' Nothing was counted against them;'} The site tries again on its own.`.replace('; The', '; the');
      else if (retrying > 0 && !got.seen.length) problem = `The site couldn’t look at ${plural(retrying, 'before photo')} of ${possessive(name)} (${got.lastError}). Each is tried again later, and stays off the page until then.`;
      // More to look at, or all looked at now: the next run a minute on (the note and the publish need JobTread). Not
      // saved (the profile kept changing): the same ones are due again
      // (One picture that wouldn't load keeps the pace: it rests on its own, and the rest go on a minute later)
      soon = !got.capped && !got.widely && (got.seen.length > 0 || got.gaveUp.length > 0 || dueLooks(after, b.looks, now).length > 0);
      // (The look's trouble is kept apart from JobTread's, so neither kind of run clears what the other said)
      if (problem) ledger.lookError = { message: problem, at: new Date(now).toISOString() };
      else delete ledger.lookError;
      await writeLedger(env.DB, ledger, now);
      if (soon && started) await soonAgain(env.DB, started, now).catch(() => {});
      const on = saved?.data ? got.seen.filter((x) => x.show).length : 0;
      return { did: { slug: lk.slug, work: 'look', looked: saved?.data ? got.seen.length : 0, on, off: saved?.data ? got.seen.length - on : 0, failed: got.failedNow, gaveUp: saved?.data ? got.gaveUp.length : 0 } };
    }
    // Nothing anywhere waits on the site's look: its trouble, if it said any, is over
    noneWaiting = !!found && !found.waiting;
    if (noneWaiting) delete ledger.lookError;
    // JobTread's reveals: as read in the last few minutes (a run a minute on after the last spends its time on the
    // photos, not on reading every job again), or fresh, and always fresh when a confirm woke this run
    let list = ctx.reveals;
    if (!list) {
      const seen = ledger.revealsSeen;
      const woke = seen ? Number(await env.DB.prepare('SELECT data FROM site_config WHERE key = ?').bind(WOKE_KEY).first('data').catch(() => 0)) || 0 : 0;
      if (!ctx.wake && seen && now - Number(seen.at) < REVEALS_FRESH_MS && now >= Number(seen.at) && Number(seen.at) >= woke && Array.isArray(seen.list)) list = seen.list;
      else {
        list = await withDeadline(jobTreadReveals(env, fetchImpl, now), deadline - clock(), 'reading JobTread’s reveals');
        ledger.revealsSeen = { at: now, list: list.map((r) => ({ slug: r.slug, name: r.name, startsAt: r.startsAt, confirmed: r.confirmed, jobId: r.jobId })) };
      }
    }
    const reveals = revealsAhead(list, now);
    const rows = await Promise.all(reveals.map((r) => env.DB.prepare('SELECT data FROM kids WHERE slug = ?').bind(r.slug).first()));
    const kids = Object.fromEntries(reveals.map((r, i) => [r.slug, rows[i]?.data ? JSON.parse(rows[i].data) : null]));

    let did = null;
    let problem = null; // said on Site → Automations until a run goes well
    // Each reveal as JobTread says it now, for the look's order (nextLook) when JobTread isn't read
    for (const r of reveals) (ledger.kids[r.slug] ||= {}).reveal = { startsAt: r.startsAt };
    const job = nextWork(reveals, kids, ledger.kids, now);
    // A kid's part that didn't happen rests: its before photos a quarter hour, its drawings half an hour, twice that
    // each time in a row (b.outRuns, mine.drawOuts), so the next runs take the other kids' work meanwhile
    const restBefores = (b) => { b.outRuns = (b.outRuns || 0) + 1; b.restUntil = now + LOOK_REST_MS * Math.min(2 ** (b.outRuns - 1), 8); };
    const restDrawings = (mine, parts) => {
      mine.tried ||= {};
      mine.drawOuts = (mine.drawOuts || 0) + 1;
      for (const part of parts) mine.tried[part] = now - RETRY_MS + Math.min(DRAW_RETRY_MS * 2 ** (mine.drawOuts - 1), RETRY_MS);
    };
    let src = null;
    let readError = '';
    // (JobTread's reveals took the run's time: no time to read this job, and nothing it did. It rests like any part
    // that got no time, and Automations says so, never that the job couldn't be read)
    const drawEnd = deadline + AFTER_MS - SAVE_MS - NOTE_MS - ADD_MS;
    const noTime = job && (job.work === 'befores' ? deadline - clock() < FILE_MS + UPLOAD_MS : drawEnd - clock() < DRAW_MIN_MS);
    if (noTime) {
      const mine = (ledger.kids[job.slug] ||= {});
      if (job.work === 'befores') {
        restBefores(mine.befores ||= {});
        problem = `${possessive(job.name)} before photos are waiting: reading JobTread took the run’s time. Nothing was counted against them; the site tries again on its own.`;
      } else restDrawings(mine, job.want);
      did = { slug: job.slug, work: job.work, starved: true };
    } else if (job) {
      const mine = (ledger.kids[job.slug] ||= {});
      // Saved first as if this try won't finish: a run Cloudflare stops partway (JobTread's read, or a drawing, past
      // its ~30 s) leaves this kid's part resting like any other that couldn't happen, never picked first every run
      // after. What the try comes to replaces it, in the ledger saved at the end
      const was = JSON.parse(JSON.stringify({ outRuns: mine.befores?.outRuns, restUntil: mine.befores?.restUntil, drawOuts: mine.drawOuts, tried: mine.tried }));
      if (job.work === 'befores') restBefores(mine.befores ||= {}); else restDrawings(mine, job.want);
      await writeLedger(env.DB, ledger, now);
      const put = (o, k, v) => { if (v === undefined) delete o[k]; else o[k] = v; };
      put(mine.befores || {}, 'outRuns', was.outRuns);
      put(mine.befores || {}, 'restUntil', was.restUntil);
      put(mine, 'drawOuts', was.drawOuts);
      put(mine, 'tried', was.tried);
      const only = job.work === 'befores' ? 'befores' : null;
      try {
        // (No longer than the run's time: one that would be is that job's trouble, rested like any other)
        const read = ctx.sources ? ctx.sources(job.slug, job.jobId, only) : designSources(env, job.slug, { askedJob: job.jobId, fetchImpl, only });
        src = await withDeadline(Promise.resolve(read), deadline - clock(), 'reading JobTread');
      } catch (e) {
        readError = String(e?.message || e).slice(0, 200) || 'no answer';
        console.error('[design-auto] read', job.slug, readError);
      }
    }
    if (noTime) {
      // (said above)
    } else if (job && readError) {
      // JobTread wouldn't give this one job (refused, too big, down, too slow): that kid's part alone rests, and the
      // run goes on to the notes and the publish, so the next run takes the next kid's work. Said on Automations until
      // the job reads again, whatever other kids' runs do meanwhile (readProblems)
      const mine = ledger.kids[job.slug];
      if (job.work === 'befores') restBefores(mine.befores ||= {}); else restDrawings(mine, job.want);
      problem = `JobTread couldn’t be read for ${possessive(job.name)} ${job.work === 'befores' ? 'before photos' : 'design'} (${readError}). Nothing was counted against them; the site tries again on its own.`;
      (mine.readProblems ||= {})[job.work] = problem;
      did = { slug: job.slug, work: job.work, error: readError };
    } else if (job) {
      const mine = ledger.kids[job.slug];
      if (mine.readProblems) { delete mine.readProblems[job.work]; if (!Object.keys(mine.readProblems).length) delete mine.readProblems; }
      if (job.work === 'befores') {
        const b = (mine.befores ||= {});
        b.checked = now;
        const ever = await everHad(env, job.slug, kids[job.slug], b);
        let got = { photos: [], owed: 0, waiting: 0, nextAt: null, gaveUp: [], failedNow: 0, lastError: '', outage: '', starved: false };
        if (src?.job) got = await bringBefores(env, job, src, kids[job.slug], b, ever, fetchImpl, now, deadline, clock);
        const saved = got.photos.length ? await addToKid(env, job.slug, { photos: got.photos }, now) : null;
        // Everything the profile has had stays remembered, so a photo staff take out never comes back on its own
        b.brought = [...new Set([...ever, ...(saved ? got.photos.map((p) => p.source.slice(3)) : [])])];
        if (saved) {
          kids[job.slug] = saved;
          b.news = (b.news || 0) + got.photos.length;
        }
        // Not saved (the profile went, or kept changing): the same ones are owed next run
        b.owed = got.owed + (saved ? 0 : got.photos.length);
        b.retryAt = got.nextAt;
        b.waiting = got.waiting;
        // Left out for good: said once, in the note when they're all in and looked at (tellWhenIn)
        const said = new Set([...(b.toldGaveUp || []), ...(b.leftOut || []).map((g) => g.id)]);
        b.leftOut = [...(b.leftOut || []), ...got.gaveUp.filter((g) => !said.has(g.id))];
        // A kid's photos stopping at an outage rest a quarter hour, twice that each time in a row (to 2 hours), so a
        // file that never loads costs the other kids next to nothing; a run that gets through ends the rest
        // (No time left after reading JobTread is rested the same way: nothing counted, the others get their turn)
        if (got.outage || got.starved) restBefores(b);
        else {
          delete b.restUntil;
          delete b.outRuns;
        }
        if (got.outage) problem = `${possessive(job.name)} before photos are waiting: ${got.outage}. Nothing was counted against them; the site tries again on its own.`;
        else if (got.starved) problem = `${possessive(job.name)} before photos are waiting: reading JobTread took the run’s time. Nothing was counted against them; the site tries again on its own.`;
        else if (got.failedNow && !got.photos.length) problem = `JobTread wouldn’t give ${plural(got.failedNow, 'before photo')} of ${possessive(job.name)} (${got.lastError}). Each is tried again later.`;
        // More to bring, or to look at (next)
        soon = !got.outage && !got.starved && (b.owed > 0 || (canLook && dueLooks(kids[job.slug], b.looks, now).length > 0));
        did = { slug: job.slug, work: 'befores', added: { befores: saved ? got.photos.length : 0, plans: [] }, owed: b.owed, waiting: got.waiting, missing: beforePhotosOf(kids[job.slug]).length ? [] : ['befores'], job: src?.job?.id || null };
      } else {
        mine.tried ||= {};
        mine.done ||= {};
        for (const part of job.want) mine.tried[part] = now;
        let plans = [];
        let missing = job.want;
        if (src?.job) {
          // (Drawing is the run's work: it may run on into the time the notes and the publish after it would have,
          // all but the time for its own note; those then come next run)
          const got = await bringDrawings(env, ctx, job, src, kids[job.slug], job.want, fetchImpl, now, drawEnd, clock);
          plans = got.plans;
          missing = got.missing;
          // No time to look at all, or out of it partway (or a service down): not a real try, so what's still wanted
          // isn't left for 6 hours, only half an hour, twice that each time in a row (so this kid doesn't take every
          // run from the others while JobTread is slow, and a plan set too big for a run ends up with the usual wait)
          if (got.starved || got.cut) restDrawings(mine, missing);
          else delete mine.drawOuts;
        } else delete mine.drawOuts;
        for (const part of job.want) if (!missing.includes(part)) mine.done[part] = now;
        const saved = plans.length ? await addToKid(env, job.slug, { plans }, now) : null;
        if (saved) {
          kids[job.slug] = saved;
          // (Owed till it's said: the run after says it, when this one has no time left for it)
          mine.filledNote = [...new Set([...(mine.filledNote || []), ...plans.map((p) => p.type)])];
        }
        did = { slug: job.slug, work: 'drawings', added: { befores: 0, plans: plans.map((p) => p.type) }, missing, job: src?.job?.id || null };
      }
    }
    // Drawings brought in: "design is in" (this run's, or one an earlier run had no time for)
    for (const r of reveals) {
      const mine = ledger.kids[r.slug];
      const kid = kids[r.slug];
      if (!mine?.filledNote?.length) continue;
      if (!kid || isRevealed(kid)) { delete mine.filledNote; continue; }
      const said = await inTime(() => tellFilled(env, { slug: r.slug, name: kid.name || r.name || r.slug, startsAt: r.startsAt }, kid, { plans: mine.filledNote.map((type) => ({ type })) }), NOTE_MS);
      if (said !== null) delete mine.filledNote;
    }
    // A reveal's before photos all in and looked at (or decided by staff first): one note to Slack. Each note is marked
    // told, and saved, before it's posted; one there's no time left for is left for the next run, unmarked
    const save = () => writeLedger(env.DB, ledger, now);
    for (const r of reveals) {
      const kid = kids[r.slug];
      if (kid && !isRevealed(kid) && left() >= NOTE_MS) await inTime(() => tellWhenIn(env, { slug: r.slug, name: kid.name || r.name || r.slug, startsAt: r.startsAt }, kid, ledger.kids[r.slug]?.befores, save), NOTE_MS);
    }
    await inTime(() => tellStanding(env, reveals, kids, ledger.kids, now, { save, hasTime: () => left() >= NOTE_MS }), NOTE_MS);
    await inTime(() => publishPages(env, reveals, kids, ledger.kids, now, fetchImpl, { canLook: !(Number(ledger.lookRest) > now), hasTime: () => left() >= PUBLISH_MS, canDeploy: () => left() >= DEPLOY_MS, left }), PUBLISH_MS);
    // (A kid whose JobTread job still won't read is still said, whatever this run did, while that part is still wanted:
    // drawings someone has added since, or a room revealed, need nothing read)
    for (const r of reveals) {
      const mine = ledger.kids[r.slug];
      if (!mine?.readProblems) continue;
      const kid = kids[r.slug];
      const has = partsOf(kid);
      if (!kid || isRevealed(kid)) delete mine.readProblems;
      else if (DRAWING_PARTS.every((part) => has[part] || mine.done?.[part])) delete mine.readProblems.drawings;
      if (mine.readProblems && !Object.keys(mine.readProblems).length) delete mine.readProblems;
    }
    problem ||= reveals.flatMap((r) => Object.values(ledger.kids[r.slug]?.readProblems || {}))[0] || null;
    if (problem) ledger.error = { message: problem, at: new Date(now).toISOString() };
    else delete ledger.error;
    await writeLedger(env.DB, ledger, now);
    if (soon && started) await soonAgain(env.DB, started, now).catch(() => {});
    return { did };
  } catch (e) {
    console.error('[design-auto]', e.message);
    // What failed, for Site → Automations; what was saved stays saved, and the ledger is left as it was (never
    // written over when it couldn't be read)
    const ledger = await readLedger(env.DB).catch(() => null);
    if (ledger) {
      // (Its turn without a look is used up, and nothing waiting on a look is still so, whatever failed after)
      if (tookYield) delete ledger.yieldLook;
      if (noneWaiting) delete ledger.lookError;
      await writeLedger(env.DB, { ...ledger, error: { message: String(e.message || e).slice(0, 300), at: new Date(now).toISOString() } }, now).catch(() => {});
    }
    return { did: null, error: e.message };
  } finally {
    if (ctx.browser && !ctx.keepBrowser) {
      await ctx.browser.close().catch(() => {});
      ctx.browser = null;
    }
  }
}

/** The heartbeat's call (./broadcast-hooks.js): a run when it's time. Never throws */
export async function maybeRunRevealDesigns(env) {
  try { return await runRevealDesigns(env); } catch { return null; }
}

/** JobTread's wake-up (./reveal-invites.js: a reveal confirmed, moved, a job's status): a run at once unless one is going. Never throws */
export async function wakeRevealDesigns(env) {
  try { return await runRevealDesigns(env, { wake: true }); } catch { return null; }
}
