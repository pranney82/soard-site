/**
 * /api/kid-items-admin — what the kid items readers have found so far (staff, Access like every admin route)
 * ===========================================================================
 * GET → { success, orders, parts }
 *   orders  the store order emails read, by store (how many gave their items, tracking, order number,
 *           an Office ship-to, a Job / PO name) and the last few reads (./_order-sweep.js)
 *   parts   each open makeover's chosen selection lines and the parts read from them (./_selection-parts.js)
 * GET ?checkin=1 → { success, practice, kids, needsLook, orders }   what the check-in page (/admin/checkin/) shows
 * POST ?scan=1 { image: 'data:image/jpeg;base64,…' } → { success, label, found }   a box's label photo → its kid and items
 * Nothing here goes to JobTread yet.
 */
import { orderSweepStatus } from './_order-sweep.js';
import { selectionPartsStatus } from './_selection-parts.js';
import { checkinView, orderReads } from './_kid-checkin.js';
import { readLabel, findBox } from './_kid-scan.js';

const headers = { 'Cache-Control': 'no-store' };

export async function onRequestGet({ env, request }) {
  try {
    if (new URL(request.url).searchParams.get('checkin')) return Response.json({ success: true, ...(await checkinView(env)) }, { headers });
    const [orders, parts] = await Promise.all([orderSweepStatus(env), selectionPartsStatus(env, { detail: true })]);
    return Response.json({ success: true, orders, parts }, { headers });
  } catch (err) {
    return Response.json({ success: false, error: err.message }, { status: 500, headers });
  }
}

/** Scan a box: the photo of its label, read, then matched to an ordered item (read only) */
export async function onRequestPost({ env, request }) {
  try {
    if (!new URL(request.url).searchParams.get('scan')) return Response.json({ success: false, error: 'Nothing to do' }, { status: 400, headers });
    const body = await request.json().catch(() => ({}));
    const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(body.image || ''));
    if (!m) return Response.json({ success: false, error: 'That isn’t a photo the site can read. Take it again.' }, { status: 400, headers });
    const bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
    const label = await readLabel(env, bytes);
    const found = findBox(await checkinView(env), await orderReads(env.DB), label);
    return Response.json({ success: true, label, found }, { headers });
  } catch (err) {
    return Response.json({ success: false, error: err.message }, { status: err.status || 500, headers });
  }
}
