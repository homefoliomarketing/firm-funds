import { createClient } from '@supabase/supabase-js'
import { sendClosingDateAlertDigest } from '@/lib/email'

// =============================================================================
// GET /api/cron/closing-date-alerts
//
// Daily cron job to check for approaching and overdue closing dates.
// Sends a digest email to the admin with deals closing within 7 days
// and funded deals that are past their closing date without repayment.
//
// Protected by CRON_SECRET header to prevent unauthorized access.
// Set up a cron job (e.g., Netlify scheduled function, or external cron)
// to call this endpoint daily.
// =============================================================================

const APPROACHING_DAYS_THRESHOLD = 7 // Alert for deals closing within 7 days

export async function GET(request: Request) {
  // Verify cron secret — fail closed if not configured
  const authHeader = request.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET

  if (!cronSecret) {
    console.error('[cron] CRON_SECRET env var not configured')
    return Response.json({ error: 'Cron not configured' }, { status: 500 })
  }
  if (authHeader !== `Bearer ${cronSecret}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Use service role client to bypass RLS
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !supabaseServiceKey) {
    return Response.json({ error: 'Missing Supabase config' }, { status: 500 })
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey)

  try {
    const today = new Date().toISOString().split('T')[0]

    // Get all active deals (funded or approved) — these are the ones we care about
    const { data: activeDeals, error } = await supabase
      .from('deals')
      .select('id, property_address, closing_date, days_until_closing, advance_amount, status, agent_id, agents(first_name, last_name)')
      .in('status', ['funded', 'approved'])
      .order('closing_date', { ascending: true })

    if (error) {
      console.error('[cron] Failed to fetch deals:', error.message)
      return Response.json({ error: 'Failed to fetch deals' }, { status: 500 })
    }

    if (!activeDeals || activeDeals.length === 0) {
      return Response.json({ message: 'No active deals to check', approaching: 0, overdue: 0 })
    }

    const approachingDeals: {
      id: string; property_address: string; closing_date: string
      days_until_closing: number; advance_amount: number; agent_name: string; status: string
    }[] = []

    const overdueDeals: {
      id: string; property_address: string; closing_date: string
      days_overdue: number; advance_amount: number; agent_name: string; status: string
    }[] = []

    for (const deal of activeDeals) {
      const agent = deal.agents as any
      const agentName = agent ? `${agent.first_name} ${agent.last_name}` : 'Unknown Agent'
      const closingDate = new Date(deal.closing_date + 'T00:00:00')
      const todayDate = new Date(today + 'T00:00:00')
      const diffMs = closingDate.getTime() - todayDate.getTime()
      const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

      if (diffDays < 0) {
        // Overdue — closing date has passed
        overdueDeals.push({
          id: deal.id,
          property_address: deal.property_address,
          closing_date: deal.closing_date,
          days_overdue: Math.abs(diffDays),
          advance_amount: deal.advance_amount,
          agent_name: agentName,
          status: deal.status,
        })
      } else if (diffDays <= APPROACHING_DAYS_THRESHOLD) {
        // Approaching — closing within threshold
        approachingDeals.push({
          id: deal.id,
          property_address: deal.property_address,
          closing_date: deal.closing_date,
          days_until_closing: diffDays,
          advance_amount: deal.advance_amount,
          agent_name: agentName,
          status: deal.status,
        })
      }
    }

    // Send digest email if there's anything to report
    if (approachingDeals.length > 0 || overdueDeals.length > 0) {
      await sendClosingDateAlertDigest({ approachingDeals, overdueDeals })
    }

    // Also update days_until_closing for all active deals (keeps it fresh)
    for (const deal of activeDeals) {
      const closingDate = new Date(deal.closing_date + 'T00:00:00')
      const todayDate = new Date(today + 'T00:00:00')
      const diffMs = closingDate.getTime() - todayDate.getTime()
      const currentDays = Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)))

      if (currentDays !== deal.days_until_closing) {
        await supabase
          .from('deals')
          .update({ days_until_closing: currentDays })
          .eq('id', deal.id)
      }
    }

    return Response.json({
      message: 'Closing date check complete',
      approaching: approachingDeals.length,
      overdue: overdueDeals.length,
      total_active: activeDeals.length,
    })
  } catch (err: any) {
    console.error('[cron] Closing date alert error:', err?.message)
    return Response.json({ error: 'Internal error' }, { status: 500 })
  }
}
