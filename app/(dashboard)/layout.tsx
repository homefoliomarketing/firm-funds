import { redirect } from 'next/navigation'
import SessionTimeout from '@/components/SessionTimeout'
import ImpersonationBanner from '@/components/ImpersonationBanner'
import { getViewContext } from '@/lib/impersonation'

// Finding #44 follow-up. Previously this layout was a 'use client' shell that
// loaded the user role inside a useEffect, which meant every dashboard page
// briefly rendered for unauthenticated users before client-side redirect.
// Middleware was already blocking the request, but defense in depth (and to
// kill the content flash entirely) we now resolve auth server-side and
// redirect to /login before any dashboard markup is sent.
//
// getViewContext() also resolves any active "view as" (impersonation) session
// so we can render the persistent banner. It reads the REAL signed-in staffer
// from the server (cookie) client — the browser-only view-as override does not
// apply here — so SessionTimeout still tracks the staffer's own session.
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getViewContext()

  if (!ctx) {
    redirect('/login')
  }

  return (
    <>
      <SessionTimeout userRole={ctx.realProfile.role} userId={ctx.realUser.id} />
      {ctx.isImpersonating && ctx.targetProfile && ctx.session ? (
        <ImpersonationBanner
          targetName={ctx.targetProfile.full_name}
          targetEmail={ctx.targetProfile.email}
          targetRole={ctx.targetProfile.role}
          expiresAt={ctx.session.expires_at}
        />
      ) : null}
      {children}
    </>
  )
}
