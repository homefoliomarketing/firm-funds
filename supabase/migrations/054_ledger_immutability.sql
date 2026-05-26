-- =============================================================================
-- Session 4: Ledger immutability (Finding 8)
-- =============================================================================
-- The agent_transactions table is the canonical financial ledger. Per FINTRAC
-- and CRA expectations it must be append-only — reversals must be new rows
-- with negative amount, not edits. Previously the admin RLS policy was
-- FOR ALL (= INSERT/SELECT/UPDATE/DELETE), so a rogue or compromised admin
-- (or a future bug) could silently rewrite history.
--
-- This migration splits the agent_transactions and document_returns admin
-- policies into separate SELECT and INSERT policies, removing the ability
-- to UPDATE or DELETE via the auth.uid() role check. Service-role writes
-- (which bypass RLS entirely) are unaffected.
--
-- agent_invoices, closing_date_amendments, and deal_messages are NOT tightened
-- here because they have legitimate status-update workflows. They'll get a
-- targeted policy audit in a follow-up.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- agent_transactions: split FOR ALL admin policy into SELECT + INSERT
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS agent_transactions_admin_all ON public.agent_transactions;

CREATE POLICY agent_transactions_admin_select
ON public.agent_transactions FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.user_profiles
    WHERE user_profiles.id = auth.uid()
      AND user_profiles.role IN ('super_admin', 'firm_funds_admin')
  )
);

CREATE POLICY agent_transactions_admin_insert
ON public.agent_transactions FOR INSERT TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.user_profiles
    WHERE user_profiles.id = auth.uid()
      AND user_profiles.role IN ('super_admin', 'firm_funds_admin')
  )
);

-- ---------------------------------------------------------------------------
-- document_returns: same split (no UPDATE/DELETE paths in app code)
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS document_returns_admin_all ON public.document_returns;

CREATE POLICY document_returns_admin_select
ON public.document_returns FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.user_profiles
    WHERE user_profiles.id = auth.uid()
      AND user_profiles.role IN ('super_admin', 'firm_funds_admin')
  )
);

CREATE POLICY document_returns_admin_insert
ON public.document_returns FOR INSERT TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.user_profiles
    WHERE user_profiles.id = auth.uid()
      AND user_profiles.role IN ('super_admin', 'firm_funds_admin')
  )
);
