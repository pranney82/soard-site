/**
 * /api/kid-items-admin — what the kid items readers have found so far (staff, Access like every admin route)
 * ===========================================================================
 * GET → { success, orders, parts }
 *   orders  the store order emails read, by store (how many gave their items, tracking, order number,
 *           an Office ship-to, a Job / PO name) and the last few reads (./_order-sweep.js)
 *   parts   each open makeover's chosen selection lines and the parts read from them (./_selection-parts.js)
 * Read-only: there is no POST. It's for checking the reads by eye before anything goes to JobTread.
 */
import { orderSweepStatus } from './_order-sweep.js';
import { selectionPartsStatus } from './_selection-parts.js';

const headers = { 'Cache-Control': 'no-store' };

export async function onRequestGet({ env }) {
  try {
    const [orders, parts] = await Promise.all([orderSweepStatus(env), selectionPartsStatus(env, { detail: true })]);
    return Response.json({ success: true, orders, parts }, { headers });
  } catch (err) {
    return Response.json({ success: false, error: err.message }, { status: 500, headers });
  }
}
