/**
 * POST /api/fetch-og-image
 * Pulls an article's preview image (og:image / twitter:image) and saves it to
 * Cloudflare Images so press cards can show a real picture without anyone
 * downloading and re-uploading by hand.
 *
 * Body: { url: "https://outlet.com/story", id?: "press/outlet-2026" }
 * Returns: { success, imageId, imageUrl, sourceImage, pageTitle }
 *
 * Admin-only (the middleware requires Access for anything not in PUBLIC_ROUTES).
 * Env: CF_ACCOUNT_ID, CF_IMAGES_TOKEN (same as /api/upload-image).
 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const MAX_HTML = 1_500_000;      // bytes of HTML we bother scanning
const MAX_IMAGE = 10 * 1024 * 1024; // matches /api/upload-image

function json(data, status = 200) {
  return Response.json(data, { status });
}

function parseTargetUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host === '::1') return null;
  return u;
}

function validId(id) {
  return typeof id === 'string' && id.length <= 256 && !id.includes('..') && /^[A-Za-z0-9][A-Za-z0-9/_.-]*$/.test(id);
}

function decodeEntities(str) {
  return String(str || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'").replace(/&#x2F;/g, '/');
}

/** Read every <meta ...> tag into { key, content } pairs (key = property|name|itemprop). */
function metaTags(html) {
  const out = [];
  const re = /<meta\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = {};
    const ar = /([a-zA-Z:_-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
    let a;
    while ((a = ar.exec(m[1])) !== null) attrs[a[1].toLowerCase()] = a[3] ?? a[4] ?? a[5] ?? '';
    const key = (attrs.property || attrs.name || attrs.itemprop || '').toLowerCase();
    if (key && attrs.content) out.push({ key, content: decodeEntities(attrs.content).trim() });
  }
  return out;
}

function findPreviewImage(html, baseUrl) {
  const tags = metaTags(html);
  const order = ['og:image:secure_url', 'og:image', 'og:image:url', 'twitter:image', 'twitter:image:src', 'image'];
  for (const key of order) {
    const hit = tags.find(t => t.key === key && t.content);
    if (hit) { try { return new URL(hit.content, baseUrl).toString(); } catch { /* next */ } }
  }
  const link = html.match(/<link\b[^>]*rel=["']image_src["'][^>]*href=["']([^"']+)["']/i);
  if (link) { try { return new URL(decodeEntities(link[1]), baseUrl).toString(); } catch { /* fall through */ } }
  return null;
}

function pageTitle(html) {
  const og = metaTags(html).find(t => t.key === 'og:title');
  if (og) return og.content;
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return t ? decodeEntities(t[1]).replace(/\s+/g, ' ').trim() : '';
}

async function uploadToImages(env, bytes, contentType, filename, id) {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: contentType }), filename);
  if (id) form.append('id', id);
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/images/v1`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.CF_IMAGES_TOKEN}` },
    body: form,
  });
  return res.json();
}

export async function onRequestPost(context) {
  const { env } = context;
  if (!env.CF_ACCOUNT_ID || !env.CF_IMAGES_TOKEN) {
    return json({ success: false, error: 'Missing Cloudflare credentials. Set CF_ACCOUNT_ID and CF_IMAGES_TOKEN in Pages settings.' }, 500);
  }

  let body;
  try { body = await context.request.json(); } catch { return json({ success: false, error: 'Invalid JSON body' }, 400); }

  const target = parseTargetUrl(body.url);
  if (!target) return json({ success: false, error: 'Enter a full article URL starting with http:// or https://' }, 400);
  let id = body.id ? String(body.id) : '';
  if (id && !validId(id)) return json({ success: false, error: 'Invalid image id. Use letters, numbers, and / _ . - only.' }, 400);

  try {
    // 1. Fetch the article page
    const pageRes = await fetch(target.toString(), {
      redirect: 'follow',
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' },
      signal: AbortSignal.timeout(12000),
    });
    const finalUrl = pageRes.url || target.toString();
    if (!pageRes.ok) {
      return json({ success: false, error: `The article page answered ${pageRes.status}. Some outlets block automated requests; save the image manually with Browse.` }, 500);
    }
    if (/(^|\.)news\.google\.com$/i.test(new URL(finalUrl).hostname)) {
      return json({ success: false, error: 'This is a Google News link. Open the story in your browser and paste the outlet\'s own URL, then try again.' }, 422);
    }
    const html = (await pageRes.text()).slice(0, MAX_HTML);

    // 2. Find the preview image
    const imageUrl = findPreviewImage(html, finalUrl);
    if (!imageUrl) return json({ success: false, error: 'No preview image found on that page. Upload one with Browse instead.', pageUrl: finalUrl }, 422);

    // 3. Download it
    const imgRes = await fetch(imageUrl, {
      redirect: 'follow',
      headers: { 'User-Agent': UA, Accept: 'image/avif,image/webp,image/*,*/*;q=0.8', Referer: finalUrl },
      signal: AbortSignal.timeout(15000),
    });
    if (!imgRes.ok) return json({ success: false, error: `The image could not be downloaded (${imgRes.status}). Save it manually with Browse.`, sourceImage: imageUrl }, 500);
    const contentType = (imgRes.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const looksLikeImage = contentType.startsWith('image/') || /\.(jpe?g|png|webp|gif|avif)(\?|$)/i.test(imageUrl);
    if (!looksLikeImage) return json({ success: false, error: `That link did not return an image (${contentType || 'unknown type'}).`, sourceImage: imageUrl }, 422);
    const bytes = await imgRes.arrayBuffer();
    if (bytes.byteLength === 0) return json({ success: false, error: 'The image download was empty.', sourceImage: imageUrl }, 500);
    if (bytes.byteLength > MAX_IMAGE) return json({ success: false, error: 'Image is larger than 10 MB. Save a smaller copy with Browse.', sourceImage: imageUrl }, 413);

    // 4. Save to Cloudflare Images (retry with a suffix if the id is taken)
    const ext = contentType.startsWith('image/') ? contentType.split('/')[1].replace('jpeg', 'jpg') : 'jpg';
    const filename = `press-image.${ext}`;
    let result = await uploadToImages(env, bytes, contentType || 'image/jpeg', filename, id);
    if (!result.success && id && (result.errors || []).some(e => e.code === 5409 || /already exists/i.test(e.message || ''))) {
      id = `${id}-${Date.now()}`;
      result = await uploadToImages(env, bytes, contentType || 'image/jpeg', filename, id);
    }
    if (!result.success) {
      return json({ success: false, error: result.errors?.[0]?.message || 'Cloudflare Images upload failed', sourceImage: imageUrl }, 500);
    }

    return json({
      success: true,
      imageId: result.result.id,
      imageUrl: result.result.variants?.[0] || null,
      sourceImage: imageUrl,
      pageTitle: pageTitle(html),
      pageUrl: finalUrl,
    });
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || /timeout/i.test(err?.message || '');
    return json({ success: false, error: timedOut ? 'The outlet took too long to respond. Try again, or save the image manually with Browse.' : (err?.message || 'Fetch failed') }, 500);
  }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204 });
}
