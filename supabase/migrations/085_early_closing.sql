-- ============================================================================
-- Migration 085: Early-closing discount refund
-- ============================================================================
-- The discount fee is computed at funding as $0.80 per $1,000 per day from
-- (funding_date + 1) through (closing_date - 1). When a deal closes EARLY
-- — i.e. actual closing happens before scheduled closing_date — the
-- brokerage owes us fewer chargeable days, so we owe the agent a partial
-- refund of the prepaid discount fee.
--
-- Storage:
--   actual_closing_date   — DATE that the deal actually closed (≤ closing_date)
--   discount_refund_amount — NUMERIC(12,2) refund issued to the agent
--
-- Math (kept in lib/calculations.ts, not hardcoded here):
--   days_saved      = closing_date - actual_closing_date
--   refund_per_day  = advance_amount / 1000 * 0.80
--   refund_total    = days_saved * refund_per_day
--
-- These columns are NULLABLE because the vast majority of deals close on
-- their scheduled date. Only populated by the early-closing recompute action.
-- ============================================================================

ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS actual_closing_date DATE,
  ADD COLUMN IF NOT EXISTS discount_refund_amount NUMERIC(12,2);

COMMENT ON COLUMN deals.actual_closing_date IS
  'Date the deal actually closed. Populated only when closing happens before the scheduled closing_date so we can compute a discount refund. NULL means closed-on-schedule (no refund).';

COMMENT ON COLUMN deals.discount_refund_amount IS
  'Refund owed to the agent for early closing. Formula: (closing_date - actual_closing_date) days × ($0.80 per $1000 of advance_amount per day). See lib/calculations.ts.';
