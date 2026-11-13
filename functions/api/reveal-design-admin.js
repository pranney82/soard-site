/**
 * GET /api/reveal-design-admin?kid=<slug>[&job=<jobId>] (Cloudflare Access)
 * ===========================================================================
 * What the kid editor's "Bring in from JobTread" can bring in for a kid's
 * reveal (public/admin/reveal-design-import.js): the drawings and design
 * boards on their JobTread job (files tagged Plans or Design, and any plan
 * sheets JobTread split out of a PDF in its Plans tab), and the before photos
 * (tagged Before). The tags are the site's own (./_file-tags.js); the old
 * .FinalPlans, .BeforePics and the rest were emptied onto them and deleted on
 * Nov 12, 2026 (./_tag-moves.js). Also the
 * job's street, city and zip and the family's name, so the editor can wipe
 * them off a drawing before it ever leaves the computer. Staff only: not in
 * _middleware's public list, never cached.
 *
 * The job: the one the editor already knows (?job=, from /api/reveals-admin),
 * checked against the kid the same way the reveal schedule matches them
 * (./_reveals.js matchProject: the job the profile names, else name + year);
 * without ?job=, found that way among every job.
 *
 * → { success, kid: { slug, name }, job: { id, name } | null,
 *     address: { street, city, zip, family },
 *     drawings: [{ id, name, type, url, thumb, tags, createdAt, size }],
 *     befores:  [{ id, name, type, url, thumb, big, tags, createdAt, size }],
 *     sheets:   [{ fileId, page, name }] }
 */
import { pave, matchProject, isProject } from './_reveals.js';
import { loadAllKids, loadAllProjects } from './_kid-status.js';
import { fetchAllJobs, buildAdminView } from './reveals-admin.js';
import { tagIds } from './_file-tags.js';

const MAX_FILE_PAGES = 20;
// Tags, loosely ("Plans" and "plans" are one). Earlier in the list = shown first: the build set, then design boards
const loose = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const DRAWING_TAGS = ['Plans', 'Design'].map(loose);
const BEFORE_TAGS = ['Before'].map(loose);
const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;
const JOB_ID = /^[A-Za-z0-9]{6,32}$/;
const headers = { 'Cache-Control': 'private, no-store' };
const ok = (body) => Response.json({ success: true, ...body }, { headers });
// (500, not 502: Cloudflare swaps a 502's body for its own error page)
const fail = (error, status = 400, extra = {}) => Response.json({ success: false, error, ...extra }, { status, headers });

const isPdf = (f) => /pdf/i.test(f?.type || '') || /\.pdf$/i.test(f?.name || '');
const isImage = (f) => /^image\//i.test(f?.type || '') || /\.(jpe?g|png|webp|heic|heif|gif)$/i.test(f?.name || '');

/** One page of a job's files, with their tags and JobTread's JPEG of each (a photo, or a PDF's first page); with tagId, only files carrying that tag */
const filesQuery = (jobId, page, tagId = null) => ({
  job: {
    $: { id: jobId },
    files: {
      // (Small pages: JobTread answers 413 when one page of files with their tags and pictures asks too much)
      $: {
        size: 20, ...(page ? { page } : {}),
        ...(tagId ? { with: { tagged: { _: 'fileTags', $: { where: ['id', tagId] }, count: {} } }, where: [['tagged', 'count'], '>', 0] } : {}),
      },
      nextPage: {},
      nodes: {
        id: {}, name: {}, type: {}, size: {}, createdAt: {}, url: {},
        thumb: { _: 'url', $: { size: 600 } },
        big: { _: 'url', $: { size: 2048 } },
        fileTags: { $: { size: 8 }, nodes: { name: {} } },
      },
    },
  },
});

/** The job's name, where it is, and the plan sheets JobTread split out of its PDFs */
const jobQuery = (jobId) => ({
  job: {
    $: { id: jobId },
    id: {}, name: {},
    location: { street: {}, city: {}, postalCode: {}, account: { name: {} } },
    plans: { $: { size: 50 }, nodes: { name: {}, page: {}, file: { id: {} } } },
  },
});

/** The family's last name, from the JobTread customer ("Dylan Marchena" → "Marchena") */
export function familyName(accountName, kidName) {
  const words = String(accountName || '').replace(/\(.*?\)/g, ' ').trim().split(/\s+/).filter(Boolean);
  const kidWords = new Set(String(kidName || '').toLowerCase().split(/\s+/));
  const last = [...words].reverse().find((w) => !kidWords.has(w.toLowerCase()) && /[a-z]/i.test(w));
  return last || '';
}

/** Sort and sort out a job's files: drawings (PDFs and pictures) tagged Plans or Design, before photos tagged Before */
export function sortFiles(files, sheets = []) {
  const sheetFiles = new Set(sheets.map((s) => s.fileId));
  const drawings = [];
  const befores = [];
  for (const f of files) {
    const tags = (f.fileTags?.nodes || []).map((t) => t.name).filter(Boolean);
    const keys = tags.map(loose);
    const out = { id: f.id, name: f.name || '', type: f.type || '', url: f.url || null, thumb: f.thumb || null, tags, createdAt: f.createdAt || null, size: f.size || 0 };
    if (!out.url) continue;
    const rank = Math.min(...keys.map((k) => DRAWING_TAGS.indexOf(k)).filter((i) => i >= 0), sheetFiles.has(f.id) ? DRAWING_TAGS.length : Infinity);
    if (Number.isFinite(rank) && (isPdf(f) || isImage(f))) drawings.push({ ...out, rank });
    else if (keys.some((k) => BEFORE_TAGS.includes(k)) && isImage(f)) befores.push({ ...out, big: f.big || null });
  }
  // Drawings: plans first, newest first within a tag (the newest set is the current one). Before photos: in the order they were taken.
  drawings.sort((a, b) => a.rank - b.rank || String(b.createdAt).localeCompare(String(a.createdAt)));
  befores.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || String(a.name).localeCompare(String(b.name)));
  return { drawings: drawings.map(({ rank, ...d }) => d), befores };
}

/**
 * What a kid's JobTread job holds for their design (the editor's Bring in from JobTread, and the automatic import,
 * ./_reveal-design-auto.js): → { kid, job, address, drawings, befores, sheets }. Throws when JobTread can't be read;
 * kid null when there's no such profile. only: 'befores' asks JobTread for the files tagged Before alone (by the tag's
 * id, ./_file-tags.js), a few small pages where a whole job is a dozen; drawings come back empty then.
 */
export async function designSources(env, slug, { askedJob = '', fetchImpl = fetch, only = null } = {}) {
  const jt = (query) => pave(env.JOBTREAD_GRANT_KEY, query, fetchImpl);
  const [kids, projects] = await Promise.all([loadAllKids(env.DB), loadAllProjects(env.DB)]);
  const kid = kids.find((k) => k.slug === slug);
  if (!kid) return { kid: null };
  const records = [...kids, ...projects];
  const belongs = (job) => { const hit = job ? matchProject(job.name, records, job.id) : null; return !!hit && !isProject(hit) && hit.slug === slug; };

  // The job: the one asked for, if it's this kid's; else found among every job
  let jobId = null;
  let detail = null;
  if (askedJob) {
    detail = (await jt(jobQuery(askedJob)))?.job || null;
    if (detail && belongs(detail)) jobId = askedJob;
    else detail = null;
  }
  if (!jobId) {
    const view = buildAdminView(await fetchAllJobs(env.JOBTREAD_GRANT_KEY, fetchImpl), kids, Date.now(), projects);
    jobId = view.jobs[slug] || null;
    if (jobId) detail = (await jt(jobQuery(jobId)))?.job || null;
  }
  const base = { kid: { slug, name: kid.name || '' }, address: { street: '', city: '', zip: '', family: '' }, drawings: [], befores: [], sheets: [] };
  if (!jobId || !detail) return { ...base, job: null };

  const sheets = (detail.plans?.nodes || [])
    .filter((p) => p?.file?.id && Number.isInteger(p.page))
    .map((p) => ({ fileId: p.file.id, page: p.page, name: String(p.name || '').trim() }));
  // Before photos only: the Before tag's id, as the site keeps it (no id yet: every file, sorted below as always)
  const tagId = only === 'befores' ? (await tagIds(env.DB).catch(() => new Map())).get('Before') || null : null;
  const list = async (tag) => {
    const out = [];
    let page = null;
    for (let i = 0; i < MAX_FILE_PAGES; i++) {
      const conn = (await jt(filesQuery(jobId, page, tag)))?.job?.files;
      out.push(...(conn?.nodes || []));
      page = conn?.nextPage || null;
      if (!page) break;
    }
    return out;
  };
  // (JobTread turning the tag filter away, should it ever: every file instead, sorted by their tags below as always)
  let files;
  try {
    files = await list(tagId);
  } catch (e) {
    if (!tagId) throw e;
    console.error('[reveal-design] the Before tag filter was turned away, so every file:', e.message);
    files = await list(null);
  }
  const loc = detail.location || {};
  return {
    ...base,
    job: { id: jobId, name: detail.name || '' },
    address: { street: loc.street || '', city: loc.city || '', zip: loc.postalCode || '', family: familyName(loc.account?.name, kid.name) },
    sheets,
    ...sortFiles(files, sheets),
  };
}

/**
 * The JobTread files this profile has had and hasn't now (staff took them out): the automatic import never brings
 * them back, and the dialog leaves them unpicked. From what it remembers and the profile's History (everHad)
 */
async function removedFiles(env, slug) {
  const { everHad, AUTO_KEY } = await import('./_reveal-design-auto.js');
  const [row, led] = await Promise.all([
    env.DB.prepare('SELECT data FROM kids WHERE slug = ?').bind(slug).first(),
    env.DB.prepare('SELECT data FROM site_config WHERE key = ?').bind(AUTO_KEY).first(),
  ]);
  const kid = row?.data ? JSON.parse(row.data) : {};
  const b = led?.data ? JSON.parse(led.data)?.kids?.[slug]?.befores || {} : {};
  const ever = await everHad(env, slug, kid, b);
  const now = new Set([...(kid.plans || []), ...(kid.beforePhotos || []), ...(kid.beforeAfterPhotos || []), ...(kid.photos || [])].map((x) => String(x?.source || '').match(/^jt:([^#]+)$/)?.[1]).filter(Boolean));
  return [...ever].filter((id) => !now.has(id));
}

export async function onRequestGet({ env, request }, { fetchImpl = fetch } = {}) {
  if (!env.DB) return fail('DB not bound', 500);
  if (!env.JOBTREAD_GRANT_KEY) return fail('JOBTREAD_GRANT_KEY is not set in Cloudflare', 500);
  const url = new URL(request.url);
  const slug = String(url.searchParams.get('kid') || '').trim().toLowerCase();
  const askedJob = String(url.searchParams.get('job') || '').trim();
  if (!SLUG.test(slug)) return fail('Which kid?');
  if (askedJob && !JOB_ID.test(askedJob)) return fail('That isn’t a JobTread job id');
  try {
    const got = await designSources(env, slug, { askedJob, fetchImpl });
    if (!got.kid) return fail('No profile with that name', 404);
    return ok({ ...got, removed: await removedFiles(env, slug).catch(() => []) });
  } catch (e) {
    return fail(e.message || 'JobTread couldn’t be reached', 500);
  }
}
