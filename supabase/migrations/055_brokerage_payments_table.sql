-- Migration 055: brokerage_payments JSONB array → real table
--
-- WHY: lib/actions/admin-actions.ts:1934 removeBrokeragePayment had a race
-- (read-modify-write the JSONB array by index — two concurrent removes could
-- clobber each other). All 5 writers had the same shape. A real table with
-- stable UUIDs and per-row RLS removes the race entirely and lets brokerages
-- see only their own payments at the DB layer.
--
-- The deals.brokerage_payments JSONB column is NOT dropped here. It is
-- renamed to brokerage_payments_legacy_jsonb so the new table can own the
-- brokerage_payments name (for PostgREST embed clarity) and the JSONB column
-- remains as a rollback safety net populated up to the migration moment.
-- A future migration can drop the legacy column once we've verified the
-- table is the source of truth.

CREATE TABLE IF NOT EXISTS brokerage_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id UUID NOT NULL REFERENCES deals(id) ON DELETE RESTRICT,
  brokerage_id UUID NOT NULL REFERENCES brokerages(id) ON DELETE RESTRICT,

  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  payment_date DATE NOT NULL,
  reference TEXT,
  method TEXT CHECK (method IN ('eft', 'wire', 'cheque', 'cash', 'other')),
  notes TEXT,

  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'confirmed', 'rejected')),

  submitted_by_role TEXT CHECK (submitted_by_role IN ('admin', 'brokerage_admin')),
  submitted_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  reviewed_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  rejection_reason TEXT
);

CREATE INDEX IF NOT EXISTS brokerage_payments_deal_id_idx
  ON brokerage_payments(deal_id);
CREATE INDEX IF NOT EXISTS brokerage_payments_brokerage_id_idx
  ON brokerage_payments(brokerage_id);
CREATE INDEX IF NOT EXISTS brokerage_payments_status_idx
  ON brokerage_payments(status) WHERE status = 'pending';

-- Backfill from deals.brokerage_payments JSONB.
-- Each existing entry becomes a row, preserving submitted_at order.
-- Legacy entries with no status field are treated as 'confirmed' (matching
-- the existing reader rule that null-status entries count toward the total).
INSERT INTO brokerage_payments (
  deal_id, brokerage_id, amount, payment_date, reference, method, notes,
  status, submitted_by_role, submitted_by_user_id, submitted_at,
  reviewed_by_user_id, reviewed_at, rejection_reason
)
SELECT
  d.id,
  d.brokerage_id,
  COALESCE((p->>'amount')::numeric, 0),
  COALESCE((p->>'date')::date, CURRENT_DATE),
  NULLIF(p->>'reference', ''),
  CASE
    WHEN p->>'method' IN ('eft', 'wire', 'cheque', 'cash', 'other') THEN p->>'method'
    ELSE NULL
  END,
  NULLIF(p->>'notes', ''),
  COALESCE(NULLIF(p->>'status', ''), 'confirmed'),
  CASE
    WHEN p->>'submitted_by_role' IN ('admin', 'brokerage_admin') THEN p->>'submitted_by_role'
    -- Legacy: pre-migration entries used 'brokerage' before role was canonicalized
    WHEN p->>'submitted_by_role' = 'brokerage' THEN 'brokerage_admin'
    ELSE NULL
  END,
  NULLIF(p->>'submitted_by_user_id', '')::uuid,
  COALESCE((p->>'submitted_at')::timestamptz, d.updated_at, now()),
  NULLIF(p->>'reviewed_by_user_id', '')::uuid,
  NULLIF(p->>'reviewed_at', '')::timestamptz,
  NULLIF(p->>'rejection_reason', '')
FROM deals d
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.brokerage_payments, '[]'::jsonb)) AS p
WHERE d.brokerage_id IS NOT NULL
  AND COALESCE((p->>'amount')::numeric, 0) > 0
ON CONFLICT DO NOTHING;

ALTER TABLE brokerage_payments ENABLE ROW LEVEL SECURITY;

-- Admin SELECT + INSERT + UPDATE (no DELETE — removals are admin-only and
-- audited; future-proof so an ordinary admin can't wipe history. If a real
-- delete is needed, do it via service role.)
CREATE POLICY brokerage_payments_admin_select ON brokerage_payments
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM user_profiles up
      WHERE up.id = auth.uid()
        AND up.role IN ('super_admin', 'firm_funds_admin')
    )
  );

CREATE POLICY brokerage_payments_admin_insert ON brokerage_payments
  FOR INSERT TO authenticated WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles up
      WHERE up.id = auth.uid()
        AND up.role IN ('super_admin', 'firm_funds_admin')
    )
  );

CREATE POLICY brokerage_payments_admin_update ON brokerage_payments
  FOR UPDATE TO authenticated USING (
    EXISTS (
      SELECT 1 FROM user_profiles up
      WHERE up.id = auth.uid()
        AND up.role IN ('super_admin', 'firm_funds_admin')
    )
  );

-- Brokerage admin: see own brokerage's payments, insert claims on own deals.
-- No update/delete — claim editing happens via admin review.
CREATE POLICY brokerage_payments_brokerage_select ON brokerage_payments
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM user_profiles up
      WHERE up.id = auth.uid()
        AND up.brokerage_id = brokerage_payments.brokerage_id
    )
  );

CREATE POLICY brokerage_payments_brokerage_insert ON brokerage_payments
  FOR INSERT TO authenticated WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles up
      WHERE up.id = auth.uid()
        AND up.brokerage_id = brokerage_payments.brokerage_id
    )
    AND submitted_by_role = 'brokerage_admin'
    AND status = 'pending'
  );

-- Agent: see payments on own deals (read-only, for visibility).
CREATE POLICY brokerage_payments_agent_select ON brokerage_payments
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM deals d
      JOIN user_profiles up ON up.id = auth.uid()
      WHERE d.id = brokerage_payments.deal_id
        AND d.agent_id = up.agent_id
    )
  );

COMMENT ON TABLE brokerage_payments IS
  'Brokerage repayments on funded deals. Replaces the deals.brokerage_payments JSONB array (migration 010). Pending claims = brokerage-submitted; confirmed = admin-verified bank deposit.';

-- Trigger: keep deals.repayment_amount in sync with the sum of confirmed
-- payments. Atomic with the INSERT/UPDATE/DELETE that triggered it, so no
-- read-modify-write race.
CREATE OR REPLACE FUNCTION recompute_deal_repayment_amount() RETURNS TRIGGER AS $$
DECLARE
  target_deal UUID;
  total NUMERIC;
BEGIN
  target_deal := COALESCE(NEW.deal_id, OLD.deal_id);
  SELECT COALESCE(SUM(amount), 0) INTO total
  FROM brokerage_payments
  WHERE deal_id = target_deal AND status = 'confirmed';

  UPDATE deals
  SET repayment_amount = CASE WHEN total > 0 THEN total ELSE NULL END
  WHERE id = target_deal;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER brokerage_payments_sync_deal_total
  AFTER INSERT OR UPDATE OR DELETE ON brokerage_payments
  FOR EACH ROW EXECUTE FUNCTION recompute_deal_repayment_amount();

-- Backfill repayment_amount one-shot so any pre-existing inconsistency is fixed.
UPDATE deals d
SET repayment_amount = sub.total
FROM (
  SELECT deal_id, NULLIF(SUM(amount), 0) AS total
  FROM brokerage_payments
  WHERE status = 'confirmed'
  GROUP BY deal_id
) sub
WHERE d.id = sub.deal_id;

-- Rename the legacy JSONB column AFTER backfill so the new table can own the
-- brokerage_payments name unambiguously in PostgREST embeds.
ALTER TABLE deals
  RENAME COLUMN brokerage_payments TO brokerage_payments_legacy_jsonb;

COMMENT ON COLUMN deals.brokerage_payments_legacy_jsonb IS
  'Deprecated as of migration 055. Backfilled into the brokerage_payments table. Retained as rollback safety net. Do not write to this column.';
