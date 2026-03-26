-- Migration: Add composite index on (action, created_at) for pending-changes query
-- The "last deployed" lookup and "changes since deploy" filter both hit action + created_at.
-- Run: wrangler d1 execute soard-db --file=scripts/migrate-audit-action-index.sql

CREATE INDEX IF NOT EXISTS idx_audit_action_ts ON audit_log(action, created_at);
