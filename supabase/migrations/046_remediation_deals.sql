-- Migration 046: Remediation Deals — manually-entered future commissions
-- assigned to satisfy a failed-deal balance.
--
-- Replaces the (incorrect) "pick from agent's funded deals" flow shipped in
-- migration 045. Firm Funds doesn't house the agent's other commissions —
-- those live at the agent's brokerage(s). When an agent elects commission
-- assignment under CPA 5.5(b), admin manually records the upcoming deal
-- (property, brokerage, expected commission, expected payment date, directed
-- amount) and the Remediation IDP is generated from that record.

-- ----------------------------------------------------------------------------
-- 1. remediation_deals table — admin-entered future commission assignments
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS remediation_deals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The failed-to-close deal whose outstanding balance this is curing
  failed_deal_id UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,

  -- Manually-entered transaction details (the brokerage is NOT necessarily
  -- the agent's current brokerage of record — agent may have transferred)
  property_address TEXT NOT NULL,
  mls_number TEXT,
  brokerage_id UUID REFERENCES brokerages(id) ON DELETE SET NULL,
  brokerage_legal_name TEXT NOT NULL,
  brokerage_address TEXT,
  broker_of_record_name TEXT,
  broker_of_record_email TEXT,

  -- Financial expectations
  expected_commission NUMERIC(12,2),    -- Informational: agent's net commission expected
  expected_closing_date DATE,
  expected_payment_date DATE,            -- When brokerage expected to remit
  directed_amount NUMERIC(12,2) NOT NULL CHECK (directed_amount > 0),

  -- Lifecycle
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'idp_sent', 'idp_signed', 'remitted', 'cancelled')),
  notes TEXT,

  -- Outcome tracking (populated by Mark Remitted)
  remitted_at TIMESTAMPTZ,
  remitted_amount NUMERIC(12,2),

  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE remediation_deals IS
  'Manually-entered future commission assignments used to satisfy a failed-deal balance under CPA 5.5(b). One failed deal can have multiple (successive Remediation IDPs).';
COMMENT ON COLUMN remediation_deals.directed_amount IS
  'The dollar amount being directed to Firm Funds from this commission. Typically the live outstanding balance (principal + compound interest) at signing time.';

CREATE INDEX IF NOT EXISTS idx_remediation_deals_failed_deal ON remediation_deals (failed_deal_id);
CREATE INDEX IF NOT EXISTS idx_remediation_deals_agent ON remediation_deals (agent_id);
CREATE INDEX IF NOT EXISTS idx_remediation_deals_status ON remediation_deals (status);

CREATE TRIGGER update_remediation_deals_updated_at
  BEFORE UPDATE ON remediation_deals
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- RLS: only service role accesses. Server actions enforce admin authorization.
ALTER TABLE remediation_deals ENABLE ROW LEVEL SECURITY;
-- (no policies — service role only)

-- ----------------------------------------------------------------------------
-- 2. esignature_envelopes — replace cures_deal_id with remediation_deal_id
-- ----------------------------------------------------------------------------

-- Drop the obsolete cures_deal_id column from migration 045 (the source-deal
-- picker design it was built for is being scrapped).
DROP INDEX IF EXISTS idx_esignature_envelopes_cures_deal;
ALTER TABLE esignature_envelopes DROP COLUMN IF EXISTS cures_deal_id;

-- Link a Remediation IDP envelope to the remediation_deals record it was
-- generated from.
ALTER TABLE esignature_envelopes
  ADD COLUMN IF NOT EXISTS remediation_deal_id UUID REFERENCES remediation_deals(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_esignature_envelopes_remediation_deal
  ON esignature_envelopes (remediation_deal_id)
  WHERE remediation_deal_id IS NOT NULL;

-- Loosen the scope check so a remediation_idp envelope can have NULL deal_id
-- AND NULL brokerage_id (it's anchored on remediation_deal_id instead).
ALTER TABLE esignature_envelopes DROP CONSTRAINT IF EXISTS chk_envelope_scope;
ALTER TABLE esignature_envelopes ADD CONSTRAINT chk_envelope_scope
  CHECK (
    -- CPA / IDP on a Firm Funds deal
    (deal_id IS NOT NULL AND brokerage_id IS NULL AND remediation_deal_id IS NULL) OR
    -- BCA on a brokerage
    (deal_id IS NULL AND brokerage_id IS NOT NULL AND remediation_deal_id IS NULL) OR
    -- Remediation IDP on a manually-entered remediation deal
    (deal_id IS NULL AND brokerage_id IS NULL AND remediation_deal_id IS NOT NULL)
  );

-- ----------------------------------------------------------------------------
-- 3. deals — 'cured' status for failed deals whose balance has been
--    fully satisfied via remediation payments
-- ----------------------------------------------------------------------------

ALTER TABLE deals DROP CONSTRAINT IF EXISTS deals_status_check;
ALTER TABLE deals ADD CONSTRAINT deals_status_check
  CHECK (status IN ('under_review', 'approved', 'funded', 'completed', 'denied', 'cancelled', 'failed_to_close', 'cured'));

COMMENT ON COLUMN deals.status IS
  'Lifecycle states. cured = the failed_to_close deal''s outstanding balance + accrued interest has been fully satisfied (via cash or one or more remediation deal remittances).';
