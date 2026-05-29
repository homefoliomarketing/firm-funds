import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import HelpShell from '@/components/help/HelpShell'
import type { HelpRole } from '@/content/help/types'

/**
 * Help Center layout. Resolves the signed-in user's role from `user_profiles`
 * and hands it to `<HelpShell>` so the sidebar renders the right side first.
 * Admins can browse Help neutrally; we default them to the agent view since
 * most operational questions come from that side.
 *
 * Auth is already enforced by the parent dashboard layout. We re-fetch the
 * profile here because we need the role, not just that the user is signed in.
 */
export default async function HelpLayout({ children }: { children: React.ReactNode }) {
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

  // Default to agent for any unrecognized role (including admins). Bud's
  // brief gates Help by signed-in status, not by exact role. Admin
  // documentation lives elsewhere; the landing copy mentions that.
  const role: HelpRole = profile?.role === 'brokerage_admin' ? 'brokerage' : 'agent'

  return <HelpShell role={role}>{children}</HelpShell>
}
