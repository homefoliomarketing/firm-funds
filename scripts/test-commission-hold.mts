/**
 * scripts/test-commission-hold.mts
 *
 * Unit checks for the pure commission-hold decision logic. No DB.
 * Run:  npx tsx scripts/test-commission-hold.mts
 */
import {
  shouldHoldForCommission,
  mapsCommissionColumns,
  parseMoneyCell,
  cellByLetter,
} from '../lib/firm-deal-detection/commission-hold-rules'
import type { ParsedFirmDeal } from '../lib/firm-deal-detection/parse-event'

let pass = 0
let fail = 0
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) {
    pass++
    console.log(`  ok   ${name}`)
  } else {
    fail++
    console.log(`  FAIL ${name}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`)
  }
}

function parsed(over: Partial<ParsedFirmDeal>): ParsedFirmDeal {
  return {
    address: '150 Pittsburgh Ave',
    mls_number: null,
    listing_agent_raw: 'Ken',
    selling_agent_raw: null,
    closing_date_iso: '2026-08-13',
    sale_price: null,
    commission_pct_listing: null,
    commission_pct_selling: null,
    listing_agent_commission_amount: null,
    selling_agent_commission_amount: null,
    confidence: 'high',
    parser_notes: null,
    ...over,
  }
}

const COLS_WITH_COMMISSION = { listing_agent_commission: 'H', selling_agent_commission: 'I' }
const COLS_NO_COMMISSION = { listing_agent: 'D', selling_agent: 'E' }

console.log('shouldHoldForCommission:')
// HOLD: date + commission columns mapped + no amounts + not split
check('date + cols + no amount -> HOLD',
  shouldHoldForCommission({ parsed: parsed({}), columnMapping: COLS_WITH_COMMISSION, coAgentSplit: false }),
  true)
// NO HOLD: listing amount already present
check('listing amount present -> no hold',
  shouldHoldForCommission({ parsed: parsed({ listing_agent_commission_amount: 12750 }), columnMapping: COLS_WITH_COMMISSION, coAgentSplit: false }),
  false)
// NO HOLD: selling amount already present
check('selling amount present -> no hold',
  shouldHoldForCommission({ parsed: parsed({ selling_agent_commission_amount: 9000 }), columnMapping: COLS_WITH_COMMISSION, coAgentSplit: false }),
  false)
// NO HOLD: pipe has no commission columns (nothing will ever appear)
check('no commission columns -> no hold',
  shouldHoldForCommission({ parsed: parsed({}), columnMapping: COLS_NO_COMMISSION, coAgentSplit: false }),
  false)
// NO HOLD: no closing date (no Tier C upside)
check('no closing date -> no hold',
  shouldHoldForCommission({ parsed: parsed({ closing_date_iso: null }), columnMapping: COLS_WITH_COMMISSION, coAgentSplit: false }),
  false)
// NO HOLD: co-agent split always sends generic
check('co-agent split -> no hold',
  shouldHoldForCommission({ parsed: parsed({}), columnMapping: COLS_WITH_COMMISSION, coAgentSplit: true }),
  false)
// NO HOLD: amount is zero counts as missing-but... zero amount + cols => still HOLD (0 is "missing")
check('zero amount counts as missing -> HOLD',
  shouldHoldForCommission({ parsed: parsed({ listing_agent_commission_amount: 0 }), columnMapping: COLS_WITH_COMMISSION, coAgentSplit: false }),
  true)
// NO HOLD: null column mapping
check('null column mapping -> no hold',
  shouldHoldForCommission({ parsed: parsed({}), columnMapping: null, coAgentSplit: false }),
  false)

console.log('mapsCommissionColumns:')
check('listing only', mapsCommissionColumns({ listing_agent_commission: 'H' }), true)
check('selling only', mapsCommissionColumns({ selling_agent_commission: 'I' }), true)
check('neither', mapsCommissionColumns({ address: 'A' }), false)
check('null', mapsCommissionColumns(null), false)

console.log('parseMoneyCell:')
check('$12,750', parseMoneyCell('$12,750'), 12750)
check('12750', parseMoneyCell('12750'), 12750)
check('12,750.50 rounds', parseMoneyCell('12,750.50'), 12751)
check('with spaces', parseMoneyCell('  $9,000 '), 9000)
check('percentage -> null', parseMoneyCell('3.5%'), null)
check('blank -> null', parseMoneyCell(''), null)
check('n/a -> null', parseMoneyCell('n/a'), null)
check('zero -> null', parseMoneyCell('0'), null)
check('null -> null', parseMoneyCell(null), null)

console.log('cellByLetter:')
const row = ['addr', 'mls', 'c', 'd', 'e', 'f', 'g', '$12,750']
check("col 'A'", cellByLetter(row, 'A'), 'addr')
check("col 'H'", cellByLetter(row, 'H'), '$12,750')
check('missing letter', cellByLetter(row, undefined), '')
check('out of range', cellByLetter(row, 'Z'), '')

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
