-- ============================================================================
-- Migration 084: Failed-funding recovery + resubmission tracking
-- ============================================================================
-- Two new lifecycle realities for the deals table:
--
-- 1. FUNDING FAILED. When an EFT bounces or banking info is wrong, we need
--    to flag the deal so it doesn't sit in 'approved' forever pretending
--    funding worked. Adds a dedicated 'funding_failed' status plus a reason
--    + timestamp so the agent dashboard can show a clear "you need to fix
--    X" CTA.
--
-- 2. RESUBMISSIONS. Agents whose deal was denied or cancelled sometimes
--    return with a corrected deal. Today we have no way to thread the new
--    deal to the old one — the audit trail just shows "denied" then a
--    brand-new ticket. Add revised_from_deal_id so the dashboard shows the
--    chain and underwriters get the original's history when they pick up
--    the new one.
-- ============================================================================

-- 1. Failure tracking columns.
ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS funding_failure_reason TEXT,
  ADD COLUMN IF NOT EXISTS funding_failed_at TIMESTAMPTZ;

COMMENT ON COLUMN deals.funding_failure_reason IS
  'Free-text reason a funding attempt failed (e.g. "EFT returned NSF", "agent banking rejected"). Populated when status moves to funding_failed.';
COMMENT ON COLUMN deals.funding_failed_at IS
  'Timestamp the funding attempt was marked failed. Drives the agent-side recovery CTA.';

-- 2. Extend the status CHECK to allow 'funding_failed'. Migration 081 last
--    rewrote this constraint; we re-list the full allowed set so it stays
--    declarative.
ALTER TABLE deals DROP CONSTRAINT IF EXISTS deals_status_check;
ALTER TABLE deals ADD CONSTRAINT deals_status_check CHECK (
  status = ANY (ARRAY[
    'offered'::text,
    'under_review'::text,
    'approved'::text,
    'funded'::text,
    'funding_failed'::text,  -- NEW: EFT bounced or banking wrong; recoverable
    'completed'::text,
    'denied'::text,
    'cancelled'::text,
    'failed_to_close'::text,
    'cured'::text
  ])
);

-- 3. Resubmission lineage.
ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS revised_from_deal_id UUID REFERENCES deals(id);

COMMENT ON COLUMN deals.revised_from_deal_id IS
  'When an agent resubmits after a denial/cancellation/funding failure, this points back to the original deal. NULL for net-new submissions. Use to render lineage on the deal detail view.';

CREATE INDEX IF NOT EXISTS idx_deals_revised_from_deal_id
  ON deals(revised_from_deal_id)
  WHERE revised_from_deal_id IS NOT NULL;

-- Sanity emit.
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
