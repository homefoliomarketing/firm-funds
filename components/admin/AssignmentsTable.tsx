'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ArrowUpDown, ChevronRight, UserPlus, AlertTriangle, Inbox } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { EmptyState } from '@/components/ui/empty-state'
import { DealNumber } from '@/components/DealNumber'
import { cn } from '@/lib/utils'

// ============================================================================
// Types
// ============================================================================

export interface AssignmentDealRow {
  id: string
  deal_number: string | null
  property_address: string
  agent_name: string | null
  brokerage_name: string | null
  status: string
  created_at: string
  assigned_to_user_id: string | null
  assigned_to_name?: string | null
  days_in_queue: number
}

export type AssignmentSection = 'unassigned' | 'mine' | 'overdue'

interface SectionConfig {
  title: string
  description: string
  emptyTitle: string
  emptyDescription: string
  emptyIcon: typeof Inbox
  emptyTone?: 'neutral' | 'positive' | 'warning'
}

const SECTION_CONFIG: Record<AssignmentSection, SectionConfig> = {
  unassigned: {
    title: 'Unassigned deals',
    description: 'Under-review deals nobody has claimed yet.',
    emptyTitle: 'No unassigned deals. Nice work',
    emptyDescription:
      'Every under-review deal is currently picked up. Check back as new submissions land.',
    emptyIcon: Inbox,
    emptyTone: 'positive',
  },
  mine: {
    title: 'My queue',
    description: 'Deals assigned to you.',
    emptyTitle: 'You have nothing in your queue',
    emptyDescription: 'Claim one from the unassigned list to get started.',
    emptyIcon: Inbox,
    emptyTone: 'neutral',
  },
  overdue: {
    title: 'Overdue (7+ days)',
    description: 'Deals stuck in under-review beyond the standard SLA.',
    emptyTitle: 'Nothing overdue',
    emptyDescription: 'Every under-review deal is inside the 7-day SLA.',
    emptyIcon: Inbox,
    emptyTone: 'positive',
  },
}

// ============================================================================
// Wire to backend
// ============================================================================
// The dedicated server action may not be checked in yet — fall back to a
// direct deal-actions update so the UI still works once the backend agent
// ships their module.

type AssignResult = { success: boolean; error?: string }
type AssignPayload = { dealId: string; userId: string | null }
type AssignFn = (payload: AssignPayload) => Promise<AssignResult>

let assignImpl: AssignFn | null = null
async function callAssignDealToUnderwriter(payload: AssignPayload): Promise<AssignResult> {
  if (!assignImpl) {
    try {
      // The dedicated assignment-actions module may not be checked in yet —
      // dynamic-import lazily and cast through unknown since the path is
      // resolved at runtime.
      const mod = (await import(
        /* webpackIgnore: true */ '@/lib/actions/assignment-actions' as string
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      )) as { assignDealToUnderwriter: AssignFn } | any
      assignImpl = mod.assignDealToUnderwriter as AssignFn
    } catch {
      // Best-effort fallback: when the dedicated action doesn't exist yet,
      // surface a friendly error so the admin can re-try later.
      assignImpl = async () => ({
        success: false,
        error:
          'Assignment service not deployed yet. The backend action `assignDealToUnderwriter` is still pending. Try again shortly.',
      })
    }
  }
  return assignImpl(payload)
}

// ============================================================================
// Component
// ============================================================================

export function AssignmentsTable({
  section,
  rows,
  currentUserId,
}: {
  section: AssignmentSection
  rows: AssignmentDealRow[]
  currentUserId: string
}) {
  const router = useRouter()
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  const [sortDesc, setSortDesc] = useState(true)

  const cfg = SECTION_CONFIG[section]

  const sorted = useMemo(
    () =>
      [...rows].sort((a, b) =>
        sortDesc
          ? b.days_in_queue - a.days_in_queue
          : a.days_in_queue - b.days_in_queue,
      ),
    [rows, sortDesc],
  )

  const handleClaim = async (dealId: string) => {
    setPendingId(dealId)
    try {
      const res = await callAssignDealToUnderwriter({
        dealId,
        userId: currentUserId,
      })
      if (res?.success) {
        toast.success('Deal assigned to you')
        startTransition(() => router.refresh())
      } else {
        toast.error(res?.error || 'Could not assign deal')
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Could not assign deal'
      toast.error(message)
    } finally {
      setPendingId(null)
    }
  }

  const queueTone = (days: number) =>
    days >= 7
      ? 'bg-destructive/15 text-destructive border-destructive/30'
      : days >= 4
        ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
        : 'bg-status-blue-muted text-status-blue border-status-blue-border'

  return (
    <section
      aria-labelledby={`assignments-${section}-title`}
      className="rounded-xl border border-border/40 bg-card overflow-hidden"
    >
      <header className="flex items-center justify-between gap-3 px-5 py-3 border-b border-border/40 bg-card/80">
        <div>
          <h2
            id={`assignments-${section}-title`}
            className="text-base font-semibold text-foreground flex items-center gap-2"
          >
            {section === 'overdue' ? (
              <AlertTriangle size={16} className="text-destructive" />
            ) : null}
            {cfg.title}
            <span className="text-xs font-normal text-muted-foreground/60 tabular-nums">
              {rows.length}
            </span>
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">{cfg.description}</p>
        </div>
        {rows.length > 1 ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSortDesc(s => !s)}
            className="gap-1 text-xs text-muted-foreground"
            aria-label={`Sort by days in queue, ${sortDesc ? 'descending' : 'ascending'}`}
          >
            <ArrowUpDown size={12} aria-hidden="true" />
            {sortDesc ? 'Longest first' : 'Shortest first'}
          </Button>
        ) : null}
      </header>

      {rows.length === 0 ? (
        <EmptyState
          icon={cfg.emptyIcon}
          title={cfg.emptyTitle}
          description={cfg.emptyDescription}
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent border-border/50">
              <TableHead className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground/70">
                Property
              </TableHead>
              <TableHead className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground/70">
                Agent
              </TableHead>
              <TableHead className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground/70">
                Brokerage
              </TableHead>
              <TableHead className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground/70">
                Days in queue
              </TableHead>
              {section === 'overdue' ? (
                <TableHead className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground/70">
                  Assigned to
                </TableHead>
              ) : null}
              <TableHead className="text-right text-[11px] font-bold uppercase tracking-wider text-muted-foreground/70">
                Action
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map(deal => {
              const isMine = deal.assigned_to_user_id === currentUserId
              const isAssigned = !!deal.assigned_to_user_id
              return (
                <TableRow
                  key={deal.id}
                  className="border-border/30 hover:bg-white/[0.03] transition-colors group"
                >
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Link
                        href={`/admin/deals/${deal.id}`}
                        className="flex items-center gap-1.5 text-sm font-semibold text-foreground group-hover:text-primary transition-colors"
                      >
                        {deal.property_address}
                        <ChevronRight
                          size={12}
                          aria-hidden="true"
                          className="text-muted-foreground/40 group-hover:text-primary/60 transition-colors"
                        />
                      </Link>
                      <DealNumber value={deal.deal_number} />
                    </div>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {deal.agent_name || '-'}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {deal.brokerage_name || '-'}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant="outline"
                      className={cn(
                        'tabular-nums text-xs',
                        queueTone(deal.days_in_queue),
                      )}
                    >
                      {deal.days_in_queue}d
                    </Badge>
                  </TableCell>
                  {section === 'overdue' ? (
                    <TableCell className="text-sm text-muted-foreground">
                      {deal.assigned_to_name ?? (
                        <span className="italic text-muted-foreground/60">
                          unassigned
                        </span>
                      )}
                    </TableCell>
                  ) : null}
                  <TableCell className="text-right">
                    {isMine ? (
                      <Badge className="bg-primary/15 text-primary border-primary/30">
                        In your queue
                      </Badge>
                    ) : (
                      <Button
                        size="sm"
                        variant={isAssigned ? 'outline' : 'default'}
                        disabled={pendingId === deal.id || isPending}
                        onClick={() => handleClaim(deal.id)}
                        className="gap-1.5"
                        aria-label={
                          isAssigned
                            ? `Reassign ${deal.property_address} to me`
                            : `Assign ${deal.property_address} to me`
                        }
                      >
                        {pendingId === deal.id ? (
                          <>
                            <LoadingSpinner label="" />
                            Assigning...
                          </>
                        ) : (
                          <>
                            <UserPlus size={14} aria-hidden="true" />
                            {isAssigned ? 'Reassign to me' : 'Assign to me'}
                          </>
                        )}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      )}
    </section>
  )
}
