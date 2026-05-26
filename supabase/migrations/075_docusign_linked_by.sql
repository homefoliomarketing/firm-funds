-- 075_docusign_linked_by.sql
-- Track which admin completed the DocuSign OAuth link, and when.
-- Used for audit when investigating "who connected this account" — and to
-- detect after-the-fact if a non-admin slipped through (defense-in-depth
-- with the callback's role re-check).

ALTER TABLE docusign_tokens
  ADD COLUMN IF NOT EXISTS linked_by_user_id UUID REFERENCES auth.users(id);

ALTER TABLE docusign_tokens
  ADD COLUMN IF NOT EXISTS linked_at TIMESTAMPTZ;
