/**
 * GET /api/pending-changes
 * What's saved in the admin but not on the live site yet, and where the
 * site update that will carry it stands.
 *
 * Saves only write D1; the site changes when a build reads D1 (Publish in
 * the admin, a git push, or an automation's deploy). So a change is live only
 * once a production build that started after it has succeeded. With the CF
 * Pages API available:
 *   - live: the newest successful production build (changes saved before it
 *     started are on the site)
 *   - active: a newer build still running; changes saved before it started
 *     are "publishing", later ones "waiting"
 *   - failed: the newest build failed, so nothing newer went live
 * Without the API it falls back to the audit log's last 'deployed' row and
 * can't see builds (publish.tracking = false).
 *
 * Changes are deduplicated by entity: each appears once with its most recent
 * action, an edit count and its contributors. Activity that never needs a
 * rebuild (live banner, emails, viewer messages, Stream uploads, invite
 * settings) is left out.
 *
 * Env bindings: DB (D1), CF_ACCOUNT_ID + CF_PAGES_TOKEN (optional), a deploy hook (see flush-deploy.js)
 */

const CF_PROJECT = 'soard-site';
const HOOK_ENV_VARS = ['CF_PAGES_DEPLOY_HOOK', 'CF_DEPLOY_HOOK', 'DEPLOY_HOOK_URL'];

// Read at runtime from D1 by Functions, or not site content at all
export const RUNTIME_TYPES = ['live-status', 'email-broadcast', 'newsletter', 'instagram-reel',
  'live-input', 'live-message', 'stream-video', 'site-config',
  // The admin's list of board committees to pick from (records carry the names)
  'board-committees',
  // Admin → Partners: logos on kid pages marked as not a partner (the admin's own note)
  'partner-logo-dismissed',
  // Admin → Applications → Settings: the form and the Apply page read open/closed live
  'application-settings',
  // Admin → People → Applications: Advisory Board applications and who hears about them (D1 only)
  'advisory-settings', 'advisory-application',
  // Admin → Partners → Waiting for a logo: "No logo needed" and who's emailed (D1 only)
  'partner-logos'];

/** Normalize a timestamp to SQLite datetime format (YYYY-MM-DD HH:MM:SS) to compare with audit_log.created_at */
export function toSqliteTimestamp(dateStr) {
  return new Date(dateStr).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

/** audit_log.created_at (UTC, no zone) → ISO */
const sqlToIso = (s) => (s ? `${String(s).replace(' ', 'T')}Z` : null);

async function fetchCfDeploys(env) {
  const { CF_ACCOUNT_ID, CF_PAGES_TOKEN } = env;
  if (!CF_ACCOUNT_ID || !CF_PAGES_TOKEN) return null;
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/pages/projects/${CF_PROJECT}/deployments?per_page=25&env=production`,
    { headers: { Authorization: `Bearer ${CF_PAGES_TOKEN}`, 'Content-Type': 'application/json' } },
  );
  if (!res.ok) return null;
  const data = await res.json();
  return data.success && Array.isArray(data.result) ? data.result : null;
}

const isLiveDeploy = (d) => d.latest_stage?.name === 'deploy' && d.latest_stage?.status === 'success';
const isFailed = (d) => ['failure', 'canceled'].includes(d.latest_stage?.status);

/**
 * CF Pages production deployments (any order) → the publishing picture:
 * { live, active, failed, typicalSeconds }. Each build is
 * { id, at (ISO, when it was created), stage, stageStatus, endedAt, url }.
 */
export function summarizeDeploys(results) {
  const prod = (results || [])
    .filter((d) => (d.environment || 'production') === 'production')
    .sort((a, b) => Date.parse(b.created_on) - Date.parse(a.created_on));
  const view = (d) => (d ? {
    id: d.id,
    at: new Date(d.created_on).toISOString(),
    stage: d.latest_stage?.name || null,
    stageStatus: d.latest_stage?.status || null,
    endedAt: d.latest_stage?.ended_on || null,
    url: d.url || null,
    commitMessage: d.deployment_trigger?.metadata?.commit_message || null,
  } : null);
  const liveIdx = prod.findIndex(isLiveDeploy);
  const newer = liveIdx === -1 ? prod : prod.slice(0, liveIdx);
  const active = newer.find((d) => !isFailed(d) && !isLiveDeploy(d));
  // A failure only matters when it's the newest word: a build running after it may still carry everything
  const failed = newer[0] && isFailed(newer[0]) ? newer[0] : null;
  const durations = prod.filter(isLiveDeploy).slice(0, 10)
    .map((d) => (Date.parse(d.latest_stage.ended_on) - Date.parse(d.created_on)) / 1000)
    .filter((s) => s > 0 && s < 3600)
    .sort((a, b) => a - b);
  return {
    live: view(prod[liveIdx]),
    active: view(active),
    failed: view(failed),
    typicalSeconds: durations.length ? Math.round(durations[Math.floor(durations.length / 2)]) : null,
  };
}

/**
 * Audit rows (newest first) → one entry per entity with its publishing state:
 * 'publishing' when a running build started after it was saved, else 'waiting'.
 */
export function summarizeChanges(rows, activeAt) {
  const map = new Map();
  for (const e of rows) {
    const key = `${e.entity_type}::${e.entity_slug}`;
    const at = sqlToIso(e.created_at);
    if (!map.has(key)) {
      map.set(key, { action: e.action, type: e.entity_type, slug: e.entity_slug, name: e.entity_name, at, edits: 1, users: new Set([e.user_email]) });
    } else {
      const c = map.get(key);
      c.edits++;
      if (e.user_email) c.users.add(e.user_email);
    }
  }
  return [...map.values()].map((c) => ({
    ...c,
    users: [...c.users].filter(Boolean),
    state: activeAt && Date.parse(c.at) <= Date.parse(activeAt) ? 'publishing' : 'waiting',
  }));
}

export async function onRequestGet(context) {
  try {
    const { DB } = context.env;
    const [cfResults, auditDeploy] = await Promise.all([
      fetchCfDeploys(context.env).catch((e) => {
        console.error('[pending-changes] CF Pages API error:', e.message);
        return null;
      }),
      DB.prepare(`SELECT user_email, created_at FROM audit_log WHERE action = 'deployed' ORDER BY created_at DESC LIMIT 1`).first(),
    ]);

    const tracking = !!cfResults;
    const deploys = tracking ? summarizeDeploys(cfResults) : { live: null, active: null, failed: null, typicalSeconds: null };
    // Without build tracking, the last Publish click is the best guess at what's live
    const since = tracking
      ? (deploys.live ? toSqliteTimestamp(deploys.live.at) : '1970-01-01 00:00:00')
      : (auditDeploy?.created_at || '1970-01-01 00:00:00');

    const placeholders = RUNTIME_TYPES.map(() => '?').join(', ');
    const rows = (await DB.prepare(
      `SELECT user_email, action, entity_type, entity_slug, entity_name, created_at
       FROM audit_log
       WHERE action != 'deployed'
         AND entity_type NOT IN (${placeholders})
         AND created_at > ?
       ORDER BY created_at DESC
       LIMIT 200`
    ).bind(...RUNTIME_TYPES, since).all()).results || [];

    const changes = summarizeChanges(rows, deploys.active?.at);
    // Who pressed Publish for the builds shown (the newest click before each started, within 15 min)
    const byFor = (build) => {
      if (!build || !auditDeploy) return null;
      const gap = Date.parse(build.at) - Date.parse(sqlToIso(auditDeploy.created_at));
      return gap >= -60e3 && gap < 15 * 60e3 ? auditDeploy.user_email : null;
    };

    return Response.json({
      success: true,
      since: sqlToIso(since),
      lastDeployBy: tracking ? byFor(deploys.live) : auditDeploy?.user_email || null,
      lastDeployAt: tracking ? deploys.live?.at || null : sqlToIso(auditDeploy?.created_at),
      totalEdits: rows.length,
      changes,
      publish: {
        tracking,
        hook: HOOK_ENV_VARS.some((k) => context.env[k]),
        live: deploys.live,
        active: deploys.active && { ...deploys.active, by: byFor(deploys.active) },
        failed: deploys.failed,
        typicalSeconds: deploys.typicalSeconds,
      },
    }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    console.error('[pending-changes]', err);
    return Response.json(
      { success: false, error: err.message || 'An unexpected error occurred' },
      { status: 500 },
    );
  }
}
