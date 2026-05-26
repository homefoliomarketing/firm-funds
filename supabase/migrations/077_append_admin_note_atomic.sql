-- Migration 077: atomic admin-note append RPC
--
-- Audit finding follow-up. addAdminNote in lib/actions/deal-actions.ts
-- previously did a read-modify-write on deals.admin_notes_timeline (jsonb
-- array). Two admins commenting on the same deal at the same moment would
-- each read the same prior-state timeline, each push their own entry, and
-- each write back; the second writer wins and the first note is lost.
--
-- This RPC runs the append as a single UPDATE that uses jsonb concatenation
-- against the live row, so concurrent calls serialize at the row lock and
-- both notes survive. Returns the resulting timeline so the caller can
-- update the UI without a second read.
--
-- Service-role only, consistent with the lockdown in migration 072. The
-- caller (addAdminNote) is already gated to super_admin / firm_funds_admin.

CREATE OR REPLACE FUNCTION append_admin_note(
  p_deal_id uuid,
  p_entry jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_timeline jsonb;
BEGIN
  IF p_entry IS NULL OR jsonb_typeof(p_entry) <> 'object' THEN
    RAISE EXCEPTION 'p_entry must be a non-null jsonb object';
  END IF;

  UPDATE deals
  SET admin_notes_timeline =
    COALESCE(admin_notes_timeline, '[]'::jsonb) || jsonb_build_array(p_entry)
  WHERE id = p_deal_id
  RETURNING admin_notes_timeline INTO new_timeline;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'deal % not found', p_deal_id;
  END IF;

  RETURN new_timeline;
END;
$$;

-- Lockdown (see migration 072): no broad public exec privilege; only the
-- server-action layer (which uses service_role) may call this.
REVOKE EXECUTE ON FUNCTION append_admin_note(uuid, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION append_admin_note(uuid, jsonb) FROM anon;
REVOKE EXECUTE ON FUNCTION append_admin_note(uuid, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION append_admin_note(uuid, jsonb) TO service_role;

COMMENT ON FUNCTION append_admin_note(uuid, jsonb) IS
  'Atomic append to deals.admin_notes_timeline. Use instead of read-modify-write to avoid lost-update races between concurrent admin sessions.';
