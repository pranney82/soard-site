-- D1 Migration: partners tier → level + category
-- Run: wrangler d1 execute soard-db --file=scripts/migrate-d1-partner-levels.sql
--
-- Adds level and category columns, backfills from existing tier + data blob,
-- then drops the old tier column (SQLite requires table rebuild for DROP COLUMN).

-- Step 1: Add new columns
ALTER TABLE partners ADD COLUMN level TEXT;
ALTER TABLE partners ADD COLUMN category TEXT;

-- Step 2: Backfill category from old tier
UPDATE partners SET category = CASE
  WHEN tier = 'construction' THEN 'build'
  WHEN tier = 'design' THEN 'design'
  WHEN tier = 'community' THEN 'community'
  WHEN tier = 'top' THEN 'build'
  ELSE 'build'
END;

-- Step 3: Backfill level from data blob (JSON extract)
-- Partners with featured=1 get 'champion', rest get 'friend'
-- (The JSON files are the source of truth for champion/builder —
--  next deploy will sync D1 from the committed JSON files)
UPDATE partners SET level = CASE
  WHEN featured = 1 THEN 'champion'
  ELSE 'friend'
END;

-- Step 4: Create indexes for new columns
CREATE INDEX IF NOT EXISTS idx_partners_level ON partners(level);
CREATE INDEX IF NOT EXISTS idx_partners_category ON partners(category);

-- Step 5: Drop old tier index (column stays until next table rebuild — harmless)
DROP INDEX IF EXISTS idx_partners_tier;
