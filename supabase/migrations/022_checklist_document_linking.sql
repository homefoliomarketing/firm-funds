-- ============================================================================
-- Migration 022: Link documents to underwriting checklist items
-- ============================================================================
-- Adds a linked_document_id column to underwriting_checklist so admins can
-- drag-and-drop uploaded documents onto checklist items to show which file
-- satisfies each requirement. When the checklist item is checked (confirmed),
-- the link is "locked" — enforced at the application layer.
-- ============================================================================

-- Add nullable FK to deal_documents
ALTER TABLE underwriting_checklist
  ADD COLUMN IF NOT EXISTS linked_document_id UUID REFERENCES deal_documents(id) ON DELETE SET NULL;

-- Index for quick lookups
CREATE INDEX IF NOT EXISTS idx_checklist_linked_doc ON underwriting_checklist(linked_document_id)
  WHERE linked_document_id IS NOT NULL;
