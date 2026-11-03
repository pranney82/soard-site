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
import { moveVersions } from './_content-history.js';
import { moveRequests } from './_profile-requests.js';

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
  // Own keys only: "constructor" or "__proto__" must not find something on Object.prototype
  const cfg = typeof collection === 'string' && Object.hasOwn(RENAMABLE, collection) ? RENAMABLE[collection] : null;
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
  // A former board member's board records are kept under their address (signatures, sign-ins): never someone else's.
  // Their own earlier address, nobody's since, is theirs to go back to (a rename undone)
  let back = false;
  if (table === 'team') {
    try {
      const { slugsOf } = await import('./_board-sign.js');
      const mine = (await slugsOf(DB, from)).find((x) => x.slug === to && x.before);
      const since = mine ? await DB.prepare('SELECT seq FROM board_sign_events WHERE slug = ? AND seq > ? LIMIT 1').bind(to, mine.before).first() : null;
      back = !!mine && !since;
    } catch { /* no signing record yet */ }
  }
  if (table === 'team' && !back) {
    for (const t of ['board_signatures', 'board_signins', 'board_activity', 'board_sign_events']) {
      const had = await DB.prepare(`SELECT slug FROM ${t} WHERE slug = ? LIMIT 1`).bind(to).first().catch(() => null);
      if (had) return { status: 409, body: { success: false, error: `“${to}” was a board member’s address, and their board records are kept under it. Pick another.` } };
    }
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
  // Their private reveal email, saved versions and profile requests follow them
  try { await DB.prepare('UPDATE reveal_board_emails SET slug = ? WHERE slug = ?').bind(to, from).run(); } catch {}
  // ...and so does the board page sign-in email they had (Board → Members), so they aren't sent it again
  try {
    const row = await DB.prepare("SELECT data FROM board_state WHERE key = 'welcome'").first();
    const w = row ? JSON.parse(row.data || '{}') : null;
    if (w && (['members', 'addresses'].some((k) => w[k]?.[from] !== undefined) || w.unconfirmed?.includes(from))) {
      for (const k of ['members', 'addresses']) if (w[k]?.[from] !== undefined) { w[k][to] = w[k][from]; delete w[k][from]; }
      if (w.unconfirmed) w.unconfirmed = w.unconfirmed.map((k) => (k === from ? to : k));
      await DB.prepare("UPDATE board_state SET data = ? WHERE key = 'welcome'").bind(JSON.stringify(w)).run();
    }
  } catch {}
  try { await moveVersions(DB, 'team', from, to); } catch {}
  try { await moveRequests(DB, from, to); } catch {}
  // A board member's board records follow them too: their sign-ins and what they did on the board page (Board →
  // Members), their last visit, signatures (this year's, earlier wordings', their signed copies and records), asks to
  // sign, adopted signature, check-ins, votes and asks. The signing chain is never rewritten: a 'renamed' event says
  // the old slug is theirs (./_board-sign.js slugsOf)
  if (table === 'team') {
    for (const t of ['board_signins', 'board_activity', 'board_activity_reports', 'board_seen', 'board_signatures', 'board_signatures_earlier', 'board_sign_asks', 'board_member_marks', 'board_checkins', 'board_votes', 'board_asks']) {
      try { await DB.prepare(`UPDATE OR IGNORE ${t} SET slug = ? WHERE slug = ?`).bind(to, from).run(); } catch {}
    }
    try { await DB.prepare("UPDATE board_files SET slug = ? WHERE slug = ? AND owner_type IN ('signed', 'record')").bind(to, from).run(); } catch {}
    try {
      const { appendEvents } = await import('./_board-sign.js');
      const had = await DB.prepare('SELECT COUNT(*) AS n FROM board_sign_events WHERE slug = ?').bind(from).first();
      if (Number(had?.n) > 0) await appendEvents(DB, async () => ({ events: [{ kind: 'renamed', slug: to, by: userEmail || '', detail: { from, to } }] }));
    } catch {}
  }
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
