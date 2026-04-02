'use server'

import { createClient } from '@/lib/supabase/server'

// ============================================================================
// Types
// ============================================================================

interface ActionResult<T = Record<string, unknown>> {
  success: boolean
  error?: string
  data?: T
}

export interface ReportMetrics {
  // Summary KPIs
  totalRevenue: number          // sum of discount_fee on funded/repaid/closed deals
  totalAdvanced: number         // sum of advance_amount on funded/repaid/closed deals
  totalReferralFeesPaid: number // sum of brokerage_referral_fee on funded/repaid/closed
  totalProfit: number           // revenue - referral fees
  avgDiscountFee: number        // average discount_fee across funded/repaid/closed
  avgDaysToClose: number        // average days_until_closing on funded deals
  totalDeals: number
  conversionRate: number        // funded+repaid+closed / total deals (%)

  // Pipeline breakdown
  pipeline: {
    under_review: number
    approved: number
    funded: number
    repaid: number
    closed: number
    denied: number
    cancelled: number
  }

  // Monthly trends (last 12 months)
  monthlyTrends: {
    month: string   // YYYY-MM
    label: string   // "Jan 2026"
    deals: number
    revenue: number
    advanced: number
    profit: number
  }[]

  // Brokerage performance
  brokeragePerformance: {
    id: string
    name: string
    brand: string | null
    totalDeals: number
    fundedDeals: number
    totalAdvanced: number
    totalReferralFees: number
    avgDealSize: number
  }[]

  // Raw deals for export
  exportDeals: {
    id: string
    property_address: string
    status: string
    gross_commission: number
    brokerage_split_pct: number
    net_commission: number
    discount_fee: number
    advance_amount: number
    brokerage_referral_fee: number
    days_until_closing: number
    closing_date: string
    funding_date: string | null
    created_at: string
    agent_name: string
    brokerage_name: string
  }[]
}

// ============================================================================
// Helper: get authenticated admin user
// ============================================================================

async function getAuthenticatedAdmin() {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return { error: 'Not authenticated', user: null, profile: null, supabase }
  }

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('*')
    .eq('id', user.id)
    .single()

  if (!profile) {
    return { error: 'User profile not found', user, profile: null, supabase }
  }

  if (!['super_admin', 'firm_funds_admin'].includes(profile.role)) {
    return { error: 'Insufficient permissions', user, profile, supabase }
  }

  return { error: null, user, profile, supabase }
}

// ============================================================================
// Fetch Report Metrics
// ============================================================================

export async function fetchReportMetrics(input: {
  dateRange: 'last_7' | 'last_30' | 'last_90' | 'ytd' | 'all'
}): Promise<ActionResult<ReportMetrics>> {
  const { error: authErr, supabase } = await getAuthenticatedAdmin()
  if (authErr || !supabase) return { success: false, error: authErr || 'Authentication failed' }

  try {
    // Calculate date filter
    const now = new Date()
    let dateFilter: string | null = null

    switch (input.dateRange) {
      case 'last_7': {
        const d = new Date(now)
        d.setDate(d.getDate() - 7)
        dateFilter = d.toISOString()
        break
      }
      case 'last_30': {
        const d = new Date(now)
        d.setDate(d.getDate() - 30)
        dateFilter = d.toISOString()
        break
      }
      case 'last_90': {
        const d = new Date(now)
        d.setDate(d.getDate() - 90)
        dateFilter = d.toISOString()
        break
      }
      case 'ytd': {
        dateFilter = new Date(now.getFullYear(), 0, 1).toISOString()
        break
      }
      case 'all':
      default:
        dateFilter = null
    }

    // Fetch all deals with agent and brokerage data
    let query = supabase
      .from('deals')
      .select('*, agent:agents(first_name, last_name), brokerage:brokerages(name, brand)')
      .order('created_at', { ascending: false })

    if (dateFilter) {
      query = query.gte('created_at', dateFilter)
    }

    const { data: deals, error: dealsErr } = await query

    if (dealsErr) {
      return { success: false, error: `Failed to fetch deals: ${dealsErr.message}` }
    }

    const allDeals = deals || []

    // Funded statuses (money has moved)
    const fundedStatuses = ['funded', 'repaid', 'closed']
    const fundedDeals = allDeals.filter(d => fundedStatuses.includes(d.status))

    // Summary KPIs
    const totalRevenue = fundedDeals.reduce((sum, d) => sum + Number(d.discount_fee || 0), 0)
    const totalAdvanced = fundedDeals.reduce((sum, d) => sum + Number(d.advance_amount || 0), 0)
    const totalReferralFeesPaid = fundedDeals.reduce((sum, d) => sum + Number(d.brokerage_referral_fee || 0), 0)
    const totalProfit = totalRevenue - totalReferralFeesPaid
    const avgDiscountFee = fundedDeals.length > 0 ? totalRevenue / fundedDeals.length : 0
    const avgDaysToClose = fundedDeals.length > 0
      ? fundedDeals.reduce((sum, d) => sum + Number(d.days_until_closing || 0), 0) / fundedDeals.length
      : 0
    const conversionRate = allDeals.length > 0
      ? (fundedDeals.length / allDeals.length) * 100
      : 0

    // Pipeline breakdown
    const pipeline = {
      under_review: allDeals.filter(d => d.status === 'under_review').length,
      approved: allDeals.filter(d => d.status === 'approved').length,
      funded: allDeals.filter(d => d.status === 'funded').length,
      repaid: allDeals.filter(d => d.status === 'repaid').length,
      closed: allDeals.filter(d => d.status === 'closed').length,
      denied: allDeals.filter(d => d.status === 'denied').length,
      cancelled: allDeals.filter(d => d.status === 'cancelled').length,
    }

    // Monthly trends (last 12 months)
    const monthlyMap = new Map<string, { deals: number; revenue: number; advanced: number; profit: number }>()

    // Initialize last 12 months
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
      monthlyMap.set(key, { deals: 0, revenue: 0, advanced: 0, profit: 0 })
    }

    for (const deal of allDeals) {
      const d = new Date(deal.created_at)
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
      const entry = monthlyMap.get(key)
      if (entry) {
        entry.deals++
        if (fundedStatuses.includes(deal.status)) {
          entry.revenue += Number(deal.discount_fee || 0)
          entry.advanced += Number(deal.advance_amount || 0)
          entry.profit += Number(deal.discount_fee || 0) - Number(deal.brokerage_referral_fee || 0)
        }
      }
    }

    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    const monthlyTrends = Array.from(monthlyMap.entries()).map(([month, data]) => {
      const [year, m] = month.split('-')
      return {
        month,
        label: `${monthNames[parseInt(m) - 1]} ${year}`,
        ...data,
      }
    })

    // Brokerage performance
    const brokerageMap = new Map<string, {
      id: string
      name: string
      brand: string | null
      totalDeals: number
      fundedDeals: number
      totalAdvanced: number
      totalReferralFees: number
    }>()

    for (const deal of allDeals) {
      const brokId = deal.brokerage_id
      if (!brokId) continue

      if (!brokerageMap.has(brokId)) {
        const brokData = deal.brokerage as { name: string; brand: string | null } | null
        brokerageMap.set(brokId, {
          id: brokId,
          name: brokData?.name || 'Unknown',
          brand: brokData?.brand || null,
          totalDeals: 0,
          fundedDeals: 0,
          totalAdvanced: 0,
          totalReferralFees: 0,
        })
      }

      const entry = brokerageMap.get(brokId)!
      entry.totalDeals++

      if (fundedStatuses.includes(deal.status)) {
        entry.fundedDeals++
        entry.totalAdvanced += Number(deal.advance_amount || 0)
        entry.totalReferralFees += Number(deal.brokerage_referral_fee || 0)
      }
    }

    const brokeragePerformance = Array.from(brokerageMap.values())
      .map(b => ({
        ...b,
        avgDealSize: b.fundedDeals > 0 ? b.totalAdvanced / b.fundedDeals : 0,
      }))
      .sort((a, b) => b.totalAdvanced - a.totalAdvanced)

    // Export-ready deal data
    const exportDeals = allDeals.map(d => {
      const agent = d.agent as { first_name: string; last_name: string } | null
      const brokerage = d.brokerage as { name: string } | null
      return {
        id: d.id,
        property_address: d.property_address,
        status: d.status,
        gross_commission: Number(d.gross_commission || 0),
        brokerage_split_pct: Number(d.brokerage_split_pct || 0),
        net_commission: Number(d.net_commission || 0),
        discount_fee: Number(d.discount_fee || 0),
        advance_amount: Number(d.advance_amount || 0),
        brokerage_referral_fee: Number(d.brokerage_referral_fee || 0),
        days_until_closing: Number(d.days_until_closing || 0),
        closing_date: d.closing_date,
        funding_date: d.funding_date,
        created_at: d.created_at,
        agent_name: agent ? `${agent.first_name} ${agent.last_name}` : 'Unknown',
        brokerage_name: brokerage?.name || 'Unknown',
      }
    })

    return {
      success: true,
      data: {
        totalRevenue,
        totalAdvanced,
        totalReferralFeesPaid,
        totalProfit,
        avgDiscountFee,
        avgDaysToClose,
        totalDeals: allDeals.length,
        conversionRate,
        pipeline,
        monthlyTrends,
        brokeragePerformance,
        exportDeals,
      },
    }
  } catch (err) {
    return { success: false, error: `Unexpected error: ${err instanceof Error ? err.message : 'Unknown'}` }
  }
}
