-- ============================================================================
-- Migration 099: remediation_deals.signed_at for DocuSign Remediation IDP flip
-- ============================================================================
-- The DocuSign Connect webhook (app/api/docusign/webhook/route.ts) was only
-- branching on BCA vs deal-level (CPA + IDP) envelopes. Remediation IDP
-- envelopes fell through to the deal-level branch and silently no-op'd
-- because remediation envelopes have NULL deal_id, NULL brokerage_id, and
-- a populated remediation_deal_id instead. The result: agents signed, but
-- our system never recorded the signed PDF or moved the remediation row
-- past 'idp_sent'.
--
-- This migration adds a signed_at column so the webhook can timestamp the
-- moment DocuSign reports the envelope completed. The column is nullable
-- (it's only populated on signing; cancelled / remitted rows leave it
-- empty if the IDP was never signed) and unindexed (low cardinality,
-- always queried by id).
-- ============================================================================

ALTER TABLE remediation_deals
  ADD COLUMN IF NOT EXISTS signed_at TIMESTAMPTZ;

COMMENT ON COLUMN remediation_deals.signed_at IS
  'Timestamp at which the Remediation IDP DocuSign envelope was reported "completed" by the Connect webhook. Populated by app/api/docusign/webhook/route.ts when document_type = remediation_idp and status flips to signed. NULL for rows that never reached idp_signed.';
