-- Deal-completion receipt feature.
-- When a deal completes (funded + repaid -> status 'completed'), the app now
-- auto-generates a one-page invoice/receipt PDF and stores it as a
-- deal_documents row so it is systematically retrievable. That insert uses a
-- new document_type ('completion_invoice') and a new upload_source ('system'),
-- neither of which were in the existing CHECK constraints, so the insert would
-- have been rejected. Add both allowed values here.
--
-- 'completion_invoice' is an agent-private margin document (it shows the agent's
-- service fee, which is effectively Firm Funds' margin). It is filtered out of
-- the brokerage portal in app code (BROKERAGE_HIDDEN_DOC_TYPES), the same way
-- the KYC/banking types are. The agent portal (own deal docs) still shows it.

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
    'completion_invoice'::text,
    'other'::text
  ]));

-- upload_source: add 'system' for app-generated documents (the completion
-- receipt). Existing values ('nexone_auto', 'manual_upload') are preserved.
ALTER TABLE deal_documents
  DROP CONSTRAINT IF EXISTS deal_documents_upload_source_check;

ALTER TABLE deal_documents
  ADD CONSTRAINT deal_documents_upload_source_check
  CHECK (upload_source = ANY (ARRAY[
    'nexone_auto'::text,
    'manual_upload'::text,
    'system'::text
  ]));
