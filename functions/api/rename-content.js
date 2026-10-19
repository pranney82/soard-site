/**
 * POST /api/rename-content
 * Changes a person's web address (slug), for instance after a name change, so
 * the old name doesn't live on in it. Moves everything keyed by the slug:
 *   - the record itself (one D1 batch: the new row in, the old row out)
 *   - their private reveal-invite email (reveal_board_emails)
 *   - their photo, when its Cloudflare Images ID carries the old slug
 *     ("team/<old>/…"): copied to "team/<new>/…", then the old one deleted.
 *     If the copy can't be made the photo stays as it was and `note` says so.
 *
 * Body: { collection: "team", from: "linzi-berkowitz", to: "linzi-lawsky" }
 * Returns: { success, slug, sha, photo, photoMoved, note }
 *
 * Admin-only (the middleware requires Access for /api/* not in PUBLIC_ROUTES).
 * Env: DB, CF_ACCOUNT_ID + CF_IMAGES_TOKEN (for the photo).
 */
import { EXTRACTORS, generateSha } from './_collections.js';
import { logAudit, getEntityName } from './_audit.js';

const RENAMABLE = { team: { dir: 'src/content/team/', imagePrefix: 'team/' } };
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CF_HASH = 'ROYFuPmfN2vPS6mt5sCkZQ';
const API = (env) => `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/images/v1`;

/** The Cloudflare Images ID inside a stored photo URL (or a bare ID) */
export function imageIdOf(photo) {
  const s = String(photo || '');
  const m = s.match(/imagedelivery\.net\/[^/]+\/(.+)$/) || s.match(/\/cdn-cgi\/imagedelivery\/[^/]+\/(.+)$/);
  let id = m ? m[1] : (/^https?:/.test(s) ? '' : s);
  const last = id.lastIndexOf('/');
  if (last > 0) {
    const suffix = id.slice(last + 1);
    if (suffix === 'public' || suffix.includes('=')) id = id.slice(0, last);
  }
  return id;
}

/** Copy an image to a new ID: the original file if Cloudflare hands it over, else a full-size copy */
async function copyImage(env, fromId, toId, fetchImpl) {
  const auth = { Authorization: `Bearer ${env.CF_IMAGES_TOKEN}` };
  let file = null;
  try {
    const r = await fetchImpl(`${API(env)}/${fromId}/blob`, { headers: auth });
    if (r.ok) file = await r.blob();
  } catch {}
  const form = new FormData();
  if (file && file.size) form.append('file', file, 'photo');
  else form.append('url', `https://imagedelivery.net/${CF_HASH}/${fromId}/w=4096,fit=scale-down,q=100`);
  form.append('id', toId);
  const res = await fetchImpl(API(env), { method: 'POST', headers: auth, body: form });
  const body = await res.json().catch(() => ({}));
  if (!body?.success) throw new Error(body?.errors?.[0]?.message || `upload ${res.status}`);
  const variants = body.result?.variants || [];
  return variants.find((v) => v.endsWith('/public')) || `https://imagedelivery.net/${CF_HASH}/${body.result?.id || toId}/public`;
}

export async function rename(env, { collection, from, to } = {}, userEmail = 'unknown', fetchImpl = fetch) {
  const cfg = RENAMABLE[collection];
  if (!cfg) return { status: 403, body: { success: false, error: 'This item’s web address can’t be changed here' } };
  if (!SLUG_RE.test(from || '') || !SLUG_RE.test(to || '') || to.length > 80) {
    return { status: 400, body: { success: false, error: 'Use lowercase letters, numbers and single hyphens, like jane-smith' } };
  }
  if (from === to) return { status: 400, body: { success: false, error: 'That’s already the web address' } };
  const { DB } = env;
  const table = collection;
  const row = await DB.prepare(`SELECT data FROM ${table} WHERE slug = ?`).bind(from).first();
  if (!row) return { status: 404, body: { success: false, error: 'Not found. Reload and try again.' } };
  if (await DB.prepare(`SELECT slug FROM ${table} WHERE slug = ?`).bind(to).first()) {
    return { status: 409, body: { success: false, error: `Someone already has the address “${to}”. Pick another.` } };
  }
  const before = JSON.parse(row.data);
  const data = { ...before, slug: to };

  // The photo first: if it can't move, the rename still goes ahead with the old photo
  let photoMoved = false;
  let oldImageId = null;
  let note = null;
  const imageId = imageIdOf(before.photo);
  if (imageId && (imageId.startsWith(`${cfg.imagePrefix}${from}/`) || imageId === `${cfg.imagePrefix}${from}`)) {
    if (env.CF_ACCOUNT_ID && env.CF_IMAGES_TOKEN) {
      try {
        data.photo = await copyImage(env, imageId, `${cfg.imagePrefix}${to}/${Date.now()}`, fetchImpl);
        photoMoved = true;
        oldImageId = imageId;
      } catch (e) {
        note = `The photo couldn’t be moved (${e.message}), so its file name still has the old address. Upload the photo again to update it.`;
      }
    } else {
      note = 'The photo’s file name still has the old address (Cloudflare Images isn’t set up here). Upload the photo again to update it.';
    }
  }

  const json = JSON.stringify(data);
  const now = new Date().toISOString();
  const [cols, vals] = EXTRACTORS[table](data);
  const all = ['"slug"', '"data"', '"updated_at"', ...cols];
  try {
    await DB.batch([
      DB.prepare(`INSERT INTO ${table} (${all.join(', ')}) VALUES (${all.map(() => '?').join(', ')})`).bind(to, json, now, ...vals),
      DB.prepare(`DELETE FROM ${table} WHERE slug = ?`).bind(from),
    ]);
  } catch (e) {
    // Nothing changed: drop the photo copy so no stray file is left behind
    if (photoMoved) try { await fetchImpl(`${API(env)}/${imageIdOf(data.photo)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${env.CF_IMAGES_TOKEN}` } }); } catch {}
    throw e;
  }
  // Their private reveal email follows them (the table exists once invites are set up)
  try { await DB.prepare('UPDATE reveal_board_emails SET slug = ? WHERE slug = ?').bind(to, from).run(); } catch {}
  if (oldImageId) {
    try { await fetchImpl(`${API(env)}/${oldImageId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${env.CF_IMAGES_TOKEN}` } }); } catch {}
  }

  const changes = [{ field: 'slug', from, to }];
  if (photoMoved) changes.push({ field: 'photo', from: before.photo, to: data.photo });
  await logAudit(DB, {
    userEmail, action: 'updated', entityType: table, entitySlug: to,
    entityName: getEntityName(data, table), changes, path: `${cfg.dir}${to}.json`, gitStatus: null,
  });
  return { status: 200, body: { success: true, slug: to, sha: await generateSha(json), photo: data.photo || '', photoMoved, note } };
}

export async function onRequestPost(context) {
  try {
    const body = await context.request.json().catch(() => ({}));
    const r = await rename(context.env, body, context.data?.userEmail || 'unknown');
    return Response.json(r.body, { status: r.status });
  } catch (err) {
    console.error('[rename-content]', err);
    return Response.json({ success: false, error: err.message || 'Couldn’t change the web address' }, { status: 500 });
  }
}
