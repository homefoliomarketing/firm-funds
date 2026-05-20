-- Migration 044: Failed-to-close status + mandatory cure election
-- When a funded deal fails to close (or comes up short), the agent owes a
-- balance. Per CPA Article 5.5, the agent must elect within 15 days:
--   (a) cash repayment, or
--   (b) assignment of next eligible commission(s) via a Remediation IDP.

-- 1. Add 'failed_to_close' to the deal status constraint
ALTER TABLE deals DROP CONSTRAINT IF EXISTS deals_status_check;
ALTER TABLE deals ADD CONSTRAINT deals_status_check
  CHECK (status IN ('under_review', 'approved', 'funded', 'completed', 'denied', 'cancelled', 'failed_to_close'));

-- 2. Add failure + cure-election columns to deals
ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS failed_to_close_at TIMESTAMPTZ;

ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS failure_reason TEXT;

ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS failure_type TEXT
    CHECK (failure_type IS NULL OR failure_type IN ('non_closing', 'commission_deficiency'));

COMMENT ON COLUMN deals.failure_type IS
  'non_closing = deal blew up entirely (CPA 5.1). commission_deficiency = closed but came up short (CPA 5.2).';

ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS outstanding_balance NUMERIC(12,2);

COMMENT ON COLUMN deals.outstanding_balance IS
  'Amount owed by agent on a failed deal. Full Purchase Price for non_closing, shortfall for commission_deficiency.';

ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS cure_election TEXT
    CHECK (cure_election IS NULL OR cure_election IN ('cash', 'commission_assignment'));

COMMENT ON COLUMN deals.cure_election IS
  'Agent election under CPA 5.5. cash = pay from own funds. commission_assignment = forward-assign next commission(s) via Remediation IDP.';

ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS cure_election_at TIMESTAMPTZ;

ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS cure_election_deadline TIMESTAMPTZ;

COMMENT ON COLUMN deals.cure_election_deadline IS
  '15 calendar days after failed_to_close_at. If agent does not elect by this deadline, deemed cash (CPA 5.5).';

-- 3. Index for finding pending cure elections quickly
CREATE INDEX IF NOT EXISTS idx_deals_pending_cure_election
  ON deals (agent_id)
  WHERE status = 'failed_to_close' AND cure_election IS NULL;

-- 4. Add 'failed_deal_balance' to agent_transactions.type constraint
-- Used when a deal fails to close and the outstanding balance is charged to the agent's ledger.
ALTER TABLE agent_transactions DROP CONSTRAINT IF EXISTS agent_transactions_type_check;
ALTER TABLE agent_transactions ADD CONSTRAINT agent_transactions_type_check
  CHECK (type = ANY (ARRAY[
    'late_closing_interest'::text,
    'late_payment_interest'::text,
    'balance_deduction'::text,
    'invoice_payment'::text,
    'adjustment'::text,
    'credit'::text,
    'failed_deal_balance'::text
  ]));

-- 5. Verify
-- SELECT status, COUNT(*) FROM deals GROUP BY status ORDER BY status;
