'use server'

import { createClient } from '@/lib/supabase/server'

export async function getPortfolioData() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated', data: null }

  // Verify admin role
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('role')
    .eq('id', user.id)
    .single()

  if (!profile || !['super_admin', 'firm_funds_admin'].includes(profile.role)) {
    return { success: false, error: 'Not authorized', data: null }
  }

  // Fetch all funded deals with agent and brokerage info
  const { data: deals, error } = await supabase
    .from('deals')
    .select('id, property_address, status, closing_date, funding_date, advance_amount, discount_fee, amount_due_from_brokerage, brokerage_referral_fee, net_commission, agent_id, brokerage_id, agents(first_name, last_name), brokerages(name)')
    .eq('status', 'funded')
    .order('funding_date', { ascending: true })

  if (error) {
    return { success: false, error: 'Failed to fetch portfolio data', data: null }
  }

  return { success: true, data: deals || [] }
}
