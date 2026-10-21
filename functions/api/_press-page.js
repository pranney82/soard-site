/**
 * Reading a press story's page: its headline, outlet, date, picture, words
 * and any YouTube video in it; whether its link still works; its copies on
 * the Internet Archive; and saving its picture to Cloudflare Images.
 * Nothing here throws.
 */
import { decodeEntities, plain, youTubeId, genericImage } from '../../public/admin/press-shared.js';
import { UA } from './_press-sources.js';

const MAX_HTML = 1_500_000;
const MAX_TEXT = 8000;
const MAX_IMAGE = 10 * 1024 * 1024;

/** Only public web addresses: nothing on this machine or a private network */
export function safeUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h === '::1' || h === '[::1]') return null;
  return u;
}

function metaTags(html) {
  const out = [];
  for (const m of html.matchAll(/<meta\b([^>]*)>/gi)) {
    const attrs = {};
    for (const a of m[1].matchAll(/([a-zA-Z:_-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) attrs[a[1].toLowerCase()] = a[3] ?? a[4] ?? a[5] ?? '';
    const key = (attrs.property || attrs.name || attrs.itemprop || '').toLowerCase();
    if (key && attrs.content) out.push([key, decodeEntities(attrs.content).trim()]);
  }
  return out;
}
const first = (tags, keys) => { for (const k of keys) { const hit = tags.find(([t, v]) => t === k && v); if (hit) return hit[1]; } return ''; };

/** JSON-LD blocks, flattened (@graph included) */
function jsonLd(html) {
  const out = [];
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const v = JSON.parse(m[1].trim());
      const push = (x) => { if (Array.isArray(x)) x.forEach(push); else if (x && typeof x === 'object') { out.push(x); if (x['@graph']) push(x['@graph']); } };
      push(v);
    } catch { /* a broken block */ }
  }
  return out;
}
const isArticle = (x) => [].concat(x['@type'] || []).some((t) => /Article|NewsArticle|BlogPosting|Report|VideoObject|WebPage/i.test(String(t)));

/** The article's words: its JSON-LD body if it has one, else its paragraphs */
export function articleText(html) {
  const ld = jsonLd(html).find((x) => isArticle(x) && typeof x.articleBody === 'string' && x.articleBody.length > 200);
  if (ld) return plain(ld.articleBody).slice(0, MAX_TEXT);
  const body = html.replace(/<(script|style|noscript|svg|nav|header|footer|aside|form|iframe|figure)\b[\s\S]*?<\/\1>/gi, ' ');
  const paras = [...body.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => plain(m[1])).filter((t) => t.length > 40);
  return paras.join('\n').slice(0, MAX_TEXT);
}

/** Everything a story needs from its page's HTML */
export function parsePage(html, pageUrl) {
  const tags = metaTags(html);
  const ld = jsonLd(html).filter(isArticle);
  const abs = (u) => { try { return u ? new URL(decodeEntities(u), pageUrl).toString() : ''; } catch { return ''; } };
  const ldImage = ld.map((x) => [].concat(x.image || x.thumbnailUrl || [])[0]).map((i) => (typeof i === 'string' ? i : i?.url)).find(Boolean);
  const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const videos = [...new Set([...html.matchAll(/(?:youtube(?:-nocookie)?\.com\/(?:embed|watch\?v=|shorts)\/?|youtu\.be\/)([\w-]{11})/gi)].map((m) => m[1]))];
  const own = youTubeId(pageUrl);
  return {
    title: plain(first(tags, ['og:title', 'twitter:title']) || ld.map((x) => x.headline || x.name).find(Boolean) || titleTag || ''),
    siteName: plain(first(tags, ['og:site_name', 'application-name']) || ld.map((x) => x.publisher?.name || x.author?.name).find((n) => typeof n === 'string') || html.match(/<link itemprop="name" content="([^"]+)"/i)?.[1] || ''),
    description: plain(first(tags, ['og:description', 'description', 'twitter:description'])),
    image: abs(first(tags, ['og:image:secure_url', 'og:image', 'og:image:url', 'twitter:image', 'twitter:image:src']) || ldImage || ''),
    published: first(tags, ['article:published_time', 'datepublished', 'og:published_time', 'pubdate', 'publish-date', 'date', 'dc.date', 'uploaddate'])
      || ld.map((x) => x.datePublished || x.uploadDate).find(Boolean) || html.match(/itemprop="(?:datePublished|uploadDate)" content="([^"]+)"/i)?.[1] || '',
    canonical: abs(html.match(/<link\b[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i)?.[1] || ''),
    videos: own ? [own, ...videos.filter((v) => v !== own)] : videos,
    text: articleText(html),
  };
}

/**
 * Read a page. { ok, status, finalUrl, blocked, page } — blocked means the
 * outlet refused an automated visit (403/429/5xx), not that the story is gone.
 */
export async function readPage(url, { fetchImpl = fetch, timeout = 9000 } = {}) {
  const u = safeUrl(url);
  if (!u) return { ok: false, status: 0, error: 'Not a web address' };
  try {
    const res = await fetchImpl(u.toString(), { redirect: 'follow', headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' }, signal: AbortSignal.timeout(timeout) });
    const finalUrl = res.url || u.toString();
    if (!res.ok) return { ok: false, status: res.status, finalUrl, blocked: [401, 403, 429, 451, 999].includes(res.status) || res.status >= 500 };
    const type = res.headers.get('content-type') || '';
    if (type && !/html|xml/i.test(type)) return { ok: false, status: res.status, finalUrl, error: `Not a web page (${type})` };
    const html = (await res.text()).slice(0, MAX_HTML);
    return { ok: true, status: res.status, finalUrl, page: parsePage(html, finalUrl) };
  } catch (e) {
    return { ok: false, status: 0, error: e?.name === 'TimeoutError' ? 'Timed out' : (e?.message || 'Fetch failed'), unreachable: true };
  }
}

/**
 * Does a story's link still work? 'ok' | 'gone' (404/410, the page's server
 * broken, or the site isn't there) | 'blocked' (the outlet refuses automated
 * visits: unknown) | 'moved' (sent to a home page, the outlet's or another
 * site's: the story is gone). The weekly check acts only on a story that fails
 * twice, days apart, so a site that's down for an afternoon is left alone.
 */
// The page's own server is broken (Hilton Head Monthly answered 500 for weeks).
// Not 503: that's also how bot walls and maintenance pages answer.
const SERVER_BROKEN = new Set([500, 502, 504, 520, 521, 522, 523, 524, 530]);
export async function checkLink(url, { fetchImpl = fetch } = {}) {
  const u = safeUrl(url);
  if (!u) return { status: 'gone', http: 0, why: 'Not a web address' };
  try {
    const res = await fetchImpl(u.toString(), { redirect: 'follow', headers: { 'User-Agent': UA, Accept: 'text/html,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' }, signal: AbortSignal.timeout(10000) });
    try { await res.body?.cancel?.(); } catch { /* nothing to read */ }
    if (res.status === 404 || res.status === 410) return { status: 'gone', http: res.status };
    if (SERVER_BROKEN.has(res.status)) return { status: 'gone', http: res.status, why: `The outlet’s server answers ${res.status}` };
    if (!res.ok) return { status: 'blocked', http: res.status };
    let fin;
    try { fin = new URL(res.url || u.toString()); } catch { fin = u; }
    // A story that lands on a home page is gone, even another site's (old
    // Neighbor Newspapers stories on mdjonline.com now go to fultonneighbor.com)
    if (u.pathname.length > 1 && (fin.pathname === '/' || fin.pathname === '')) return { status: 'moved', http: res.status, finalUrl: fin.toString() };
    return { status: 'ok', http: res.status };
  } catch (e) {
    // A name that no longer resolves is gone; a slow or flaky site is unknown
    const msg = String(e?.message || '');
    if (/ENOTFOUND|getaddrinfo|DNS|name not resolved|could not resolve/i.test(msg)) return { status: 'gone', http: 0, why: 'The site isn’t there any more' };
    return { status: 'blocked', http: 0, why: e?.name === 'TimeoutError' ? 'Timed out' : msg.slice(0, 80) };
  }
}

// ── The Internet Archive ─────────────────────────────────────────────
/**
 * The saved copy nearest the story's own date (that's the one with the story in it).
 * → { url } | { none: true } (no copy) | { limited: true } (the Archive asked us to slow down) | { error }
 */
export async function archiveLookup(url, date, { fetchImpl = fetch } = {}) {
  try {
    const ts = String(date || '').replace(/-/g, '').slice(0, 8);
    const res = await fetchImpl(`https://archive.org/wayback/available?url=${encodeURIComponent(url)}${ts ? `&timestamp=${ts}` : ''}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(7000) });
    if (res.status === 429) return { limited: true };
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const j = await res.json();
    const snap = j?.archived_snapshots?.closest;
    return snap?.available && /^2\d\d$/.test(String(snap.status || '200')) && snap.url ? { url: snap.url.replace(/^http:\/\//, 'https://') } : { none: true };
  } catch (e) { return { error: e?.name === 'TimeoutError' ? 'Timed out' : (e?.message || 'Failed') }; }
}
/** Ask the Internet Archive to save a copy now (it can take minutes; a later lookup finds it). → { ok, limited } */
export async function archiveSave(url, { fetchImpl = fetch } = {}) {
  try {
    const res = await fetchImpl(`https://web.archive.org/save/${url}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
    return { ok: res.status < 400, limited: res.status === 429 };
  } catch { return { ok: false }; }
}
/** A saved copy as the outlet served it (no archive toolbar), for reading a story that's gone */
export const archiveRaw = (snapshot) => String(snapshot || '').replace(/\/web\/(\d+)[a-z_]*\//, '/web/$1id_/');

// ── Pictures ─────────────────────────────────────────────────────────
/**
 * Save a story's picture to Cloudflare Images under `id` (a suffix is added
 * when the id is taken). Returns { imageId } or { error }.
 */
export async function saveImage(env, imageUrl, id, { fetchImpl = fetch, referer = '' } = {}) {
  if (!env.CF_ACCOUNT_ID || !env.CF_IMAGES_TOKEN) return { error: 'Cloudflare Images isn’t set up (CF_ACCOUNT_ID, CF_IMAGES_TOKEN)' };
  const u = safeUrl(imageUrl);
  if (!u) return { error: 'Not a picture address' };
  if (genericImage(u.toString())) return { error: 'That’s the site’s logo, not a picture of the story' };
  try {
    const res = await fetchImpl(u.toString(), { redirect: 'follow', headers: { 'User-Agent': UA, Accept: 'image/avif,image/webp,image/*,*/*;q=0.8', ...(referer ? { Referer: referer } : {}) }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return { error: `The picture couldn’t be downloaded (${res.status})` };
    const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (type && !type.startsWith('image/')) return { error: `That isn’t a picture (${type})` };
    if (type === 'image/svg+xml') return { error: 'That’s a drawing (a logo), not a picture of the story' };
    const bytes = await res.arrayBuffer();
    if (!bytes.byteLength) return { error: 'The picture was empty' };
    if (bytes.byteLength > MAX_IMAGE) return { error: 'The picture is over 10 MB' };
    if (bytes.byteLength < 6000) return { error: 'The picture is too small to use' };
    const upload = async (withId) => {
      const form = new FormData();
      form.append('file', new Blob([bytes], { type: type || 'image/jpeg' }), `press.${(type.split('/')[1] || 'jpg').replace('jpeg', 'jpg')}`);
      if (withId) form.append('id', withId);
      const r = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/images/v1`, { method: 'POST', headers: { Authorization: `Bearer ${env.CF_IMAGES_TOKEN}` }, body: form });
      return r.json().catch(() => ({ success: false, errors: [{ message: `Cloudflare answered ${r.status}` }] }));
    };
    let j = await upload(id);
    if (!j.success && (j.errors || []).some((e) => e.code === 5409 || /exists/i.test(e.message || ''))) j = await upload(`${id}-${Date.now().toString(36)}`);
    if (!j.success) return { error: j.errors?.[0]?.message || 'Cloudflare Images didn’t take it' };
    return { imageId: j.result.id };
  } catch (e) {
    return { error: e?.name === 'TimeoutError' ? 'The picture took too long to download' : (e?.message || 'Download failed') };
  }
}
