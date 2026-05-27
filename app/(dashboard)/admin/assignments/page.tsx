import { redirect } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, ClipboardList } from 'lucide-react'

import { createClient, createServiceRoleClient } from '@/lib/supabase/server'
import {
  AssignmentsTable,
  type AssignmentDealRow,
  type AssignmentSection,
} from '@/components/admin/AssignmentsTable'

export const metadata = {
  title: 'Underwriter Assignments — Firm Funds Admin',
  robots: { index: false, follow: false },
}

const OVERDUE_DAYS = 7

function daysBetween(iso: string): number {
  const created = new Date(iso).getTime()
  const now = Date.now()
  return Math.max(0, Math.floor((now - created) / 86400000))
}

export default async function AssignmentsPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('id, full_name, role, is_active')
    .eq('id', user.id)
    .single()

  if (
    !profile ||
    profile.is_active === false ||
    !['super_admin', 'firm_funds_admin'].includes(profile.role)
  ) {
    redirect('/login')
  }

  // Pull every under-review deal in one query so we can bucket on the server.
  // Service role is used because RLS on `deals` already restricts to admins,
  // but the service client gives us cross-brokerage visibility without the
  // brokerage_admin policy interfering.
  const service = createServiceRoleClient()
  const { data: dealRows, error: dealsErr } = await service
    .from('deals')
    .select(
      'id, property_address, status, created_at, assigned_to_user_id, agents(first_name, last_name), brokerages(name)',
    )
    .eq('status', 'under_review')
    .order('created_at', { ascending: true })
    .limit(500)

  // Look up assignee names for any deals that ARE assigned. Avoid a per-row
  // join to keep the page fast.
  const assigneeIds = Array.from(
    new Set(
      (dealRows ?? [])
        .map((d: any) => d.assigned_to_user_id)
        .filter((id: string | null): id is string => !!id),
    ),
  )

  let assigneeMap = new Map<string, string>()
  if (assigneeIds.length > 0) {
    const { data: assignees } = await service
      .from('user_profiles')
      .select('id, full_name')
      .in('id', assigneeIds)
    for (const a of assignees ?? []) {
      assigneeMap.set(a.id, a.full_name ?? 'Unknown')
    }
  }

  const allDeals: AssignmentDealRow[] = (dealRows ?? []).map((d: any) => ({
    id: d.id,
    property_address: d.property_address,
    agent_name: d.agents
      ? `${d.agents.first_name ?? ''} ${d.agents.last_name ?? ''}`.trim() || null
      : null,
    brokerage_name: d.brokerages?.name ?? null,
    status: d.status,
    created_at: d.created_at,
    assigned_to_user_id: d.assigned_to_user_id,
    assigned_to_name: d.assigned_to_user_id
      ? assigneeMap.get(d.assigned_to_user_id) ?? null
      : null,
    days_in_queue: daysBetween(d.created_at),
  }))

  const unassigned = allDeals.filter(d => !d.assigned_to_user_id)
  const mine = allDeals.filter(d => d.assigned_to_user_id === user.id)
  const overdue = allDeals.filter(d => d.days_in_queue >= OVERDUE_DAYS)

  const sections: Array<{ key: AssignmentSection; rows: AssignmentDealRow[] }> = [
    { key: 'unassigned', rows: unassigned },
    { key: 'mine', rows: mine },
    { key: 'overdue', rows: overdue },
  ]

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-40 bg-card/80 backdrop-blur-sm border-b border-border/50">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
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
              <ClipboardList size={16} className="text-primary" aria-hidden="true" />
              <h1 className="text-sm font-semibold text-foreground">
                Underwriter Assignments
              </h1>
            </div>
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span>
              <span className="font-semibold text-foreground tabular-nums">
                {unassigned.length}
              </span>{' '}
              unassigned
            </span>
            <span>·</span>
            <span>
              <span className="font-semibold text-foreground tabular-nums">
                {mine.length}
              </span>{' '}
              in your queue
            </span>
            <span>·</span>
            <span>
              <span className="font-semibold text-destructive tabular-nums">
                {overdue.length}
              </span>{' '}
              overdue
            </span>
          </div>
        </div>
      </header>

      <main id="main-content" className="max-w-6xl mx-auto px-4 py-6 space-y-5">
        {dealsErr ? (
          <div
            role="alert"
            className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            Failed to load deals: {dealsErr.message}
          </div>
        ) : null}

        {sections.map(s => (
          <AssignmentsTable
            key={s.key}
            section={s.key}
            rows={s.rows}
            currentUserId={user.id}
          />
        ))}
      </main>
    </div>
  )
}
