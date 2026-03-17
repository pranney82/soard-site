-- SOARD D1 Database Schema
-- Run: wrangler d1 execute soard-db --file=scripts/schema.sql

-- Kids profiles (187+ rows)
CREATE TABLE IF NOT EXISTS kids (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  year INTEGER,
  status TEXT DEFAULT 'completed',
  featured INTEGER DEFAULT 0,
  child_count INTEGER DEFAULT 1,
  room_count INTEGER DEFAULT 1,
  data TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_kids_year ON kids(year);
CREATE INDEX IF NOT EXISTS idx_kids_featured ON kids(featured);
CREATE INDEX IF NOT EXISTS idx_kids_status ON kids(status);
CREATE INDEX IF NOT EXISTS idx_kids_name ON kids(name);

-- Partners (370+ rows)
CREATE TABLE IF NOT EXISTS partners (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  tier TEXT,
  featured INTEGER DEFAULT 0,
  data TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_partners_tier ON partners(tier);
CREATE INDEX IF NOT EXISTS idx_partners_featured ON partners(featured);
CREATE INDEX IF NOT EXISTS idx_partners_name ON partners(name);

-- Press mentions (89+ rows)
CREATE TABLE IF NOT EXISTS press (
  slug TEXT PRIMARY KEY,
  title TEXT,
  date TEXT,
  category TEXT,
  featured INTEGER DEFAULT 0,
  data TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_press_date ON press(date);
CREATE INDEX IF NOT EXISTS idx_press_category ON press(category);
CREATE INDEX IF NOT EXISTS idx_press_featured ON press(featured);

-- Team members (19 rows)
CREATE TABLE IF NOT EXISTS team (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  "group" TEXT,
  order_num INTEGER DEFAULT 0,
  data TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Events (4+ rows)
CREATE TABLE IF NOT EXISTS events (
  slug TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  date TEXT,
  status TEXT DEFAULT 'upcoming',
  featured INTEGER DEFAULT 0,
  data TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_date ON events(date);
CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);

-- Community projects (6+ rows)
CREATE TABLE IF NOT EXISTS community (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  order_num INTEGER DEFAULT 0,
  data TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Articles (3+ rows)
CREATE TABLE IF NOT EXISTS articles (
  slug TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  featured INTEGER DEFAULT 0,
  order_num INTEGER DEFAULT 0,
  data TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Site config (settings, our-story, faq, media, financials)
CREATE TABLE IF NOT EXISTS site_config (
  key TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Financial documents (PDF metadata — actual files in R2)
CREATE TABLE IF NOT EXISTS financials (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  year INTEGER,
  type TEXT,
  url TEXT NOT NULL,
  source TEXT DEFAULT 'r2',
  file_size TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_financials_year ON financials(year);
CREATE INDEX IF NOT EXISTS idx_financials_type ON financials(type);
