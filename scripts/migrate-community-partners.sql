-- Add community_partners table
-- Run: wrangler d1 execute soard-db --file=scripts/migrate-community-partners.sql --remote

CREATE TABLE IF NOT EXISTS community_partners (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT,
  featured INTEGER DEFAULT 0,
  order_num INTEGER DEFAULT 0,
  data TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_community_partners_name ON community_partners(name);
CREATE INDEX IF NOT EXISTS idx_community_partners_category ON community_partners(category);
CREATE INDEX IF NOT EXISTS idx_community_partners_featured ON community_partners(featured);

