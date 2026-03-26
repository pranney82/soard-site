-- Migration: Add audit_log table
-- Run: wrangler d1 execute soard-db --file=scripts/migrate-audit-log.sql

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_email TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_slug TEXT,
  entity_name TEXT,
  changes TEXT,
  path TEXT,
  git_status TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_email);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_slug);
