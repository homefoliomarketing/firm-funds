/**
 * Admin Portfolio / Collections dashboard.
 *
 * Bird's-eye view of capital deployed and collection status. Renders even
 * when no deals are funded yet (the zero state is the point — Bud should
 * be able to bookmark this page on day one and watch it fill in as real
 * deals flow through).
 *
 * Sections:
 *   1. Capital deployed — outstanding net advances, lifetime totals, MTD throughput
 *   2. By status — count + $ for each terminal/in-flight deal status
 *   3. Aging buckets — outstanding $ grouped by days since funding
 *   4. Recent funded — last 10 funded deals for context
 *
 * Read-only. All cards link through to the existing /admin/deals filter
 * pages or /admin/deals/<id> details.
 */
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createServiceRoleClient } from '@/lib/supabase/server'
import { getAuthenticatedAdmin } from '@/lib/auth-helpers'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ArrowLeft, DollarSign, TrendingUp, CheckCircle2, AlertTriangle, Clock, Activity } from 'lucide-react'
import { formatCurrency, formatDate } from '@/lib/formatting'
import { getStatusBadgeClass, formatStatusLabel } from '@/lib/constants'

export const dynamic = 'force-dynamic'

interface PortfolioDeal {
  id: string
  status: string
  advance_amount: number
  amount_due_from_brokerage: number
  net_commission: number
  property_address: string
  funding_date: string | null
  repayment_date: string | null
  due_date: string | null
  brokerage_id: string
  created_at: string
}

interface AgingBucket {
  label: string
  range: string
  outstanding: number
  count: number
}

async function loadPortfolio() {
  const supabase = createServiceRoleClient()
  // Pull all deals once. The table is small enough that filtering in JS
  // is faster than 5 separate queries with status filters. If this ever
  // grows beyond a few thousand rows, swap to a materialized view.
  const { data: deals } = await supabase
    .from('deals')
    .select('id, status, advance_amount, amount_due_from_brokerage, net_commission, property_address, funding_date, repayment_date, due_date, brokerage_id, created_at')
    .neq('status', 'offered') // offered rows carry $0 placeholders; ignore in stats
    .order('created_at', { ascending: false })

  return (deals ?? []) as PortfolioDeal[]
}

function getAgingBuckets(funded: PortfolioDeal[]): AgingBucket[] {
  const buckets: AgingBucket[] = [
    { label: '0-30 days', range: '0-30', outstanding: 0, count: 0 },
    { label: '31-60 days', range: '31-60', outstanding: 0, count: 0 },
    { label: '61-90 days', range: '61-90', outstanding: 0, count: 0 },
    { label: '90+ days', range: '90+', outstanding: 0, count: 0 },
  ]
  const now = Date.now()
  for (const deal of funded) {
    if (!deal.funding_date) continue
    const ageDays = Math.floor((now - new Date(deal.funding_date).getTime()) / 86_400_000)
    const owed = Number(deal.amount_due_from_brokerage ?? 0)
    if (owed <= 0) continue
    const idx = ageDays <= 30 ? 0 : ageDays <= 60 ? 1 : ageDays <= 90 ? 2 : 3
    buckets[idx].outstanding += owed
    buckets[idx].count += 1
  }
  return buckets
}

function computeStats(deals: PortfolioDeal[]) {
  const monthAgo = Date.now() - 30 * 86_400_000

  // "Outstanding" = funded deals where the brokerage hasn't remitted yet
  // (i.e. not in completed/cured state). Uses amount_due_from_brokerage
  // because that's the receivable from our POV.
  const outstandingDeals = deals.filter(d =>
    ['funded', 'failed_to_close'].includes(d.status)
  )
  const outstandingTotal = outstandingDeals.reduce(
    (sum, d) => sum + Number(d.amount_due_from_brokerage ?? 0),
    0
  )

  const lifetimeAdvanced = deals
    .filter(d => ['funded', 'completed', 'failed_to_close', 'cured'].includes(d.status))
    .reduce((sum, d) => sum + Number(d.advance_amount ?? 0), 0)

  const mtdFunded = deals.filter(d =>
    d.funding_date && new Date(d.funding_date).getTime() >= monthAgo
  )
  const mtdAdvanced = mtdFunded.reduce(
    (sum, d) => sum + Number(d.advance_amount ?? 0),
    0
  )

  // Per-status breakdown for the table.
  const statusBuckets = new Map<string, { count: number; total_advance: number }>()
  for (const d of deals) {
    const bucket = statusBuckets.get(d.status) ?? { count: 0, total_advance: 0 }
    bucket.count += 1
    bucket.total_advance += Number(d.advance_amount ?? 0)
    statusBuckets.set(d.status, bucket)
  }

  return {
    outstandingTotal,
    outstandingCount: outstandingDeals.length,
    lifetimeAdvanced,
    mtdAdvanced,
    mtdFundedCount: mtdFunded.length,
    statusBuckets,
    aging: getAgingBuckets(outstandingDeals),
    recentFunded: deals
      .filter(d => d.funding_date)
      .slice(0, 10),
  }
}

export default async function PortfolioPage() {
  const auth = await getAuthenticatedAdmin()
  if (auth.error) redirect('/login')

  const deals = await loadPortfolio()
  const s = computeStats(deals)

  const headerKpis = [
    { label: 'Outstanding receivable', value: formatCurrency(s.outstandingTotal), sub: `${s.outstandingCount} active deals`, icon: Clock, accent: 'text-status-amber' },
    { label: 'Lifetime advanced', value: formatCurrency(s.lifetimeAdvanced), sub: 'Since launch', icon: TrendingUp, accent: 'text-primary' },
    { label: 'Funded (last 30d)', value: formatCurrency(s.mtdAdvanced), sub: `${s.mtdFundedCount} deals`, icon: DollarSign, accent: 'text-status-green' },
    { label: 'Total deals', value: deals.length, sub: 'All statuses', icon: Activity, accent: 'text-muted-foreground' },
  ]

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border/50 bg-card/80 backdrop-blur-sm">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-5">
          <Link href="/admin" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-2">
            <ArrowLeft size={14} aria-hidden="true" /> Admin dashboard
          </Link>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Portfolio &amp; Collections</h1>
          <p className="text-sm text-muted-foreground mt-1">Capital deployed, outstanding receivables, and aging across all brokerages.</p>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* KPIs */}
        <section aria-label="Top-line metrics" className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-8">
          {headerKpis.map(kpi => (
            <Card key={kpi.label} className="border-border/40 bg-card/60">
              <CardContent className="p-4 sm:p-5">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">{kpi.label}</span>
                  <kpi.icon size={15} className={`${kpi.accent} opacity-60`} aria-hidden="true" />
                </div>
                <p className="text-2xl font-bold tracking-tight text-foreground tabular-nums">{kpi.value}</p>
                <p className="text-[11px] text-muted-foreground/70 mt-1">{kpi.sub}</p>
              </CardContent>
            </Card>
          ))}
        </section>

        {/* Aging buckets */}
        <section aria-label="Aging" className="mb-8">
          <Card className="border-border/40">
            <CardHeader className="py-3 px-5 border-b border-border/40">
              <CardTitle className="text-sm font-bold uppercase tracking-wider text-muted-foreground/70 flex items-center gap-2">
                <AlertTriangle size={14} className="text-status-amber" aria-hidden="true" />
                Outstanding by age
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0 grid grid-cols-2 lg:grid-cols-4 divide-y lg:divide-y-0 lg:divide-x divide-border/30">
              {s.aging.map(bucket => (
                <div key={bucket.range} className="p-5">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">{bucket.label}</p>
                  <p className="text-xl font-bold mt-2 tabular-nums text-foreground">{formatCurrency(bucket.outstanding)}</p>
                  <p className="text-[11px] text-muted-foreground/70 mt-1">{bucket.count} {bucket.count === 1 ? 'deal' : 'deals'}</p>
                </div>
              ))}
            </CardContent>
          </Card>
          <p className="text-[11px] text-muted-foreground/60 mt-2 px-1">
            Aging based on funding date. Brokerages have the settlement window after closing to remit before any interest accrues.
          </p>
        </section>

        {/* By status */}
        <section aria-label="By status" className="mb-8">
          <Card className="border-border/40">
            <CardHeader className="py-3 px-5 border-b border-border/40">
              <CardTitle className="text-sm font-bold uppercase tracking-wider text-muted-foreground/70 flex items-center gap-2">
                <Activity size={14} className="text-primary" aria-hidden="true" />
                Deals by status
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {s.statusBuckets.size === 0 ? (
                <div className="px-6 py-12 text-center text-sm text-muted-foreground">
                  No deals on the books yet.
                </div>
              ) : (
                <div className="divide-y divide-border/30">
                  {Array.from(s.statusBuckets.entries())
                    .sort((a, b) => b[1].total_advance - a[1].total_advance)
                    .map(([status, bucket]) => (
                      <div key={status} className="px-5 py-3 flex items-center justify-between gap-4">
                        <div className="flex items-center gap-3 min-w-0">
                          <span className={`inline-flex px-2.5 py-0.5 text-[11px] font-semibold rounded-md whitespace-nowrap ${getStatusBadgeClass(status)}`}>
                            {formatStatusLabel(status)}
                          </span>
                          <span className="text-sm text-muted-foreground">{bucket.count} {bucket.count === 1 ? 'deal' : 'deals'}</span>
                        </div>
                        <span className="text-sm font-bold tabular-nums text-foreground">{formatCurrency(bucket.total_advance)}</span>
                      </div>
                    ))}
                </div>
              )}
            </CardContent>
          </Card>
        </section>

        {/* Recent funded */}
        <section aria-label="Recently funded">
          <Card className="border-border/40">
            <CardHeader className="py-3 px-5 border-b border-border/40">
              <CardTitle className="text-sm font-bold uppercase tracking-wider text-muted-foreground/70 flex items-center gap-2">
                <CheckCircle2 size={14} className="text-status-green" aria-hidden="true" />
                Recently funded
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {s.recentFunded.length === 0 ? (
                <div className="px-6 py-12 text-center text-sm text-muted-foreground">
                  No funded deals yet. Once funding kicks in, the most recent ones will show here.
                </div>
              ) : (
                <div className="divide-y divide-border/30">
                  {s.recentFunded.map(deal => (
                    <Link
                      key={deal.id}
                      href={`/admin/deals/${deal.id}`}
                      className="block px-5 py-3 hover:bg-white/[0.03] transition-colors"
                    >
                      <div className="flex items-center justify-between gap-4">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-foreground truncate">{deal.property_address}</p>
                          <p className="text-[11px] text-muted-foreground mt-0.5">
                            Funded {deal.funding_date ? formatDate(deal.funding_date) : '-'}
                          </p>
                        </div>
                        <span className={`inline-flex px-2.5 py-0.5 text-[11px] font-semibold rounded-md whitespace-nowrap ${getStatusBadgeClass(deal.status)}`}>
                          {formatStatusLabel(deal.status)}
                        </span>
                        <span className="text-sm font-bold tabular-nums text-primary tabular-nums">{formatCurrency(deal.advance_amount)}</span>
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </section>

        <div className="mt-8 flex justify-end">
          <Link
            href="/admin"
            className="inline-flex items-center justify-center h-8 px-3 text-sm font-medium rounded-md border border-border/50 text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors"
          >
            Back to dashboard
          </Link>
        </div>
      </main>
    </div>
  )
}
