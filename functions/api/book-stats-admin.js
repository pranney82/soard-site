/**
 * GET /api/book-stats-admin?days=30&version=<the saved upload> (Cloudflare
 * Access) — the anniversary book's readers for Admin → Site Config →
 * Anniversary book: visits, readers, time, how far people read, each page,
 * downloads, shares, links followed, devices, where readers came from.
 * days=0 is everything. See _book-stats.js readStats.
 *
 * Env bindings: DB (D1)
 */
import { readStats } from './_book-stats.js';

export async function onRequestGet(context) {
  try {
    const url = new URL(context.request.url);
    const days = Math.min(3650, Math.max(0, Number(url.searchParams.get('days') ?? 30) || 0));
    const v = url.searchParams.get('version') || '';
    const stats = await readStats(context.env.DB, { days, version: /^[a-z0-9]{4,20}$/.test(v) ? v : null });
    return Response.json({ success: true, ...stats }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    console.error('[book-stats-admin]', err);
    return Response.json({ success: false, error: 'Couldn’t read the book’s numbers. Try again.' }, { status: 500 });
  }
}
