import { redirect } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Shield } from 'lucide-react'

import { createClient, createServiceRoleClient } from '@/lib/supabase/server'
import { hasCapability } from '@/lib/access'
import {
  BalanceAdjustmentForm,
  type BalanceAdjustmentAgent,
} from '@/components/admin/BalanceAdjustmentForm'
import { Card, CardContent } from '@/components/ui/card'

export const metadata = {
  title: 'Adjust Agent Balance | Firm Funds Admin',
  robots: { index: false, follow: false },
}

// Server-rendered shell. The actual form is client-side so we can run the
// search box, confirmation modal, and toast off the same component tree
// without round-tripping. Auth + initial agent list are loaded here so the
// browser never sees more than it needs to.
export default async function BalanceAdjustmentPage() {
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

  if (
    !profile ||
    profile.is_active === false ||
    !['super_admin', 'firm_funds_admin'].includes(profile.role)
  ) {
    redirect('/login')
  }
  // Least-privilege: only Owner (money.write) may adjust agent balances.
  if (!hasCapability(profile, 'money.write')) {
    redirect('/admin')
  }

  // Use the service-role client because soft-deleted brokerages still own
  // active agents in some cases (rare), and we want admins to be able to
  // adjust any active agent's balance. RLS on agents already restricts admin
  // reads, but the service client keeps query shape consistent across
  // admin server-rendered pages.
  const service = createServiceRoleClient()
  const { data: agentRows, error: agentErr } = await service
    .from('agents')
    .select('id, first_name, last_name, email, account_balance, brokerage_id, brokerages(name)')
    .eq('status', 'active')
    .is('deleted_at', null)
    .order('last_name')
    .limit(2000)

  type AgentRow = {
    id: string
    first_name: string | null
    last_name: string | null
    email: string | null
    account_balance: number | string | null
    brokerage_id: string | null
    brokerages: { name: string | null }[] | { name: string | null } | null
  }
  const pickOneBrokerage = (rel: AgentRow['brokerages']): { name: string | null } | null => {
    if (rel == null) return null
    return Array.isArray(rel) ? rel[0] ?? null : rel
  }
  const agents: BalanceAdjustmentAgent[] = ((agentRows ?? []) as AgentRow[]).map(a => ({
    id: a.id,
    first_name: a.first_name ?? '',
    last_name: a.last_name ?? '',
    email: a.email,
    account_balance: Number(a.account_balance) || 0,
    brokerage_name: pickOneBrokerage(a.brokerages)?.name ?? null,
  }))

  return (
    <div className="min-h-screen bg-background">
      {/* Top bar — keeps the back link visible without forcing a full layout */}
      <header className="sticky top-0 z-40 bg-card/80 backdrop-blur-sm border-b border-border/50">
        <div className="max-w-3xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link
              href="/admin"
              className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-white/5 transition-colors"
            >
              <ArrowLeft size={14} aria-hidden="true" />
              Admin
            </Link>
            <div className="w-px h-6 bg-border/30" aria-hidden="true" />
            <div className="flex items-center gap-2">
              <Shield size={16} className="text-primary" aria-hidden="true" />
              <h1 className="text-sm font-semibold text-foreground">
                Agent Balance Adjustment
              </h1>
            </div>
          </div>
        </div>
      </header>

      <main id="main-content" className="max-w-3xl mx-auto px-4 py-6 space-y-4">
        {/* Intro */}
        <Card className="border-amber-500/30 bg-amber-500/5">
          <CardContent className="p-4">
            <p className="text-sm text-foreground">
              <strong className="font-semibold text-amber-300">Heads up:</strong> every
              adjustment is audit-logged with the reason and notes you enter below. Use
              this page for refunds, corrections, write-offs, and one-off manual charges
              that don&apos;t belong on a deal. For deal-level fees, use the deal page
              instead.
            </p>
          </CardContent>
        </Card>

        {agentErr ? (
          <div
            role="alert"
            className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            Failed to load agents: {agentErr.message}
          </div>
        ) : null}

        <BalanceAdjustmentForm agents={agents} />

        <div className="text-center pt-2">
          <Link
            href="/admin/audit?action=balance.adjust"
            className="text-xs text-muted-foreground hover:text-primary underline-offset-4 hover:underline"
          >
            View all manual adjustments &rarr;
          </Link>
        </div>
      </main>
    </div>
  )
}
