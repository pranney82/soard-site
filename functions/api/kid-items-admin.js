/**
 * /api/kid-items-admin — what the kid items readers have found so far (staff, Access like every admin route)
 * ===========================================================================
 * GET → { success, orders, parts }
 *   orders  the store order emails read, by store (how many gave their items, tracking, order number,
 *           an Office ship-to, a Job / PO name) and the last few reads (./_order-sweep.js)
 *   parts   each open makeover's chosen selection lines and the parts read from them (./_selection-parts.js)
 * GET ?checkin=1 → { success, practice, kids, needsLook, orders }   what the check-in page (/admin/checkin/) shows
 * Read-only: there is no POST. Nothing here goes to JobTread yet.
 */
import { orderSweepStatus } from './_order-sweep.js';
import { selectionPartsStatus } from './_selection-parts.js';
import { checkinView } from './_kid-checkin.js';

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
