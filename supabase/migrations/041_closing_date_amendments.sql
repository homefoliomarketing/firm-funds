-- ============================================================================
-- Migration 041: Closing Date Amendments
-- ============================================================================
-- Tracks agent-initiated requests to amend a deal's closing date.
-- Requires uploaded executed amendment document.
-- Admin must approve before fees are recalculated and an amended CPA is sent.
-- ============================================================================

CREATE TABLE IF NOT EXISTS closing_date_amendments (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  deal_id UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  requested_by UUID NOT NULL,
  old_closing_date DATE NOT NULL,
  new_closing_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  amendment_document_id UUID REFERENCES deal_documents(id) ON DELETE SET NULL,
  reviewed_by UUID,
  reviewed_at TIMESTAMPTZ,
  rejection_reason TEXT,
  amended_envelope_id TEXT,
  old_discount_fee NUMERIC(12,2),
  new_discount_fee NUMERIC(12,2),
  old_settlement_period_fee NUMERIC(12,2),
  new_settlement_period_fee NUMERIC(12,2),
  old_advance_amount NUMERIC(12,2),
  new_advance_amount NUMERIC(12,2),
  old_due_date DATE,
  new_due_date DATE,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cda_deal ON closing_date_amendments(deal_id);
CREATE INDEX IF NOT EXISTS idx_cda_status ON closing_date_amendments(status);
CREATE INDEX IF NOT EXISTS idx_cda_pending ON closing_date_amendments(status) WHERE status = 'pending';

ALTER TABLE closing_date_amendments ENABLE ROW LEVEL SECURITY;

CREATE POLICY cda_agent_read ON closing_date_amendments
  FOR SELECT USING (
    deal_id IN (
      SELECT id FROM deals WHERE agent_id IN (
        SELECT agent_id FROM user_profiles WHERE id = auth.uid() AND role = 'agent'
      )
    )
  );

CREATE POLICY cda_admin_all ON closing_date_amendments
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role IN ('super_admin', 'firm_funds_admin')
    )
  );

-- Add 'closing_date_amendment' to valid document types
-- First drop the old constraint, then re-add with the new value
ALTER TABLE deal_documents DROP CONSTRAINT IF EXISTS deal_documents_document_type_check;
ALTER TABLE deal_documents ADD CONSTRAINT deal_documents_document_type_check
  CHECK (document_type IN (
    'aps', 'amendment', 'trade_record', 'mls_listing', 'commission_agreement',
    'direction_to_pay', 'notice_of_fulfillment', 'kyc_fintrac', 'id_verification',
    'brokerage_cooperation_agreement', 'closing_date_amendment', 'other'
  ));
