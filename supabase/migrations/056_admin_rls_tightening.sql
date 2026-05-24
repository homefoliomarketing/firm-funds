-- Migration 056: tighten admin RLS on agent_invoices, closing_date_amendments,
-- and deal_messages.
--
-- WHY: each of these had a FOR ALL admin policy granting INSERT/SELECT/UPDATE/DELETE.
-- A code audit confirms no app path uses the auth-scoped client to UPDATE or
-- DELETE these tables — all mutations happen via the service-role client
-- (createServiceRoleClient), which bypasses RLS anyway. So removing
-- UPDATE/DELETE from the admin policy costs nothing in current functionality
-- and prevents a future bug (or a compromised admin session) from rewriting
-- or wiping these records via the user-scoped client.
--
-- The one exception was deleteDeal's cascade DELETE on closing_date_amendments.
-- That code path now uses createServiceRoleClient too (see deal-actions.ts
-- in this same commit).

-- ---------------------------------------------------------------------------
-- agent_invoices: split FOR ALL into SELECT + INSERT only
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS agent_invoices_admin_all ON agent_invoices;

CREATE POLICY agent_invoices_admin_select ON agent_invoices
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('super_admin', 'firm_funds_admin')
    )
  );

CREATE POLICY agent_invoices_admin_insert ON agent_invoices
  FOR INSERT TO authenticated WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('super_admin', 'firm_funds_admin')
    )
  );

-- ---------------------------------------------------------------------------
-- closing_date_amendments: split FOR ALL into SELECT + INSERT only
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS cda_admin_all ON closing_date_amendments;

CREATE POLICY cda_admin_select ON closing_date_amendments
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('super_admin', 'firm_funds_admin')
    )
  );

CREATE POLICY cda_admin_insert ON closing_date_amendments
  FOR INSERT TO authenticated WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('super_admin', 'firm_funds_admin')
    )
  );

-- ---------------------------------------------------------------------------
-- deal_messages: split FOR ALL into SELECT + INSERT only
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS deal_messages_admin_all ON deal_messages;

CREATE POLICY deal_messages_admin_select ON deal_messages
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('super_admin', 'firm_funds_admin')
    )
  );

CREATE POLICY deal_messages_admin_insert ON deal_messages
  FOR INSERT TO authenticated WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('super_admin', 'firm_funds_admin')
    )
  );
