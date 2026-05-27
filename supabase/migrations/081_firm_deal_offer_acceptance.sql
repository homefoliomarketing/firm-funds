-- ============================================================================
-- Migration 081: Firm Deal Offer Acceptance
-- ============================================================================
-- Post-acceptance UX for the firm-deal pipeline. When an agent clicks the
-- offer banner CTA, we create a placeholder `deals` row in a new 'offered'
-- status, link it back to the firm_deal_event, and notify the brokerage so
-- their admin can submit the actual advance request on the agent's behalf.
--
-- The 'offered' row is intentionally light on financials (agent doesn't yet
-- know the brokerage split, gross commission, etc.). We carry NOT NULL on
-- the financial columns by inserting 0 placeholders and gate the UI to hide
-- those numbers when status='offered'. When the brokerage submits, the same
-- row transitions to 'under_review' and the real numbers overwrite the 0s.
--
-- Bud's design (session 36, 2026-05-26):
--   "We need to send a notification to the brokerage via email and inside
--    their portal indicating that they have a deal to send to us. I believe
--    most deals will be sent by the brokerage admins."
--   "This deal should then get put down in their 'Your Deals' list as a New
--    Deal. It should stay there for 60 days and if it doesn't get turned
--    into a deal, it should just drop off and delete."
--   "We need action as soon as possible. We should send a nudge to whoever
--    is selected after 2 hours including a new email" + at 4h, an aggressive
--    internal email to Firm Funds.
-- ============================================================================

-- 1. Extend the deals.status CHECK constraint to include 'offered'.
ALTER TABLE deals DROP CONSTRAINT IF EXISTS deals_status_check;
ALTER TABLE deals ADD CONSTRAINT deals_status_check CHECK (
  status = ANY (ARRAY[
    'offered'::text,         -- NEW: agent accepted the firm-deal offer; brokerage notified
    'under_review'::text,
    'approved'::text,
    'funded'::text,
    'completed'::text,
    'denied'::text,
    'cancelled'::text,
    'failed_to_close'::text,
    'cured'::text
  ])
);

-- 2. Extend deals.source CHECK to include 'firm_deal_offer'.
ALTER TABLE deals DROP CONSTRAINT IF EXISTS deals_source_check;
ALTER TABLE deals ADD CONSTRAINT deals_source_check CHECK (
  source = ANY (ARRAY[
    'nexone_auto'::text,
    'manual_portal'::text,
    'firm_deal_offer'::text  -- NEW: created by agent accepting an offer
  ])
);

-- 3. Tracking columns on the deals row for the offered lifecycle.
ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS offered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS offered_event_id UUID REFERENCES firm_deal_events(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS brokerage_notified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS brokerage_nudge_2h_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS internal_alert_4h_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS brokerage_declined_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS brokerage_declined_reason TEXT;

COMMENT ON COLUMN deals.offered_at IS
  'Timestamp the agent clicked the firm-deal offer CTA. Set only for source=firm_deal_offer.';
COMMENT ON COLUMN deals.offered_event_id IS
  'Back-link to firm_deal_events for traceability. Lets us reconstruct which automated event produced this deal.';
COMMENT ON COLUMN deals.brokerage_notified_at IS
  'First email/in-portal notification sent to the brokerage admin team about this offered deal.';
COMMENT ON COLUMN deals.brokerage_nudge_2h_at IS
  'Second-pass nudge to the brokerage 2 hours after the initial notification. Fired by the firm-deal-offer-nudges cron.';
COMMENT ON COLUMN deals.internal_alert_4h_at IS
  'Aggressive escalation to the Firm Funds internal inbox 4 hours after notification. Tells us to call the brokerage directly.';
COMMENT ON COLUMN deals.brokerage_declined_at IS
  'Set when a brokerage admin marks the offer as "doesn''t qualify". status moves to cancelled at the same time.';
COMMENT ON COLUMN deals.brokerage_declined_reason IS
  'Free-text reason from the brokerage admin (e.g. "agent owes us money", "unusual deal").';

-- 4. Indexes for the cron's hot path: pick up offered deals by age.
CREATE INDEX IF NOT EXISTS idx_deals_offered_pending
  ON deals(status, brokerage_notified_at)
  WHERE status = 'offered';

CREATE INDEX IF NOT EXISTS idx_deals_offered_event
  ON deals(offered_event_id)
  WHERE offered_event_id IS NOT NULL;

-- 5. RLS: existing brokerage_admin policies on `deals` cover read for their
-- own brokerage's deals, so the dashboard list will pick up offered rows
-- automatically. No new policies needed.

-- 6. Sanity check: emit a notice with the new column count.
DO $$
DECLARE
  status_check TEXT;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO status_check
  FROM pg_constraint c
  JOIN pg_class t ON c.conrelid = t.oid
  WHERE t.relname = 'deals' AND c.conname = 'deals_status_check';
  RAISE NOTICE 'deals_status_check is now: %', status_check;
END $$;
