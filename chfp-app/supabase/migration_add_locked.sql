-- ============================================================
-- MIGRATION: Add 'locked' column to existing samples table
-- Run this in the Supabase SQL Editor BEFORE deploying the new code
-- ============================================================

ALTER TABLE samples ADD COLUMN IF NOT EXISTS locked BOOLEAN NOT NULL DEFAULT false;
