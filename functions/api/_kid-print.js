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

import { readState, writeState } from './_kid-record.js';
import { PRINTER_ROOTS } from './_printer-roots.js';
import { SITE } from './_kid-labels.js';

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
