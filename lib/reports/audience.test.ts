import { describe, it, expect } from 'vitest'
import * as XLSX from 'xlsx'
import { reportToWorkbook } from './xlsx'
import { reportToPdf } from './pdf'
import type { ReportAudience, ReportPackage } from './types'

// Distinctive values chosen so they collide with nothing else in the fixture,
// letting a raw substring check prove a figure is present or absent.
const FEE_CHARGED = 7777 // the fee the agent paid (feesEarned / fee / discountFee)
const FEE_BASE = 8888 // total fees generated (revenue-share feeBase) - FF revenue
const FIRM_PROFIT = 6666 // Firm Funds gross profit
const SETTLEMENT_FEE = 5555 // settlement fee - part of what the agent paid
const REFERRAL = 4321 // the brokerage's referral cut
const AGENT_BALANCE = 1234

function fixture(audience: ReportAudience): ReportPackage {
  const isAgent = audience === 'agent'
  return {
    meta: {
      scope: isAgent ? 'agent' : 'brokerage',
      audience,
      scopeLabel: isAgent ? 'Test Agent' : 'Test Brokerage',
      periodLabel: 'All time',
      startDate: null,
      endDate: null,
      statusLabel: 'All statuses',
      generatedAtLabel: 'Jun 10, 2026',
    },
    summary: {
      fundedCount: 1,
      fundedAmount: 1000,
      feesEarned: FEE_CHARGED,
      collectedCount: 0,
      collectedAmount: 0,
      referralPaid: REFERRAL,
      firmProfit: FIRM_PROFIT,
      outstandingCount: 1,
      outstandingAmount: 700,
    },
    fundedDeals: [
      {
        date: '2026-06-01',
        dealNumber: '0001-0601-26',
        agentName: 'Test Agent',
        brokerageName: 'Test Brokerage',
        advanceAmount: 1000,
        days: 30,
        fee: FEE_CHARGED,
        status: 'funded',
      },
    ],
    collections: [],
    revenueShare: [
      { brokerageName: 'Test Brokerage', feeBase: FEE_BASE, sharePct: 20, shareAmount: REFERRAL, remitted: 0 },
    ],
    aging: [{ label: '0 to 30 days', count: 1, amount: 700 }],
    failedDeals: [],
    dealDetail: [
      {
        dealNumber: '0001-0601-26',
        status: 'funded',
        agentName: 'Test Agent',
        brokerageName: 'Test Brokerage',
        property: '1 Test St',
        grossCommission: 2000,
        netCommission: 1900,
        discountFee: FEE_CHARGED,
        settlementFee: SETTLEMENT_FEE,
        advanceAmount: 1000,
        referralFee: REFERRAL,
        amountDueFromBrokerage: 700,
        fundingDate: '2026-06-01',
        closingDate: '2026-07-01',
        repaymentDate: null,
        createdAt: '2026-06-01',
      },
    ],
    agentLedger: isAgent
      ? [{ date: '2026-06-01', type: 'deal_advance', description: 'Advance issued', amount: 1000, runningBalance: AGENT_BALANCE }]
      : undefined,
    agentBalance: isAgent ? AGENT_BALANCE : undefined,
    notes: ['Test note.'],
  }
}

// Collect every RAW cell value (v, never the formatted w) across all sheets, so
// a currency-formatted leak like "$7,777.00" can't slip past a substring check.
function allRawValues(wb: XLSX.WorkBook): string {
  const out: string[] = []
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name]
    for (const addr of Object.keys(ws)) {
      if (addr[0] === '!') continue
      const cell = ws[addr] as XLSX.CellObject
      if (cell && cell.v != null) out.push(String(cell.v))
    }
  }
  return out.join('\n')
}

describe('report exports - audience margin stripping', () => {
  it('internal Excel includes Firm Funds margin figures', () => {
    const text = allRawValues(XLSX.read(reportToWorkbook(fixture('internal')), { type: 'buffer' }))
    expect(text).toContain(String(FEE_CHARGED))
    expect(text).toContain(String(FEE_BASE))
    expect(text).toContain(String(FIRM_PROFIT))
    expect(text).toContain(String(SETTLEMENT_FEE))
    expect(text.toLowerCase()).toContain('gross profit')
  })

  it('brokerage Excel hides Firm Funds margin but keeps their referral earnings', () => {
    const text = allRawValues(XLSX.read(reportToWorkbook(fixture('brokerage')), { type: 'buffer' }))
    expect(text).not.toContain(String(FEE_CHARGED))
    expect(text).not.toContain(String(FEE_BASE))
    expect(text).not.toContain(String(FIRM_PROFIT))
    expect(text).not.toContain(String(SETTLEMENT_FEE))
    expect(text.toLowerCase()).not.toContain('gross profit')
    expect(text.toLowerCase()).not.toContain('fees earned')
    // Their own money is present.
    expect(text).toContain('Referral earnings')
    expect(text).toContain(String(REFERRAL))
  })

  it('agent Excel shows the fee they paid but hides our profit and the brokerage cut', () => {
    const text = allRawValues(XLSX.read(reportToWorkbook(fixture('agent')), { type: 'buffer' }))
    // Fees THEY paid are shown (it's their money / a deductible expense).
    expect(text).toContain(String(FEE_CHARGED))
    expect(text).toContain(String(SETTLEMENT_FEE))
    expect(text).toContain('Fees you paid')
    expect(text).toContain('Current balance')
    expect(text).toContain(String(AGENT_BALANCE))
    // Our profit, the FF revenue base, and the brokerage's referral cut are gone.
    expect(text).not.toContain(String(FIRM_PROFIT))
    expect(text).not.toContain(String(FEE_BASE))
    expect(text).not.toContain(String(REFERRAL))
    expect(text.toLowerCase()).not.toContain('gross profit')
    expect(text.toLowerCase()).not.toContain('referral earnings')
    expect(text.toLowerCase()).not.toContain('owed to firm funds')
  })

  it('brokerage and agent PDFs render without error', async () => {
    for (const audience of ['brokerage', 'agent'] as const) {
      const bytes = await reportToPdf(fixture(audience))
      expect(bytes.length).toBeGreaterThan(1000)
      expect(String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3], bytes[4])).toBe('%PDF-')
    }
  })
})
