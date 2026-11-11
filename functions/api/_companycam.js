/**
 * CompanyCam's Public API, as the site uses it
 * ===========================================================================
 * https://api.companycam.com/public_api/v1 with COMPANYCAM_TOKEN as the
 * bearer: a Personal Access Token (Read & Write) that a CompanyCam admin or
 * manager makes at app.companycam.com/access-keys. It can do what its owner
 * can, so an admin's token can also archive projects. v1 on purpose:
 * CompanyCam stops supporting v2 in 2027.
 *
 * Every answer is { data, errors, meta }. Lists page by cursor (meta.has_next
 * and meta.next_cursor, sent back as `after`), at most 100 a page. Limits are
 * per token: 240 reads and 100 writes a minute, and a 429 says how long to
 * wait (Retry-After).
 *
 * The site's webhook (./companycam-webhook.js) is signed with a token the
 * site works out from COMPANYCAM_TOKEN (webhookToken), so there's no second
 * secret to keep: X-CompanyCam-Signature = Base64(HMAC-SHA1(token, raw body)).
 *
 * Env: COMPANYCAM_TOKEN.
 */

export const CC_API = 'https://api.companycam.com/public_api/v1';
export const CC_APP = 'https://app.companycam.com';
const TIMEOUT_MS = 20000;
const PAGE = 100;
const enc = new TextEncoder();

export class CompanyCamError extends Error {
  constructor(message, { status = 0, code = null, retryAfter = null } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export const companycamOn = (env) => !!String(env?.COMPANYCAM_TOKEN || '').trim();

/** One call: { data, meta }. Throws CompanyCamError with the status and CompanyCam's own words. */
export async function cc(env, method, path, { query = null, body, fetchImpl = fetch } = {}) {
  const token = String(env?.COMPANYCAM_TOKEN || '').trim();
  if (!token) throw new CompanyCamError('COMPANYCAM_TOKEN is not set', { code: 'no_token' });
  const url = new URL(CC_API + path);
  for (const [k, v] of Object.entries(query || {})) if (v != null && v !== '') url.searchParams.set(k, String(v));
  const init = { method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetchImpl(url.toString(), init);
  if (res.status === 204) return { data: null, meta: {} };
  const text = await res.text();
  let out = null;
  try { out = text ? JSON.parse(text) : null; } catch { out = null; }
  if (!res.ok) {
    const e = out?.errors?.[0];
    const said = typeof e === 'string' ? e : e?.message || text.slice(0, 200) || res.statusText || 'no answer';
    throw new CompanyCamError(`CompanyCam returned ${res.status}: ${said}`, {
      status: res.status, code: (typeof e === 'object' && e?.code) || null, retryAfter: Number(res.headers.get('Retry-After')) || null,
    });
  }
  return { data: out && 'data' in out ? out.data : out, meta: out?.meta || {} };
}

/** Every page of a list, up to `max` items */
export async function ccAll(env, path, { query = {}, max = 500, fetchImpl = fetch } = {}) {
  const items = [];
  let after = null;
  while (items.length < max) {
    const { data, meta } = await cc(env, 'GET', path, { query: { ...query, limit: PAGE, after }, fetchImpl });
    items.push(...(Array.isArray(data) ? data : []));
    if (!meta?.has_next || !meta?.next_cursor) break;
    after = meta.next_cursor;
  }
  return items.slice(0, max);
}

const id = (v) => encodeURIComponent(String(v));

// ─── Projects ───────────────────────────────────────────────────────

export const getProject = async (env, projectId, o) => (await cc(env, 'GET', `/projects/${id(projectId)}`, o)).data;
/** Name or street address matches (CompanyCam's own search) */
export const searchProjects = async (env, q, o) => (await cc(env, 'GET', '/projects/search', { ...o, query: { query: String(q).slice(0, 200), limit: 25 } })).data || [];
/**
 * Make a project. CompanyCam answers with the existing one (restored if it
 * was deleted) when a project with this name and address is already there.
 */
export const createProject = async (env, project, o) => (await cc(env, 'POST', '/projects', { ...o, body: { project } })).data;
export const updateProject = async (env, projectId, project, o) => (await cc(env, 'PATCH', `/projects/${id(projectId)}`, { ...o, body: { project } })).data;
export const archiveProject = (env, projectId, o) => cc(env, 'PATCH', `/projects/${id(projectId)}/archive`, { ...o, body: {} });
export const unarchiveProject = (env, projectId, o) => cc(env, 'PATCH', `/projects/${id(projectId)}/unarchive`, { ...o, body: {} });
export const setProjectDescription = (env, projectId, description, o) => cc(env, 'PATCH', `/projects/${id(projectId)}/description`, { ...o, body: { description: String(description).slice(0, 10000) } });
export const projectLabels = async (env, projectId, o) => (await cc(env, 'GET', `/projects/${id(projectId)}/labels`, o)).data || [];
export const addProjectLabels = async (env, projectId, labels, o) => (await cc(env, 'POST', `/projects/${id(projectId)}/labels`, { ...o, body: { project: { labels } } })).data || [];
export const removeProjectLabel = (env, projectId, labelId, o) => cc(env, 'DELETE', `/projects/${id(projectId)}/labels/${id(labelId)}`, o);
export const projectUrl = (projectId) => `${CC_APP}/projects/${id(projectId)}`;

// ─── Photos and documents ───────────────────────────────────────────

/** Newest first */
export const projectPhotos = (env, projectId, { max = 500, fetchImpl = fetch } = {}) => ccAll(env, `/projects/${id(projectId)}/photos`, { max, fetchImpl });
export const projectDocuments = (env, projectId, { max = 200, fetchImpl = fetch } = {}) => ccAll(env, `/projects/${id(projectId)}/documents`, { max, fetchImpl });
export const getPhoto = async (env, photoId, o) => (await cc(env, 'GET', `/photos/${id(photoId)}`, { ...o, query: { include: 'tags,annotations' } })).data;
export const getDocument = async (env, documentId, o) => (await cc(env, 'GET', `/documents/${id(documentId)}`, o)).data;
export const deletePhoto = (env, photoId, o) => cc(env, 'DELETE', `/photos/${id(photoId)}`, o);
export const setPhotoDescription = (env, photoId, content, o) => cc(env, 'POST', `/photos/${id(photoId)}/descriptions`, { ...o, body: { description: { content: String(content).slice(0, 2000) } } });
export const addPhotoTags = (env, photoId, tags, o) => cc(env, 'POST', `/photos/${id(photoId)}/tags`, { ...o, body: { tags } });
/** The company's photo tags */
export const listTags = (env, o = {}) => ccAll(env, '/tags', { max: 500, ...o });

/** The biggest picture CompanyCam has for a photo */
export function photoImageUrl(photo) {
  const uris = Array.isArray(photo?.uris) ? photo.uris : [];
  const pick = (t) => uris.find((u) => u?.type === t);
  const u = pick('original') || pick('web') || uris[0];
  return u?.url || u?.uri || null;
}

// ─── Videos ─────────────────────────────────────────────────────────

const CC_V2 = 'https://api.companycam.com/v2';
/**
 * A project's videos, newest first: [{ id, status, playback_url, captured_at, duration, … }].
 * Asked of CompanyCam's v2 API first: it gives each processed video's stream
 * on Mux, whose whole-video MP4 fits JobTread (all 75 together 1.36 GB, the
 * largest 106 MB, on Nov 11 2026). v1, which the site uses for everything
 * else, gives only the original upload (on CompanyCam's own storage, a phone's
 * full-size file), so it's the fallback when v2 won't answer this key.
 */
export async function projectVideos(env, projectId, { max = 500, fetchImpl = fetch } = {}) {
  const token = String(env?.COMPANYCAM_TOKEN || '').trim();
  if (!token) throw new CompanyCamError('COMPANYCAM_TOKEN is not set', { code: 'no_token' });
  const out = [];
  for (let page = 1; out.length < max && page <= 50; page++) {
    const res = await fetchImpl(`${CC_V2}/projects/${id(projectId)}/videos?page=${page}&per_page=${PAGE}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if ([401, 403, 404].includes(res.status) && page === 1) return ccAll(env, `/projects/${id(projectId)}/videos`, { max, fetchImpl });
    if (res.status === 404) break;
    if (!res.ok) throw new CompanyCamError(`CompanyCam returned ${res.status} listing videos`, { status: res.status, retryAfter: Number(res.headers.get('Retry-After')) || null });
    const body = await res.json().catch(() => null);
    const list = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : null;
    // Never "no videos" from an answer that isn't a list
    if (!list) throw new CompanyCamError('CompanyCam’s v2 answered without a list of videos', { status: res.status });
    out.push(...list);
    if (list.length < PAGE) break;
  }
  return out.slice(0, max);
}

/**
 * A photo's or video's comments, oldest first: [{ content, creator_name, created_at, … }].
 * Asked of v1, then of v2 (which documents them for photos); [] when neither
 * keeps comments for it or v2 won't answer this key.
 */
export async function itemComments(env, kind, itemId, { fetchImpl = fetch } = {}) {
  const path = `/${kind === 'video' ? 'videos' : 'photos'}/${id(itemId)}/comments`;
  let list = null;
  try {
    list = await ccAll(env, path, { max: 100, fetchImpl });
  } catch (e) {
    if (!(e instanceof CompanyCamError) || e.status !== 404) throw e;
    const token = String(env?.COMPANYCAM_TOKEN || '').trim();
    const res = await fetchImpl(`${CC_V2}${path}?per_page=${PAGE}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    // v2 refuses the site's key (seen Nov 11 2026): a video's comments aren't to be had here, so it has none to carry
    if ([401, 403, 404].includes(res.status)) return [];
    if (!res.ok) throw new CompanyCamError(`CompanyCam returned ${res.status} listing comments`, { status: res.status, retryAfter: Number(res.headers.get('Retry-After')) || null });
    const body = await res.json().catch(() => null);
    list = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : null;
    if (!list) throw new CompanyCamError('CompanyCam’s v2 answered without a list of comments', { status: res.status });
  }
  const when = (c) => (typeof c?.created_at === 'number' ? c.created_at * 1000 : Date.parse(c?.created_at || '') || 0);
  return list.filter((c) => c && c.status !== 'deleted' && String(c.content || '').trim()).sort((a, b) => when(a) - when(b));
}

/** Comments as one note for JobTread ("Name: words", one a line), or '' */
export const commentsNote = (comments) => (comments || [])
  .map((c) => `${String(c.creator_name || '').trim() ? `${String(c.creator_name).trim()}: ` : ''}${String(c.content).trim()}`).join('\n').slice(0, 2000);

const NOT_READY = new Set(['pending', 'processing', 'processing_error', 'failed', 'uploading', 'deleted']);
/** Whether a video file address is CompanyCam's original upload (a long signed address JobTread can't take, over 1024 characters) */
export const isOriginalUpload = (url) => ORIGINAL.test(String(url || ''));
const MUX = /^https:\/\/stream\.mux\.com\/([A-Za-z0-9]+)\.m3u8(?:\?|$)/;
const ORIGINAL = /^https:\/\/companycam-video\.s3\.amazonaws\.com\/[^?#]+\.(mp4|mov|m4v)(?:[?#]|$)/i;
/**
 * A ready video as one file, or null. CompanyCam's videos live on Mux, which
 * plays them as a stream (…/<id>.m3u8) and also hands out the whole video at
 * its best quality (…/<id>/highest.mp4); v1 gives only the original upload
 * on CompanyCam's own storage (status "active"), used as it is. Anything
 * still on its way, or deleted, waits.
 */
export function videoFileUrl(video) {
  const states = [video?.status, video?.processing_status].map((s) => String(s || '').toLowerCase());
  if (states.some((s) => NOT_READY.has(s))) return null;
  const urls = [video?.playback_url, video?.url, ...(Array.isArray(video?.uris) ? video.uris.map((u) => u?.url || u?.uri) : [])].map((u) => String(u || ''));
  for (const u of urls) {
    const m = u.match(MUX);
    if (m) return `https://stream.mux.com/${m[1]}/highest.mp4`;
  }
  return urls.find((u) => ORIGINAL.test(u)) || null;
}

/** What CompanyCam said about a video that gave no file, for the record: its fields and states, never a link */
export const videoShape = (video) => ({
  fields: Object.keys(video || {}).sort().join(','), status: video?.status ?? null, processing: video?.processing_status ?? null,
  playback: video?.playback_url ? String(video.playback_url).replace(/^(https?:\/\/[^/]+).*$/, '$1') : null,
});

/** The text and stickers someone drew on a photo, as words ("" when there's no markup) */
export function markupText(photo) {
  const a = photo?.annotations;
  if (!a) return '';
  return [...(a.text || []), ...(a.stickers || [])].map((s) => String(s).trim()).filter(Boolean).join(' · ');
}

/** Base64 MD5, which CompanyCam's upload checks */
export async function md5Base64(bytes) {
  let digest;
  try {
    digest = new Uint8Array(await crypto.subtle.digest('MD5', bytes)); // Workers has MD5
  } catch {
    const { createHash } = await import('node:crypto'); // Node (the tests)
    digest = new Uint8Array(createHash('md5').update(new Uint8Array(bytes)).digest());
  }
  return btoa(String.fromCharCode(...digest));
}

/**
 * Put a picture in a project from its bytes: an upload slot, the bytes, then
 * the photo. (A photo made from a URL is fetched later and fails silently.)
 */
export async function uploadPhoto(env, projectId, { bytes, filename, contentType = 'image/jpeg', capturedAt = null, description = '' }, { fetchImpl = fetch } = {}) {
  const checksum = await md5Base64(bytes);
  const slot = (await cc(env, 'POST', '/uploads', { body: { upload: { filename, content_type: contentType, checksum } }, fetchImpl })).data;
  if (!slot?.upload_url || !slot?.upload_id) throw new CompanyCamError('CompanyCam didn’t give an upload slot');
  const put = await fetchImpl(slot.upload_url, { method: slot.method || 'PUT', headers: slot.headers || { 'Content-Type': contentType, 'Content-MD5': checksum }, body: bytes, signal: AbortSignal.timeout(60000) });
  if (!put.ok) throw new CompanyCamError(`CompanyCam’s upload returned ${put.status}`, { status: put.status });
  const photo = { upload_id: slot.upload_id };
  if (capturedAt) photo.captured_at = new Date(capturedAt).toISOString();
  if (description) photo.description = String(description).slice(0, 2000);
  return (await cc(env, 'POST', `/projects/${id(projectId)}/photos`, { body: { photo }, fetchImpl })).data;
}

// ─── Webhooks ───────────────────────────────────────────────────────

export const listWebhooks = (env, o = {}) => ccAll(env, '/webhooks', { max: 100, ...o });
export const createWebhook = async (env, webhook, o) => (await cc(env, 'POST', '/webhooks', { ...o, body: { webhook } })).data;
export const updateWebhook = async (env, webhookId, webhook, o) => (await cc(env, 'PATCH', `/webhooks/${id(webhookId)}`, { ...o, body: { webhook } })).data;
export const deleteWebhook = (env, webhookId, o) => cc(env, 'DELETE', `/webhooks/${id(webhookId)}`, o);
/** What CompanyCam sent to a webhook (newest first): event, resource, success, the site's answer */
export const webhookDeliveries = async (env, webhookId, { since = null, limit = 20, fetchImpl = fetch } = {}) =>
  (await cc(env, 'GET', `/webhooks/${id(webhookId)}/deliveries`, { query: { limit, created_after: since }, fetchImpl })).data || [];

async function hmac(algo, key, message, encoding) {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: algo }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, typeof message === 'string' ? enc.encode(message) : message));
  return encoding === 'hex' ? [...sig].map((b) => b.toString(16).padStart(2, '0')).join('') : btoa(String.fromCharCode(...sig));
}

// ─── The site's own short link to a video's original upload ─────────
// JobTread takes a file by address only up to 1024 characters, and CompanyCam's
// signed address for an original is longer, so JobTread is given a short,
// signed, hours-long link to /api/companycam-file instead, which streams it.

const FILE_LINK_TTL_MS = 6 * 60 * 60 * 1000;
const fileLinkKey = async (env) => {
  const token = String(env?.COMPANYCAM_TOKEN || '').trim();
  return token ? hmac('SHA-256', token, 'soard-site companycam file link v1', 'hex') : null;
};
const fileLinkMessage = ({ v, p, e }) => `${v}.${p}.${e}`;

/** The short link's query for one video: { v, p, e, s } (video, project, expiry in ms, signature) */
export async function signFileLink(env, { videoId, projectId, now = Date.now() }) {
  const key = await fileLinkKey(env);
  if (!key) return null;
  const q = { v: String(videoId), p: String(projectId), e: String(now + FILE_LINK_TTL_MS) };
  return { ...q, s: await hmac('SHA-256', key, fileLinkMessage(q), 'hex') };
}

/** A short link's query, checked: signed with this site's key and not yet expired */
export async function checkFileLink(env, { v, p, e, s } = {}, now = Date.now()) {
  if (![v, p, e, s].every((x) => typeof x === 'string' && x) || !/^\d+$/.test(v) || !/^\d+$/.test(p) || !/^\d+$/.test(e) || Number(e) < now) return false;
  const key = await fileLinkKey(env);
  if (!key) return false;
  const want = await hmac('SHA-256', key, fileLinkMessage({ v, p, e }), 'hex');
  if (want.length !== s.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ s.charCodeAt(i);
  return diff === 0;
}

/** The webhook's signing token: worked out from COMPANYCAM_TOKEN, so a new API token means a new webhook token */
export async function webhookToken(env) {
  const token = String(env?.COMPANYCAM_TOKEN || '').trim();
  if (!token) return null;
  return hmac('SHA-256', token, 'soard-site companycam webhook v1', 'hex');
}

/** Base64(HMAC-SHA1(token, raw body)): what X-CompanyCam-Signature should say */
export const signatureFor = (token, rawBody) => hmac('SHA-1', token, rawBody, 'base64');

export const currentUser = async (env, o) => (await cc(env, 'GET', '/users/current', o)).data;
