/**
 * /api/kid-items-admin — kid items: what's ordered, checking it in, labels, shelves (staff, Access like every admin route)
 * ===========================================================================
 * GET → { success, orders, parts, jobtread }      the readers' and the JobTread writer's state (Automations)
 * GET ?checkin=1 → { success, practice, kids, needsLook, shelves, printer }   what the check-in page shows
 * GET ?printer-setup=1 → the file to send to the label printer once (Zebra Printer Setup Utility → Files)
 * POST, each answering with the page's fresh view ({ success, view, … }):
 *   ?scan=1    { image: 'data:image/jpeg;base64,…' } → { label, found }   a box's label photo → its kid and items
 *   ?receive=1 { tap, jobId, itemId, partKey, name, line, units, boxes, shelf? } → { receipt, shelf, jt, print };
 *              { items: [those] } a whole shipment at once → { results: [{ tap, jobId, shelf, repeat } | { tap, error, status }], print, jt }
 *   ?house=1   { tap, jobId, itemId, partKey, name, line }        "Not coming here" (it went to the house)
 *   ?undo=1    { taps: [...] } (or one { tap })                     check-ins or boxes out taken back → { results: [{ tap, shelf, moved? }] }
 *   ?shelf=1   { tap, shelf }                                      a check-in moved to another shelf (or the Floor)
 *   ?reprint=1 { tap }                                             a check-in's labels again
 *   ?decide=1  { orderKey, items: [{ itemName, decision }] }      Needs a look and Wrong kid answers
 *   ?other=1   { tap, jobId, name, cents, donated, units, boxes } something else that came, typed in
 *   ?shelf-labels=1 { shelves: ['1', …] }                          the shelves' own signs
 *   ?out=1     { items: [{ tap, ref, box }] } a load (Confirm), each one box of one check-in, out to the house
 *              → { results: [{ tap, repeat } | { tap, error, status }] } (or one { tap, ref, box })
 * Every check-in is saved first, then its kid's lines are written to JobTread (./_kid-jt.js) and its labels printed.
 */
import { orderSweepStatus } from './_order-sweep.js';
import { selectionPartsStatus } from './_selection-parts.js';
import { checkinView, orderReads } from './_kid-checkin.js';
import { readLabel, findBox, likelyBoxes } from './_kid-scan.js';
import { receive, undoMany, moveShelf, decide, typedIn, checkOut, checkOutMany, OUT_BATCH, shelfName, SHELVES, ensureRecord } from './_kid-record.js';
import { writeKidNow, kidJtStatus } from './_kid-jt.js';
import { shelfLabel } from './_kid-labels.js';
import { printLabels, printReceipts, labelsOf, printerStatus, printerSetup, PRINTER_URL, PRINTER_USER } from './_kid-print.js';
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

/** Who's looking: their first name, and whether they're a makeover's Project Manager (the page opens on Check out for them) */
async function meOf(request, env, view) {
  const email = await who(request, env);
  if (!email) return { first: null, pm: false };
  const row = await env.DB.prepare("SELECT data FROM staff_state WHERE key = 'directory'").first().catch(() => null);
  let accounts = [];
  try { accounts = JSON.parse(row?.data || '{}').accounts || []; } catch { /* none */ }
  const first = String(accounts.find((a) => String(a.email || '').toLowerCase() === email)?.name || '').split(/\s+/)[0] || email.split('@')[0];
  const pm = view.kids.some((k) => k.pm && k.pm.toLowerCase() === first.toLowerCase());
  return { first, pm };
}

async function pageView(env) {
  const [view, printer] = await Promise.all([checkinView(env), printerStatus(env)]);
  return { ...view, printer };
}

export async function onRequestGet({ env, request }) {
  try {
    const q = new URL(request.url).searchParams;
    if (q.get('checkin')) {
      const view = await pageView(env);
      return Response.json({ success: true, ...view, me: await meOf(request, env, view), printerUrl: PRINTER_URL, printerUser: PRINTER_USER }, { headers });
    }
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
const labelsFor = (view, receipt) => labelsOf(view.kids.find((k) => k.jobId === receipt.job_id)?.short, receipt);

/**
 * Check-ins' labels to the printer (./_kid-print.js printReceipts: each printed once, in parts the hub takes, held
 * here while the printer is off). It carries on if the phone hangs up first: Cloudflare stops a request's unfinished
 * work when its caller leaves, and waitUntil keeps it, so a check-in saved always gets its labels
 */
function printFor(context, receipts, view, opts = {}) {
  const run = printReceipts(context.env, receipts, (r) => labelsFor(view, r), opts);
  context.waitUntil?.(run.catch(() => {}));
  return run;
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
      const [view, reads] = [await checkinView(env, { photos: false }), await orderReads(env.DB)];
      const found = findBox(view, reads, label);
      const likely = found ? [] : likelyBoxes(view, reads, label);
      // Every scan kept (what was read, what it found; never the photo), so a miss can be looked into
      await env.DB.prepare('CREATE TABLE IF NOT EXISTS kid_scans (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, by_email TEXT, label TEXT, found TEXT, likely INTEGER)').run().catch(() => {});
      await env.DB.prepare('INSERT INTO kid_scans (at, by_email, label, found, likely) VALUES (?, ?, ?, ?, ?)')
        .bind(new Date().toISOString(), await who(request, env), JSON.stringify(label), found ? JSON.stringify(found) : null, likely.length).run().catch(() => {});
      return Response.json({ success: true, label, found, likely }, { headers });
    }
    await ensureRecord(env.DB);
    const by = await who(request, env);
    const out = {};
    let jobId = null;
    let print = null;
    if (q.get('receive') && Array.isArray(body.items)) {
      // A whole shipment checked in at once: each item on its own (one that can't go doesn't stop the rest), all their
      // labels printed together, each kid's JobTread lines written once
      const results = [];
      const fresh = [];
      const jobs = new Set();
      body.items.forEach((it, n) => { if (n >= 60) results.push({ tap: it.tap, error: 'More than 60 at once. Check in the rest separately.', status: 400 }); });
      for (const it of body.items.slice(0, 60)) {
        try {
          const r = await receive(env.DB, it, { by });
          jobs.add(r.receipt.job_id);
          results.push({ tap: it.tap, jobId: r.receipt.job_id, shelf: r.shelf, repeat: r.repeat });
          // A retry from the phone (its first answer never came back) prints only what never reached the printer
          if (!r.repeat || !r.receipt.printed_at) fresh.push(r.receipt);
        } catch (err) {
          results.push({ tap: it.tap, error: err.message, status: err.status || 500 });
        }
      }
      const view = await checkinView(env);
      out.results = results;
      if (fresh.length) out.print = await printFor(context, fresh, view);
      // JobTread in the background: the done sheet doesn't wait on it, kid after kid (the heartbeat backs it up)
      const write = (async () => { for (const j of jobs) await writeKidNow(env, j); })();
      if (context.waitUntil) { context.waitUntil(write); out.jt = 'later'; } else { await write; out.jt = 'later'; }
      return Response.json({ success: true, ...out, view: { ...(await checkinView(env)), printer: await printerStatus(env) } }, { headers });
    }
    if (q.get('receive') || q.get('other')) {
      const r = q.get('other') ? await typedIn(env.DB, body, { by }) : await receive(env.DB, body, { by });
      jobId = r.receipt.job_id;
      Object.assign(out, { receipt: r.receipt.id, shelf: r.shelf, repeat: r.repeat });
      // A retry of the same tap prints only if the first one's labels never reached the printer
      if (!r.repeat || !r.receipt.printed_at) print = r.receipt;
    } else if (q.get('out') && Array.isArray(body.items)) {
      // A whole load in one go (Confirm): each box or item on its own, so one that can't go doesn't stop the rest
      const results = await checkOutMany(env.DB, body.items, { by });
      const jobs = new Set(results.filter((x) => x.receipt && !x.repeat).map((x) => x.receipt.job_id));
      out.results = results.map(({ tap, repeat, error, status }) => (error ? { tap, error, status } : { tap, repeat }));
      // JobTread in the background: Confirm answers at once (the heartbeat backs it up)
      const write = (async () => { for (const j of jobs) await writeKidNow(env, j); })();
      if (context.waitUntil) context.waitUntil(write); else await write;
      out.jt = 'later';
    } else if (q.get('out')) {
      const r = await checkOut(env.DB, body, { by });
      jobId = r.receipt.job_id;
      Object.assign(out, { receipt: r.receipt.id, repeat: r.repeat, item: { jobId: r.receipt.job_id, itemId: r.receipt.item_id, partKey: r.receipt.part_key, name: r.receipt.name } });
    } else if (q.get('house')) {
      const r = await receive(env.DB, { ...body, kind: 'house' }, { by });
      jobId = r.receipt.job_id;
      out.receipt = r.receipt.id;
    } else if (q.get('undo') && (Array.isArray(body.taps) || body.tap)) {
      // An undo (a check-in, Take back off the truck: every box of a thing in one go); JobTread in the background.
      // One tap (an older copy of the page) answers as it always did: an error is the answer's own
      const single = !Array.isArray(body.taps);
      const results = await undoMany(env.DB, (single ? [body.tap] : body.taps.slice(0, OUT_BATCH)).map(String), { by });
      if (single && results[0].error) return Response.json({ success: false, error: results[0].error }, { status: results[0].status, headers });
      out.results = results.map(({ tap, shelf, moved, error, status }) => (error ? { tap, error, status } : { tap, shelf, ...(moved ? { moved } : {}) }));
      // A box back from the truck whose shelf is another kid's by now goes on a new one: its label is printed again with it
      const moved = results.filter((x) => x.moved);
      if (moved.length) {
        const view = await checkinView(env);
        const labels = [];
        for (const m of moved) {
          const r = await env.DB.prepare('SELECT * FROM kid_receipts WHERE id = ?').bind(m.ref).first();
          if (r) labels.push(...(m.box ? labelsFor(view, r).slice(m.box - 1, m.box) : labelsFor(view, r)));
        }
        if (labels.length) out.print = await printLabels(env, labels);
      }
      const jobs = new Set(results.filter((x) => !x.error && !x.repeat).map((x) => x.jobId));
      const write = (async () => { for (const j of jobs) await writeKidNow(env, j); })();
      if (context.waitUntil) context.waitUntil(write); else await write;
      out.jt = 'later';
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
    if (print) out.print = await printFor(context, [print], view, { again: Boolean(q.get('reprint')) });
    // JobTread now, for the kid it changed: the answer says whether it's there
    if (jobId) out.jt = await writeKidNow(env, jobId);
    return Response.json({ success: true, ...out, view: { ...(out.jt === 'written' ? await checkinView(env) : view), printer: await printerStatus(env) } }, { headers });
  } catch (err) {
    return fail(err);
  }
}
