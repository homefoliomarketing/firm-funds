-- Session 30: agent new-deal form allows uploading a "Banking Information"
-- slot on a first advance, but the deal_documents check constraint didn't
-- include 'banking_info', so those uploads were rejected with "Invalid
-- document type". Add banking_info to the allowed values.

ALTER TABLE deal_documents
  DROP CONSTRAINT IF EXISTS deal_documents_document_type_check;

ALTER TABLE deal_documents
  ADD CONSTRAINT deal_documents_document_type_check
  CHECK (document_type = ANY (ARRAY[
    'aps'::text,
    'amendment'::text,
    'trade_record'::text,
    'mls_listing'::text,
    'commission_agreement'::text,
    'direction_to_pay'::text,
    'notice_of_fulfillment'::text,
    'kyc_fintrac'::text,
    'id_verification'::text,
    'brokerage_cooperation_agreement'::text,
    'closing_date_amendment'::text,
    'banking_info'::text,
    'other'::text
  ]));
