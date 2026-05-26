-- =============================================================================
-- Migration 070: One pending closing-date amendment per deal
-- =============================================================================
-- Belt-and-suspenders for the race fixed in lib/actions/amendment-actions.ts.
-- The server actions already check for an existing pending amendment before
-- inserting a new one, but two concurrent submits can both pass that check
-- and both insert. With two pending amendments on one deal, the second
-- approval would compute its fee delta against the WRONG baseline (the first
-- amendment's already-applied closing date) and miscalculate the charge.
--
-- This partial unique index makes that database-level impossible: at most
-- one row per deal_id can have status = 'pending'. A duplicate insert
-- attempt will fail with a unique-violation error, surfacing the conflict
-- cleanly instead of silently corrupting the fee math later.
-- =============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS closing_date_amendments_one_pending_per_deal
  ON closing_date_amendments (deal_id)
  WHERE status = 'pending';

COMMENT ON INDEX closing_date_amendments_one_pending_per_deal IS
  'Enforces at most one pending closing-date amendment per deal. Prevents the race where two concurrent amendment submits both pass the JS-side pre-check and create duplicate pending rows, which would later cause the second approval to miscompute its fee delta against the wrong baseline.';
