-- =============================================================================
-- Session 1: Switch financial FKs from CASCADE to RESTRICT
-- =============================================================================
-- Defense in depth with migration 048's trigger. Even if the trigger is
-- bypassed or dropped, RESTRICT at the FK layer prevents silent wipeout of
-- signed contracts (esignature_envelopes), remediation history
-- (remediation_deals), and amendments (closing_date_amendments).
--
-- Operational tables (deal_documents, underwriting_checklist, message_reads,
-- document_requests, document_returns) stay CASCADE because under_review
-- deals can be legitimately deleted along with their working files.
-- =============================================================================

-- esignature_envelopes.deal_id
ALTER TABLE esignature_envelopes
  DROP CONSTRAINT IF EXISTS esignature_envelopes_deal_id_fkey,
  ADD CONSTRAINT esignature_envelopes_deal_id_fkey
    FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE RESTRICT;

-- remediation_deals.failed_deal_id
ALTER TABLE remediation_deals
  DROP CONSTRAINT IF EXISTS remediation_deals_failed_deal_id_fkey,
  ADD CONSTRAINT remediation_deals_failed_deal_id_fkey
    FOREIGN KEY (failed_deal_id) REFERENCES deals(id) ON DELETE RESTRICT;

-- closing_date_amendments.deal_id
ALTER TABLE closing_date_amendments
  DROP CONSTRAINT IF EXISTS closing_date_amendments_deal_id_fkey,
  ADD CONSTRAINT closing_date_amendments_deal_id_fkey
    FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE RESTRICT;
