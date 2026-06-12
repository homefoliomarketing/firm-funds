-- ============================================================================
-- Migration 117: Amendment recalculates brokerage profit share + remittance,
--                agent is invoiced for the extra fee
-- ============================================================================
-- When a FUNDED deal's closing date is amended, the discount fee changes for the
-- extra (or fewer) days. Previously the funded amendment only adjusted the
-- agent's account_balance and left the brokerage's numbers untouched. As of this
-- change the funded amendment ALSO recomputes the brokerage's profit share
-- (deals.brokerage_referral_fee) and remittance (deals.amount_due_from_brokerage)
-- for the new closing date, and a targeted invoice is raised to the agent for the
-- extra fee. The brokerage keeps its larger share the net-remittance way (it
-- remits less at settlement); there is NO brokerage ledger.
--
-- These four columns snapshot the old/new brokerage figures on the amendment row
-- for the audit trail, the amended CPA, and the amended-remittance notice.
-- ============================================================================

ALTER TABLE closing_date_amendments
  ADD COLUMN IF NOT EXISTS old_brokerage_referral_fee numeric(12,2),
  ADD COLUMN IF NOT EXISTS new_brokerage_referral_fee numeric(12,2),
  ADD COLUMN IF NOT EXISTS old_amount_due_from_brokerage numeric(12,2),
  ADD COLUMN IF NOT EXISTS new_amount_due_from_brokerage numeric(12,2);

COMMENT ON COLUMN closing_date_amendments.old_brokerage_referral_fee IS
  'Brokerage profit share (deals.brokerage_referral_fee) BEFORE this amendment. Snapshot for audit + amended CPA + amended-remittance notice.';
COMMENT ON COLUMN closing_date_amendments.new_brokerage_referral_fee IS
  'Brokerage profit share AFTER this amendment (old + referralPct * fee_adjustment_amount).';
COMMENT ON COLUMN closing_date_amendments.old_amount_due_from_brokerage IS
  'Amount the brokerage remits to Firm Funds (deals.amount_due_from_brokerage) BEFORE this amendment.';
COMMENT ON COLUMN closing_date_amendments.new_amount_due_from_brokerage IS
  'Amount the brokerage remits AFTER this amendment (old - referralPct * fee_adjustment_amount). Lower on an extension, higher on a shortening.';

-- --------------------------------------------------------------------------
-- Drift fix: these two columns are read/written by the app (since migration
-- 041's flow) but were added to prod out-of-band and never recorded in a
-- migration. ADD ... IF NOT EXISTS is a no-op on prod and makes a fresh DB
-- rebuild match what the code expects.
-- --------------------------------------------------------------------------
ALTER TABLE closing_date_amendments
  ADD COLUMN IF NOT EXISTS fee_adjustment_amount numeric(12,2),
  ADD COLUMN IF NOT EXISTS adjustment_scenario text;

-- --------------------------------------------------------------------------
-- Tie an invoice to the deal it bills. A funded extension raises a targeted
-- invoice for exactly the extra discount fee on a specific deal; deal_id lets
-- that invoice be traced back to the deal (the existing whole-balance invoices
-- leave it NULL).
-- --------------------------------------------------------------------------
ALTER TABLE agent_invoices
  ADD COLUMN IF NOT EXISTS deal_id uuid REFERENCES deals(id);

COMMENT ON COLUMN agent_invoices.deal_id IS
  'Deal this invoice bills, when the invoice is for a single deal (e.g. a closing-date-extension fee). NULL for whole-balance account invoices.';

-- --------------------------------------------------------------------------
-- Make broker_share_remitted honest. The flag (migration 043) was never set
-- true, so every "pending remit" figure showed the full share as permanently
-- unpaid. Under the net-remittance model the share is realized when the deal
-- completes (the brokerage has remitted the net amount, i.e. kept its share).
-- Backfill completed deals so their share reads as remitted; going forward the
-- completion path sets it (lib/actions/deal-actions.ts).
-- --------------------------------------------------------------------------
UPDATE deals
  SET broker_share_remitted = true
  WHERE status = 'completed'
    AND broker_share_amount IS NOT NULL
    AND broker_share_amount > 0
    AND broker_share_remitted = false;
