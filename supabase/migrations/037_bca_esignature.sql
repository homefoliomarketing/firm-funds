-- 037: BCA (Brokerage Cooperation Agreement) e-signature support
-- Extends esignature_envelopes to track brokerage-level envelopes (not just deal-level)

-- 1. Make deal_id nullable (BCA envelopes are brokerage-level, not deal-level)
ALTER TABLE esignature_envelopes ALTER COLUMN deal_id DROP NOT NULL;

-- 2. Add brokerage_id FK for brokerage-level envelopes
ALTER TABLE esignature_envelopes ADD COLUMN brokerage_id UUID REFERENCES brokerages(id) ON DELETE CASCADE;

-- 3. Enforce: exactly one of deal_id or brokerage_id must be set
ALTER TABLE esignature_envelopes ADD CONSTRAINT chk_envelope_scope
  CHECK (
    (deal_id IS NOT NULL AND brokerage_id IS NULL) OR
    (deal_id IS NULL AND brokerage_id IS NOT NULL)
  );

-- 4. Expand document_type to include 'bca'
ALTER TABLE esignature_envelopes DROP CONSTRAINT IF EXISTS esignature_envelopes_document_type_check;
ALTER TABLE esignature_envelopes ADD CONSTRAINT esignature_envelopes_document_type_check
  CHECK (document_type IN ('cpa', 'idp', 'bca'));

-- 5. Index for brokerage lookups
CREATE INDEX idx_esignature_envelopes_brokerage_id ON esignature_envelopes(brokerage_id);

-- 6. Track when BCA is signed on the brokerage record
ALTER TABLE brokerages ADD COLUMN bca_signed_at TIMESTAMPTZ;

-- 7. Add brokerage_cooperation_agreement to deal_documents document_type constraint
-- (so webhook can store signed BCA PDFs)
ALTER TABLE deal_documents DROP CONSTRAINT IF EXISTS deal_documents_document_type_check;
ALTER TABLE deal_documents ADD CONSTRAINT deal_documents_document_type_check
  CHECK (document_type IN (
    'aps', 'amendment', 'trade_record', 'mls_listing',
    'commission_agreement', 'direction_to_pay',
    'notice_of_fulfillment', 'kyc_fintrac', 'id_verification',
    'brokerage_cooperation_agreement', 'other'
  ));
