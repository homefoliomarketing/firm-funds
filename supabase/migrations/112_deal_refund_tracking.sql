-- ============================================================================
-- Migration 112: Per-deal agent-refund tracking + completion gate
-- ============================================================================
-- When a deal produces an agent CREDIT (an early-closing discount refund, or a
-- closing-date amendment that moves the date earlier and refunds overcharged
-- days), the agent is owed a refund. Previously nothing tracked this per-deal and
-- a deal could be marked 'completed' while a refund was still outstanding.
--
-- `refund_owed_amount` is the dollar amount currently owed to the agent for THIS
-- deal. The deal-actions 'completed' gate blocks completion while it is > 0.
-- 'Mark refund issued' pays the agent (a positive balance delta that clears the
-- credit), zeroes refund_owed_amount, and stamps refund_issued_at. Deal-scoped,
-- so an unrelated credit on another deal never blocks this one.
-- ============================================================================

ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS refund_owed_amount numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS refund_issued_at timestamptz,
  ADD COLUMN IF NOT EXISTS refund_issued_by uuid;

COMMENT ON COLUMN deals.refund_owed_amount IS
  'Agent refund currently owed for THIS deal (early-closing / amendment credit). Completion gate: a deal with refund_owed_amount > 0 cannot be marked completed. Zeroed when the refund is issued.';
COMMENT ON COLUMN deals.refund_issued_at IS
  'Timestamp the most recent agent refund was paid out (Mark refund issued). Informational; the gate keys off refund_owed_amount.';
COMMENT ON COLUMN deals.refund_issued_by IS
  'user_profiles/auth user id who marked the refund issued.';

-- Allow a dedicated ledger type for the refund payout that clears the credit.
-- Replicates the full list from migration 106 and appends 'refund_issued'.
ALTER TABLE agent_transactions DROP CONSTRAINT IF EXISTS agent_transactions_type_check;
ALTER TABLE agent_transactions ADD CONSTRAINT agent_transactions_type_check
  CHECK (type = ANY (ARRAY[
    'late_closing_interest',
    'late_payment_interest',
    'balance_deduction',
    'balance_deduction_reversed',
    'invoice_payment',
    'adjustment',
    'credit',
    'failed_deal_balance',
    'failed_deal_interest',
    'deal_advance',
    'deal_repayment',
    'refund_issued'
  ]));

-- Backfill: live (non-terminal) deals that already carry an early-closing
-- discount refund are treated as refund-owed so the new gate + dashboard alert
-- pick them up. Completed/cured/cancelled/denied deals are left alone.
UPDATE deals
  SET refund_owed_amount = discount_refund_amount
  WHERE discount_refund_amount IS NOT NULL
    AND discount_refund_amount > 0
    AND refund_owed_amount = 0
    AND status NOT IN ('completed', 'cured', 'cancelled', 'denied');
