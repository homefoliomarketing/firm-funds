// Builds a normalized ReportPackage from live deal data. This is the single
// source of truth feeding both the Excel and branded-PDF exporters, so the
// numbers are computed once here and never re-derived in the generators.
//
// Money semantics (verified against docs/architecture/database.md):
//  - There is NO deals.funded_at / deals.completed_at. Money-out date is
//    deals.funding_date (DATE); money-back is deals.repayment_date / status.
//  - Revenue convention matches the existing reports: a deal counts once its
//    money has moved (status in funded/completed/failed_to_close/cured).
//  - advance_amount = cash to the agent; discount_fee = our fee; the brokerage
//    repays amount_due_from_brokerage; brokerage_referral_fee is their share.

import { createServiceRoleClient } from '@/lib/supabase/server'
import type {
  ReportFilters,
  ReportPackage,
  ReportMeta,
  ReportSummary,
  FundedRow,
  CollectionRow,
  RevenueShareRow,
  AgingBucket,
  FailedRow,
  DealDetailRow,
  AgentLedgerLine,
  ReportTargets,
} from './types'

const MONEY_MOVED = ['funded', 'completed', 'failed_to_close', 'cured']

function torontoToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Toronto',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}

function longDate(ymdValue: string | null): string {
  if (!ymdValue) return ''
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Toronto',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(new Date(ymdValue.slice(0, 10) + 'T12:00:00Z'))
}

function ymd(value: string | null): string | null {
  return value ? value.slice(0, 10) : null
}

function inPeriod(dateStr: string | null, start: string | null, end: string | null): boolean {
  const d = ymd(dateStr)
  if (!d) return false
  if (start && d < start) return false
  if (end && d > end) return false
  return true
}

function daysBetween(fromYmd: string, toYmd: string): number {
  const a = new Date(fromYmd + 'T12:00:00Z').getTime()
  const b = new Date(toYmd + 'T12:00:00Z').getTime()
  return Math.floor((b - a) / 86400000)
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

function round(v: number): number {
  return Math.round(v * 100) / 100
}

type Embed<T> = T | T[] | null
function one<T>(e: Embed<T>): T | null {
  if (!e) return null
  return Array.isArray(e) ? e[0] ?? null : e
}

interface RawAgent {
  first_name: string | null
  last_name: string | null
}
interface RawBrokerage {
  name: string | null
  profit_share_pct: number | null
  referral_fee_percentage: number | null
}
interface RawDeal {
  id: string
  deal_number: string | null
  status: string
  property_address: string | null
  days_until_closing: number | null
  gross_commission: number | null
  net_commission: number | null
  discount_fee: number | null
  settlement_period_fee: number | null
  advance_amount: number | null
  brokerage_referral_fee: number | null
  amount_due_from_brokerage: number | null
  broker_share_amount: number | null
  broker_share_remitted: boolean | null
  outstanding_balance: number | null
  failed_deal_interest_charged: number | null
  failed_to_close_at: string | null
  funding_date: string | null
  closing_date: string | null
  actual_closing_date: string | null
  due_date: string | null
  repayment_date: string | null
  created_at: string
  brokerage_id: string | null
  agent_id: string | null
  agent: Embed<RawAgent>
  brokerage: Embed<RawBrokerage>
}

const DEAL_COLUMNS = `
  id, deal_number, status, property_address, days_until_closing,
  gross_commission, net_commission, discount_fee, settlement_period_fee,
  advance_amount, brokerage_referral_fee, amount_due_from_brokerage,
  broker_share_amount, broker_share_remitted, outstanding_balance,
  failed_deal_interest_charged, failed_to_close_at,
  funding_date, closing_date, actual_closing_date, due_date, repayment_date, created_at,
  brokerage_id, agent_id,
  agent:agents(first_name, last_name),
  brokerage:brokerages(name, profit_share_pct, referral_fee_percentage)
`

function agentName(d: RawDeal): string {
  const a = one(d.agent)
  if (!a) return 'Unknown agent'
  return [a.first_name, a.last_name].filter(Boolean).join(' ').trim() || 'Unknown agent'
}
function brokerageName(d: RawDeal): string {
  return one(d.brokerage)?.name?.trim() || 'Unknown brokerage'
}

export async function buildReportPackage(filters: ReportFilters): Promise<ReportPackage> {
  const supabase = createServiceRoleClient()
  const start = filters.startDate || null
  const end = filters.endDate || null
  const today = torontoToday()
  const statusFilter = filters.status && filters.status !== 'all' ? filters.status : null
  const audience = filters.audience || 'internal'

  let query = supabase
    .from('deals')
    .select(DEAL_COLUMNS)
    .neq('status', 'offered')
    .order('created_at', { ascending: false })
    .limit(10000)
  if (filters.scope === 'brokerage' && filters.scopeId) query = query.eq('brokerage_id', filters.scopeId)
  if (filters.scope === 'agent' && filters.scopeId) query = query.eq('agent_id', filters.scopeId)

  const { data, error } = await query
  if (error) throw new Error(`Report query failed: ${error.message}`)
  const deals = (data ?? []) as unknown as RawDeal[]

  // Funded in period (money-out events).
  const fundedDeals: FundedRow[] = deals
    .filter((d) => MONEY_MOVED.includes(d.status) && inPeriod(d.funding_date, start, end))
    .filter((d) => !statusFilter || d.status === statusFilter)
    .map((d) => ({
      date: ymd(d.funding_date) || '',
      dealNumber: d.deal_number,
      agentName: agentName(d),
      brokerageName: brokerageName(d),
      advanceAmount: num(d.advance_amount),
      days: num(d.days_until_closing),
      fee: num(d.discount_fee),
      status: d.status,
    }))
    .sort((a, b) => (a.date < b.date ? 1 : -1))

  // Collections in period (money-back).
  const collections: CollectionRow[] = deals
    .filter(
      (d) =>
        d.status === 'completed' &&
        inPeriod(d.repayment_date || d.actual_closing_date || d.closing_date, start, end),
    )
    .map((d) => ({
      paidDate: ymd(d.repayment_date || d.actual_closing_date || d.closing_date) || '',
      fundedDate: ymd(d.funding_date),
      dealNumber: d.deal_number,
      agentName: agentName(d),
      brokerageName: brokerageName(d),
      amount: num(d.amount_due_from_brokerage),
    }))
    .sort((a, b) => (a.paidDate < b.paidDate ? 1 : -1))

  // Revenue share by brokerage (over deals funded in the period).
  const shareMap = new Map<string, RevenueShareRow>()
  for (const d of deals) {
    if (!MONEY_MOVED.includes(d.status) || !inPeriod(d.funding_date, start, end)) continue
    const key = brokerageName(d)
    const b = one(d.brokerage)
    const pct = num(b?.profit_share_pct) || num(b?.referral_fee_percentage) * 100
    const row =
      shareMap.get(key) || { brokerageName: key, feeBase: 0, sharePct: round(pct), shareAmount: 0, remitted: 0 }
    row.feeBase += num(d.discount_fee) + num(d.settlement_period_fee)
    row.shareAmount += num(d.brokerage_referral_fee)
    if (d.broker_share_remitted) row.remitted += num(d.broker_share_amount)
    shareMap.set(key, row)
  }
  const revenueShare = Array.from(shareMap.values())
    .filter((r) => r.shareAmount > 0 || r.feeBase > 0)
    .map((r) => ({ ...r, feeBase: round(r.feeBase), shareAmount: round(r.shareAmount), remitted: round(r.remitted) }))
    .sort((a, b) => b.shareAmount - a.shareAmount)

  // Aging - point-in-time snapshot of open 'funded' receivables by days outstanding.
  const agingDefs = [
    { label: '0 to 30 days', min: 0, max: 30 },
    { label: '31 to 60 days', min: 31, max: 60 },
    { label: '61 to 90 days', min: 61, max: 90 },
    { label: '90+ days', min: 91, max: Number.POSITIVE_INFINITY },
  ]
  const aging: AgingBucket[] = agingDefs.map((def) => ({ label: def.label, count: 0, amount: 0 }))
  let flaggedCount = 0
  let flaggedAmount = 0
  for (const d of deals) {
    if (d.status === 'funded') {
      const fundedYmd = ymd(d.funding_date) || today
      const age = Math.max(0, daysBetween(fundedYmd, today))
      const idx = agingDefs.findIndex((def) => age >= def.min && age <= def.max)
      const bucket = aging[idx >= 0 ? idx : aging.length - 1]
      if (bucket) {
        bucket.count += 1
        bucket.amount += num(d.amount_due_from_brokerage)
      }
    } else if (d.status === 'failed_to_close') {
      flaggedCount += 1
      flaggedAmount += num(d.outstanding_balance)
    }
  }
  for (const b of aging) b.amount = round(b.amount)
  if (flaggedCount > 0) {
    aging.push({ label: 'Flagged / in remediation', count: flaggedCount, amount: round(flaggedAmount), flagged: true })
  }

  // Failed / cured deals (ongoing liabilities, shown regardless of period).
  const failedDeals: FailedRow[] = deals
    .filter((d) => d.status === 'failed_to_close' || d.status === 'cured')
    .map((d) => ({
      dealNumber: d.deal_number,
      agentName: agentName(d),
      brokerageName: brokerageName(d),
      advanceAmount: num(d.advance_amount),
      outstanding: num(d.outstanding_balance),
      interestAccrued: num(d.failed_deal_interest_charged),
      failedAt: ymd(d.failed_to_close_at),
      status: d.status,
    }))

  // Full deal list (period-scoped by created_at or funding_date when a period is set).
  const dealDetail: DealDetailRow[] = deals
    .filter((d) => (!start && !end ? true : inPeriod(d.created_at, start, end) || inPeriod(d.funding_date, start, end)))
    .filter((d) => !statusFilter || d.status === statusFilter)
    .map((d) => ({
      dealNumber: d.deal_number,
      status: d.status,
      agentName: agentName(d),
      brokerageName: brokerageName(d),
      property: d.property_address || '',
      grossCommission: num(d.gross_commission),
      netCommission: num(d.net_commission),
      discountFee: num(d.discount_fee),
      settlementFee: num(d.settlement_period_fee),
      advanceAmount: num(d.advance_amount),
      referralFee: num(d.brokerage_referral_fee),
      amountDueFromBrokerage: num(d.amount_due_from_brokerage),
      fundingDate: ymd(d.funding_date),
      closingDate: ymd(d.closing_date),
      repaymentDate: ymd(d.repayment_date),
      createdAt: ymd(d.created_at) || '',
    }))

  // Summary metrics.
  const feesEarned = fundedDeals.reduce((s, r) => s + r.fee, 0)
  const fundedAmount = fundedDeals.reduce((s, r) => s + r.advanceAmount, 0)
  const referralPaid = deals
    .filter((d) => MONEY_MOVED.includes(d.status) && inPeriod(d.funding_date, start, end))
    .reduce((s, d) => s + num(d.brokerage_referral_fee), 0)
  const collectedAmount = collections.reduce((s, r) => s + r.amount, 0)
  const openFunded = deals.filter((d) => d.status === 'funded')
  const summary: ReportSummary = {
    fundedCount: fundedDeals.length,
    fundedAmount: round(fundedAmount),
    feesEarned: round(feesEarned),
    collectedCount: collections.length,
    collectedAmount: round(collectedAmount),
    referralPaid: round(referralPaid),
    firmProfit: round(feesEarned - referralPaid),
    outstandingCount: openFunded.length,
    outstandingAmount: round(openFunded.reduce((s, d) => s + num(d.amount_due_from_brokerage), 0)),
  }

  const scopeLabel = await resolveScopeLabel(supabase, filters)
  const meta: ReportMeta = {
    scope: filters.scope,
    audience,
    scopeLabel: scopeLabel.label,
    scopeSubLabel: scopeLabel.subLabel,
    periodLabel:
      start || end
        ? `${start ? longDate(start) : 'Beginning'} to ${end ? longDate(end) : longDate(today)}`
        : 'All time',
    startDate: start,
    endDate: end,
    statusLabel: statusFilter || 'All statuses',
    generatedAtLabel: longDate(today),
  }

  // Agent ledger (agent-scoped reports only).
  let agentLedger: AgentLedgerLine[] | undefined
  let agentBalance: number | undefined
  if (filters.scope === 'agent' && filters.scopeId) {
    const { data: txns } = await supabase
      .from('agent_transactions')
      .select('created_at, type, amount, running_balance, description')
      .eq('agent_id', filters.scopeId)
      .order('created_at', { ascending: false })
      .limit(1000)
    agentLedger = (txns ?? []).map((t: Record<string, unknown>) => ({
      date: ymd((t.created_at as string) ?? null) || '',
      type: String(t.type ?? ''),
      description: String(t.description ?? ''),
      amount: num(t.amount),
      runningBalance: num(t.running_balance),
    }))
    const { data: ag } = await supabase
      .from('agents')
      .select('account_balance')
      .eq('id', filters.scopeId)
      .single()
    agentBalance = num((ag as Record<string, unknown> | null)?.account_balance)
  }

  // Brokerage audience: strip every Firm Funds margin figure from the data
  // itself (defence in depth - the generators also hide these), so the bytes a
  // brokerage downloads never contain our fee, total revenue, or gross profit.
  if (audience === 'brokerage') {
    summary.feesEarned = 0
    summary.firmProfit = 0
    for (const r of fundedDeals) r.fee = 0
    for (const r of dealDetail) {
      r.discountFee = 0
      r.settlementFee = 0
    }
    for (const r of revenueShare) r.feeBase = 0
  } else if (audience === 'agent') {
    // Agent statement: keep the fees THEY paid, but strip our gross profit and
    // the brokerage's referral cut, and drop the brokerage/Firm-Funds AR
    // sections (revenue share, aging, collections) that are not the agent's
    // own transactions. The generators render only the agent-relevant sections.
    summary.firmProfit = 0
    summary.referralPaid = 0
    revenueShare.length = 0
    aging.length = 0
    collections.length = 0
    for (const r of dealDetail) {
      r.referralFee = 0
      r.amountDueFromBrokerage = 0
    }
  }

  let notes: string[]
  if (audience === 'brokerage') {
    notes = [
      'This report shows your brokerage deals, the advances your agents received, your referral earnings, what your brokerage owes Firm Funds, and aging.',
      'Firm Funds fees, revenue, and margin are not shown.',
      'Aging and outstanding balances are a point-in-time snapshot as of the generated date, regardless of the selected period.',
    ]
  } else if (audience === 'agent') {
    notes = [
      'This statement shows your deals, the advances you received, the fees you paid Firm Funds, your current balance, and your transaction ledger.',
      'The fees you paid Firm Funds may be a deductible business expense; confirm with your accountant.',
      'Your current balance is what you owe Firm Funds (a positive number) or your credit (a negative number) as of the generated date.',
    ]
  } else {
    notes = [
      'Advances are recorded as a receivable (an asset owed back to Firm Funds), not an expense.',
      'Operating expenses (rent, payroll, software, insurance) are tracked in your accounting software, not in Firm Funds. This report covers fee revenue, advances, collections, brokerage share, and amounts owed.',
      'Aging and outstanding balances are a point-in-time snapshot as of the generated date, regardless of the selected period.',
    ]
  }

  return {
    meta,
    summary,
    fundedDeals,
    collections,
    revenueShare,
    aging,
    failedDeals,
    dealDetail,
    agentLedger,
    agentBalance,
    notes,
  }
}

async function resolveScopeLabel(
  supabase: ReturnType<typeof createServiceRoleClient>,
  filters: ReportFilters,
): Promise<{ label: string; subLabel?: string }> {
  if (filters.scope === 'company') return { label: 'All brokerages (whole company)' }
  if (filters.scope === 'brokerage' && filters.scopeId) {
    const { data } = await supabase.from('brokerages').select('name').eq('id', filters.scopeId).single()
    const name = (data as { name: string | null } | null)?.name
    return { label: name || 'Brokerage' }
  }
  if (filters.scope === 'agent' && filters.scopeId) {
    const { data } = await supabase
      .from('agents')
      .select('first_name, last_name, brokerage:brokerages(name)')
      .eq('id', filters.scopeId)
      .single()
    const a = data as { first_name: string | null; last_name: string | null; brokerage: Embed<{ name: string | null }> } | null
    const nm = a ? [a.first_name, a.last_name].filter(Boolean).join(' ') : 'Agent'
    const br = one(a?.brokerage ?? null)?.name || undefined
    return { label: nm || 'Agent', subLabel: br }
  }
  return { label: 'Report' }
}

// Lightweight lists for the report scope pickers in the UI.
export async function listReportTargets(): Promise<ReportTargets> {
  const supabase = createServiceRoleClient()
  const [{ data: brokerages }, { data: agents }] = await Promise.all([
    supabase.from('brokerages').select('id, name').order('name'),
    supabase.from('agents').select('id, first_name, last_name, brokerage_id, brokerage:brokerages(name)').order('last_name'),
  ])
  return {
    brokerages: ((brokerages ?? []) as Array<{ id: string; name: string | null }>).map((b) => ({
      id: b.id,
      name: b.name || 'Unnamed brokerage',
    })),
    agents: (
      (agents ?? []) as Array<{
        id: string
        first_name: string | null
        last_name: string | null
        brokerage_id: string | null
        brokerage: Embed<{ name: string | null }>
      }>
    ).map((a) => ({
      id: a.id,
      name: [a.first_name, a.last_name].filter(Boolean).join(' ') || 'Unnamed agent',
      brokerageId: a.brokerage_id ?? null,
      brokerageName: one(a.brokerage)?.name || '',
    })),
  }
}
