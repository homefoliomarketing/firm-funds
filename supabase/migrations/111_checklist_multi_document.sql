-- ============================================================================
-- Migration 111: Allow multiple documents per underwriting checklist item
-- ============================================================================
-- The original single FK `linked_document_id` (migration 022) only allows ONE
-- document per checklist line, so dropping a second document onto a line
-- replaced the first. This adds an array of ADDITIONAL manually-linked
-- documents.
--
-- The scalar `linked_document_id` is RETAINED and untouched: it remains the
-- channel for auto-linking (the e-sign webhooks that store a signed CPA/IDP, and
-- the KYC upload flow). The underwriting UI now renders the UNION of the scalar
-- and this array, so both auto-linked and manually-linked documents show on the
-- same line. Manual drag-drop appends to this array; auto-link keeps using the
-- scalar. No backfill is needed because the UI reads the union.
--
-- NOTE: a uuid[] has no FK cascade, so deleteDocument() in deal-actions.ts prunes
-- a deleted document id out of any checklist arrays explicitly.
-- ============================================================================

ALTER TABLE underwriting_checklist
  ADD COLUMN IF NOT EXISTS linked_document_ids uuid[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN underwriting_checklist.linked_document_ids IS
  'Additional documents manually linked to this checklist item (drag-drop, migration 111). The UI shows the union of linked_document_id (auto-link/primary) and this array. No FK cascade: app code prunes deleted document ids.';
