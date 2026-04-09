-- ============================================================================
-- Migration 039: Charges & Fees Overhaul
-- ============================================================================
-- Adds: settlement_period_fee, due_date, per-deal referral %, balance deduction
-- tracking, and payment status to support the new 3-tier fee structure:
--   1. Discount Fee (existing, no change)
--   2. Settlement Period Fee (new: 14 days at same rate, non-refundable)
--   3. Late Payment Interest (new: 24% p.a. after due date)
-- ============================================================================

-- 1. New columns on deals
ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS settlement_period_fee NUMERIC(12,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS due_date DATE,
  ADD COLUMN IF NOT EXISTS brokerage_referral_pct NUMERIC(5,4),
  ADD COLUMN IF NOT EXISTS balance_deducted NUMERIC(12,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'pending'
    CHECK (payment_status IN ('pending', 'paid', 'overdue', 'not_applicable'));

COMMENT ON COLUMN deals.settlement_period_fee IS '14-day settlement period fee ($0.75/$1,000/day × 14). Flat, non-refundable.';
COMMENT ON COLUMN deals.due_date IS 'Brokerage payment due date = closing_date + 14 calendar days';
COMMENT ON COLUMN deals.brokerage_referral_pct IS 'Per-deal referral percentage snapshot (0-1 decimal). Copied from brokerage default at funding, can be overridden.';
COMMENT ON COLUMN deals.balance_deducted IS 'Amount deducted from advance to pay agent outstanding balance';
COMMENT ON COLUMN deals.payment_status IS 'Payment tracking: pending (funded, awaiting payment), paid (completed), overdue (past due_date), not_applicable (denied/cancelled)';

-- 2. Expand agent_transactions type constraint to include new types
ALTER TABLE agent_transactions DROP CONSTRAINT IF EXISTS agent_transactions_type_check;
ALTER TABLE agent_transactions ADD CONSTRAINT agent_transactions_type_check
  CHECK (type IN (
    'late_closing_interest',
    'late_payment_interest',
    'balance_deduction',
    'invoice_payment',
    'adjustment',
    'credit'
  ));

-- 3. Backfill existing deals
-- Funded/completed deals get settlement_period_fee = 0 (no retroactive charges)
UPDATE deals SET settlement_period_fee = 0
  WHERE status IN ('funded', 'completed') AND settlement_period_fee IS NULL;

-- Backfill due_date from closing_date for funded deals
UPDATE deals SET due_date = closing_date + INTERVAL '14 days'
  WHERE status IN ('funded', 'completed') AND due_date IS NULL AND closing_date IS NOT NULL;

-- Snapshot brokerage referral pct from brokerage record
UPDATE deals SET brokerage_referral_pct = (
  SELECT referral_fee_percentage FROM brokerages WHERE brokerages.id = deals.brokerage_id
) WHERE brokerage_referral_pct IS NULL AND brokerage_id IS NOT NULL;

-- Set payment_status for existing deals
UPDATE deals SET payment_status = 'paid' WHERE status = 'completed' AND payment_status = 'pending';
UPDATE deals SET payment_status = 'not_applicable' WHERE status IN ('denied', 'cancelled') AND payment_status = 'pending';

-- Deals that are funded and past due_date → overdue
UPDATE deals SET payment_status = 'overdue'
  WHERE status = 'funded' AND due_date < CURRENT_DATE AND payment_status = 'pending';

-- 4. Performance indexes
CREATE INDEX IF NOT EXISTS idx_deals_due_date_funded ON deals(due_date) WHERE status = 'funded';
CREATE INDEX IF NOT EXISTS idx_deals_payment_status ON deals(payment_status);
CREATE INDEX IF NOT EXISTS idx_deals_funded_pending ON deals(status, payment_status)
  WHERE status = 'funded' AND payment_status IN ('pending', 'overdue');
