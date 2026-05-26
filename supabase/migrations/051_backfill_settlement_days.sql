-- =============================================================================
-- Session 2: Backfill settlement_days_at_funding for legacy deals
-- =============================================================================
-- Migration 047 added settlement_days_at_funding as the snapshot of the
-- brokerage's effective settlement window at submission time. Deals submitted
-- before 047 may still be under_review or approved (not yet funded) with NULL
-- in this column. Backfill to 14 (the prior global default) so funding-time
-- fallback never picks up the NEW 7-day standard for an already-quoted deal.
-- =============================================================================

UPDATE deals
SET settlement_days_at_funding = 14
WHERE settlement_days_at_funding IS NULL
  AND status IN ('under_review', 'approved');
