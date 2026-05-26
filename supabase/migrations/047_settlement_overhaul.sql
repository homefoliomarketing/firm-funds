-- =============================================================================
-- Migration 047: Settlement period overhaul (7 days standard, 5-strike auto-bump)
-- =============================================================================
-- Bud's 2026-05-24 pricing/settlement restructure:
--   1. Standard settlement window drops from 14 -> 7 days
--   2. Brokerages that miss the 7-day deadline 5 times auto-bump to 14 days
--      (admin can manually reset the strikes back to 0)
--   3. Late-payment interest moves from 14-day-due to 30-day-from-closing grace
--      (no schema change for that; pure code change)
--
-- This migration adds:
--   - brokerages.late_strike_count                  — running count of 7-day misses
--   - brokerages.auto_bumped_to_14_days_at          — non-null = bumped to 14
--   - brokerages.last_strike_reset_at               — last admin reset timestamp
--   - brokerages.settlement_days_override           — optional manual override
--   - deals.settlement_days_at_funding              — snapshot of the brokerage's
--     effective window when the deal was funded (so strike counting + late
--     status are stable even if the brokerage's effective days change later)
--   - deals.late_strike_recorded                    — bool, makes strike counting
--     idempotent per deal (max one strike per deal)
-- =============================================================================

ALTER TABLE brokerages
  ADD COLUMN IF NOT EXISTS late_strike_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS auto_bumped_to_14_days_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_strike_reset_at timestamptz,
  ADD COLUMN IF NOT EXISTS settlement_days_override integer;

COMMENT ON COLUMN brokerages.late_strike_count IS
  'Running count of times this brokerage missed the standard 7-day settlement deadline. Resets only when an admin clears it.';
COMMENT ON COLUMN brokerages.auto_bumped_to_14_days_at IS
  'Timestamp when this brokerage auto-bumped to 14-day settlement (after hitting BROKERAGE_LATE_STRIKE_THRESHOLD strikes). Non-null = bumped.';
COMMENT ON COLUMN brokerages.last_strike_reset_at IS
  'Last time an admin manually reset late_strike_count and/or cleared auto_bumped_to_14_days_at.';
COMMENT ON COLUMN brokerages.settlement_days_override IS
  'Optional admin override of the brokerage''s settlement window (in days). Takes precedence over the auto-bump logic.';

ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS settlement_days_at_funding integer,
  ADD COLUMN IF NOT EXISTS late_strike_recorded boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN deals.settlement_days_at_funding IS
  'The brokerage''s effective settlement window (in days) snapshotted when this deal was funded. Stable for the life of the deal even if the brokerage''s effective days later change.';
COMMENT ON COLUMN deals.late_strike_recorded IS
  'True once the brokerage has been recorded as missing the settlement window for this deal. Prevents double-counting if a payment is recorded more than once.';
