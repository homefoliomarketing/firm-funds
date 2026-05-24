-- =============================================================================
-- Session 1: Deal delete safeguards + soft delete + backup-script RPC
-- =============================================================================
-- Prevents hard-delete of deals in any "money has moved" status. Companion to
-- the app-layer status guard in deleteDeal (lib/actions/deal-actions.ts).
-- Adds a deleted_at column for soft delete. Adds list_public_tables() RPC so
-- the backup script auto-detects schema changes.
-- =============================================================================

-- 1. Soft-delete column on deals
ALTER TABLE deals ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- 2. Trigger: block hard-DELETE on deals in financial statuses
CREATE OR REPLACE FUNCTION prevent_financial_deal_delete()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status IN ('funded', 'completed', 'failed_to_close', 'cured') THEN
    RAISE EXCEPTION 'Cannot delete deal in status "%". Use soft delete (set deleted_at) instead.', OLD.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS prevent_financial_deal_delete ON deals;
CREATE TRIGGER prevent_financial_deal_delete
  BEFORE DELETE ON deals
  FOR EACH ROW
  EXECUTE FUNCTION prevent_financial_deal_delete();

-- 3. RPC for backup script to list tables dynamically
CREATE OR REPLACE FUNCTION list_public_tables()
RETURNS TABLE(table_name text)
SECURITY DEFINER
LANGUAGE sql
SET search_path = ''
AS $$
  SELECT t.table_name::text
  FROM information_schema.tables t
  WHERE t.table_schema = 'public'
    AND t.table_type = 'BASE TABLE'
  ORDER BY t.table_name;
$$;

REVOKE ALL ON FUNCTION list_public_tables() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION list_public_tables() TO service_role;

COMMENT ON FUNCTION list_public_tables() IS
  'Returns names of all base tables in public schema. Used by scripts/backup-db.mjs.';
COMMENT ON COLUMN deals.deleted_at IS
  'Soft-delete timestamp. Non-null means the deal is hidden from normal queries. Required because funded/completed/failed/cured deals cannot be hard-deleted.';
