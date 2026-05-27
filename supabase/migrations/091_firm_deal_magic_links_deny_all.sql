-- ============================================================================
-- Migration 091: Explicit deny-all RLS policy on firm_deal_magic_links
-- ============================================================================
-- Pre-flight (2026-05-27 session):
--   SELECT polname FROM pg_policy
--   WHERE polrelid = 'public.firm_deal_magic_links'::regclass;
--   → 0 rows
--
-- Migration 080 enabled RLS on firm_deal_magic_links but added NO policies.
-- Postgres with RLS-on + zero policies defaults to deny-all for non-owners
-- and bypass for service role, which is what we actually want. But that
-- behaviour relies on no future migration accidentally adding a permissive
-- policy. An explicit deny policy is documentation + insurance against
-- regression — any future "grant authenticated SELECT" will visibly
-- conflict.
--
-- Service role bypasses RLS so the dispatcher and the magic-link route
-- continue to work unchanged.
-- ============================================================================

DROP POLICY IF EXISTS firm_deal_magic_links_no_authenticated_access
  ON firm_deal_magic_links;

CREATE POLICY firm_deal_magic_links_no_authenticated_access
  ON firm_deal_magic_links
  FOR ALL TO authenticated
  USING (false)
  WITH CHECK (false);

COMMENT ON POLICY firm_deal_magic_links_no_authenticated_access
  ON firm_deal_magic_links IS
  'Defence-in-depth: explicitly deny ALL operations to authenticated users. Service role bypasses RLS and is the only intended reader/writer (dispatcher + /agent/firm-deal/[token] route). See migration 091.';
