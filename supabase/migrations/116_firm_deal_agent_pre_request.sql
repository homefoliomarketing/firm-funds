-- ============================================================================
-- Migration 116: Firm-deal agent "pre-request" (request-on-approval)
-- ============================================================================
-- An agent who onboards via a firm-deal offer link finishes ID + banking and
-- lands on the "You're all set" page while Firm Funds reviews their account.
-- Before this migration that page was a dead end: the agent had to wait for the
-- approval email, log back in, FIND the offer, and click "Notify my brokerage".
--
-- Now they can PRE-REQUEST the advance from that page. We record the intent on
-- the firm_deal_events row, and the moment Firm Funds activates the account
-- (KYC verified AND banking approved -> account_activated_at set), the approval
-- action fires the normal offer-acceptance flow on their behalf: it creates the
-- 'offered' deal and notifies the brokerage. The agent never has to come back.
--
-- Per-side, mirroring the existing matched_agent_id / second_matched_agent_id
-- and offer_deal_id / second_offer_deal_id pairs: the primary matched agent and
-- the (rare, dual-agency) second matched agent each carry their own pre-request
-- timestamp, so one side pre-requesting never fires the other side's offer.
-- ============================================================================

ALTER TABLE firm_deal_events
  ADD COLUMN IF NOT EXISTS agent_pre_request_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS second_agent_pre_request_at TIMESTAMPTZ;

COMMENT ON COLUMN firm_deal_events.agent_pre_request_at IS
  'Set when the PRIMARY matched agent pre-requests the advance during onboarding (before account activation). The activation hook (fireQueuedFirmDealOffersForAgent) reads this to auto-create the offered deal + notify the brokerage once account_activated_at flips. Ignored once offer_deal_id is set (offer already accepted).';
COMMENT ON COLUMN firm_deal_events.second_agent_pre_request_at IS
  'Dual-agency twin of agent_pre_request_at for the SECOND matched agent (second_offer_deal_id side).';

-- Hot path for the activation hook: "events this agent pre-requested but that
-- have not been turned into an offered deal yet." One partial index per side.
CREATE INDEX IF NOT EXISTS idx_firm_deal_events_pre_request_primary
  ON firm_deal_events(matched_agent_id)
  WHERE agent_pre_request_at IS NOT NULL AND offer_deal_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_firm_deal_events_pre_request_second
  ON firm_deal_events(second_matched_agent_id)
  WHERE second_agent_pre_request_at IS NOT NULL AND second_offer_deal_id IS NULL;
