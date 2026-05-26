-- Migration 058: eft_transfers JSONB array → real table
--
-- WHY: lib/actions/admin-actions.ts recordEftTransfer / confirmEftTransfer /
-- removeEftTransfer all read the deals.eft_transfers JSONB array, mutate it
-- in JavaScript, and write the whole array back. Concurrent admins (or one
-- admin in two tabs) race: both read [a, b], both write [a, b, c] vs [a, b, d],
-- last writer wins, one transfer disappears. confirmEftTransfer and
-- removeEftTransfer also indexed by integer position, so a concurrent insert
-- could shift the index and confirm or delete the wrong row. removeEftTransfer
-- was already tagged severity='critical' for this reason.
--
-- This is the same fix migration 055 applied to brokerage_payments. A real
-- table with stable UUIDs eliminates both the race and the indexing bug.
--
-- The deals.eft_transfers JSONB column is NOT dropped here. It is renamed to
-- eft_transfers_legacy_jsonb so the new table can own the eft_transfers name
-- (for PostgREST embed clarity) and the JSONB column remains as a rollback
-- safety net. A future migration can drop it once we've verified the table is
-- the source of truth in production.

CREATE TABLE IF NOT EXISTS eft_transfers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id UUID NOT NULL REFERENCES deals(id) ON DELETE RESTRICT,

  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0 AND amount <= 25000),
  transfer_date DATE NOT NULL,
  reference TEXT,

  confirmed BOOLEAN NOT NULL DEFAULT false,
  confirmed_at TIMESTAMPTZ,
  confirmed_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,

  recorded_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS eft_transfers_deal_id_idx
  ON eft_transfers(deal_id);

-- Backfill from deals.eft_transfers JSONB. Each existing entry becomes a row.
-- Legacy entries have no recorded_by_user_id (column is nullable); the
-- recorded_at falls back to the deal's updated_at as a best-effort timestamp.
INSERT INTO eft_transfers (
  deal_id, amount, transfer_date, reference, confirmed, recorded_at
)
SELECT
  d.id,
  COALESCE((t->>'amount')::numeric, 0),
  COALESCE((t->>'date')::date, CURRENT_DATE),
  NULLIF(t->>'reference', ''),
  COALESCE((t->>'confirmed')::boolean, false),
  COALESCE(d.updated_at, now())
FROM deals d
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.eft_transfers, '[]'::jsonb)) AS t
WHERE COALESCE((t->>'amount')::numeric, 0) > 0
ON CONFLICT DO NOTHING;

ALTER TABLE eft_transfers ENABLE ROW LEVEL SECURITY;

-- Admin-only: SELECT + INSERT + UPDATE + DELETE.
-- Unlike brokerage_payments, EFT transfers are not visible to brokerages or
-- agents at all (they describe Firm Funds' outbound wires). No need for the
-- broader policies that 055 added.
CREATE POLICY eft_transfers_admin_select ON eft_transfers
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM user_profiles up
      WHERE up.id = auth.uid()
        AND up.role IN ('super_admin', 'firm_funds_admin')
    )
  );

CREATE POLICY eft_transfers_admin_insert ON eft_transfers
  FOR INSERT TO authenticated WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles up
      WHERE up.id = auth.uid()
        AND up.role IN ('super_admin', 'firm_funds_admin')
    )
  );

CREATE POLICY eft_transfers_admin_update ON eft_transfers
  FOR UPDATE TO authenticated USING (
    EXISTS (
      SELECT 1 FROM user_profiles up
      WHERE up.id = auth.uid()
        AND up.role IN ('super_admin', 'firm_funds_admin')
    )
  );

CREATE POLICY eft_transfers_admin_delete ON eft_transfers
  FOR DELETE TO authenticated USING (
    EXISTS (
      SELECT 1 FROM user_profiles up
      WHERE up.id = auth.uid()
        AND up.role IN ('super_admin', 'firm_funds_admin')
    )
  );

COMMENT ON TABLE eft_transfers IS
  'Outbound EFT/wire transfers Firm Funds sends to fund a deal. Replaces the deals.eft_transfers JSONB array. Admin-only — not visible to brokerages or agents.';

-- Rename the legacy JSONB column AFTER backfill so the new table can own the
-- eft_transfers name unambiguously in PostgREST embeds.
ALTER TABLE deals
  RENAME COLUMN eft_transfers TO eft_transfers_legacy_jsonb;

COMMENT ON COLUMN deals.eft_transfers_legacy_jsonb IS
  'Deprecated as of migration 058. Backfilled into the eft_transfers table. Retained as rollback safety net. Do not write to this column.';
