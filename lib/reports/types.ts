// Shared data contract for the financial reporting + export system.
// A ReportPackage is the single normalized object that feeds BOTH the
// Excel (xlsx) generator and the branded PDF generator, so the two exports
// always agree. Built by lib/reports/build.ts; consumed by lib/reports/xlsx.ts,
// lib/reports/pdf.ts, and the /api/admin/reports/export route.

export type ReportScope = 'company' | 'brokerage' | 'agent'

export interface ReportFilters {
  scope: ReportScope
  // brokerage_id when scope === 'brokerage', agent_id when scope === 'agent'
  scopeId?: string | null
  // Inclusive YYYY-MM-DD bounds. Null means open-ended (all time).
  startDate?: string | null
  endDate?: string | null
  // Optional deal status filter ('all' or null = every status).
  status?: string | null
}

export interface ReportMeta {
  scope: ReportScope
  scopeLabel: string // 'All brokerages (whole company)' | brokerage name | agent name
  scopeSubLabel?: string // e.g. the brokerage name shown under an agent report
  periodLabel: string // 'May 1, 2026 to May 31, 2026' or 'All time'
  startDate: string | null
  endDate: string | null
  statusLabel: string
  generatedAtLabel: string
}

export interface ReportSummary {
  fundedCount: number
  fundedAmount: number // sum of advance_amount for deals funded in the period
  feesEarned: number // sum of discount_fee for deals funded in the period
  collectedCount: number
  collectedAmount: number // sum of amount_due_from_brokerage collected in the period
  referralPaid: number // sum of brokerage_referral_fee for deals funded in the period
  firmProfit: number // feesEarned - referralPaid (gross profit, before operating expenses)
  outstandingCount: number // open 'funded' receivables, as of now
  outstandingAmount: number // sum of amount_due_from_brokerage for those open receivables
}

export interface FundedRow {
  date: string // funding_date
  dealNumber: string | null
  agentName: string
  brokerageName: string
  advanceAmount: number
  days: number
  fee: number // discount_fee
  status: string
}

export interface CollectionRow {
  paidDate: string
  fundedDate: string | null
  dealNumber: string | null
  agentName: string
  brokerageName: string
  amount: number // amount_due_from_brokerage
}

export interface RevenueShareRow {
  brokerageName: string
  feeBase: number // total fees generated on their deals (discount + settlement)
  sharePct: number // whole-number percent, for display
  shareAmount: number // brokerage_referral_fee earned
  remitted: number // broker_share_amount already paid out
}

export interface AgingBucket {
  label: string
  count: number
  amount: number
  flagged?: boolean
}

export interface FailedRow {
  dealNumber: string | null
  agentName: string
  brokerageName: string
  advanceAmount: number
  outstanding: number
  interestAccrued: number
  failedAt: string | null
  status: string // 'failed_to_close' | 'cured'
}

export interface DealDetailRow {
  dealNumber: string | null
  status: string
  agentName: string
  brokerageName: string
  property: string
  grossCommission: number
  netCommission: number
  discountFee: number
  settlementFee: number
  advanceAmount: number
  referralFee: number
  amountDueFromBrokerage: number
  fundingDate: string | null
  closingDate: string | null
  repaymentDate: string | null
  createdAt: string
}

export interface AgentLedgerLine {
  date: string
  type: string
  description: string
  amount: number
  runningBalance: number
}

export interface ReportPackage {
  meta: ReportMeta
  summary: ReportSummary
  fundedDeals: FundedRow[]
  collections: CollectionRow[]
  revenueShare: RevenueShareRow[]
  aging: AgingBucket[]
  failedDeals: FailedRow[]
  dealDetail: DealDetailRow[]
  agentLedger?: AgentLedgerLine[] // present only for agent-scoped reports
  agentBalance?: number // present only for agent-scoped reports
  notes: string[] // plain-language footnotes for the accountant
}

// Lightweight lists used to populate the report scope pickers in the UI.
export interface ReportTargets {
  brokerages: { id: string; name: string }[]
  agents: { id: string; name: string; brokerageId: string | null; brokerageName: string }[]
}
