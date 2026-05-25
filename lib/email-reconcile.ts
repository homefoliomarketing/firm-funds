import 'server-only'

import { createServiceRoleClient } from '@/lib/supabase/server'
import { logAuditEventServiceRole } from '@/lib/audit'

// Finding #42 follow-up: mirror auth.users.email -> user_profiles.email AFTER
// Supabase confirms the email change. updateEmail() in settings-actions.ts
// intentionally does NOT write the new address to user_profiles immediately
// because magic-link/invite recovery flows key on user_profiles.email; writing
// the unverified value lets a stolen-session attacker redirect recovery.
//
// Reconciliation runs in two places:
//   1. /auth/email-confirmed route, the redirect target Supabase hits when
//      the user clicks the confirmation link in their NEW inbox
//   2. getAuthenticatedUser(), a safety net that catches the cross-device
//      case (user clicked the link on a phone that isn't logged in here)
//
// Both paths converge here so the audit-log entry is written exactly once
// (the function is idempotent: a no-op if profile already matches auth).

interface ReconcileInput {
  userId: string
  authEmail: string | null | undefined
  profileEmail: string | null | undefined
}

interface ReconcileResult {
  changed: boolean
  oldEmail: string | null
  newEmail: string | null
}

export async function reconcileUserEmail(
  input: ReconcileInput
): Promise<ReconcileResult> {
  const authEmail = (input.authEmail ?? '').toLowerCase().trim() || null
  const profileEmail = (input.profileEmail ?? '').toLowerCase().trim() || null

  if (!authEmail || authEmail === profileEmail) {
    return { changed: false, oldEmail: profileEmail, newEmail: profileEmail }
  }

  const serviceClient = createServiceRoleClient()

  // Use a CAS-style guard: only update if the profile email still matches what
  // we just read. Prevents racing with a concurrent reconcile that already
  // mirrored the change (e.g., the user opened the same confirm link twice).
  const updateQuery = serviceClient
    .from('user_profiles')
    .update({ email: authEmail })
    .eq('id', input.userId)

  const { error: updateError } = profileEmail
    ? await updateQuery.eq('email', profileEmail)
    : await updateQuery.is('email', null)

  if (updateError) {
    console.warn(
      `[email-reconcile] failed to mirror auth email for user ${input.userId}: ${updateError.message}`
    )
    return { changed: false, oldEmail: profileEmail, newEmail: profileEmail }
  }

  await logAuditEventServiceRole({
    userId: input.userId,
    action: 'user.email_change_confirmed',
    entityType: 'user',
    entityId: input.userId,
    severity: 'warning',
    actorEmail: authEmail,
    metadata: { old_email: profileEmail, new_email: authEmail },
  })

  return { changed: true, oldEmail: profileEmail, newEmail: authEmail }
}
