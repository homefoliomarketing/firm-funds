import { redirect } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Users } from 'lucide-react'

import { createClient, createServiceRoleClient } from '@/lib/supabase/server'
import { AgentsSearchList, type AgentListItem } from '@/components/admin/AgentsSearchList'

export const metadata = {
  title: 'Agents | Firm Funds Admin',
  robots: { index: false, follow: false },
}

// Shape of the brokerage relation as PostgREST returns it on the agents join:
// either a single row, an array (it nests one-to-many style), or null.
type BrokerageRel =
  | { id: string; name: string | null }[]
  | { id: string; name: string | null }
  | null

type AgentRow = {
  id: string
  first_name: string | null
  last_name: string | null
  email: string | null
  phone: string | null
  reco_number: string | null
  status: string
  account_balance: number | string | null
  flagged_by_brokerage: boolean | null
  created_at: string
  brokerages: BrokerageRel
}

// Admin-facing list/search of EVERY agent, so any agent can be found and have
// their ledger opened even with no current deal (a reset or deal-less agent is
// otherwise unreachable). Mirrors the auth gate + service-role read pattern of
// the sibling /admin/agents/[id] profile page. Any internal staff tier may view
// agent ledgers, so the gate admits all admin roles (no Owner-only narrowing).
export default async function AdminAgentsPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('role, is_active, staff_role')
    .eq('id', user.id)
    .single()

  if (
    !profile ||
    profile.is_active === false ||
    !['super_admin', 'firm_funds_admin'].includes(profile.role)
  ) {
    redirect('/login')
  }

  // Service-role read: RLS would otherwise hide cross-brokerage agents from
  // admins in some cases. Agent count is modest (low hundreds at most), so we
  // load all and let the client component filter; no server-side pagination.
  const service = createServiceRoleClient()
  const { data: agentRows } = await service
    .from('agents')
    .select(
      'id, first_name, last_name, email, phone, reco_number, status, account_balance, flagged_by_brokerage, created_at, brokerages(id, name)',
    )
    .order('last_name', { ascending: true })
    .order('first_name', { ascending: true })

  const agents: AgentListItem[] = ((agentRows ?? []) as AgentRow[]).map((a) => {
    const rel = a.brokerages
    const brokerage = Array.isArray(rel) ? rel[0] ?? null : rel
    return {
      id: a.id,
      first_name: a.first_name,
      last_name: a.last_name,
      email: a.email,
      reco_number: a.reco_number,
      status: a.status,
      account_balance: Number(a.account_balance) || 0,
      brokerage,
    }
  })

  return (
    <div className="min-h-screen bg-background">
      {/* Top bar — consistent with the agent profile page header. */}
      <header className="sticky top-0 z-40 bg-card/80 backdrop-blur-sm border-b border-border/50">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center gap-3">
          <Link
            href="/admin"
            className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-white/5 transition-colors"
          >
            <ArrowLeft size={14} aria-hidden="true" />
            Admin
          </Link>
          <div className="w-px h-6 bg-border/30" aria-hidden="true" />
          <div className="flex items-center gap-2 min-w-0">
            <Users size={16} className="text-primary flex-shrink-0" aria-hidden="true" />
            <h1 className="text-sm font-semibold text-foreground truncate">Agents</h1>
          </div>
        </div>
      </header>

      <main id="main-content" className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        <AgentsSearchList agents={agents} />
      </main>
    </div>
  )
}
