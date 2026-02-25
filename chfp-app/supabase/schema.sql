-- ============================================================
-- CHFP Softening Project — Supabase Schema
-- Run this in the Supabase SQL Editor (Dashboard > SQL Editor)
-- ============================================================

-- Samples table: one row per sampling day
CREATE TABLE samples (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sample_date DATE NOT NULL UNIQUE,
  analyst TEXT DEFAULT '',
  sample_time TEXT DEFAULT '',
  values JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast date lookups and ordering
CREATE INDEX idx_samples_date ON samples (sample_date DESC);

-- Auto-update the updated_at timestamp
CREATE OR REPLACE FUNCTION update_modified_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON samples
  FOR EACH ROW
  EXECUTE FUNCTION update_modified_column();

-- Enable Row Level Security (required by Supabase)
ALTER TABLE samples ENABLE ROW LEVEL SECURITY;

-- Allow all operations via the anon key (the app password gate handles access)
CREATE POLICY "Allow all access" ON samples
  FOR ALL
  USING (true)
  WITH CHECK (true);
