import { redirect } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, UserCog } from 'lucide-react'

import { createClient, createServiceRoleClient } from '@/lib/supabase/server'
import { hasCapability } from '@/lib/access'
import { StaffRolesManager, type StaffRow } from '@/components/admin/StaffRolesManager'

export const metadata = {
  title: 'Staff & Roles | Firm Funds Admin',
  robots: { index: false, follow: false },
}

// Owner-only. The proxy already bounces non-owners off /admin/staff, and the
// server actions behind the UI re-check 'roles.manage' — this page-level gate is
// the third, defense-in-depth layer.
export default async function StaffRolesPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('role, staff_role, is_active')
    .eq('id', user.id)
    .single()

  if (!profile || profile.is_active === false || !hasCapability(profile, 'roles.manage')) {
    redirect('/admin')
  }

  // Service-role read: list every internal staff account regardless of RLS.
  const service = createServiceRoleClient()
  const { data: staffRows } = await service
    .from('user_profiles')
    .select('id, email, full_name, role, staff_role, is_active, last_login')
    .in('role', ['super_admin', 'firm_funds_admin'])
    .order('full_name', { ascending: true })

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border/60 bg-card/40">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex items-center gap-3">
          <Link
            href="/admin"
            className="text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Back to admin dashboard"
          >
            <ArrowLeft size={20} />
          </Link>
          <UserCog size={20} className="text-primary" />
          <div>
            <h1 className="text-lg font-semibold text-foreground leading-tight">Staff &amp; Roles</h1>
            <p className="text-xs text-muted-foreground">Decide what each staff member can do.</p>
          </div>
        </div>
      </header>

      <main id="main-content" className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <StaffRolesManager initialStaff={(staffRows ?? []) as StaffRow[]} currentUserId={user.id} />
      </main>
    </div>
  )
}
