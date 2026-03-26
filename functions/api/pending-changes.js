/**
 * GET /api/pending-changes
 * Returns audit log entries since the last successful production deploy,
 * deduplicated by entity. Each entity appears once with its most recent
 * action, plus an edit count and list of contributors.
 *
 * Checks both the CF Pages API and the audit log 'deployed' row for the
 * last deploy time, and uses whichever is more recent. This means pending
 * changes clear regardless of how the deploy was triggered (admin panel,
 * CLI, git push, etc.).
 *
 * Env bindings: DB (D1), CF_ACCOUNT_ID (optional), CF_PAGES_TOKEN (optional)
 */

const CF_PROJECT = 'soard-site';

/**
 * Normalize a timestamp to SQLite datetime format (YYYY-MM-DD HH:MM:SS)
 * so SQL string comparisons with audit_log.created_at work correctly.
 */
function toSqliteTimestamp(dateStr) {
  return new Date(dateStr).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

/**
 * Fetch the latest successful production deploy from CF Pages.
 * Returns { at, by } or null.
 */
async function fetchCfDeploy(env) {
  const { CF_ACCOUNT_ID, CF_PAGES_TOKEN } = env;
  if (!CF_ACCOUNT_ID || !CF_PAGES_TOKEN) return null;

  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/pages/projects/${CF_PROJECT}/deployments?per_page=20`,
    {
      headers: {
        'Authorization': `Bearer ${CF_PAGES_TOKEN}`,
        'Content-Type': 'application/json',
      },
    }
  );
  if (!res.ok) return null;

  const data = await res.json();
  if (!data.success || !data.result) return null;

  const deploy = data.result.find(
    d => d.environment === 'production' && d.latest_stage?.status === 'success'
  );
  if (!deploy) return null;

  const commitHash = deploy.deployment_trigger?.metadata?.commit_hash || null;
  return {
    at: toSqliteTimestamp(deploy.created_on),
    by: commitHash ? commitHash.slice(0, 7) : null,
  };
}

/**
 * Fetch the latest 'deployed' audit log row.
 * Returns { at, by } or null.
 */
async function fetchAuditDeploy(DB) {
  const result = await DB.prepare(
    `SELECT user_email, created_at FROM audit_log
     WHERE action = 'deployed' ORDER BY created_at DESC LIMIT 1`
  ).all();
  const row = result.results?.[0];
  if (!row) return null;
  return { at: row.created_at, by: row.user_email };
}

export async function onRequestGet(context) {
  try {
    const { DB } = context.env;

    // Fetch both sources in parallel — CF API + D1 audit log
    const [cfResult, auditResult] = await Promise.all([
      fetchCfDeploy(context.env).catch(e => {
        console.error('[pending-changes] CF Pages API error:', e.message);
        return null;
      }),
      fetchAuditDeploy(DB),
    ]);

    // Use whichever deploy is more recent.
    // The audit log row is written instantly on admin "Deploy Now";
    // the CF Pages entry only appears after the build succeeds.
    // Comparing both means admin deploys clear pending changes immediately,
    // while CLI/git-push deploys clear once the build finishes.
    let lastDeploy = null;
    if (cfResult && auditResult) {
      lastDeploy = cfResult.at > auditResult.at ? cfResult : auditResult;
    } else {
      lastDeploy = cfResult || auditResult;
    }

    const since = lastDeploy?.at || '1970-01-01 00:00:00';

    // Get audit log entries since the last deploy
    const changesResult = await DB.prepare(
      `SELECT user_email, action, entity_type, entity_slug, entity_name, created_at
       FROM audit_log
       WHERE action != 'deployed'
         AND created_at > ?
       ORDER BY created_at DESC
       LIMIT 200`
    ).bind(since).all();

    const rows = changesResult.results || [];

    // Deduplicate by entity (type + slug). Keep the most recent action per entity.
    const entityMap = new Map();
    for (const e of rows) {
      const key = `${e.entity_type}::${e.entity_slug}`;
      if (!entityMap.has(key)) {
        entityMap.set(key, {
          action: e.action,
          type: e.entity_type,
          slug: e.entity_slug,
          name: e.entity_name,
          at: e.created_at,
          edits: 1,
          users: new Set([e.user_email]),
        });
      } else {
        const existing = entityMap.get(key);
        existing.edits++;
        if (e.user_email) existing.users.add(e.user_email);
      }
    }

    const changes = Array.from(entityMap.values()).map(c => ({
      action: c.action,
      type: c.type,
      slug: c.slug,
      name: c.name,
      at: c.at,
      edits: c.edits,
      users: Array.from(c.users).filter(Boolean),
    }));

    return Response.json({
      success: true,
      since: lastDeploy?.at || null,
      lastDeployBy: lastDeploy?.by || null,
      lastDeployAt: lastDeploy?.at || null,
      totalEdits: rows.length,
      changes,
    });
  } catch (err) {
    console.error('[pending-changes]', err);
    return Response.json(
      { success: false, error: err.message || 'An unexpected error occurred' },
      { status: 500 }
    );
  }
}
