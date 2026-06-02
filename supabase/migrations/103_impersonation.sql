-- 103_impersonation.sql
-- ============================================================================
-- "View as user" (impersonation) — look-only, Owner-only, fully audited.
-- ============================================================================
-- Lets an Owner view the app AS a specific agent or brokerage user to diagnose
-- problems ("I can't see my deal", "the form won't submit"). It is:
--   * LOOK-ONLY      — every write / money / destructive action is blocked
--                      while a view-as session is active (enforced in proxy.ts).
--   * OWNER-ONLY     — gated by the existing `impersonate` capability
--                      (lib/access.ts), which only the Owner tier holds.
--   * TIME-LIMITED   — a hard expiry (see IMPERSONATION_MAX_DURATION_MS in
--                      lib/constants.ts); the on-screen banner counts down to it.
--   * FULLY AUDITED  — rows are written on start, stop, and any blocked action,
--                      always attributed to the REAL staffer, never the target.
--
-- WHY THIS IS THE SAFE SHAPE:
--   * The staffer's real Supabase auth cookie is NEVER touched, so they remain
--     the actor everywhere automatically. The target's credentials are never
--     read or changed.
--   * Impersonation state lives ENTIRELY in this table, keyed by the real
--     (JWT-verified) user id. There is nothing to forge: "am I viewing as
--     someone?" is simply "is there an active, unexpired row for auth.uid()?".
--   * No RLS policy on any existing table changes. RLS stays the real boundary
--     and is still evaluated on the real auth.uid() (the Owner = super_admin,
--     who can already read everything). Impersonation only changes which rows
--     the UI filters to; it never widens what RLS allows.
-- ============================================================================

-- 1. The session table (idempotent).
CREATE TABLE IF NOT EXISTS public.impersonation_sessions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The real staffer doing the viewing. Bound to the verified auth user.
  real_user_id        uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  real_email          text,
  real_role           text,
  -- The user being viewed.
  target_user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  target_email        text,
  target_role         text NOT NULL,           -- 'agent' | 'brokerage_admin'
  target_agent_id     uuid,                     -- denormalized for reporting
  target_brokerage_id uuid,                     -- denormalized for reporting
  reason              text,                     -- optional free-text note
  started_at          timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,     -- hard cap; UI counts down to it
  ended_at            timestamptz,              -- NULL while active
  ended_reason        text,                     -- 'manual'|'expired'|'logout'|'switched'|'revoked'
  ip_address          inet,
  user_agent          text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- 2. At most ONE active session per staffer. Starting a new view-as ends the
--    previous one first (see startImpersonation), and this index guarantees the
--    invariant even under a race.
CREATE UNIQUE INDEX IF NOT EXISTS idx_impersonation_active_per_user
  ON public.impersonation_sessions (real_user_id)
  WHERE ended_at IS NULL;

-- 3. Reporting index: "everything I did while viewing target X".
CREATE INDEX IF NOT EXISTS idx_impersonation_target
  ON public.impersonation_sessions (target_user_id);

-- 4. RLS. Reads are allowed for the owning staffer (so the cookie-scoped proxy
--    client can check its own active session) and for any internal admin (so an
--    audit/reporting screen can see all view-as activity). There are NO
--    user-scoped INSERT/UPDATE/DELETE policies: every write goes through the
--    service-role client (createServiceRoleClient), which bypasses RLS, so even
--    the Owner cannot fabricate or tamper with a session via the anon client.
ALTER TABLE public.impersonation_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS impersonation_select_own_or_admin ON public.impersonation_sessions;
CREATE POLICY impersonation_select_own_or_admin
  ON public.impersonation_sessions
  FOR SELECT TO authenticated
  USING (real_user_id = auth.uid() OR is_admin());

COMMENT ON TABLE public.impersonation_sessions IS
  'Look-only "view as user" sessions. One active row per real_user_id (Owner). Source of truth for impersonation: an active, unexpired row means the Owner is currently viewing as target_user_id. Writes via service role only; reads gated by RLS. See lib/impersonation.ts.';

-- 5. Audit log gets a nullable pointer to the impersonated target so a reviewer
--    can filter the log to "actions that happened while viewing as X". The
--    actor columns (user_id / actor_email / actor_role) always stay the REAL
--    staffer; this column is the only place the target is recorded on a row.
ALTER TABLE public.audit_log
  ADD COLUMN IF NOT EXISTS impersonated_target_id uuid;

CREATE INDEX IF NOT EXISTS idx_audit_log_impersonated_target
  ON public.audit_log (impersonated_target_id)
  WHERE impersonated_target_id IS NOT NULL;

COMMENT ON COLUMN public.audit_log.impersonated_target_id IS
  'When set, this audit row was written while the actor was viewing-as (impersonating) this target user. Actor columns remain the real staffer. See migration 103 / lib/impersonation.ts.';
