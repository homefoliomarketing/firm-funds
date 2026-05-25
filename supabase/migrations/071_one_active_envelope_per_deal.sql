-- 071: enforce at most one active (sent/delivered) envelope per (deal, document_type)
-- Backstops Finding 31: two concurrent sendForSignature calls cannot both
-- create real DocuSign envelopes for the same deal. The second insert hits
-- this partial unique index and the JS code voids the duplicate envelope.

CREATE UNIQUE INDEX IF NOT EXISTS esignature_envelopes_one_active_per_deal_doctype
  ON esignature_envelopes(deal_id, document_type) WHERE status IN ('sent','delivered');
