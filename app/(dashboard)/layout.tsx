import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import SessionTimeout from '@/components/SessionTimeout'

// Finding #44 follow-up. Previously this layout was a 'use client' shell that
// loaded the user role inside a useEffect, which meant every dashboard page
// briefly rendered for unauthenticated users before client-side redirect.
// Middleware was already blocking the request, but defense in depth (and to
// kill the content flash entirely) we now resolve auth server-side and
// redirect to /login before any dashboard markup is sent.
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('role')
    .eq('id', user.id)
    .single()

  if (!profile) {
    redirect('/login')
  }

  return (
    <>
      <SessionTimeout userRole={profile.role} userId={user.id} />
      {children}
    </>
  )
}
