-- Migration 068: verify the brokerage_payments / eft_transfers JSONB → table
-- backfills did not silently drop financial rows
--
-- AUDIT FINDING #27 (MEDIUM): migrations 055 and 058 backfilled JSONB array
-- entries into real tables. Both used WHERE COALESCE((p->>'amount')::numeric, 0) > 0
-- which silently skipped any zero-amount or unparseable-amount entries. No
-- post-insert verification asserted that table rowcounts match JSONB element
-- counts. If any legacy admin entry was a zero-amount placeholder or had a
-- malformed amount field, it vanished without log.
--
-- Fix: this migration runs a DO block that RAISEs NOTICE with the count diffs.
-- It does NOT mutate data; it surfaces the gap so Bud can decide whether to
-- backfill the missing entries or document them as known-bad before the
-- legacy_jsonb columns are eventually dropped in a future migration.

DO $$
DECLARE
  v_bp_legacy_count int;
  v_bp_new_count int;
  v_bp_missing int;
  v_eft_legacy_count int;
  v_eft_new_count int;
  v_eft_missing int;
BEGIN
  -- brokerage_payments
  SELECT COALESCE(SUM(jsonb_array_length(brokerage_payments_legacy_jsonb)), 0)
    INTO v_bp_legacy_count
    FROM deals
    WHERE brokerage_payments_legacy_jsonb IS NOT NULL
      AND jsonb_typeof(brokerage_payments_legacy_jsonb) = 'array';

  SELECT COUNT(*) INTO v_bp_new_count FROM brokerage_payments;

  v_bp_missing := GREATEST(0, v_bp_legacy_count - v_bp_new_count);

  RAISE NOTICE
    'brokerage_payments backfill audit: legacy JSONB entries=%, new table rows=%, missing=%',
    v_bp_legacy_count, v_bp_new_count, v_bp_missing;

  IF v_bp_missing > 0 THEN
    RAISE NOTICE
      'WARNING: % brokerage_payments entries were dropped during backfill (likely zero-amount or unparseable). Inspect deals.brokerage_payments_legacy_jsonb to recover.',
      v_bp_missing;
  END IF;

  -- eft_transfers
  SELECT COALESCE(SUM(jsonb_array_length(eft_transfers_legacy_jsonb)), 0)
    INTO v_eft_legacy_count
    FROM deals
    WHERE eft_transfers_legacy_jsonb IS NOT NULL
      AND jsonb_typeof(eft_transfers_legacy_jsonb) = 'array';

  SELECT COUNT(*) INTO v_eft_new_count FROM eft_transfers;

  v_eft_missing := GREATEST(0, v_eft_legacy_count - v_eft_new_count);

  RAISE NOTICE
    'eft_transfers backfill audit: legacy JSONB entries=%, new table rows=%, missing=%',
    v_eft_legacy_count, v_eft_new_count, v_eft_missing;

  IF v_eft_missing > 0 THEN
    RAISE NOTICE
      'WARNING: % eft_transfers entries were dropped during backfill (likely zero-amount or unparseable). Inspect deals.eft_transfers_legacy_jsonb to recover.',
      v_eft_missing;
  END IF;
END $$;
