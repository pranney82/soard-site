/**
 * /api/kid-items-admin — kid items: what's ordered, checking it in, labels, shelves (staff, Access like every admin route)
 * ===========================================================================
 * GET → { success, orders, parts, jobtread }      the readers' and the JobTread writer's state (Automations)
 * GET ?checkin=1 → { success, practice, kids, needsLook, shelves, printer }   what the check-in page shows
 * GET ?printer-setup=1 → the file to send to the label printer once (Zebra Printer Setup Utility → Files)
 * POST, each answering with the page's fresh view ({ success, view, … }):
 *   ?scan=1    { image: 'data:image/jpeg;base64,…' } → { label, found }   a box's label photo → its kid and items
 *   ?receive=1 { tap, jobId, itemId, partKey, name, line, units, boxes, shelf? } → { receipt, shelf, jt, print }
 *   ?house=1   { tap, jobId, itemId, partKey, name, line }        "Not coming here" (it went to the house)
 *   ?undo=1    { tap }                                             a check-in taken back
 *   ?shelf=1   { tap, shelf }                                      a check-in moved to another shelf (or the Floor)
 *   ?reprint=1 { tap }                                             a check-in's labels again
 *   ?decide=1  { orderKey, items: [{ itemName, decision }] }      Needs a look and Wrong kid answers
 *   ?other=1   { tap, jobId, name, cents, donated, units, boxes } something else that came, typed in
 *   ?shelf-labels=1 { shelves: ['1', …] }                          the shelves' own signs
 * Every check-in is saved first, then its kid's lines are written to JobTread (./_kid-jt.js) and its labels printed.
 */
import { orderSweepStatus } from './_order-sweep.js';
import { selectionPartsStatus } from './_selection-parts.js';
import { checkinView, orderReads } from './_kid-checkin.js';
import { readLabel, findBox } from './_kid-scan.js';
import { receive, undo, moveShelf, decide, typedIn, shelfName, SHELVES, ensureRecord } from './_kid-record.js';
import { writeKidNow, kidJtStatus } from './_kid-jt.js';
import { receiptLabels, shelfLabel } from './_kid-labels.js';
import { printLabels, printerStatus, printerSetup, PRINTER_URL, PRINTER_USER } from './_kid-print.js';
import { verifyJwt } from './_middleware.js';

const headers = { 'Cache-Control': 'no-store' };
const fail = (err) => Response.json({ success: false, error: err.message }, { status: err.status || 500, headers });

/** Who's signed in (their Access email), for the record */
async function who(request, env) {
  const cookie = (request.headers.get('Cookie') || '').split(/;\s*/).find((c) => c.startsWith('CF_Authorization='));
  const jwt = request.headers.get('CF-Access-JWT-Assertion') || (cookie ? cookie.slice('CF_Authorization='.length) : '');
  if (!jwt || !env.CF_ACCESS_TEAM_DOMAIN || !env.CF_ACCESS_AUD) return null;
  try { return String((await verifyJwt(jwt, env.CF_ACCESS_TEAM_DOMAIN, env.CF_ACCESS_AUD))?.email || '').toLowerCase() || null; } catch { return null; }
}

async function pageView(env) {
  const [view, printer] = await Promise.all([checkinView(env), printerStatus(env)]);
  return { ...view, printer };
}

export async function onRequestGet({ env, request }) {
  try {
    const q = new URL(request.url).searchParams;
    if (q.get('checkin')) return Response.json({ success: true, ...(await pageView(env)), printerUrl: PRINTER_URL, printerUser: PRINTER_USER }, { headers });
    if (q.get('printer-setup')) {
      return new Response(await printerSetup(env.DB), { headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': 'attachment; filename="soard-printer-setup.txt"' } });
    }
    const [orders, parts, jobtread] = await Promise.all([orderSweepStatus(env), selectionPartsStatus(env, { detail: true }), kidJtStatus(env)]);
    return Response.json({ success: true, orders, parts, jobtread }, { headers });
  } catch (err) {
    return fail(err);
  }
}

/** One check-in's labels: one a box, the kid's name, the item, the shelf, a QR to it */
function labelsFor(view, receipt) {
  const kid = view.kids.find((k) => k.jobId === receipt.job_id);
  return receiptLabels({ kid: kid?.short || 'SOARD', item: receipt.name, line: receipt.line_name, boxes: receipt.boxes, shelf: receipt.shelf ? shelfName(receipt.shelf) : '', at: receipt.at, tap: receipt.id });
}

export async function onRequestPost(context) {
  const { env, request } = context;
  try {
    const q = new URL(request.url).searchParams;
    const body = await request.json().catch(() => ({}));
    if (q.get('scan')) {
      const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(body.image || ''));
      if (!m) return Response.json({ success: false, error: 'That isn’t a photo the site can read. Take it again.' }, { status: 400, headers });
      const bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
      const label = await readLabel(env, bytes);
      const found = findBox(await checkinView(env, { photos: false }), await orderReads(env.DB), label);
      return Response.json({ success: true, label, found }, { headers });
    }
    await ensureRecord(env.DB);
    const by = await who(request, env);
    const out = {};
    let jobId = null;
    let print = null;
    if (q.get('receive') || q.get('other')) {
      const r = q.get('other') ? await typedIn(env.DB, body, { by }) : await receive(env.DB, body, { by });
      jobId = r.receipt.job_id;
      Object.assign(out, { receipt: r.receipt.id, shelf: r.shelf, repeat: r.repeat });
      // A retry of the same tap doesn't print twice
      if (!r.repeat) print = r.receipt;
    } else if (q.get('house')) {
      const r = await receive(env.DB, { ...body, kind: 'house' }, { by });
      jobId = r.receipt.job_id;
      out.receipt = r.receipt.id;
    } else if (q.get('undo')) {
      jobId = (await undo(env.DB, body.tap, { by })).jobId;
    } else if (q.get('shelf')) {
      jobId = (await moveShelf(env.DB, body.tap, String(body.shelf || ''))).jobId;
      out.shelf = String(body.shelf);
    } else if (q.get('reprint')) {
      const r = await env.DB.prepare('SELECT * FROM kid_receipts WHERE id = ?').bind(String(body.tap || '')).first();
      if (!r) return Response.json({ success: false, error: 'That check-in isn’t saved yet.' }, { status: 404, headers });
      print = r;
    } else if (q.get('decide')) {
      const items = Array.isArray(body.items) ? body.items.slice(0, 40) : [];
      if (!items.length) return Response.json({ success: false, error: 'Pick whose it is.' }, { status: 400, headers });
      const kids = new Set();
      for (const it of items) {
        const d = await decide(env.DB, { orderKey: body.orderKey, itemName: it.itemName, decision: it.decision }, { by });
        if (d.kid) kids.add(d.kid);
      }
      // Whoever had it before is written too (Wrong kid moves it off them)
      for (const k of [...kids, ...(body.from ? [String(body.from)] : [])]) context.waitUntil?.(writeKidNow(env, k));
    } else if (q.get('shelf-labels')) {
      const shelves = (Array.isArray(body.shelves) ? body.shelves : SHELVES).map(String).filter((s) => SHELVES.includes(s)).slice(0, 29);
      const r = await printLabels(env, shelves.map((s) => shelfLabel({ shelf: s, name: shelfName(s) })));
      return Response.json({ success: true, print: r }, { headers });
    } else {
      return Response.json({ success: false, error: 'Nothing to do' }, { status: 400, headers });
    }
    const view = await checkinView(env);
    if (print) out.print = await printLabels(env, labelsFor(view, print));
    // JobTread now, for the kid it changed: the answer says whether it's there
    if (jobId) out.jt = await writeKidNow(env, jobId);
    return Response.json({ success: true, ...out, view: { ...(out.jt === 'written' ? await checkinView(env) : view), printer: await printerStatus(env) } }, { headers });
  } catch (err) {
    return fail(err);
  }
}
