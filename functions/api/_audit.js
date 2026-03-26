/**
 * Audit Log Helper
 * ================
 * Logs every mutation (create, update, delete) to the audit_log table in D1.
 * Each entry records: who, what action, which entity, field-level diffs, and git status.
 *
 * Usage:
 *   import { logAudit, diffJson } from './_audit.js';
 *   await logAudit(DB, { userEmail, action, entityType, entitySlug, entityName, changes, path, gitStatus });
 */

/**
 * Compute field-level diffs between two JSON objects.
 * Returns an array of { field, from, to } for changed top-level fields.
 * Skips noisy internal fields. Deep-compares via JSON.stringify.
 */
export function diffJson(oldObj, newObj) {
  if (!oldObj || !newObj) return null;

  const diffs = [];
  const allKeys = new Set([...Object.keys(oldObj), ...Object.keys(newObj)]);

  for (const key of allKeys) {
    const oldVal = oldObj[key];
    const newVal = newObj[key];

    // Compare by serialized value to handle arrays/objects
    const oldStr = JSON.stringify(oldVal) ?? 'undefined';
    const newStr = JSON.stringify(newVal) ?? 'undefined';

    if (oldStr !== newStr) {
      diffs.push({
        field: key,
        from: summarizeValue(oldVal),
        to: summarizeValue(newVal),
      });
    }
  }

  return diffs.length > 0 ? diffs : null;
}

/**
 * Summarize a value for the audit log.
 * Truncates long strings/arrays so the log stays readable.
 */
function summarizeValue(val) {
  if (val === undefined) return null;
  if (val === null) return null;
  if (typeof val === 'string') {
    // Strip HTML tags for readability
    const stripped = val.replace(/<[^>]+>/g, '').trim();
    return stripped.length > 120 ? stripped.slice(0, 120) + '…' : stripped;
  }
  if (Array.isArray(val)) {
    return `[${val.length} items]`;
  }
  if (typeof val === 'object') {
    return '{…}';
  }
  return val;
}

/**
 * Insert an audit log entry into D1.
 */
export async function logAudit(DB, entry) {
  try {
    await DB.prepare(
      `INSERT INTO audit_log (user_email, action, entity_type, entity_slug, entity_name, changes, path, git_status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
    ).bind(
      entry.userEmail || 'unknown',
      entry.action,
      entry.entityType,
      entry.entitySlug || null,
      entry.entityName || null,
      entry.changes ? JSON.stringify(entry.changes) : null,
      entry.path || null,
      entry.gitStatus || null,
    ).run();
  } catch (err) {
    // Audit logging should never break the main operation
    console.error('[audit] Failed to log:', err.message);
  }
}

/**
 * Resolve a human-readable entity name from parsed data.
 */
export function getEntityName(data, entityType) {
  if (!data) return null;
  if (data.name) return data.name;
  if (data.title) return data.title;
  return null;
}
