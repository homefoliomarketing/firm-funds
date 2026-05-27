-- ============================================================================
-- Migration 090: Prevent duplicate remediation_deals per (failed_deal, property)
-- ============================================================================
-- When an underwriter opens a remediation for a failed deal we sometimes
-- create the row twice — usually because the UI rendered stale state and
-- a second click fired before the first save round-tripped. The duplicate
-- shows two IDP signing flows for the same property and confuses the
-- agent's ledger.
--
-- Partial UNIQUE index keyed on (failed_deal_id, lower(trim(property_address)))
-- excluding cancelled rows. The trim/lower normalisation matches what the
-- intake form does so "129 Simon Ave" and "129 simon ave " collide.
--
-- Cancelled remediations are excluded so an operator can cancel a mistake
-- and re-create cleanly without manually deleting the bad row.
-- ============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS remediation_deals_unique_per_failed_deal_property
  ON remediation_deals (failed_deal_id, lower(trim(property_address)))
  WHERE status <> 'cancelled';

COMMENT ON INDEX remediation_deals_unique_per_failed_deal_property IS
  'Partial unique index: at most one non-cancelled remediation per (failed_deal_id, normalised property_address). Cancel and re-create if a duplicate is needed. See migration 090.';
