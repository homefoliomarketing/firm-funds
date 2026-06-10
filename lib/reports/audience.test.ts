import { describe, it, expect } from 'vitest'
import * as XLSX from 'xlsx'
import { reportToWorkbook } from './xlsx'
import { reportToPdf } from './pdf'
import type { ReportPackage } from './types'

// Distinctive Firm Funds margin values that must NEVER appear in a brokerage
// report. Chosen so they collide with nothing else in the fixture.
const FEE_CHARGED = 7777
const FEE_BASE = 8888
const FIRM_PROFIT = 6666
const SETTLEMENT_FEE = 5555

function fixture(audience: 'internal' | 'brokerage'): ReportPackage {
  return {
    meta: {
      scope: 'brokerage',
      audience,
      scopeLabel: 'Test Brokerage',
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
      referralPaid: 50,
      firmProfit: FIRM_PROFIT,
      outstandingCount: 1,
      outstandingAmount: 900,
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
      { brokerageName: 'Test Brokerage', feeBase: FEE_BASE, sharePct: 20, shareAmount: 50, remitted: 0 },
    ],
    aging: [{ label: '0 to 30 days', count: 1, amount: 900 }],
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
        referralFee: 50,
        amountDueFromBrokerage: 900,
        fundingDate: '2026-06-01',
        closingDate: '2026-07-01',
        repaymentDate: null,
        createdAt: '2026-06-01',
      },
    ],
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

describe('report exports — audience margin stripping', () => {
  it('internal Excel includes Firm Funds margin figures', () => {
    const wb = XLSX.read(reportToWorkbook(fixture('internal')), { type: 'buffer' })
    const text = allRawValues(wb)
    expect(text).toContain(String(FEE_CHARGED))
    expect(text).toContain(String(FEE_BASE))
    expect(text).toContain(String(FIRM_PROFIT))
    expect(text).toContain(String(SETTLEMENT_FEE))
    expect(text.toLowerCase()).toContain('gross profit')
  })

  it('brokerage Excel hides every Firm Funds margin figure', () => {
    const wb = XLSX.read(reportToWorkbook(fixture('brokerage')), { type: 'buffer' })
    const text = allRawValues(wb)
    // Our margin: fee charged, fee base, gross profit, settlement fee — all gone.
    expect(text).not.toContain(String(FEE_CHARGED))
    expect(text).not.toContain(String(FEE_BASE))
    expect(text).not.toContain(String(FIRM_PROFIT))
    expect(text).not.toContain(String(SETTLEMENT_FEE))
    expect(text.toLowerCase()).not.toContain('gross profit')
    expect(text.toLowerCase()).not.toContain('fees earned')
    // Their own stuff is still present.
    expect(text).toContain('Referral earnings')
    expect(text).toContain('1000') // advance to their agent
    expect(text).toContain('900') // owed to Firm Funds
  })

  it('brokerage PDF renders without error', async () => {
    const bytes = await reportToPdf(fixture('brokerage'))
    expect(bytes.length).toBeGreaterThan(1000)
    // %PDF- magic header.
    expect(String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3], bytes[4])).toBe('%PDF-')
  })
})
