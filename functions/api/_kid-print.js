/**
 * Kid items: printing labels on the Office's Zebra from the check-in page, with one tap
 * ===========================================================================
 * The printer keeps a socket open to the site (Zebra Cloud Connect): it signs in to
 * /api/printer-ws/ with the user "soard" and the printer's own password (kept in
 * kid_items_state 'printer', made here the first time), and the socket is held by
 * the PrintHub Durable Object (workers/live-hub/src/print-hub.js, bound as
 * PRINT_HUB). A check-in's labels go straight to it. The setup file
 * (printerSetup) is sent to the printer once from Zebra's Printer Setup Utility
 * app: where to connect, its password, the clock, and the root certificates it
 * needs to trust the site.
 */

import { readState, writeState, claimPrint, releasePrint, ensureRecord, shelfName } from './_kid-record.js';
import { PRINTER_ROOTS } from './_printer-roots.js';
import { SITE, receiptLabels } from './_kid-labels.js';

export const PRINTER_USER = 'soard';
export const PRINTER_URL = `${SITE}/api/printer-ws/`;

/** The printer's password, made once (long and random; only the printer and the admin see it) */
export async function printerToken(DB) {
  const st = await readState(DB, 'printer');
  if (st.token) return st.token;
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const token = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  await writeState(DB, 'printer', { ...st, token, madeAt: new Date().toISOString() });
  return (await readState(DB, 'printer')).token;
}

/** Equal without saying where they differ */
export function sameSecret(a, b) {
  const x = String(a || ''), y = String(b || '');
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  return d === 0 && x.length > 0;
}

/** The printer's sign-in on its socket: Basic, user soard and its password (never in the URL, where logs keep it) */
export async function printerAllowed(request, DB) {
  const st = await readState(DB, 'printer');
  if (!st.token) return false;
  const m = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(request.headers.get('Authorization') || '');
  if (!m) return false;
  let pair = '';
  try { pair = atob(m[1]); } catch { return false; }
  const at = pair.indexOf(':');
  return at > 0 && pair.slice(0, at) === PRINTER_USER && sameSecret(pair.slice(at + 1), st.token);
}

/**
 * The file to send to the printer once, from Printer Setup Utility (Files): Zebra SGD commands, then the
 * root certificates as WEBLINK1_CA.NRD (CISDFCRC16 with the CRC and checksum skipped), then a restart
 */
export async function printerSetup(DB) {
  const token = await printerToken(DB);
  const host = new URL(SITE).host;
  const pem = PRINTER_ROOTS.replace(/\r?\n/g, '\n');
  const size = new TextEncoder().encode(pem).length.toString(16).toUpperCase().padStart(8, '0');
  const set = (k, v) => `! U1 setvar "${k}" "${v}"\r\n`;
  return [
    set('ip.ntp.enable', 'on'),
    set('ip.ntp.servers', 'time.cloudflare.com'),
    set('weblink.logging.max_entries', '100'),
    set('weblink.ip.conn1.location', PRINTER_URL),
    set('weblink.ip.conn1.authentication.add', `${host} ${PRINTER_USER} ${token}`),
    set('weblink.ip.conn1.retry_interval', '10'),
    `! CISDFCRC16\r\n0000\r\nWEBLINK1_CA.NRD\r\n${size}\r\n0000\r\n${pem}`,
    '\r\n! U1 do "device.reset" ""\r\n',
  ].join('');
}

const hub = (env) => env.PRINT_HUB?.get(env.PRINT_HUB.idFromName('office')) || null;

/** Send labels to the printer → { printed, queued, online, setUp, problems } (never throws) */
export async function printLabels(env, labels) {
  const stub = hub(env);
  if (!stub) return { printed: 0, online: false, setUp: false, problems: [] };
  try {
    const res = await stub.fetch('https://hub/print', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ labels }) });
    const r = await res.json();
    return { printed: r.sent || 0, queued: r.queued || 0, online: Boolean(r.online), setUp: true, problems: r.problems || [] };
  } catch (err) {
    console.error('[kid-print]', err.message);
    return { printed: 0, online: false, setUp: true, problems: [], error: 'The site couldn’t reach the printer.' };
  }
}

/** The printer now → { setUp, online, seenAt, problems, waiting } */
export async function printerStatus(env) {
  const stub = hub(env);
  if (!stub) return { bound: false, setUp: false, online: false, problems: [] };
  try {
    const s = await (await stub.fetch('https://hub/status')).json();
    return { bound: true, setUp: Boolean(s.seenAt), online: Boolean(s.online), seenAt: s.seenAt ? new Date(s.seenAt).toISOString() : null, printedAt: s.printedAt ? new Date(s.printedAt).toISOString() : null, problems: s.problems || [], waiting: s.waiting || 0 };
  } catch {
    return { bound: true, setUp: false, online: false, problems: [] };
  }
}

// ─── Check-ins' labels: each printed once, none lost ───────────────────

// The hub takes this many labels a request
const PART = 40;
// While the printer is off, check-ins' labels wait on the site; once it's back they print, if they're this recent
export const PRINT_WAIT_MS = 2 * 60 * 60 * 1000;

/** A check-in's labels, one a box (kid: the kid's short name) */
export const labelsOf = (kid, r, set = null) => receiptLabels({ kid: kid || 'SOARD', item: r.name, line: r.line_name, set, boxes: r.boxes, shelf: r.shelf ? shelfName(r.shelf) : '', at: r.at, tap: r.id });

/** Each check-in's boxes on the truck, from a view (its load-out receipts): Map(check-in id → 'all' | Set of box numbers) */
export function loadedBoxes(view) {
  const m = new Map();
  for (const k of view?.kids || []) for (const i of k.items || []) for (const x of i.receipts || []) {
    if (x.kind !== 'out' || x.undone || !x.ref || m.get(x.ref) === 'all') continue;
    m.set(x.ref, x.box ? new Set([...(m.get(x.ref) || []), Number(x.box)]) : 'all');
  }
  return m;
}
/** A check-in's labels for its boxes still at the Office: a box on the truck keeps the label it has */
export const officeLabels = (labels, loaded) => (loaded === 'all' ? [] : loaded ? labels.filter((_, n) => !loaded.has(n + 1)) : labels);

/**
 * Check-ins' labels to the printer, each check-in printed once. Each is claimed first (./_kid-record.js claimPrint), so
 * a retry overlapping the first try prints nothing twice; a claim whose labels the printer didn't take is let go. They
 * go in parts the hub takes at once (40). The printer off: nothing is sent (the hub would hold only 60, for two hours,
 * and drop the rest without a word): they wait here as check-ins not printed yet, and print when it's back on
 * (maybePrintWaiting, on the heartbeat). again: Print again (prints what was printed before).
 * labelsFor(receipt) → its labels. → { printed, queued (waiting for the printer), online, setUp, problems, error? }
 */
export async function printReceipts(env, receipts, labelsFor, { again = false, now = new Date().toISOString() } = {}) {
  const labelsOfR = new Map(receipts.map((r) => [r.id, labelsFor(r)]));
  const some = receipts.filter((r) => labelsOfR.get(r.id).length);
  // Nothing to print (every box of them on the truck): said so, and the printer isn't asked
  if (!some.length) {
    if (!again && receipts.length) await claimPrint(env.DB, receipts.map((r) => r.id), now);
    return { printed: 0, none: true, online: true, setUp: Boolean(hub(env)), problems: [] };
  }
  if (!hub(env)) return { printed: 0, online: false, setUp: false, problems: [] };
  const status = await printerStatus(env);
  if (!status.online) return { printed: 0, queued: some.reduce((t, r) => t + labelsOfR.get(r.id).length, 0), online: false, setUp: status.setUp, problems: status.problems };
  const ids = new Set(again ? receipts.map((r) => r.id) : await claimPrint(env.DB, receipts.map((r) => r.id), now));
  const mine = some.filter((r) => ids.has(r.id));
  const parts = [];
  for (const r of mine) {
    const last = parts[parts.length - 1];
    const ls = labelsOfR.get(r.id);
    if (last && last.labels.length + ls.length <= PART) { last.receipts.push(r); last.labels.push(...ls); } else parts.push({ receipts: [r], labels: [...ls] });
  }
  let printed = 0, queued = 0, problems = status.problems, error = null;
  for (let i = 0; i < parts.length; i++) {
    const p = await printLabels(env, parts[i].labels);
    problems = p.problems || problems;
    if (p.error || (p.printed || 0) + (p.queued || 0) < parts[i].labels.length) {
      // Not taken: this part and the rest aren't printed after all
      error = p.error || 'The printer didn’t take every label';
      if (!again) await releasePrint(env.DB, parts.slice(i).flatMap((x) => x.receipts.map((r) => r.id)), now);
      break;
    }
    printed += p.printed || 0;
    // The printer went off between the check and the send: the hub holds these few until it's back
    queued += p.queued || 0;
  }
  return { printed, queued, online: true, setUp: true, problems, ...(error ? { error } : {}) };
}

/** On the heartbeat: check-ins from the last two hours whose labels never printed, printed once the printer is on. Never throws */
export async function maybePrintWaiting(env, { now = Date.now() } = {}) {
  if (!env?.DB || !hub(env)) return null;
  try {
    await ensureRecord(env.DB);
    const rows = (await env.DB.prepare("SELECT * FROM kid_receipts WHERE kind = 'receive' AND undone_at IS NULL AND printed_at IS NULL AND at > ? ORDER BY at LIMIT 200")
      .bind(new Date(now - PRINT_WAIT_MS).toISOString()).all()).results || [];
    if (!rows.length || !(await printerStatus(env)).online) return null;
    const { checkinView } = await import('./_kid-checkin.js');
    const view = await checkinView(env, { photos: false });
    const short = new Map(view.kids.map((k) => [k.jobId, k.short]));
    // A part of a set says which part (as the labels printed at check-in do)
    const setOf = new Map(view.kids.flatMap((k) => k.items.flatMap((i) => (i.receipts || []).map((x) => [x.id, i.set || null]))));
    // Only its boxes still at the Office (a check-in moved after some boxes were loaded)
    const loaded = loadedBoxes(view);
    return await printReceipts(env, rows, (r) => officeLabels(labelsOf(short.get(r.job_id), r, setOf.get(r.id) || null), loaded.get(r.id)));
  } catch (err) {
    console.error('[kid-print] waiting labels', err.message);
    return null;
  }
}
