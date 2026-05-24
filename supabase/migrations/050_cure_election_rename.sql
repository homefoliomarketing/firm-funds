-- =============================================================================
-- Session 2: Rename cure_election 'cash' → 'cash_repayment'
-- =============================================================================
-- The agent submits "cash" but the admin Pending Cure Elections dashboard
-- filters/labels on "cash_repayment". That mismatch means every elected
-- cash repayment shows as "Awaiting election" past the 15-day deadline.
-- Canonicalize on 'cash_repayment' to match contract language (Article 5.5(a)
-- "Cash Repayment") and the admin dashboard.
-- =============================================================================

ALTER TABLE deals DROP CONSTRAINT IF EXISTS deals_cure_election_check;

UPDATE deals SET cure_election = 'cash_repayment' WHERE cure_election = 'cash';

ALTER TABLE deals ADD CONSTRAINT deals_cure_election_check
  CHECK (cure_election IS NULL OR cure_election IN ('cash_repayment', 'commission_assignment'));

COMMENT ON COLUMN deals.cure_election IS
  'Agent election under CPA 5.5. cash_repayment = pay from own funds. commission_assignment = forward-assign next commission(s) via Remediation IDP.';
