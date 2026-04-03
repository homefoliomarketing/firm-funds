-- =============================================================================
-- Document Requests Table
-- =============================================================================
-- Tracks admin requests for specific documents from agents.
-- Run this in the Supabase SQL Editor.
-- =============================================================================

CREATE TABLE IF NOT EXISTS document_requests (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  deal_id UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL,
  message TEXT,
  requested_by UUID NOT NULL REFERENCES auth.users(id),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'fulfilled', 'cancelled')),
  fulfilled_at TIMESTAMPTZ,
  fulfilled_document_id UUID REFERENCES deal_documents(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- Index for fast lookups by deal
CREATE INDEX IF NOT EXISTS idx_document_requests_deal_id ON document_requests(deal_id);
CREATE INDEX IF NOT EXISTS idx_document_requests_status ON document_requests(status);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_document_requests_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_document_requests_updated_at ON document_requests;
CREATE TRIGGER trg_document_requests_updated_at
  BEFORE UPDATE ON document_requests
  FOR EACH ROW
  EXECUTE FUNCTION update_document_requests_updated_at();

-- =============================================================================
-- RLS Policies
-- =============================================================================

ALTER TABLE document_requests ENABLE ROW LEVEL SECURITY;

-- Admins can do everything
CREATE POLICY "Admins full access to document_requests"
  ON document_requests
  FOR ALL
  USING (is_admin())
  WITH CHECK (is_admin());

-- Agents can read requests for their own deals
CREATE POLICY "Agents read own deal document_requests"
  ON document_requests
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM deals
      WHERE deals.id = document_requests.deal_id
      AND deals.agent_id = get_user_agent_id()
    )
  );

-- Brokerage admins can read requests for their brokerage's deals
CREATE POLICY "Brokerage admins read brokerage document_requests"
  ON document_requests
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM deals
      WHERE deals.id = document_requests.deal_id
      AND deals.brokerage_id = get_user_brokerage_id()
    )
  );
