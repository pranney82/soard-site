/**
 * Jotform, copied home (Oct 2026)
 * ===========================================================================
 * Peter, Oct 22 2026: "grab all the stuff you need and whatever you need to
 * backfill since we are not using jotform anymore". Families applied on
 * Jotform before the site had its own form (2025: "Bedroom Application",
 * 2026: "SOARD Application"), and the Advisory Board takes applications
 * there. Every submission is copied once, before Jotform goes away:
 *
 *  - To the site: the answers into D1 (jotform_backfill.answers), and every
 *    photo and file the family uploaded, plus Jotform's PDF of the
 *    application, into R2. Each submission's files get a random folder that
 *    only D1 knows. The bucket has a public domain, so this is the same
 *    protection the site's own application uploads have.
 *  - To the family's JobTread account, when there's no doubt which one it is
 *    (JobTread's Application URL links the submission, or exactly one
 *    applicant has the child's name): whatever JobTread doesn't have yet,
 *    named the way staff and the site's form name them. That's "<Child>.jpg",
 *    "<Child> Family.jpg", "<Child> Space 1.jpg", "<Child> Space 2.jpg",
 *    "<Child>_Application.pdf" and "<Child>_Application.mp4". The child's
 *    photo becomes the family's avatar in Admin → Applicants until their kid
 *    page has photos of its own.
 *
 * Never makes a JobTread account: a new one starts the new-applicant emails.
 * Rides the application sweep (./_applications.js), a few submissions a run,
 * until each is done; jotform_backfill holds each one's state and
 * jotform_backfill_state the run's. JOTFORM_API_KEY lives in Cloudflare;
 * nothing here stores or reports a URL that carries it.
 */

import { pave, SOARD_ORG_ID, normalizeName } from './_reveals.js';
import { SITE_ORIGIN } from './_broadcast-notify.js';
import { refreshApplicants, childPhotoFile, ensureApplicantSchema } from './_applicants.js';

export const JOTFORM_FORMS = [
  { id: '250455568355161', kind: 'makeover', label: 'Bedroom Application (2025)' },
  { id: '252326779451161', kind: 'makeover', label: 'SOARD Application (2026)' },
  { id: '261805783731058', kind: 'advisory', label: 'Advisory Board Application' },
];
// Jotform answers from one of these, depending on where the account lives
const API_BASES = ['https://api.jotform.com', 'https://eu-api.jotform.com', 'https://hipaa-api.jotform.com'];
const PER_RUN = 3;
// Bump when a fix should retry what didn't copy (a blocked run, rows out of tries)
const VERSION = 2;
const MAX_TRIES = 4;
const iso = (t = Date.now()) => new Date(t).toISOString();
const parse = (s, d = null) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };
const bucket = (env) => env?.APPLICANT_FILES || env?.FILES || null;

// ─── D1 ─────────────────────────────────────────────────────────────

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS jotform_backfill (
    submission_id TEXT PRIMARY KEY, form_id TEXT NOT NULL, kind TEXT NOT NULL, name TEXT, submitted_at TEXT,
    account_id TEXT, matched_by TEXT, folder TEXT, status TEXT NOT NULL DEFAULT 'pending',
    answers TEXT, saved TEXT, attached TEXT, tries INTEGER NOT NULL DEFAULT 0, error TEXT, updated_at TEXT NOT NULL)`,
  'CREATE TABLE IF NOT EXISTS jotform_backfill_state (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT NOT NULL)',
];
const _ready = new WeakSet();
async function ensureSchema(DB) {
  if (_ready.has(DB)) return;
  await DB.batch(SCHEMA.map(s => DB.prepare(s)));
  _ready.add(DB);
}
async function getState(DB, key) {
  return (await DB.prepare('SELECT value FROM jotform_backfill_state WHERE key = ?').bind(key).first())?.value ?? null;
}
async function setState(DB, key, value, now) {
  await DB.prepare('INSERT INTO jotform_backfill_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .bind(key, value == null ? null : String(value), iso(now)).run();
}

// ─── Jotform ────────────────────────────────────────────────────────

/** Jotform's API: the response's content, or an error that never repeats the key */
async function jotform(env, path, fetchImpl, base = env.__jotformBase || API_BASES[0]) {
  const url = new URL(`${base}${path}`);
  url.searchParams.set('apiKey', env.JOTFORM_API_KEY);
  const res = await fetchImpl(url.toString(), { headers: { accept: 'application/json' } });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || (body.responseCode && body.responseCode !== 200)) {
    throw Object.assign(new Error(`Jotform ${path.split('?')[0]} answered ${res.status}${body?.message ? `: ${String(body.message).slice(0, 120)}` : ''}`), { status: res.status });
  }
  return body.content;
}

/** Which of Jotform's servers holds the account (remembered in the run's state) */
async function findBase(env, fetchImpl, now) {
  const known = await getState(env.DB, 'api');
  if (known) return known;
  let last;
  for (const base of API_BASES) {
    try {
      await jotform(env, '/user', fetchImpl, base);
      await setState(env.DB, 'api', base, now);
      return base;
    } catch (e) { last = e; }
  }
  throw last;
}

/** A Jotform answer that's a name ({ first, last }, or text) */
const nameOf = (a) => (a && typeof a === 'object' ? [a.first, a.middle, a.last].filter(Boolean).join(' ') : String(a || '')).replace(/\s+/g, ' ').trim();

/** Who a submission is about: the child (makeover forms) or the applicant (Advisory Board) */
export function submissionName(answers, kind) {
  const list = Object.values(answers || {});
  const named = (re) => list.find(q => q?.type === 'control_fullname' && re.test(q.text || '') && nameOf(q.answer));
  const q = kind === 'makeover' ? named(/child/i) : (named(/^(your |full )?name/i) || list.find(q2 => q2?.type === 'control_fullname' && nameOf(q2.answer)));
  return q ? nameOf(q.answer) : '';
}

/** What each upload is, from its question */
function kindOf(text) {
  const t = String(text || '').toLowerCase();
  if (/picture|photo|image|upload/.test(t)) {
    if (/famil/.test(t)) return 'family';
    if (/second picture of the space|second photo of the space/.test(t)) return 'space2';
    if (/space|room/.test(t)) return 'space1';
    if (/child/.test(t)) return 'child';
  }
  if (/video/.test(t)) return 'video';
  return 'file';
}

/**
 * Every file a submission holds, from its answers: native uploads (a list of
 * URLs), the Image Upload Preview widget ({ widget_metadata: { value: [{ name,
 * url }] } }), and any other answer that's a link to a video or photo.
 */
export function submissionFiles(answers) {
  const out = [];
  for (const [qid, q] of Object.entries(answers || {})) {
    if (!q || q.answer == null || q.answer === '') continue;
    const kind = kindOf(q.text || q.cfname || q.name);
    const add = (url, name) => { if (url) out.push({ qid, kind, url: String(url), name: name || decodeURIComponent(String(url).split('?')[0].split('/').pop() || 'file') }); };
    if (q.type === 'control_fileupload') {
      for (const u of [].concat(q.answer)) add(u);
      continue;
    }
    if (q.type === 'control_widget') {
      const w = typeof q.answer === 'string' ? parse(q.answer, null) : q.answer;
      const values = w?.widget_metadata?.value;
      if (Array.isArray(values)) { for (const v of values) add(v?.url, v?.name); continue; }
    }
    const text = typeof q.answer === 'string' ? q.answer : JSON.stringify(q.answer);
    for (const m of text.matchAll(/https?:\/\/[^\s"'<>\\]+\.(?:mp4|mov|m4v|webm|jpe?g|png|heic|pdf)\b/gi)) add(m[0]);
  }
  return out;
}

/**
 * What a file is, from its first bytes. Jotform sends widget uploads as
 * application/octet-stream, so the header alone can't say.
 */
export function sniffType(bytes) {
  if (!bytes || bytes.byteLength < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  const head = String.fromCharCode(...bytes.slice(0, 12));
  if (head.startsWith('GIF8')) return 'image/gif';
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return 'image/webp';
  if (head.startsWith('%PDF-')) return 'application/pdf';
  if (head.slice(4, 8) === 'ftyp') {
    const brand = head.slice(8, 12);
    if (/^avi[fs]$/.test(brand)) return 'image/avif';
    if (/^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(brand)) return 'image/heic';
    if (brand === 'qt  ') return 'video/quicktime';
    return 'video/mp4';
  }
  return null;
}

const looksRight = (kind, type, bytes) => {
  if (!bytes || bytes.byteLength < 200) return false;
  if (kind === 'pdf') return new TextDecoder().decode(bytes.slice(0, 5)) === '%PDF-';
  if (kind === 'video') return /^video\//.test(type);
  if (/^(child|family|space1|space2)$/.test(kind)) return /^image\//.test(type);
  return !/^text\/html/.test(type);
};

/**
 * A file from Jotform. Uploads need the account's key; widget uploads live
 * under /widget-uploads/ and files.jotform.com sends them on to /uploads/.
 * Tries each way once and reports only hosts, paths and statuses.
 */
async function download(env, file, fetchImpl) {
  const abs = file.url.startsWith('http') ? file.url : `https://www.jotform.com${file.url.startsWith('/') ? '' : '/'}${file.url}`;
  const u = new URL(abs);
  const ways = [abs];
  if (u.pathname.startsWith('/widget-uploads/')) ways.push(`https://www.jotform.com${u.pathname.replace(/^\/widget-uploads\//, '/uploads/')}`);
  const tried = [];
  for (const way of ways) {
    let url = new URL(way);
    for (let hop = 0; hop < 3; hop++) {
      // The key goes to Jotform only, never to where Jotform redirects (storage, a CDN)
      const jotformHost = /(^|\.)jotform\.com$/.test(url.hostname);
      if (jotformHost) url.searchParams.set('apiKey', env.JOTFORM_API_KEY);
      else url.searchParams.delete('apiKey');
      const res = await fetchImpl(url.toString(), { redirect: 'manual', headers: jotformHost ? { APIKEY: env.JOTFORM_API_KEY } : {} });
      tried.push(`${url.hostname}${url.pathname.split('/').slice(0, 3).join('/')} ${res.status}`);
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        url = new URL(res.headers.get('location'), url);
        continue;
      }
      if (res.ok) {
        const bytes = new Uint8Array(await res.arrayBuffer());
        const said = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        const type = /^(image|video)\/|^application\/pdf$/.test(said) ? said : (sniffType(bytes) || said);
        if (looksRight(file.kind, type, bytes)) return { bytes, type: type || 'application/octet-stream' };
        tried.push(`  not a ${file.kind} (${type || 'no type'}, ${bytes.byteLength} bytes)`);
      }
      break;
    }
  }
  return { error: tried.join('; ').slice(0, 400) };
}

/** Jotform's PDF of the application */
async function downloadPdf(env, formId, sid, fetchImpl) {
  const base = env.__jotformBase || API_BASES[0];
  const ways = [
    `${base}/pdf-converter/${formId}/fill-pdf?download=1&submissionID=${sid}`,
    `${base}/generatePDF?formid=${formId}&submissionid=${sid}&download=1`,
  ];
  const tried = [];
  for (const way of ways) {
    const url = new URL(way);
    url.searchParams.set('apiKey', env.JOTFORM_API_KEY);
    const res = await fetchImpl(url.toString(), { headers: { APIKEY: env.JOTFORM_API_KEY } });
    tried.push(`${url.pathname.split('/').slice(0, 2).join('/')} ${res.status}`);
    if (!res.ok) continue;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (looksRight('pdf', 'application/pdf', bytes)) return { bytes, type: 'application/pdf' };
    tried.push('  not a PDF');
  }
  return { error: tried.join('; ') };
}

// ─── JobTread ───────────────────────────────────────────────────────

async function accountFiles(env, accountId, fetchImpl) {
  const data = await pave(env.JOBTREAD_GRANT_KEY, {
    account: {
      $: { id: accountId }, id: {}, name: {},
      jobs: { $: { size: 2, sortBy: [{ field: 'createdAt', order: 'desc' }] }, nodes: { id: {}, name: {} } },
      // The family's own files (a busy job's hundreds of newer files would push them out of a page of everything)
      files: { $: { size: 100, where: [['job', 'id'], '=', null] }, nodes: { id: {}, name: {}, type: {}, job: { id: {} } } },
    },
  }, fetchImpl);
  const a = data?.account;
  if (!a?.id) return null;
  return { name: a.name, jobName: a.jobs?.nodes?.[0]?.name || null, files: (a.files?.nodes || []).filter(f => !f.job?.id) };
}

async function uploadToJobTread(env, { accountId, name, bytes, type }, fetchImpl) {
  const out = await pave(env.JOBTREAD_GRANT_KEY, {
    createUploadRequest: { $: { organizationId: SOARD_ORG_ID, size: bytes.byteLength, type }, createdUploadRequest: { id: {}, url: {}, method: {}, headers: {} } },
  }, fetchImpl);
  const req = out?.createUploadRequest?.createdUploadRequest;
  if (!req?.url) throw new Error('JobTread did not return an upload URL');
  const put = await fetchImpl(req.url, { method: req.method || 'PUT', headers: req.headers || {}, body: bytes });
  if (!put.ok) throw new Error(`JobTread upload returned ${put.status}`);
  const made = await pave(env.JOBTREAD_GRANT_KEY, {
    createFile: { $: { name, targetType: 'account', targetId: accountId, uploadRequestId: req.id }, createdFile: { id: {} } },
  }, fetchImpl);
  return made?.createFile?.createdFile?.id || null;
}

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/heic': 'heic', 'image/heif': 'heif', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'application/pdf': 'pdf' };
/** The JobTread name for each kind, the way staff and the site's form name them */
function jobtreadName(kind, child, type) {
  const ext = EXT[type] || (type.startsWith('image/') ? 'jpg' : 'bin');
  return {
    child: `${child}.${ext}`, family: `${child} Family.${ext}`, space1: `${child} Space 1.${ext}`, space2: `${child} Space 2.${ext}`,
    pdf: `${child}_Application.pdf`, video: `${child}_Application.${ext}`,
  }[kind] || null;
}

/** Does JobTread already have this kind of file for the family? */
function hasKind(kind, files, names) {
  const ns = files.map(f => String(f.name || ''));
  if (kind === 'child') return !!childPhotoFile(files.filter(f => /^image\//.test(f.type || 'image/')), names);
  if (kind === 'family') return ns.some(n => /famil/i.test(n) && !/\.pdf$/i.test(n));
  if (kind === 'space1') return ns.some(n => /space ?1|\bspace\b(?! ?2)/i.test(n));
  if (kind === 'space2') return ns.some(n => /space ?2/i.test(n));
  if (kind === 'pdf') return ns.some(n => /application.*\.pdf$/i.test(n));
  if (kind === 'video') return files.some(f => /^video\//.test(f.type || '')) || ns.some(n => /\.(mp4|mov|m4v)$/i.test(n));
  return true;
}

// ─── Matching ───────────────────────────────────────────────────────

const words = (s) => normalizeName(s).split(' ').filter(w => w && !/^(jr|sr|ii|iii|iv|and)$/.test(w));

/**
 * The family's JobTread account, only when there's no doubt: JobTread's
 * Application URL links this submission, or exactly one applicant's name has
 * every word of the child's name. { accountId, by } where by is 'link',
 * 'name', 'several' or 'none'.
 */
export function matchAccount(sid, name, applicants) {
  const linked = applicants.filter(a => String(a.application_url || '').includes(sid));
  if (linked.length === 1) return { accountId: linked[0].account_id, by: 'link' };
  const w = words(name);
  if (!w.length) return { accountId: null, by: 'none' };
  const hits = applicants.filter(a => { const aw = new Set(words(a.name)); return w.every(x => aw.has(x)); });
  if (hits.length === 1) return { accountId: hits[0].account_id, by: 'name' };
  return { accountId: null, by: hits.length > 1 ? 'several' : 'none' };
}

// ─── The run ────────────────────────────────────────────────────────

/** List every submission once, matched to its family */
async function listSubmissions(env, { fetchImpl, now }) {
  const { DB } = env;
  await ensureApplicantSchema(DB);
  const { results: applicants } = await DB.prepare('SELECT account_id, name, application_url FROM applicants').all();
  let n = 0;
  for (const form of JOTFORM_FORMS) {
    const subs = await jotform(env, `/form/${form.id}/submissions?limit=1000&orderby=created_at`, fetchImpl);
    const stmts = [];
    for (const s of subs || []) {
      if (String(s.status || 'ACTIVE').toUpperCase() === 'DELETED') continue;
      const name = submissionName(s.answers, form.kind);
      const m = form.kind === 'makeover' ? matchAccount(String(s.id), name, applicants || []) : { accountId: null, by: 'advisory' };
      stmts.push(DB.prepare(`INSERT OR IGNORE INTO jotform_backfill (submission_id, form_id, kind, name, submitted_at, account_id, matched_by, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(String(s.id), form.id, form.kind, name || null, s.created_at || null, m.accountId, m.by, iso(now)));
      n++;
    }
    if (stmts.length) await DB.batch(stmts);
  }
  await setState(DB, 'listed', iso(now), now);
  return n;
}

/** Copy one submission: the archive first, then JobTread */
async function copySubmission(env, row, { fetchImpl, now }) {
  const { DB } = env;
  const files = bucket(env);
  if (!files) throw new Error('No R2 bucket bound');
  const sub = await jotform(env, `/submission/${row.submission_id}`, fetchImpl);
  const folder = row.folder || `jotform-archive/${crypto.randomUUID()}`;
  if (!row.folder) await DB.prepare('UPDATE jotform_backfill SET folder = ? WHERE submission_id = ?').bind(folder, row.submission_id).run();

  // The answers stay in D1 (private); only files go to the bucket
  await DB.prepare('UPDATE jotform_backfill SET answers = ? WHERE submission_id = ?')
    .bind(JSON.stringify({ formId: row.form_id, submissionId: row.submission_id, createdAt: sub?.created_at || row.submitted_at, answers: sub?.answers || {} }), row.submission_id).run();
  const saved = [];
  const got = {};
  const list = submissionFiles(sub?.answers);
  for (const [i, f] of list.entries()) {
    const d = await download(env, f, fetchImpl);
    if (d.error) { saved.push({ kind: f.kind, name: f.name, error: d.error }); continue; }
    // Numbered by kind, never the family's file name (which can carry the child's name)
    const key = `${folder}/${String(i + 1).padStart(2, '0')}-${f.kind}.${EXT[d.type] || 'bin'}`;
    await files.put(key, d.bytes, { httpMetadata: { contentType: d.type } });
    saved.push({ kind: f.kind, name: f.name, key, type: d.type, size: d.bytes.byteLength });
    if (!got[f.kind]) got[f.kind] = d;
  }
  const pdf = await downloadPdf(env, row.form_id, row.submission_id, fetchImpl);
  if (pdf.error) saved.push({ kind: 'pdf', error: pdf.error });
  else {
    await files.put(`${folder}/application.pdf`, pdf.bytes, { httpMetadata: { contentType: 'application/pdf' } });
    saved.push({ kind: 'pdf', key: `${folder}/application.pdf`, size: pdf.bytes.byteLength });
    got.pdf = pdf;
  }

  // JobTread: only what the family's account doesn't have yet
  const attached = [];
  if (row.kind === 'makeover' && row.account_id) {
    const acct = await accountFiles(env, row.account_id, fetchImpl);
    if (!acct) attached.push({ error: 'The JobTread account is gone' });
    else {
      const names = [acct.name, acct.jobName];
      for (const kind of ['child', 'family', 'space1', 'space2', 'pdf', 'video']) {
        const d = got[kind];
        if (!d || hasKind(kind, acct.files, names)) continue;
        const name = jobtreadName(kind, acct.name, d.type);
        const id = await uploadToJobTread(env, { accountId: row.account_id, name, bytes: d.bytes, type: d.type }, fetchImpl);
        acct.files.push({ id, name, type: d.type });
        attached.push({ kind, name, id });
      }
    }
  }
  // Nothing at all came down although there were files: worth another try, and a reason to look
  const wanted = list.length + 1;
  const came = saved.filter(s => s.key).length;
  const status = came === 0 && wanted > 0 ? 'unreachable' : 'done';
  await DB.prepare('UPDATE jotform_backfill SET status = ?, saved = ?, attached = ?, error = ?, tries = tries + 1, updated_at = ? WHERE submission_id = ?')
    .bind(status, JSON.stringify(saved), JSON.stringify(attached), status === 'done' ? null : 'No file could be downloaded', iso(now), row.submission_id).run();
  return { status, saved: came, attached: attached.filter(a => a.id).length };
}

// ─── Unfinished on the old form ─────────────────────────────────────

// What isn't a question on a Jotform page (headings, text, page breaks, buttons)
const NOT_ASKED = new Set(['control_head', 'control_text', 'control_button', 'control_pagebreak', 'control_divider', 'control_image', 'control_collapse', 'control_widget_header']);
const filled = (v) => v != null && v !== '' && !(typeof v === 'object' && !Object.values(v).some((x) => x != null && String(x).trim() !== ''));

/**
 * The makeover applications started on the old form that never became a family in JobTread (nobody to
 * place them with), for Applications → Submissions: who, when, how far they got, and whether the site
 * kept the PDF. Peter, Oct 24 2026: listed as unfinished, read-only, never sent to JobTread.
 */
export async function unfinishedOldForm(DB) {
  try {
    const { results } = await DB.prepare("SELECT submission_id, name, submitted_at, answers, saved FROM jotform_backfill WHERE kind = 'makeover' AND account_id IS NULL ORDER BY submitted_at DESC").all();
    return (results || []).map((r) => {
      const qs = Object.values(parse(r.answers, {})?.answers || {}).filter((x) => x && !NOT_ASKED.has(x.type));
      return {
        id: r.submission_id, name: r.name || null, startedAt: r.submitted_at ? `${String(r.submitted_at).replace(' ', 'T')}Z` : null,
        answered: qs.filter((x) => filled(x.answer)).length, questions: qs.length,
        hasPdf: parse(r.saved, []).some((x) => x.kind === 'pdf' && x.key),
      };
    });
  } catch {
    return []; // no copy yet (a new database)
  }
}

/** The bucket key of the PDF the site kept for an unfinished old-form application, or null */
export async function oldFormPdfKey(DB, submissionId) {
  try {
    const row = await DB.prepare("SELECT saved FROM jotform_backfill WHERE submission_id = ? AND kind = 'makeover' AND account_id IS NULL").bind(String(submissionId)).first();
    return parse(row?.saved, []).find((x) => x.kind === 'pdf' && x.key)?.key || null;
  } catch {
    return null;
  }
}

// ─── A second look (Oct 24 2026) ────────────────────────────────────

const SECOND_LOOK = 1;
const APPLICATION_URL = '22P4v2gNtdFR'; // JobTread's Application URL field (FIELDS in ./_applications.js)

/** What a family's account is missing, from the copies the site saved (its bucket, not Jotform) */
async function attachSaved(env, row, accountId, fetchImpl) {
  const files = bucket(env);
  const acct = await accountFiles(env, accountId, fetchImpl);
  if (!acct) return [{ error: 'The JobTread account is gone' }];
  const saved = parse(row.saved, []);
  const out = [];
  for (const kind of ['child', 'family', 'space1', 'space2', 'pdf', 'video']) {
    const s = saved.find((x) => x.kind === kind && x.key);
    if (!s || hasKind(kind, acct.files, [acct.name, acct.jobName])) continue;
    const obj = await files?.get(s.key);
    if (!obj) { out.push({ kind, error: 'Not in the bucket' }); continue; }
    const bytes = new Uint8Array(await obj.arrayBuffer());
    const type = s.type || obj.httpMetadata?.contentType || (kind === 'pdf' ? 'application/pdf' : 'image/jpeg');
    const name = jobtreadName(kind, acct.name, type);
    const id = await uploadToJobTread(env, { accountId, name, bytes, type }, fetchImpl);
    acct.files.push({ id, name, type });
    out.push({ kind, name, id });
  }
  return out;
}

/**
 * Peter, Oct 24 2026: "any jotform files should be brought into the website/app, no redirect to
 * jotform at all". The copy matched only families on the Applicants board, by the words of the
 * child's name, so two families' files stayed in the site's bucket: one whose JobTread account links
 * the submission but isn't on the board, one whose first and last names are the same word. And
 * JobTread's Application URL still sent the families who applied before the website form to Jotform.
 * Once, after the copy:
 *  - what's still unmatched is matched against every customer account: the one whose Application
 *    URL names the submission, else the one named exactly as the child;
 *  - that account gets what it's missing, from the site's saved copies;
 *  - every Application URL on Jotform points at the family's page in the admin instead (cleared on
 *    an account that isn't on the board). The old links stay in jotform_backfill_state, to undo.
 * Never throws.
 */
export async function jotformSecondLook(env, { fetchImpl = fetch, now = Date.now() } = {}) {
  try {
    const { DB } = env;
    if (!DB || !env.JOBTREAD_GRANT_KEY) return null;
    await ensureSchema(DB);
    if (!(await getState(DB, 'done'))) return null;
    if (String(await getState(DB, 'second_look')) === String(SECOND_LOOK)) return { done: true };

    // Every customer account, with its Application URL
    const accounts = [];
    let page = null;
    for (let i = 0; i < 50; i++) {
      const data = await pave(env.JOBTREAD_GRANT_KEY, {
        organization: {
          $: { id: SOARD_ORG_ID },
          accounts: {
            $: { size: 100, where: ['type', 'customer'], ...(page ? { page } : {}) }, // (JobTread refuses ['type', '=', …] here)
            nodes: { id: {}, name: {}, customFieldValues: { $: { where: [['customField', 'id'], '=', APPLICATION_URL] }, nodes: { value: {} } } },
            nextPage: {},
          },
        },
      }, fetchImpl);
      const got = data?.organization?.accounts;
      for (const a of got?.nodes || []) accounts.push({ id: a.id, name: a.name || '', url: String(a.customFieldValues?.nodes?.[0]?.value || '') });
      page = got?.nextPage || null;
      if (!page) break;
    }

    const matched = [];
    const { results: left } = await DB.prepare("SELECT * FROM jotform_backfill WHERE kind = 'makeover' AND account_id IS NULL").all();
    for (const row of left || []) {
      const linked = accounts.filter((a) => a.url.includes(row.submission_id));
      const named = row.name ? accounts.filter((a) => normalizeName(a.name) === normalizeName(row.name)) : [];
      const hit = linked.length === 1 ? { id: linked[0].id, by: 'link' } : named.length === 1 ? { id: named[0].id, by: 'name' } : null;
      if (!hit) continue;
      const attached = await attachSaved(env, row, hit.id, fetchImpl);
      await DB.prepare('UPDATE jotform_backfill SET account_id = ?, matched_by = ?, attached = ?, updated_at = ? WHERE submission_id = ?')
        .bind(hit.id, hit.by, JSON.stringify(attached), iso(now), row.submission_id).run();
      matched.push({ id: hit.id, by: hit.by, files: attached.filter((a) => a.id).length });
    }

    await ensureApplicantSchema(DB);
    const { results: board } = await DB.prepare('SELECT account_id FROM applicants').all();
    const onBoard = new Set((board || []).map((r) => r.account_id));
    const pointed = [];
    for (const a of accounts.filter((x) => /jotform\.com/i.test(x.url))) {
      const next = onBoard.has(a.id) ? `${SITE_ORIGIN}/admin/#applications/applicants/${a.id}` : null;
      try {
        await pave(env.JOBTREAD_GRANT_KEY, { updateAccount: { $: { id: a.id, customFieldValues: { [APPLICATION_URL]: next } } } }, fetchImpl);
        pointed.push({ id: a.id, was: a.url, now: next });
      } catch (e) {
        pointed.push({ id: a.id, was: a.url, error: String(e.message || e).slice(0, 200) });
      }
    }

    const touched = [...new Set([...matched.map((m) => m.id), ...pointed.filter((p) => !p.error && p.now).map((p) => p.id)])];
    if (touched.length) await refreshApplicants(env, touched, { fetchImpl, now }).catch(() => 0);
    await setState(DB, 'second_look_result', JSON.stringify({ at: iso(now), matched, pointed }), now);
    await setState(DB, 'second_look', SECOND_LOOK, now);
    return { matched: matched.length, files: matched.reduce((n, m) => n + m.files, 0), pointed: pointed.filter((p) => !p.error).length, failed: pointed.filter((p) => p.error).length };
  } catch (e) {
    try { await setState(env.DB, 'last_error', `${iso(now)} second look: ${String(e.message || e).slice(0, 300)}`, now); } catch { /* best effort */ }
    return { error: String(e.message || e) };
  }
}

/**
 * One run of the backfill, from the application sweep: list once, then copy
 * a few submissions. Stops trying when Jotform won't hand over any file
 * three times in a row (state 'blocked', with what each way answered), and
 * once all are done, re-reads the families it added files to so their
 * photos show. Never throws.
 */
export async function runJotformBackfill(env, { fetchImpl = fetch, now = Date.now(), perRun = PER_RUN } = {}) {
  try {
    const { DB } = env;
    if (!DB || !env.JOTFORM_API_KEY || !env.JOBTREAD_GRANT_KEY) return null;
    await ensureSchema(DB);
    const finished = await getState(DB, 'done');
    if (finished) return { done: true };
    // A new version retries what didn't copy: unfinished submissions, and done ones with a file left behind
    if (String(await getState(DB, 'version')) !== String(VERSION)) {
      await DB.batch([
        DB.prepare("UPDATE jotform_backfill SET tries = 0 WHERE status != 'done'"),
        DB.prepare(`UPDATE jotform_backfill SET status = 'pending', tries = 0 WHERE status = 'done' AND saved LIKE '%"error"%'`),
        DB.prepare("DELETE FROM jotform_backfill_state WHERE key = 'blocked'"),
      ]);
      await setState(DB, 'version', VERSION, now);
    }
    if (await getState(DB, 'blocked')) return { blocked: true };
    env = { ...env, __jotformBase: await findBase(env, fetchImpl, now) };
    if (!(await getState(DB, 'listed'))) {
      const listed = await listSubmissions(env, { fetchImpl, now });
      return { listed };
    }
    const { results } = await DB.prepare(`SELECT * FROM jotform_backfill WHERE status IN ('pending', 'error', 'unreachable') AND tries < ?
      ORDER BY CASE WHEN account_id IS NOT NULL THEN 0 ELSE 1 END, submitted_at LIMIT ?`).bind(MAX_TRIES, perRun).all();
    const out = [];
    for (const row of results || []) {
      try {
        out.push({ id: row.submission_id, ...(await copySubmission(env, row, { fetchImpl, now })) });
      } catch (e) {
        await DB.prepare("UPDATE jotform_backfill SET status = 'error', error = ?, tries = tries + 1, updated_at = ? WHERE submission_id = ?")
          .bind(String(e.message || e).slice(0, 300), iso(now), row.submission_id).run();
        out.push({ id: row.submission_id, error: String(e.message || e) });
      }
    }
    const unreachable = await DB.prepare("SELECT count(*) AS n FROM jotform_backfill WHERE status = 'unreachable'").first('n');
    const copied = await DB.prepare("SELECT count(*) AS n FROM jotform_backfill WHERE status = 'done'").first('n');
    if (unreachable >= 3 && !copied) {
      await setState(DB, 'blocked', `${iso(now)} Jotform handed over no files: ${(await DB.prepare("SELECT saved FROM jotform_backfill WHERE status = 'unreachable' LIMIT 1").first('saved') || '').slice(0, 900)}`, now);
      return { blocked: true, out };
    }
    const left = await DB.prepare('SELECT count(*) AS n FROM jotform_backfill WHERE status != ? AND tries < ?').bind('done', MAX_TRIES).first('n');
    if (!left) {
      // The families' new files, in the Applicants mirror now (their avatars)
      const { results: touched } = await DB.prepare("SELECT DISTINCT account_id FROM jotform_backfill WHERE account_id IS NOT NULL AND attached LIKE '%\"id\"%'").all();
      await refreshApplicants(env, (touched || []).map(r => r.account_id), { fetchImpl, now }).catch(() => 0);
      await setState(DB, 'done', iso(now), now);
    }
    return { out, left };
  } catch (e) {
    try { await setState(env.DB, 'last_error', `${iso(now)} ${String(e.message || e).slice(0, 300)}`, now); } catch { /* best effort */ }
    return { error: String(e.message || e) };
  }
}

/** Where the backfill stands, for Site → Automations (counts and times only, no names or files) */
export async function backfillFacts(DB) {
  await ensureSchema(DB);
  const { results } = await DB.prepare('SELECT status, account_id, attached, tries FROM jotform_backfill').all();
  const { results: state } = await DB.prepare('SELECT key, value, updated_at FROM jotform_backfill_state').all();
  const st = Object.fromEntries((state || []).map((r) => [r.key, r]));
  const rows = results || [];
  const added = (r) => (parse(r.attached, []) || []).filter((a) => a?.id).length;
  return {
    total: rows.length, copied: rows.filter((r) => r.status === 'done').length,
    left: rows.filter((r) => r.status !== 'done' && r.tries < MAX_TRIES).length,
    gaveUp: rows.filter((r) => r.status !== 'done' && r.tries >= MAX_TRIES).length,
    families: new Set(rows.filter((r) => r.account_id && added(r)).map((r) => r.account_id)).size,
    files: rows.reduce((n, r) => n + added(r), 0),
    listedAt: st.listed?.value || null, doneAt: st.done?.value || null, blockedAt: st.blocked?.updated_at || null,
  };
}
