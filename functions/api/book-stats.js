/**
 * POST /api/book-stats — the anniversary book's reader says what was read
 * ========================================================================
 * Sent with navigator.sendBeacon by src/components/book/flipbook.js every
 * half minute while someone reads, and when they leave. Added to daily
 * counters (_book-stats.js); nothing about the person is kept.
 *
 * Public, rate limited by the middleware (a gala's shared Wi-Fi gets room for
 * a crowd). Always 204: counting must never put an error on a reader's page.
 *
 * Env bindings: DB (D1)
 */
import { statsRows, recordStats } from './_book-stats.js';

const MAX_BODY = 8 * 1024;

export async function onRequestPost(context) {
  try {
    const text = await context.request.text();
    if (text.length <= MAX_BODY) {
      const body = JSON.parse(text);
      const rows = statsRows(body);
      if (rows?.length && context.env.DB) await recordStats(context.env.DB, body.v, rows);
    }
  } catch {
    // A lost count isn't worth an error on the reader's page
  }
  return new Response(null, { status: 204 });
}
