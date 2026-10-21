/**
 * Where the press monitor looks for SOARD coverage. Each reader returns
 * found items in one shape:
 *   { provider, id, url, link, title, source, sourceUrl, published, description, query, videoId? }
 * `id` is unique per provider (Google's own article id, Bing's article
 * address, a YouTube video id); `url` is the outlet's own address when the
 * provider gives it (Google's needs decoding first: decodeGoogleLink).
 * Nothing here throws: a reader that can't reach its source returns
 * { items: [], error }.
 */
import { decodeEntities, plain, cleanTitle, urlKey, youTubeId, relevance, OWN_CHANNELS } from '../../public/admin/press-shared.js';

export const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const TIMEOUT = 10000;

async function get(fetchImpl, url, opts = {}) {
  const res = await fetchImpl(url, { redirect: 'follow', ...opts, headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', ...(opts.headers || {}) }, signal: AbortSignal.timeout(opts.timeout || TIMEOUT) });
  return res;
}
const isoDate = (s) => { const t = Date.parse(s || ''); return Number.isFinite(t) ? new Date(t).toISOString() : null; };
/** "9mo ago", "8y ago", "3 weeks ago", "Streamed 2 years ago" → an approximate date (YouTube search gives no other) */
export function relativeDate(text, now = Date.now()) {
  const m = String(text || '').match(/(\d+)\s*(seconds?|secs?|s|minutes?|mins?|hours?|hrs?|h|days?|d|weeks?|wks?|w|months?|mo|years?|yrs?|y)\b\s*ago/i);
  if (!m) return null;
  const n = Number(m[1]);
  const u = m[2].toLowerCase();
  const DAY = 864e5;
  const ms = /^(mo|month)/.test(u) ? n * 30.44 * DAY : /^(y|yr|year)/.test(u) ? n * 365.25 * DAY : /^(w|wk|week)/.test(u) ? n * 7 * DAY : /^(d|day)/.test(u) ? n * DAY : /^(h|hr|hour)/.test(u) ? n * 36e5 : /^(m|min)/.test(u) ? n * 6e4 : n * 1e3;
  return new Date(now - ms).toISOString();
}

// ── RSS ──────────────────────────────────────────────────────────────
function tag(block, name) {
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>\\s*(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))\\s*</${name}>`, 'i');
  const m = block.match(re);
  return m ? (m[1] ?? m[2] ?? '').trim() : '';
}
const attr = (block, name, a) => block.match(new RegExp(`<${name}\\b[^>]*\\s${a}="([^"]*)"`, 'i'))?.[1] || '';
export const rssItems = (xml) => [...String(xml || '').matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map((m) => m[1]);

// ── Google News ──────────────────────────────────────────────────────
/** Google News search results (its links are Google's own; decodeGoogleLink finds the outlet's) */
export async function googleNews(query, { fetchImpl = fetch } = {}) {
  try {
    const res = await get(fetchImpl, `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`);
    if (!res.ok) return { items: [], error: `Google News answered ${res.status}` };
    return { items: parseGoogleRss(await res.text(), query) };
  } catch (e) { return { items: [], error: `Google News: ${e.message}` }; }
}
export function parseGoogleRss(xml, query = '') {
  return rssItems(xml).map((b) => {
    const link = decodeEntities(tag(b, 'link'));
    const source = decodeEntities(tag(b, 'source'));
    const articleId = link.match(/\/articles\/([^?#/]+)/)?.[1];
    if (!articleId) return null;
    return {
      provider: 'google', id: `g:${articleId}`, url: null, link,
      title: cleanTitle(decodeEntities(tag(b, 'title')), source), source, sourceUrl: attr(b, 'source', 'url'),
      published: isoDate(tag(b, 'pubDate')), description: '', query,
    };
  }).filter(Boolean);
}
/**
 * The outlet's own address behind a Google News link. Google stopped
 * redirecting (the page sends readers on with script), so this asks Google
 * the way its page does: the article page carries a signature and time,
 * which its batchexecute endpoint trades for the address.
 */
export async function decodeGoogleLink(link, { fetchImpl = fetch } = {}) {
  const id = String(link || '').match(/news\.google\.com\/(?:rss\/)?articles\/([^?#/]+)/)?.[1];
  if (!id) return null;
  try {
    const page = await get(fetchImpl, `https://news.google.com/rss/articles/${id}`);
    if (!page.ok) return null;
    const html = await page.text();
    const sg = html.match(/data-n-a-sg="([^"]+)"/)?.[1];
    const ts = html.match(/data-n-a-ts="([^"]+)"/)?.[1];
    if (!sg || !ts) return null;
    const req = [[['Fbv4je', JSON.stringify(['garturlreq', [['X', 'X', ['X', 'X'], null, null, 1, 1, 'US:en', null, 1, null, null, null, null, null, 0, 1], 'X', 'X', 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0], id, Number(ts), sg]), null, 'generic']]];
    const res = await get(fetchImpl, 'https://news.google.com/_/DotsSplashUi/data/batchexecute', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: `f.req=${encodeURIComponent(JSON.stringify(req))}`,
    });
    if (!res.ok) return null;
    const text = await res.text();
    const chunk = text.split('\n\n')[1];
    const outer = JSON.parse(chunk);
    const url = JSON.parse(outer[0][2])[1];
    return /^https?:\/\//.test(url) && !/news\.google\.com/.test(url) ? url : null;
  } catch { return null; }
}

// ── Bing News ────────────────────────────────────────────────────────
/** Bing News: real addresses (inside its click-tracking link). It returns nothing for quoted searches */
export async function bingNews(query, { fetchImpl = fetch } = {}) {
  const q = String(query || '').replace(/"/g, '').trim();
  try {
    const res = await get(fetchImpl, `https://www.bing.com/news/search?q=${encodeURIComponent(q)}&format=rss&mkt=en-US`);
    if (!res.ok) return { items: [], error: `Bing News answered ${res.status}` };
    return { items: parseBingRss(await res.text(), query) };
  } catch (e) { return { items: [], error: `Bing News: ${e.message}` }; }
}
export function parseBingRss(xml, query = '') {
  return rssItems(xml).map((b) => {
    const raw = decodeEntities(tag(b, 'link'));
    let url = raw;
    try { const u = new URL(raw); if (/bing\.com$/i.test(u.hostname) && u.searchParams.get('url')) url = u.searchParams.get('url'); } catch { return null; }
    if (!/^https?:\/\//.test(url)) return null;
    const source = decodeEntities(tag(b, 'News:Source'));
    return {
      provider: 'bing', id: `b:${urlKey(url)}`, url, link: url,
      title: cleanTitle(decodeEntities(tag(b, 'title')), source), source, sourceUrl: '',
      published: isoDate(tag(b, 'pubDate')), description: plain(decodeEntities(tag(b, 'description'))), query,
    };
  }).filter(Boolean);
}

// ── YouTube ──────────────────────────────────────────────────────────
/** A station's newest uploads (its channel feed), the ones that name SOARD */
export async function youTubeChannel(channel, { fetchImpl = fetch } = {}) {
  try {
    const res = await get(fetchImpl, `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channel.id)}`);
    if (!res.ok) return { items: [], error: `${channel.name} feed answered ${res.status}` };
    return { items: parseYouTubeFeed(await res.text(), channel) };
  } catch (e) { return { items: [], error: `${channel.name} feed: ${e.message}` }; }
}
export function parseYouTubeFeed(xml, channel = {}) {
  return [...String(xml || '').matchAll(/<entry>([\s\S]*?)<\/entry>/gi)].map((m) => {
    const b = m[1];
    const videoId = tag(b, 'yt:videoId');
    const title = decodeEntities(tag(b, 'title'));
    const description = decodeEntities(tag(b, 'media:description'));
    if (!videoId || !relevance({ title, description }).any) return null;
    const author = decodeEntities(tag(b.match(/<author>([\s\S]*?)<\/author>/i)?.[1] || '', 'name')) || channel.name || '';
    return {
      provider: 'youtube', id: `y:${videoId}`, url: `https://www.youtube.com/watch?v=${videoId}`, link: `https://www.youtube.com/watch?v=${videoId}`,
      title, source: channel.name || author, sourceUrl: `https://www.youtube.com/channel/${channel.id || ''}`,
      // A station on the watch list: its videos count as that station's coverage
      published: isoDate(tag(b, 'published')), description: description.slice(0, 600), query: `channel:${channel.id || ''}`, videoId,
    };
  }).filter(Boolean);
}
/** YouTube search results, newest first, without SOARD's own channel */
export async function youTubeSearch(query, { fetchImpl = fetch } = {}) {
  try {
    const res = await get(fetchImpl, `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=CAI%253D`);
    if (!res.ok) return { items: [], error: `YouTube search answered ${res.status}` };
    return { items: parseYouTubeSearch(await res.text(), query) };
  } catch (e) { return { items: [], error: `YouTube search: ${e.message}` }; }
}
export function parseYouTubeSearch(html, query = '') {
  const m = String(html || '').match(/var ytInitialData = (\{[\s\S]*?\});<\/script>/);
  if (!m) return [];
  let data;
  try { data = JSON.parse(m[1]); } catch { return []; }
  const out = [];
  const walk = (v) => {
    if (!v || typeof v !== 'object') return;
    if (v.videoRenderer?.videoId) {
      const r = v.videoRenderer;
      const text = (x) => (x?.runs || []).map((t) => t.text).join('') || x?.simpleText || '';
      const title = text(r.title);
      const channel = text(r.ownerText) || text(r.longBylineText);
      const description = (r.detailedMetadataSnippets || []).map((s) => text(s.snippetText)).join(' ') || text(r.descriptionSnippet);
      if (!OWN_CHANNELS.some((re) => re.test(channel)) && relevance({ title, description }).any) {
        out.push({
          provider: 'youtube', id: `y:${r.videoId}`, url: `https://www.youtube.com/watch?v=${r.videoId}`, link: `https://www.youtube.com/watch?v=${r.videoId}`,
          title, source: channel, sourceUrl: '', published: relativeDate(text(r.publishedTimeText)), publishedText: text(r.publishedTimeText), description: description.slice(0, 600), query, videoId: r.videoId,
        });
      }
      return;
    }
    for (const k in v) walk(v[k]);
  };
  walk(data);
  return out;
}
export { youTubeId };
