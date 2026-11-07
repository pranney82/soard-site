/**
 * The families who applied, for the board page: to read, never to change
 * ===========================================================================
 * Peter, Nov 4 2026: "names and scores are in the applications admin, board
 * can have access to it, maybe we should build a way for them to see this
 * information in a read only type thing". Nov 6: "show the application map to
 * the board ... the ability for the board to see the video, photos and
 * application". Applicants (staff) stays where families are decided, messaged
 * and scored; the board page reads the same mirror (D1 applicants,
 * ./_applicants.js) and the same scorecards (./_applicant-scores.js), so the
 * two never disagree.
 *
 *   list    every family and organization not archived and not a test run:
 *           name, season, status, what they asked for, county, when they
 *           applied, where they are on the map, its kid page once public, the
 *           child's photo, and the score (ranked once everyone scoring the
 *           season has finished their card); and the service area
 *   one     the same, with the facts the score rests on (diagnosis, age,
 *           mobility, speech, language, who referred them, qualified, a
 *           denial's reason), each scorer's card, criterion by criterion, and
 *           their video, photos and application
 *   a file  through familyFile below, one of those and nothing else
 *
 * Never on the board page: the family's messages with SOARD, staff's onsite
 * and Zoom notes, anything else that sits in the same JobTread account (signed
 * agreements, letters, whatever was emailed in), or a scorer's notes. A file
 * goes to the board only when its name proves it's their application, video or
 * a photo they sent (../../public/admin/application-files.js provenParts); the
 * rest stays with staff. No link to JobTread's copy of a file reaches the
 * browser: each comes through /api/board-file, behind the board's sign-in, and
 * a member's opening one is noted for Board → Members.
 */

import { listApplicants, getApplicantRow, familyFiles } from './_applicants.js';
import { scoreSummaries, familyScores } from './_applicant-scores.js';
import { getLiveForm } from './_application-forms.js';
import { DEFAULT_SERVICE_AREA } from './_application-form.js';
import { applicantFiles, applicationSettings, cleanYear } from './_applications.js';
import { projectsNow } from './_board.js';
import { readState, writeState } from './_board-roles.js';
import { noteFamilyOpen } from './_board-activity.js';
import { provenParts, fileKind } from '../../public/admin/application-files.js';
import { STAGE_OF_JOB } from '../../public/admin/board/stages.js';

const isTest = (a) => !!a.isTest || /^\s*test\b/i.test(String(a.name || ''));
// Cloudflare Images only: imagedelivery.net, or through the site (the way People's photos are kept: a crop's trim=a;b;c;d)
const photoOf = (url) => (/^(https:\/\/imagedelivery\.net\/|(https:\/\/sunshineonaranneyday\.com)?\/cdn-cgi\/imagedelivery\/)[\w/=,.;-]+$/.test(String(url || '')) ? String(url) : null);

/** Whole years from a birthday ("2017-03-04") to today, or null */
export function ageFrom(birthday, now = Date.now()) {
  const m = String(birthday || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const d = new Date(now);
  let age = d.getUTCFullYear() - Number(m[1]);
  if (d.getUTCMonth() + 1 < Number(m[2]) || (d.getUTCMonth() + 1 === Number(m[2]) && d.getUTCDate() < Number(m[3]))) age -= 1;
  return age >= 0 && age < 120 ? age : null;
}

const scoreOf = (s) => (s && (s.count || s.started?.length) ? {
  total: s.total ?? null, tier: s.tier || null, ranked: !!s.ranked, count: s.count || 0, of: s.of || 0,
  criteria: s.criteria || null, talk: s.talk || [], rubric: s.rubric || null,
} : null);

/**
 * Where a family is, from application to reveal (Peter, Nov 7 2026: "the life span of a project for us from
 * application to completion"): their open job's JobTread status once it says one (STAGE_OF_JOB, shared with the
 * page: ../../public/admin/board/stages.js), else their application's. An
 * approved family whose job is closed has had their reveal. `open`: projectsNow's { [jobId]: status }, or null when
 * JobTread can't be read (then the application's status is all there is)
 */
const STAGE_OF_STATUS = { Applied: 'applied', 'In Review': 'review', Approved: 'approved', Denied: 'denied' };
export function stageOf(a, open) {
  const job = a?.jobId && open ? open[a.jobId] : undefined;
  if (job !== undefined && STAGE_OF_JOB[job]) return STAGE_OF_JOB[job];
  if (job === undefined && a?.jobId && open && a.status === 'Approved') return 'revealed';
  return STAGE_OF_STATUS[a?.status] || 'none';
}

/** One family as the board's list has it (`open`: as stageOf takes it) */
function row(a, s, open = null) {
  // Its page once it's public
  const kid = a.kid && a.kid.slug && !a.kid.draft ? a.kid : null;
  return {
    // (no status is no status: 17 older families have a season and none, and "Applied" would say something untrue)
    id: a.id, name: String(a.name || '').trim(), kind: a.kind === 'organization' ? 'organization' : 'family',
    status: a.status || '', stage: stageOf(a, open), jobId: a.jobId || null, season: a.year || '', types: Array.isArray(a.types) ? a.types : [],
    county: a.county || '', city: a.city || '', area: a.area || 'unknown', areaMiles: a.areaMiles ?? null,
    ...(a.lat != null && a.lng != null ? { lat: a.lat, lng: a.lng } : {}),
    applied: a.submittedAt || a.createdAt || null, stageAt: a.stageAt || null,
    ...(kid ? { page: kid.kind === 'community' ? `/community/${kid.slug}/` : `/kids/${kid.slug}/` } : {}),
    // The kid page's photo, else the application's, through the board's own route (never a staff-only address)
    ...(a.photo ? { photo: photoOf(a.photo) || `/api/board-file?family=${encodeURIComponent(a.id)}&face=1` } : {}),
    score: scoreOf(s),
  };
}

/** The service area as the application draws it */
async function serviceArea(DB) {
  const live = await getLiveForm(DB).catch(() => null);
  const area = live?.definition?.serviceArea;
  return { polygon: area?.polygon || DEFAULT_SERVICE_AREA.polygon, nearMiles: area?.nearMiles ?? DEFAULT_SERVICE_AREA.nearMiles };
}

/** The application's window, as the board may know it: open or not, its season, when it opens and closes */
async function applicationWindow(DB) {
  const s = await applicationSettings(DB).catch(() => ({}));
  return { open: s.open === true, year: cleanYear(s.year) || '', opensAt: s.opensAt ? String(s.opensAt) : '', closesAt: s.closesAt ? String(s.closesAt) : '' };
}

/**
 * Every family the board can read about, newest first, each where they are from application to reveal →
 * { families, makeovers, boundary, application, jobs, at }. `makeovers`: the open makeovers whose family isn't among
 * them (an older family JobTread doesn't mark as an applicant), by their page; `jobs`: false when JobTread couldn't
 * be read, so the stages are the applications' alone
 */
export async function familiesList(env, { fetchImpl = fetch } = {}) {
  const [list, scores, boundary, projects, application] = await Promise.all([
    listApplicants(env.DB), scoreSummaries(env.DB).catch(() => new Map()), serviceArea(env.DB),
    projectsNow(env, { fetchImpl }).catch(() => null), applicationWindow(env.DB),
  ]);
  const tests = await testAccounts(env.DB);
  const open = projects?.open || null;
  // (a test run's job is its own: the whole list is checked, tests too, before a makeover counts as nobody's)
  const theirs = new Set(list.map((a) => a.jobId).filter(Boolean));
  const makeovers = [...(projects?.waiting || []), ...(projects?.building || [])].filter((p) => p.jobId && !theirs.has(p.jobId)).map((p) => ({
    id: `job-${p.jobId}`, jobId: p.jobId, name: p.name || '', kind: p.kind === 'community' ? 'organization' : 'family', stage: STAGE_OF_JOB[p.status] || 'approved',
    ...(p.url || p.slug ? { page: p.url || `/kids/${p.slug}/` } : {}), ...(p.photo ? { photo: p.photo } : {}),
  }));
  return { families: list.filter((a) => !isTest(a) && !tests.has(a.id)).map((a) => row(a, scores.get(a.id), open)), makeovers, boundary, application, jobs: !!open, at: new Date().toISOString() };
}

// A database with no applications table has no website tests. Any other failure stops here: unsure means not shown
const noTable = (err) => /no such table/i.test(err?.message || '');
/** Every account a website test run made (deleted ones too: a test isn't a family once its answers are gone) */
async function testAccounts(DB) {
  try {
    return new Set(((await DB.prepare('SELECT jt_account_id FROM applications WHERE is_test = 1').all()).results || []).map((r) => r.jt_account_id));
  } catch (err) {
    if (noTable(err)) return new Set();
    throw err;
  }
}

const parsed = (x) => { try { return JSON.parse(x || 'null') || {}; } catch { return {}; } };

/**
 * A family the board may read about, with the site's application when it came from the form → { a, app } or null.
 * A website test run has an ordinary name, so its application is what says it's a test; an application deleted from
 * the site takes the site's copies with it (JobTread's stay, as they do for staff)
 */
async function readable(env, id) {
  const a = await getApplicantRow(env.DB, id);
  if (!a || a.archivedAt || isTest(a)) return null;
  let rows = [];
  try {
    rows = (await env.DB.prepare('SELECT id, is_test, deleted_at, files, jt_state FROM applications WHERE jt_account_id = ? ORDER BY submitted_at DESC').bind(id).all()).results || [];
  } catch (err) {
    if (!noTable(err)) return null;
  }
  if (rows.some((r) => r.is_test)) return null;
  const row = rows.find((r) => !r.deleted_at);
  return { a, app: row ? { id: row.id, files: parsed(row.files), state: parsed(row.jt_state) } : null };
}

// What a browser may be sent as what it is. Anything else a family or staff attached (an SVG or a web page can run
// scripts on the site's own address) isn't the application, a video or a photo, so it never goes out.
const SHOWN_TYPES = {
  pdf: ['application/pdf'],
  image: ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'image/heic', 'image/heif'],
  video: ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-m4v'],
};
const BY_EXTENSION = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', heic: 'image/heic', heif: 'image/heif', mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/x-m4v', webm: 'video/webm' };
function shownType(f) {
  const said = String(f?.type || '').split(';')[0].trim().toLowerCase();
  // (a file JobTread has no type for goes by its name)
  const type = said && said !== 'application/octet-stream' ? said : BY_EXTENSION[String(f?.name || '').match(/\.([a-z0-9]{2,5})$/i)?.[1]?.toLowerCase()] || '';
  return SHOWN_TYPES[fileKind({ ...f, type })]?.includes(type) ? type : '';
}
const onCdn = (url) => { try { const u = new URL(url); return u.protocol === 'https:' && u.host === 'cdn.jobtread.com'; } catch { return false; } };

// JobTread's answer is kept a few minutes: a video asks for itself piece by piece, and each piece shouldn't ask JobTread
const KEPT_MS = 10 * 60_000;
// …and while JobTread is down, for no longer than this: a file staff took away doesn't stay on the board page for good
const STALE_MS = 60 * 60_000;
const keptKey = (id) => `family-files:${id}`;
const keepOf = (f) => ({ id: f.id, name: f.name, type: shownType(f), size: f.size ?? null, at: f.at ?? null, url: f.url, thumb: f.thumb || null, ...(f.label ? { label: f.label } : {}) });

/**
 * The application, the video and the photos of one family, from JobTread → { pdf, video, photos, at } (`stale`: the
 * last answer, when JobTread can't give one), or null when there's neither. Whatever a file's name doesn't prove is
 * dropped here, before it's kept or sent, so nothing past this point can show it.
 */
async function readFiles(env, a, { now = Date.now(), fresh = false, fetchImpl = fetch } = {}) {
  const kept = await readState(env.DB, keptKey(a.id)).catch(() => ({}));
  if (!fresh && kept.at && now - kept.at < KEPT_MS) return kept;
  // (JobTread failed under a minute ago: not again yet, or every piece of a video and every face would wait on it)
  if (!(kept.failedAt && now - kept.failedAt < 60_000)) {
    try {
      const { pdf, video, photos } = provenParts((await familyFiles(env, a.id, { fetchImpl })).filter((f) => f?.url && onCdn(f.url) && shownType(f)), a.name);
      const value = { at: now, pdf: pdf ? keepOf(pdf) : null, video: video ? keepOf(video) : null, photos: photos.map(keepOf) };
      await writeState(env.DB, keptKey(a.id), value).catch(() => null);
      return value;
    } catch (err) {
      console.error('[board-families] files', err.message);
      await writeState(env.DB, keptKey(a.id), { ...kept, failedAt: now }).catch(() => null);
    }
  }
  return kept.at && now - kept.at < STALE_MS ? { ...kept, stale: true } : null;
}

const fileAddress = (id, fileId, more = '') => `/api/board-file?family=${encodeURIComponent(id)}&file=${encodeURIComponent(fileId)}${more}`;
const siteAddress = (id, field, more = '') => `/api/board-file?family=${encodeURIComponent(id)}&site=${encodeURIComponent(field)}${more}`;
/** One of their files as the page's viewer takes it (`private`: fetched when it's shown, never ahead) */
const shown = (id, f) => ({
  id: f.id, name: f.name, type: f.type, size: f.size, at: f.at, url: fileAddress(id, f.id), private: true,
  ...(f.label ? { label: f.label } : {}),
  // (a video's card reads its length here: seeing the card isn't watching it)
  ...(f.type.startsWith('video/') ? { probe: fileAddress(id, f.id, '&peek=1') } : {}),
  ...(f.thumb ? { thumb: fileAddress(id, f.id, '&size=600') } : {}),
  // (a photo the browser can't open, HEIC in Chrome, shows JobTread's JPEG of it)
  ...(f.thumb && f.type.startsWith('image/') ? { preview: fileAddress(id, f.id, '&size=2048') } : {}),
});

// The form's photos, in its order, for a family whose photos haven't reached JobTread yet
const SITE_PHOTOS = [['photoChild', 'Child'], ['photoFamily', 'Family'], ['photoSpace1', 'Space 1'], ['photoSpace2', 'Space 2'], ['photoSpace3', 'Space 3']];

/** What the page shows of their application: { application, video, photos, videoSoon, unavailable } */
function mediaOf(id, a, app, files) {
  const name = String(a.name || '').trim();
  const photos = (files?.photos || []).map((f) => shown(id, f));
  if (!photos.length && app) {
    for (const [field, label] of SITE_PHOTOS) {
      const f = app.files?.[field];
      if (f?.key) photos.push({ id: field, name: `${name} ${label}.jpg`, type: f.type || 'image/jpeg', size: f.size ?? null, at: null, url: siteAddress(id, field), private: true, label, ...(f.thumbKey ? { thumb: siteAddress(id, field, '&thumb=1') } : {}) });
    }
  }
  const application = files?.pdf ? shown(id, files.pdf)
    : app?.state?.pdf?.key ? { id: 'pdf', name: `${name}_Application.pdf`, type: 'application/pdf', size: null, at: null, url: siteAddress(id, 'pdf'), private: true } : null;
  return {
    application, video: files?.video ? shown(id, files.video) : null, photos,
    // Sent on the form, and still on its way through Stream to JobTread
    videoSoon: !files?.video && !!app?.files?.video && !app?.state?.video,
    unavailable: !files,
  };
}

/** One family, read-only, with what their score rests on → { family } (404 for none, an archived one or a test) */
export async function familyOne(env, id, { now = Date.now(), fetchImpl = fetch } = {}) {
  const found = await readable(env, id);
  if (!found) throw Object.assign(new Error('That family isn’t on the board page'), { status: 404 });
  const { a, app } = found;
  const [sc, files, projects] = await Promise.all([familyScores(env.DB, id).catch(() => null), readFiles(env, a, { now, fresh: true, fetchImpl }), projectsNow(env, { fetchImpl }).catch(() => null)]);
  const f = a.fields || {};
  return {
    family: {
      ...row(a, sc?.summary ? { ...sc.summary, rubric: sc.rubric } : null, projects?.open || null),
      facts: {
        diagnosis: String(f.diagnosis || '').slice(0, 2000), age: ageFrom(f.birthday, now), gender: f.gender || '', language: f.language || '',
        verbal: f.verbal || '', mobile: f.mobile || '', qualified: f.qualified || '', referredBy: String(f.referredBy || '').slice(0, 200),
        ...(a.status === 'Denied' && f.denialReason ? { denialReason: String(f.denialReason).slice(0, 2000) } : {}),
      },
      rubric: sc?.rubric || null,
      // Each scorer's card: their name and scores, never their notes
      cards: (sc?.cards || []).map((c) => ({ name: c.name || nameFromEmail(c.evaluator), scores: c.scores, total: c.total, complete: !!c.complete, done: c.done, rubric: c.rubric, at: c.completedAt || c.updatedAt || null })),
      visited: !!sc?.visited,
      media: mediaOf(id, a, app, files),
    },
  };
}

const NOT_FOUND = () => new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'private, no-store' } });
// A family's application, video and photos are never kept on the computer that opened them, like the board's other
// private files (a shared computer shouldn't still have them); a thumbnail in a list is kept a few minutes
const cacheRule = (small) => (small ? 'private, max-age=300' : 'private, no-store');
const safeName = (s) => String(s || 'file').replace(/[^\w .()-]/g, '').trim().slice(0, 120) || 'file';

/** JobTread's copy, passed through (a Range too, so a video can seek and a big PDF opens page by page) */
async function fromCdn(url, type, name, request, { small = false, fetchImpl = fetch } = {}) {
  if (!onCdn(url)) return NOT_FOUND();
  const range = request.headers.get('range');
  const res = await fetchImpl(url, { headers: range ? { range } : {} });
  // (500, not 502: Cloudflare swaps a 502's body for its own error page)
  if (!res.ok) return new Response('JobTread didn’t send the file', { status: res.status === 404 ? 404 : res.status === 416 ? 416 : 500, headers: { 'Cache-Control': 'private, no-store' } });
  const headers = new Headers({ 'Content-Type': type, 'Content-Disposition': `inline; filename="${safeName(name)}"`, 'Cache-Control': cacheRule(small), 'X-Content-Type-Options': 'nosniff' });
  for (const k of ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
    const v = res.headers.get(k);
    if (v) headers.set(k, v);
  }
  return new Response(res.body, { status: res.status, headers });
}

/**
 * /api/board-file?family=…: one of the things the board may see of a family, and nothing else. The address names a
 * file, never where it is: the family is checked, the file has to be among the application, the video and the photos
 * as read from JobTread (or the site's copy of them), and JobTread's link stays here. The caller has been checked as
 * a board member or a Board admin (./board-file.js).
 */
export async function familyFile(context, q, { now = Date.now(), fetchImpl = fetch } = {}) {
  const { env, request } = context;
  const id = q.get('family') || '';
  if (!/^[A-Za-z0-9]{6,32}$/.test(id)) return NOT_FOUND();
  const found = await readable(env, id);
  if (!found) return NOT_FOUND();
  const { a, app } = found;
  // What was opened, once it's on its way (the first piece of a video or a PDF, once)
  const noted = (res, what) => {
    if (res.ok && !/^bytes=(?!0-)/.test(request.headers.get('range') || '')) {
      const done = noteFamilyOpen(env, context.data?.boardMember, request, id, what, a.name, { now });
      if (context.waitUntil) context.waitUntil(done);
    }
    return res;
  };

  // The child's photo in a list: the one staff's list has (the mirror's pick), only when it's among what the board
  // may see; else their photo named as the child; else the form's, until JobTread has it
  if (q.has('face')) {
    const photos = (await readFiles(env, a, { now, fetchImpl }))?.photos || [];
    const plain = (u) => String(u || '').split('?')[0];
    const face = photos.find((p) => p.thumb && plain(p.thumb) === plain(a.photo)) || photos.find((p) => p.thumb && p.label === 'Child');
    if (face) return fromCdn(face.thumb.replace(/([?&]size=)\d+/, '$1256'), 'image/jpeg', `${a.name}.jpg`, request, { small: true, fetchImpl });
    const field = ['photoChild', 'photoSpace1'].find((k) => app?.files?.[k]?.thumbKey);
    return field ? fromSite(env, app.files[field].thumbKey, `${a.name}.jpg`, { small: true }) : NOT_FOUND();
  }

  // The site's own copy, until JobTread has it
  if (q.has('site')) {
    const field = q.get('site') || '';
    if (!app) return NOT_FOUND();
    if (field === 'pdf') {
      if (!app.state?.pdf?.key) return NOT_FOUND();
      return noted(await fromSite(env, app.state.pdf.key, `${a.name}_Application.pdf`), 'application');
    }
    if (!SITE_PHOTOS.some(([k]) => k === field)) return NOT_FOUND();
    const thumb = q.has('thumb');
    const key = thumb ? app.files?.[field]?.thumbKey : app.files?.[field]?.key;
    if (!key) return NOT_FOUND();
    const res = await fromSite(env, key, `${a.name}.jpg`, { small: thumb });
    return thumb ? res : noted(res, 'photos');
  }

  const fileId = q.get('file') || '';
  if (!fileId) return NOT_FOUND();
  const inFiles = (files) => [files?.pdf, files?.video, ...(files?.photos || [])].find((f) => f?.id === fileId);
  // A file added in the last few minutes isn't in what's kept: ask JobTread again before saying no (once a minute at most)
  const known = await readFiles(env, a, { now, fetchImpl });
  const f = inFiles(known) || (now - (known?.at || 0) > 60_000 ? inFiles(await readFiles(env, a, { now, fresh: true, fetchImpl })) : null);
  if (!f) return NOT_FOUND();
  const what = fileKind(f) === 'video' ? 'video' : fileKind(f) === 'pdf' ? 'application' : 'photos';
  const size = q.get('size');
  if (size) {
    if (!['256', '600', '2048'].includes(size) || !f.thumb) return NOT_FOUND();
    // A tile's thumbnail; 2048 is the whole photo, or the first page of the application, as the viewer shows it
    const big = size === '2048';
    const res = await fromCdn(f.thumb.replace(/([?&]size=)\d+/, `$1${size}`), 'image/jpeg', `${a.name}.jpg`, request, { small: !big, fetchImpl });
    return big ? noted(res, what) : res;
  }
  const res = await fromCdn(f.url, f.type, f.name, request, { fetchImpl });
  // (`peek`: a video's card reading its length; any other file by that address is opened like any other)
  return q.has('peek') && what === 'video' ? res : noted(res, what);
}

/** The site's copy, from R2: a photo or the PDF, nothing else */
async function fromSite(env, key, name, { small = false } = {}) {
  const obj = await applicantFiles(env)?.get(key);
  if (!obj) return NOT_FOUND();
  const type = String(obj.httpMetadata?.contentType || '').toLowerCase();
  if (![...SHOWN_TYPES.pdf, ...SHOWN_TYPES.image].includes(type)) return NOT_FOUND();
  return new Response(obj.body, { headers: { 'Content-Type': type, 'Content-Disposition': `inline; filename="${safeName(name)}"`, 'Cache-Control': cacheRule(small), 'X-Content-Type-Options': 'nosniff' } });
}

/** "sam.lee@soardcharity.com" → "Sam Lee" (a card saved before names were kept) */
export function nameFromEmail(email) {
  const local = String(email || '').split('@')[0];
  return local.split(/[._-]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ') || 'A scorer';
}
