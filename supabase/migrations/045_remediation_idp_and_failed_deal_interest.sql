-- Migration 045: Remediation IDP + 24%/yr failed-deal interest accrual
--
-- Completes the mandatory cure-election feature shipped in migration 044.
-- Two pieces:
--   1. Support the Remediation IDP document (CPA 5.6, BCA 3.5) — agent assigns
--      a future commission to satisfy an outstanding failed-deal balance.
--   2. Daily 24% p.a. interest accrual on unpaid failed-deal balances starting
--      on the 31st day after the demand notice (CPA 5.3).

-- ----------------------------------------------------------------------------
-- 1. Remediation IDP — extend esignature_envelopes
-- ----------------------------------------------------------------------------

ALTER TABLE esignature_envelopes DROP CONSTRAINT IF EXISTS esignature_envelopes_document_type_check;
ALTER TABLE esignature_envelopes ADD CONSTRAINT esignature_envelopes_document_type_check
  CHECK (document_type IN ('cpa', 'idp', 'bca', 'remediation_idp'));

-- For a remediation_idp envelope:
--   deal_id      = the funded "source" deal whose commission is being assigned
--   cures_deal_id = the failed_to_close deal whose outstanding balance this clears
-- For all other document types this column is NULL.
ALTER TABLE esignature_envelopes
  ADD COLUMN IF NOT EXISTS cures_deal_id UUID REFERENCES deals(id) ON DELETE SET NULL;

COMMENT ON COLUMN esignature_envelopes.cures_deal_id IS
  'For remediation_idp envelopes: the failed-to-close deal whose outstanding balance this Remediation IDP satisfies. NULL for cpa/idp/bca.';

CREATE INDEX IF NOT EXISTS idx_esignature_envelopes_cures_deal
  ON esignature_envelopes (cures_deal_id)
  WHERE cures_deal_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 2. Failed-deal interest — extend agent_transactions + deals
-- ----------------------------------------------------------------------------

-- Add 'failed_deal_interest' to the transaction type CHECK constraint.
ALTER TABLE agent_transactions DROP CONSTRAINT IF EXISTS agent_transactions_type_check;
ALTER TABLE agent_transactions ADD CONSTRAINT agent_transactions_type_check
  CHECK (type = ANY (ARRAY[
    'late_closing_interest'::text,
    'late_payment_interest'::text,
    'balance_deduction'::text,
    'invoice_payment'::text,
    'adjustment'::text,
    'credit'::text,
    'failed_deal_balance'::text,
    'failed_deal_interest'::text
  ]));

-- Idempotency: total interest charged on this failed deal to date.
-- Cron re-computes total interest owed from the 31st day to today and charges
-- only the delta. Self-healing if a cron run is missed.
ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS failed_deal_interest_charged NUMERIC(12,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN deals.failed_deal_interest_charged IS
  'Total 24%/yr interest charged on this failed deal''s outstanding balance to date (CPA 5.3). Used by the daily accrual cron for idempotency.';

ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS failed_deal_interest_calculated_at TIMESTAMPTZ;

COMMENT ON COLUMN deals.failed_deal_interest_calculated_at IS
  'When the failed-deal interest accrual cron last touched this deal.';

-- Index for the accrual cron query — partial index keeps it tiny.
CREATE INDEX IF NOT EXISTS idx_deals_failed_interest_eligible
  ON deals (failed_to_close_at)
  WHERE status = 'failed_to_close' AND outstanding_balance > 0;
