-- Migration 043: White-label brokerage submission system (Phase 1)
-- Session 34 — adds negotiated profit-share fields, agent activation tracking,
-- and per-deal broker share snapshot fields.

-- 1. Brokerages: white-label partner flag + negotiated profit share
ALTER TABLE brokerages
  ADD COLUMN IF NOT EXISTS is_white_label_partner BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE brokerages
  ADD COLUMN IF NOT EXISTS profit_share_pct NUMERIC(5,2) NOT NULL DEFAULT 0
    CHECK (profit_share_pct >= 0 AND profit_share_pct <= 100);

COMMENT ON COLUMN brokerages.profit_share_pct IS
  'Negotiated profit share % for white-label partner brokerages. Per-brokerage, set during onboarding. Never hardcoded. Whole number (e.g. 20.00 = 20%).';

-- 2. Agents: welcome email tracking + activation timestamp
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS welcome_email_sent_at TIMESTAMPTZ;

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS account_activated_at TIMESTAMPTZ;

COMMENT ON COLUMN agents.account_activated_at IS
  'Set automatically when both kyc_status=verified AND banking_approval_status=approved.';

-- Backfill: any agent already KYC-verified + banking-approved is activated
UPDATE agents
SET account_activated_at = COALESCE(updated_at, NOW())
WHERE kyc_status = 'verified'
  AND banking_approval_status = 'approved'
  AND account_activated_at IS NULL;

-- Trigger: auto-set account_activated_at when both gates pass
CREATE OR REPLACE FUNCTION set_agent_account_activated()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.account_activated_at IS NULL
     AND NEW.kyc_status = 'verified'
     AND NEW.banking_approval_status = 'approved' THEN
    NEW.account_activated_at = NOW();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_set_agent_account_activated ON agents;
CREATE TRIGGER trg_set_agent_account_activated
  BEFORE INSERT OR UPDATE OF kyc_status, banking_approval_status ON agents
  FOR EACH ROW
  EXECUTE FUNCTION set_agent_account_activated();

-- 3. Deals: broker share fields (snapshot pct at funding so renegotiations don't change closed deals)
ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS broker_share_pct_at_funding NUMERIC(5,2);

ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS broker_share_amount NUMERIC(12,2);

ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS broker_share_remitted BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN deals.broker_share_pct_at_funding IS
  'Snapshot of brokerage profit_share_pct at funding time. Historical deals are not affected by future pct renegotiations.';
COMMENT ON COLUMN deals.broker_share_amount IS
  'Calculated at deal completion: discount_fee * broker_share_pct_at_funding / 100. Brokerage short-pays remittance by this amount.';

-- Index for monthly statement queries (unremitted broker share by brokerage)
CREATE INDEX IF NOT EXISTS idx_deals_broker_share_unremitted
  ON deals(brokerage_id, status)
  WHERE broker_share_amount IS NOT NULL AND broker_share_remitted = false;
