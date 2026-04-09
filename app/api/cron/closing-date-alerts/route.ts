import { createClient } from '@supabase/supabase-js'
import { sendClosingDateAlertDigest, sendSettlementReminderClosingDay, sendSettlementReminder7Day, sendSettlementReminder3Day } from '@/lib/email'
import { autoChargeDailyLateInterest } from '@/lib/actions/account-actions'
import { SETTLEMENT_PERIOD_DAYS } from '@/lib/constants'

// =============================================================================
// GET /api/cron/closing-date-alerts
//
// Daily cron job that handles:
// 1. Closing date alerts — approaching and overdue deals → admin digest email
// 2. Settlement period reminders — closing day, 7-day, 3-day → agent + brokerage
// 3. Auto-charge late interest — 24% p.a. daily on overdue deals
// 4. Update payment_status for overdue deals
//
// Protected by CRON_SECRET header.
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
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' })

    // =======================================================================
    // 1. Closing Date Alerts (existing functionality)
    // =======================================================================

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

    // Send admin digest
    if (approachingDeals.length > 0 || overdueDeals.length > 0) {
      await sendClosingDateAlertDigest({ approachingDeals, overdueDeals })
    }

    // Update days_until_closing for all active deals
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

    // =======================================================================
    // 2. Settlement Period Reminders (new)
    // =======================================================================

    // Fetch funded deals with settlement info for reminders
    const { data: fundedDeals } = await supabase
      .from('deals')
      .select('id, property_address, closing_date, due_date, advance_amount, amount_due_from_brokerage, settlement_period_fee, agent_id, brokerage_id, agents(first_name, email), brokerages(name, email, broker_of_record_email)')
      .eq('status', 'funded')
      .not('due_date', 'is', null)

    let remindersSent = 0

    if (fundedDeals) {
      for (const deal of fundedDeals) {
        const agent = deal.agents as any
        const brokerage = deal.brokerages as any
        if (!agent?.email) continue

        // Skip pre-migration deals
        if (!deal.settlement_period_fee || deal.settlement_period_fee <= 0) continue

        const closingDate = new Date(deal.closing_date + 'T00:00:00')
        const todayDate = new Date(today + 'T00:00:00')
        const daysSinceClosing = Math.floor((todayDate.getTime() - closingDate.getTime()) / (1000 * 60 * 60 * 24))

        const reminderParams = {
          dealId: deal.id,
          propertyAddress: deal.property_address,
          agentEmail: agent.email,
          agentFirstName: agent.first_name,
          brokerageEmail: brokerage?.email || brokerage?.broker_of_record_email || null,
          brokerageName: brokerage?.name,
          advanceAmount: deal.advance_amount,
          dueDate: deal.due_date!,
          amountDueFromBrokerage: deal.amount_due_from_brokerage,
          daysRemaining: 0,
        }

        // Closing day (daysSinceClosing === 0)
        if (daysSinceClosing === 0) {
          reminderParams.daysRemaining = SETTLEMENT_PERIOD_DAYS
          await sendSettlementReminderClosingDay(reminderParams)
          remindersSent++
        }
        // 7 days after closing (7 days remaining)
        else if (daysSinceClosing === 7) {
          reminderParams.daysRemaining = 7
          await sendSettlementReminder7Day(reminderParams)
          remindersSent++
        }
        // 11 days after closing (3 days remaining)
        else if (daysSinceClosing === SETTLEMENT_PERIOD_DAYS - 3) {
          reminderParams.daysRemaining = 3
          await sendSettlementReminder3Day(reminderParams)
          remindersSent++
        }
      }
    }

    // =======================================================================
    // 3. Auto-charge Late Interest + Update Payment Status (new)
    // =======================================================================

    const lateInterestResult = await autoChargeDailyLateInterest()

    // Update payment_status for deals past due date
    await supabase
      .from('deals')
      .update({ payment_status: 'overdue' })
      .eq('status', 'funded')
      .eq('payment_status', 'pending')
      .lt('due_date', today)

    return Response.json({
      message: 'Daily cron complete',
      approaching: approachingDeals.length,
      overdue: overdueDeals.length,
      total_active: activeDeals.length,
      reminders_sent: remindersSent,
      late_interest: {
        deals_charged: lateInterestResult.charged,
        errors: lateInterestResult.errors,
      },
    })
  } catch (err: any) {
    console.error('[cron] Closing date alert error:', err?.message)
    return Response.json({ error: 'Internal error' }, { status: 500 })
  }
}
