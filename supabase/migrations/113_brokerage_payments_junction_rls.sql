-- ============================================================================
-- Migration 113: SEC-D4 — brokerage_payments RLS honors the brokerage_admins
-- junction
-- ============================================================================
-- The brokerage-facing SELECT and INSERT policies on brokerage_payments
-- (migration 055) gate ONLY on the legacy user_profiles.brokerage_id column.
-- A brokerage admin who administers a brokerage via the brokerage_admins
-- junction (migrations 087/098) but whose user_profiles.brokerage_id points
-- elsewhere (or is null) is wrongly DENIED their own brokerage's payment rows
-- (fail-closed; not a data leak). This brings the two policies in line with the
-- deal_documents policies (migration 095), which already honor the junction.
--
-- The widening is bounded: access is granted ONLY when the user is tied to the
-- payment row's own brokerage_id, either via the legacy column OR via confirmed
-- membership in brokerage_admins for that SAME brokerage. It can never widen
-- beyond a brokerage the user actually administers. The recursion-safe
-- public.is_user_brokerage_admin_of(uuid, uuid) helper (migration 095) is used
-- so joining brokerage_admins does not re-trigger the 094 recursion.
--
-- The INSERT policy keeps its existing guards unchanged
-- (submitted_by_role = 'brokerage_admin' AND status = 'pending'); only the
-- brokerage-membership test is broadened.
-- ============================================================================

DROP POLICY IF EXISTS brokerage_payments_brokerage_select ON brokerage_payments;
CREATE POLICY brokerage_payments_brokerage_select ON brokerage_payments
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM user_profiles up
      WHERE up.id = auth.uid()
        AND (
          up.brokerage_id = brokerage_payments.brokerage_id
          OR public.is_user_brokerage_admin_of(up.id, brokerage_payments.brokerage_id)
        )
    )
  );

DROP POLICY IF EXISTS brokerage_payments_brokerage_insert ON brokerage_payments;
CREATE POLICY brokerage_payments_brokerage_insert ON brokerage_payments
  FOR INSERT TO authenticated WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles up
      WHERE up.id = auth.uid()
        AND (
          up.brokerage_id = brokerage_payments.brokerage_id
          OR public.is_user_brokerage_admin_of(up.id, brokerage_payments.brokerage_id)
        )
    )
    AND submitted_by_role = 'brokerage_admin'
    AND status = 'pending'
  );
