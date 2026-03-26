/**
 * GET /api/audit-log
 * Query the server-side audit trail with filtering and pagination.
 *
 * Query params:
 *   limit    — max entries to return (default 50, max 200)
 *   offset   — skip N entries for pagination (default 0)
 *   user     — filter by user email (exact match)
 *   action   — filter by action type (created, updated, deleted, drafted, published)
 *   type     — filter by entity type (kids, partners, team, etc.)
 *   search   — search entity name (LIKE %search%)
 *   from     — ISO date string, entries after this date
 *   to       — ISO date string, entries before this date
 *
 * Env bindings: DB (D1)
 */

export async function onRequestGet(context) {
  try {
    const { DB } = context.env;
    const url = new URL(context.request.url);

    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);
    const user = url.searchParams.get('user');
    const action = url.searchParams.get('action');
    const type = url.searchParams.get('type');
    const search = url.searchParams.get('search');
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');

    const conditions = [];
    const params = [];

    if (user) {
      conditions.push('user_email = ?');
      params.push(user);
    }
    if (action) {
      conditions.push('action = ?');
      params.push(action);
    }
    if (type) {
      conditions.push('entity_type = ?');
      params.push(type);
    }
    if (search) {
      conditions.push('entity_name LIKE ?');
      params.push(`%${search}%`);
    }
    if (from) {
      conditions.push('created_at >= ?');
      params.push(from);
    }
    if (to) {
      conditions.push('created_at <= ?');
      params.push(to);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Get total count for pagination
    const countResult = await DB.prepare(
      `SELECT COUNT(*) as total FROM audit_log ${where}`
    ).bind(...params).first();

    // Get entries
    const entries = await DB.prepare(
      `SELECT id, user_email, action, entity_type, entity_slug, entity_name, changes, path, git_status, created_at
       FROM audit_log ${where}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`
    ).bind(...params, limit, offset).all();

    return Response.json({
      success: true,
      total: countResult?.total || 0,
      limit,
      offset,
      entries: (entries.results || []).map(e => ({
        ...e,
        changes: e.changes ? JSON.parse(e.changes) : null,
      })),
    });
  } catch (err) {
    console.error('[audit-log]', err);
    return Response.json(
      { success: false, error: err.message || 'An unexpected error occurred' },
      { status: 500 }
    );
  }
}
