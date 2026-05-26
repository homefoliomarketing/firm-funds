-- =============================================================================
-- Session 9: Batched recompute of days_until_closing
-- =============================================================================
-- The daily closing-date-alerts cron used to recompute days_until_closing for
-- each active deal in a JavaScript loop, issuing one UPDATE per changed row.
-- That's fine at 5 deals but scales badly. This function does the same work
-- in a single set-based UPDATE.
--
-- Cap at GREATEST(0, ...) preserves the "never go negative" behaviour from
-- the previous loop. The IS DISTINCT FROM guard prevents pointless writes
-- (and pointless audit_log noise from any UPDATE triggers).
-- =============================================================================

CREATE OR REPLACE FUNCTION recompute_active_deal_days_until_closing()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE public.deals
  SET days_until_closing = GREATEST(0, (closing_date - CURRENT_DATE))
  WHERE status IN ('approved', 'funded')
    AND closing_date IS NOT NULL
    AND days_until_closing IS DISTINCT FROM GREATEST(0, (closing_date - CURRENT_DATE));
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION recompute_active_deal_days_until_closing() TO service_role;
