'use server'

import { createServiceRoleClient } from '@/lib/supabase/server'
import { getAuthenticatedAdmin } from '@/lib/auth-helpers'
import { liveFailedDealInterestOwed, failedDealAccrualStartDate } from '@/lib/calculations'

type ActionResult<T = unknown> = { success: boolean; error?: string; data?: T }

export type RemediationSummary = {
  id: string
  status: 'pending' | 'idp_sent' | 'idp_signed' | 'remitted' | 'cancelled'
  directed_amount: number
  expected_payment_date: string | null
  property_address: string
  brokerage_legal_name: string
}

export type PendingCureElectionRow = {
  deal_id: string
  property_address: string
  failed_to_close_at: string
  cure_election: 'cash_repayment' | 'commission_assignment' | null
  cure_election_at: string | null
  cure_election_deadline: string | null
  outstanding_principal: number
  posted_interest: number
  live_interest_total: number
  unposted_interest: number
  live_balance_owed: number
  accrual_start_date: string
  in_grace_period: boolean
  agent: {
    id: string
    first_name: string | null
    last_name: string | null
    email: string | null
    brokerage_name: string | null
  }
  latest_remediation: RemediationSummary | null
}

export type CuredDealRow = {
  deal_id: string
  property_address: string
  failed_to_close_at: string
  cured_at: string  // best-guess: failed_deal_interest_calculated_at after fully cleared
  agent: {
    id: string
    first_name: string | null
    last_name: string | null
    email: string | null
  }
}

export type PendingCureElectionsResult = {
  pending: PendingCureElectionRow[]
  recently_cured: CuredDealRow[]
  as_of: string  // YYYY-MM-DD Toronto
}

// ============================================================================
// Get all failed-to-close deals with everything an admin needs to triage
// ============================================================================

export async function getPendingCureElections(): Promise<ActionResult<PendingCureElectionsResult>> {
  const { error: authErr, user } = await getAuthenticatedAdmin()
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  const serviceClient = createServiceRoleClient()
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' })

  try {
    const { data: failedDeals, error: failedErr } = await serviceClient
      .from('deals')
      .select(`
        id,
        property_address,
        failed_to_close_at,
        outstanding_balance,
        failed_deal_interest_charged,
        cure_election,
        cure_election_at,
        cure_election_deadline,
        agent_id,
        agents:agent_id (
          id,
          first_name,
          last_name,
          email,
          brokerage_id,
          brokerages:brokerage_id ( name )
        )
      `)
      .eq('status', 'failed_to_close')
      .order('failed_to_close_at', { ascending: true })

    if (failedErr) {
      console.error('getPendingCureElections failed deals error:', failedErr.message)
      return { success: false, error: failedErr.message }
    }

    const failedDealIds = (failedDeals || []).map(d => d.id)

    // Pull every remediation deal tied to these failed deals in one shot, then
    // pick the most recent per failed_deal_id.
    const remediationsByFailedDeal = new Map<string, RemediationSummary>()
    if (failedDealIds.length > 0) {
      const { data: remediations, error: remErr } = await serviceClient
        .from('remediation_deals')
        .select('id, failed_deal_id, status, directed_amount, expected_payment_date, property_address, brokerage_legal_name, created_at')
        .in('failed_deal_id', failedDealIds)
        .order('created_at', { ascending: false })

      if (remErr) {
        console.error('getPendingCureElections remediations error:', remErr.message)
      } else {
        for (const r of remediations || []) {
          if (!remediationsByFailedDeal.has(r.failed_deal_id)) {
            remediationsByFailedDeal.set(r.failed_deal_id, {
              id: r.id,
              status: r.status as RemediationSummary['status'],
              directed_amount: Number(r.directed_amount) || 0,
              expected_payment_date: r.expected_payment_date || null,
              property_address: r.property_address,
              brokerage_legal_name: r.brokerage_legal_name,
            })
          }
        }
      }
    }

    type FailedDealRow = {
      id: string
      property_address: string
      failed_to_close_at: string | null
      outstanding_balance: number | string | null
      failed_deal_interest_charged: number | string | null
      cure_election: string | null
      cure_election_at: string | null
      cure_election_deadline: string | null
      agent_id: string | null
      agents: {
        id: string
        first_name: string | null
        last_name: string | null
        email: string | null
        brokerage_id: string | null
        brokerages: { name: string | null } | null
      } | null
    }
    const pending: PendingCureElectionRow[] = ((failedDeals as unknown as FailedDealRow[]) || []).map((d) => {
      const agent = d.agents
      const brokerage = agent?.brokerages
      const principal = Number(d.outstanding_balance) || 0
      const postedInterest = Number(d.failed_deal_interest_charged) || 0
      const failedAt = d.failed_to_close_at ? (d.failed_to_close_at as string).slice(0, 10) : null
      const accrualStart = failedAt ? failedDealAccrualStartDate(failedAt) : ''
      const liveInterestTotal = failedAt ? liveFailedDealInterestOwed(principal, failedAt) : 0
      const unposted = Math.max(0, Math.round((liveInterestTotal - postedInterest) * 100) / 100)
      const liveBalance = Math.round((principal + liveInterestTotal) * 100) / 100
      const inGrace = accrualStart ? today < accrualStart : false

      return {
        deal_id: d.id,
        property_address: d.property_address,
        failed_to_close_at: d.failed_to_close_at as string,
        cure_election: d.cure_election as PendingCureElectionRow['cure_election'],
        cure_election_at: d.cure_election_at,
        cure_election_deadline: d.cure_election_deadline,
        outstanding_principal: principal,
        posted_interest: postedInterest,
        live_interest_total: liveInterestTotal,
        unposted_interest: unposted,
        live_balance_owed: liveBalance,
        accrual_start_date: accrualStart,
        in_grace_period: inGrace,
        agent: {
          id: agent?.id || d.agent_id || '',
          first_name: agent?.first_name || null,
          last_name: agent?.last_name || null,
          email: agent?.email || null,
          brokerage_name: brokerage?.name || null,
        },
        latest_remediation: remediationsByFailedDeal.get(d.id) || null,
      }
    })

    // Recently cured (last 90 days). `cured` status flips on the same write
    // that updates failed_deal_interest_calculated_at, so use that as the
    // cure timestamp.
    const ninetyDaysAgoMs = Date.now() - 90 * 24 * 60 * 60 * 1000
    const ninetyDaysAgoIso = new Date(ninetyDaysAgoMs).toISOString()

    const { data: curedDeals, error: curedErr } = await serviceClient
      .from('deals')
      .select(`
        id,
        property_address,
        failed_to_close_at,
        failed_deal_interest_calculated_at,
        agent_id,
        agents:agent_id ( id, first_name, last_name, email )
      `)
      .eq('status', 'cured')
      .gte('failed_deal_interest_calculated_at', ninetyDaysAgoIso)
      .order('failed_deal_interest_calculated_at', { ascending: false })

    if (curedErr) {
      console.error('getPendingCureElections cured deals error:', curedErr.message)
    }

    type CuredDealQueryRow = {
      id: string
      property_address: string
      failed_to_close_at: string
      failed_deal_interest_calculated_at: string | null
      agent_id: string | null
      agents: {
        id: string
        first_name: string | null
        last_name: string | null
        email: string | null
      } | null
    }
    const recentlyCured: CuredDealRow[] = ((curedDeals as unknown as CuredDealQueryRow[]) || []).map((d) => ({
      deal_id: d.id,
      property_address: d.property_address,
      failed_to_close_at: d.failed_to_close_at,
      cured_at: d.failed_deal_interest_calculated_at || d.failed_to_close_at,
      agent: {
        id: d.agents?.id || d.agent_id || '',
        first_name: d.agents?.first_name || null,
        last_name: d.agents?.last_name || null,
        email: d.agents?.email || null,
      },
    }))

    return {
      success: true,
      data: { pending, recently_cured: recentlyCured, as_of: today },
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'An unexpected error occurred'
    console.error('getPendingCureElections error:', message)
    return { success: false, error: message }
  }
}
