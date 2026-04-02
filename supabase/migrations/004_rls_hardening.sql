-- =============================================================================
-- RLS Policy Hardening
-- =============================================================================
-- Run this in the Supabase SQL Editor.
-- This tightens RLS policies so agents can only see their own data,
-- admins see everything, and brokerage admins see their brokerage's data.
-- =============================================================================

-- -----------------------------------------------
-- Helper functions (create if they don't exist)
-- -----------------------------------------------

CREATE OR REPLACE FUNCTION get_user_role()
RETURNS TEXT AS $$
  SELECT role FROM user_profiles WHERE id = auth.uid()
$$ LANGUAGE sql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION get_user_agent_id()
RETURNS UUID AS $$
  SELECT agent_id FROM user_profiles WHERE id = auth.uid()
$$ LANGUAGE sql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION get_user_brokerage_id()
RETURNS UUID AS $$
  SELECT brokerage_id FROM user_profiles WHERE id = auth.uid()
$$ LANGUAGE sql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION is_admin()
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM user_profiles
    WHERE id = auth.uid()
    AND role IN ('super_admin', 'firm_funds_admin')
  )
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- -----------------------------------------------
-- DEALS table
-- -----------------------------------------------
ALTER TABLE deals ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if they exist (safe to ignore errors)
DROP POLICY IF EXISTS "Agents can view own deals" ON deals;
DROP POLICY IF EXISTS "Agents can insert own deals" ON deals;
DROP POLICY IF EXISTS "Admins can view all deals" ON deals;
DROP POLICY IF EXISTS "Admins can update all deals" ON deals;
DROP POLICY IF EXISTS "Brokerage admins can view brokerage deals" ON deals;

-- Agents: read only their own deals
CREATE POLICY "Agents can view own deals"
  ON deals FOR SELECT
  USING (agent_id = get_user_agent_id());

-- Agents: insert deals only for themselves
CREATE POLICY "Agents can insert own deals"
  ON deals FOR INSERT
  WITH CHECK (agent_id = get_user_agent_id());

-- Admins: full read access
CREATE POLICY "Admins can view all deals"
  ON deals FOR SELECT
  USING (is_admin());

-- Admins: can update any deal
CREATE POLICY "Admins can update all deals"
  ON deals FOR UPDATE
  USING (is_admin());

-- Brokerage admins: read deals belonging to their brokerage
CREATE POLICY "Brokerage admins can view brokerage deals"
  ON deals FOR SELECT
  USING (
    brokerage_id = get_user_brokerage_id()
    AND get_user_role() = 'brokerage_admin'
  );

-- -----------------------------------------------
-- DEAL_DOCUMENTS table
-- -----------------------------------------------
ALTER TABLE deal_documents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Agents can view own deal documents" ON deal_documents;
DROP POLICY IF EXISTS "Agents can insert own deal documents" ON deal_documents;
DROP POLICY IF EXISTS "Admins can view all documents" ON deal_documents;
DROP POLICY IF EXISTS "Admins can delete documents" ON deal_documents;

-- Agents: view docs for their own deals
CREATE POLICY "Agents can view own deal documents"
  ON deal_documents FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM deals
      WHERE deals.id = deal_documents.deal_id
      AND deals.agent_id = get_user_agent_id()
    )
  );

-- Agents: upload docs for their own deals
CREATE POLICY "Agents can insert own deal documents"
  ON deal_documents FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM deals
      WHERE deals.id = deal_documents.deal_id
      AND deals.agent_id = get_user_agent_id()
    )
  );

-- Admins: full read
CREATE POLICY "Admins can view all documents"
  ON deal_documents FOR SELECT
  USING (is_admin());

-- Admins: can delete
CREATE POLICY "Admins can delete documents"
  ON deal_documents FOR DELETE
  USING (is_admin());

-- -----------------------------------------------
-- UNDERWRITING_CHECKLIST table
-- -----------------------------------------------
ALTER TABLE underwriting_checklist ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can view checklist" ON underwriting_checklist;
DROP POLICY IF EXISTS "Admins can update checklist" ON underwriting_checklist;

CREATE POLICY "Admins can view checklist"
  ON underwriting_checklist FOR SELECT
  USING (is_admin());

CREATE POLICY "Admins can update checklist"
  ON underwriting_checklist FOR UPDATE
  USING (is_admin());

-- -----------------------------------------------
-- AGENTS table
-- -----------------------------------------------
ALTER TABLE agents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Agents can view own record" ON agents;
DROP POLICY IF EXISTS "Admins can view all agents" ON agents;
DROP POLICY IF EXISTS "Brokerage admins can view their agents" ON agents;

CREATE POLICY "Agents can view own record"
  ON agents FOR SELECT
  USING (id = get_user_agent_id());

CREATE POLICY "Admins can view all agents"
  ON agents FOR SELECT
  USING (is_admin());

CREATE POLICY "Brokerage admins can view their agents"
  ON agents FOR SELECT
  USING (
    brokerage_id = get_user_brokerage_id()
    AND get_user_role() = 'brokerage_admin'
  );

-- -----------------------------------------------
-- BROKERAGES table
-- -----------------------------------------------
ALTER TABLE brokerages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Agents can view own brokerage" ON brokerages;
DROP POLICY IF EXISTS "Admins can view all brokerages" ON brokerages;
DROP POLICY IF EXISTS "Brokerage admins can view own brokerage" ON brokerages;

CREATE POLICY "Agents can view own brokerage"
  ON brokerages FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM agents
      WHERE agents.brokerage_id = brokerages.id
      AND agents.id = get_user_agent_id()
    )
  );

CREATE POLICY "Admins can view all brokerages"
  ON brokerages FOR SELECT
  USING (is_admin());

CREATE POLICY "Brokerage admins can view own brokerage"
  ON brokerages FOR SELECT
  USING (
    id = get_user_brokerage_id()
    AND get_user_role() = 'brokerage_admin'
  );

-- -----------------------------------------------
-- USER_PROFILES table
-- -----------------------------------------------
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own profile" ON user_profiles;
DROP POLICY IF EXISTS "Admins can view all profiles" ON user_profiles;

CREATE POLICY "Users can view own profile"
  ON user_profiles FOR SELECT
  USING (id = auth.uid());

CREATE POLICY "Admins can view all profiles"
  ON user_profiles FOR SELECT
  USING (is_admin());
