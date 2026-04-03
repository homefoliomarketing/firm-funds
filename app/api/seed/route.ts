import { createServiceRoleClient } from '@/lib/supabase/server'
import { calculateDeal } from '@/lib/calculations'
import { calcDaysUntilClosing } from '@/lib/constants'

// =============================================================================
// GET /api/seed — One-shot test data seeder
// Creates 4 brokerages, 10-50 agents each, 15 deals per brokerage.
// Also creates brokerage_admin logins so you can test the portal.
//
// DELETE /api/seed — Wipe all seeded test data
//
// Protected by a secret query param: ?key=firmfunds-seed-2026
// =============================================================================

const SEED_KEY = 'firmfunds-seed-2026'

// Tag so we can find and delete seed data later
const SEED_TAG = '[SEED]'

// Ontario street names / cities for realistic-ish addresses
const STREETS = [
  'Maple Ave', 'King St W', 'Queen St E', 'Bayview Dr', 'Lakeshore Blvd',
  'Yonge St', 'Dundas St', 'Bloor St W', 'College St', 'Eglinton Ave',
  'Danforth Ave', 'Bathurst St', 'St Clair Ave W', 'Lawrence Ave E',
  'Sheppard Ave', 'Finch Ave W', 'Steeles Ave E', 'Kennedy Rd',
  'McCowan Rd', 'Markham Rd', 'Brimley Rd', 'Warden Ave', 'Victoria Park Ave',
  'Don Mills Rd', 'Leslie St', 'Bayfield St', 'Pine Ridge Dr', 'Cedar Lane',
  'Oak Hollow Cres', 'Willow Creek Blvd',
]

const CITIES = [
  'Toronto', 'Mississauga', 'Brampton', 'Markham', 'Vaughan',
  'Richmond Hill', 'Oakville', 'Burlington', 'Hamilton', 'Barrie',
  'Oshawa', 'Whitby', 'Ajax', 'Pickering', 'Newmarket',
  'Aurora', 'King City', 'Caledon', 'Milton', 'Georgetown',
]

const FIRST_NAMES = [
  'James', 'Sarah', 'Michael', 'Emily', 'David', 'Jessica', 'Robert', 'Ashley',
  'William', 'Amanda', 'Daniel', 'Stephanie', 'Chris', 'Jennifer', 'Kevin',
  'Lauren', 'Andrew', 'Nicole', 'Jason', 'Melissa', 'Ryan', 'Samantha',
  'Brian', 'Rachel', 'Mark', 'Megan', 'Steven', 'Heather', 'Paul', 'Brittany',
  'Alex', 'Natasha', 'Omar', 'Priya', 'Wei', 'Fatima', 'Raj', 'Elena',
  'Hassan', 'Anika', 'Marco', 'Yuki', 'Chen', 'Olga', 'Tariq', 'Sofia',
  'Liam', 'Zara', 'Noah', 'Isla',
]

const LAST_NAMES = [
  'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller',
  'Davis', 'Rodriguez', 'Martinez', 'Wilson', 'Anderson', 'Thomas', 'Taylor',
  'Moore', 'Jackson', 'Martin', 'Lee', 'Perez', 'Thompson', 'White',
  'Harris', 'Sanchez', 'Clark', 'Ramirez', 'Lewis', 'Robinson', 'Walker',
  'Young', 'Allen', 'Patel', 'Singh', 'Chen', 'Wang', 'Kim', 'Nguyen',
  'Khan', 'Ali', 'Santos', 'Sharma', 'Costa', 'Romano', 'Tanaka', 'Volkov',
  'Okonkwo', 'MacDonald', 'Campbell', 'Fraser', 'O\'Brien', 'Murphy',
]

const BROKERAGES = [
  { name: 'Maple Realty Group', email: 'admin@maplerealty-test.ca', agentCount: 35 },
  { name: 'Lakeshore Properties Inc.', email: 'admin@lakeshoreprops-test.ca', agentCount: 22 },
  { name: 'Northern Star Real Estate', email: 'admin@northernstar-test.ca', agentCount: 48 },
  { name: 'Bay Street Brokerage', email: 'admin@baystreet-test.ca', agentCount: 14 },
]

function rand(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

function randomAddress(): string {
  return `${rand(1, 999)} ${pick(STREETS)}, ${pick(CITIES)}, ON`
}

function randomClosingDate(): string {
  // Random date between 5 and 90 days from now
  const daysAhead = rand(5, 90)
  const date = new Date()
  date.setDate(date.getDate() + daysAhead)
  return date.toISOString().slice(0, 10) // YYYY-MM-DD
}

function randomPastClosingDate(): string {
  // For funded deals — closing date in the past 1-60 days
  const daysAgo = rand(1, 60)
  const date = new Date()
  date.setDate(date.getDate() - daysAgo)
  return date.toISOString().slice(0, 10)
}

// =============================================================================
// SEED
// =============================================================================

export async function GET(request: Request) {
  const url = new URL(request.url)
  if (url.searchParams.get('key') !== SEED_KEY) {
    return Response.json({ error: 'Invalid seed key' }, { status: 403 })
  }

  const supabase = createServiceRoleClient()
  const results: string[] = []

  try {
    for (const brokDef of BROKERAGES) {
      // =====================================================================
      // 1. Create brokerage
      // =====================================================================
      const { data: brokerage, error: brokErr } = await supabase
        .from('brokerages')
        .insert({
          name: `${SEED_TAG} ${brokDef.name}`,
          email: brokDef.email,
          status: 'active',
          referral_fee_percentage: 20,
          notes: 'Test brokerage — safe to delete',
        })
        .select()
        .single()

      if (brokErr || !brokerage) {
        results.push(`FAILED brokerage ${brokDef.name}: ${brokErr?.message}`)
        continue
      }
      results.push(`Created brokerage: ${brokerage.name} (${brokerage.id})`)

      // =====================================================================
      // 2. Create brokerage admin user (for portal login)
      // =====================================================================
      const adminEmail = brokDef.email
      const adminPassword = 'TestPass123!'

      const { data: authUser, error: authErr } = await supabase.auth.admin.createUser({
        email: adminEmail,
        password: adminPassword,
        email_confirm: true,
        user_metadata: { full_name: `${brokDef.name} Admin` },
      })

      if (authErr || !authUser?.user) {
        results.push(`  WARN: Could not create admin login for ${adminEmail}: ${authErr?.message}`)
      } else {
        // Create user_profile
        await supabase.from('user_profiles').insert({
          id: authUser.user.id,
          email: adminEmail,
          role: 'brokerage_admin',
          brokerage_id: brokerage.id,
          full_name: `${brokDef.name} Admin`,
          is_active: true,
        })
        results.push(`  Admin login: ${adminEmail} / ${adminPassword}`)
      }

      // =====================================================================
      // 3. Create agents
      // =====================================================================
      const usedNames = new Set<string>()
      const agentIds: string[] = []

      for (let i = 0; i < brokDef.agentCount; i++) {
        let firstName: string, lastName: string, fullKey: string
        // Avoid duplicate names
        do {
          firstName = pick(FIRST_NAMES)
          lastName = pick(LAST_NAMES)
          fullKey = `${firstName}-${lastName}`
        } while (usedNames.has(fullKey))
        usedNames.add(fullKey)

        const agentEmail = `${firstName.toLowerCase()}.${lastName.toLowerCase().replace("'", '')}@${brokDef.name.toLowerCase().replace(/[^a-z]/g, '')}-test.ca`

        const { data: agent, error: agentErr } = await supabase
          .from('agents')
          .insert({
            brokerage_id: brokerage.id,
            first_name: firstName,
            last_name: lastName,
            email: agentEmail,
            phone: `416-${rand(100, 999)}-${rand(1000, 9999)}`,
            status: 'active',
            flagged_by_brokerage: Math.random() < 0.08, // ~8% flagged
            outstanding_recovery: 0,
          })
          .select()
          .single()

        if (agent) {
          agentIds.push(agent.id)
        }
      }
      results.push(`  Created ${agentIds.length} agents`)

      // =====================================================================
      // 4. Create 15 deals with random data
      // =====================================================================
      const statuses: ('under_review' | 'approved' | 'funded')[] = ['under_review', 'approved', 'funded']
      let dealsCreated = 0

      for (let i = 0; i < 15; i++) {
        const status = pick(statuses)
        const agentId = pick(agentIds)
        const grossCommission = rand(5000, 55000)
        const brokerageSplitPct = rand(5, 25)

        // Use past closing dates for funded deals, future for others
        const closingDate = status === 'funded' ? randomPastClosingDate() : randomClosingDate()
        const daysUntilClosing = calcDaysUntilClosing(closingDate)

        // Calculate financials — use absolute value for days if past
        const calcDays = Math.max(Math.abs(daysUntilClosing), 1)
        let calc
        try {
          calc = calculateDeal({
            grossCommission,
            brokerageSplitPct,
            daysUntilClosing: Math.min(calcDays, 120), // clamp to valid range
          })
        } catch {
          // Skip if calculation fails (edge case with days)
          continue
        }

        const { data: deal, error: dealErr } = await supabase
          .from('deals')
          .insert({
            agent_id: agentId,
            brokerage_id: brokerage.id,
            status,
            property_address: randomAddress(),
            closing_date: closingDate,
            gross_commission: grossCommission,
            brokerage_split_pct: brokerageSplitPct,
            net_commission: calc.netCommission,
            days_until_closing: daysUntilClosing,
            discount_fee: calc.discountFee,
            advance_amount: calc.advanceAmount,
            brokerage_referral_fee: calc.brokerageReferralFee,
            amount_due_from_brokerage: calc.amountDueFromBrokerage,
            funding_date: status === 'funded' ? new Date().toISOString() : null,
            source: 'manual_portal',
            notes: `${SEED_TAG} Test deal`,
          })
          .select()
          .single()

        if (deal) dealsCreated++
      }
      results.push(`  Created ${dealsCreated} deals`)
    }

    return Response.json({
      success: true,
      message: 'Seed data created successfully',
      loginCredentials: BROKERAGES.map(b => ({
        brokerage: b.name,
        email: b.email,
        password: 'TestPass123!',
      })),
      details: results,
    }, { status: 200 })

  } catch (err: any) {
    return Response.json({
      success: false,
      error: err.message,
      details: results,
    }, { status: 500 })
  }
}

// =============================================================================
// DELETE — Wipe all seed data
// =============================================================================

export async function DELETE(request: Request) {
  const url = new URL(request.url)
  if (url.searchParams.get('key') !== SEED_KEY) {
    return Response.json({ error: 'Invalid seed key' }, { status: 403 })
  }

  const supabase = createServiceRoleClient()
  const results: string[] = []

  try {
    // 1. Find all seeded brokerages
    const { data: brokerages } = await supabase
      .from('brokerages')
      .select('id, name')
      .like('name', `${SEED_TAG}%`)

    if (!brokerages || brokerages.length === 0) {
      return Response.json({ success: true, message: 'No seed data found to delete' })
    }

    const brokerageIds = brokerages.map(b => b.id)

    // 2. Delete deals (and cascade will handle deal_documents, etc.)
    const { count: dealsDeleted } = await supabase
      .from('deals')
      .delete({ count: 'exact' })
      .in('brokerage_id', brokerageIds)
    results.push(`Deleted ${dealsDeleted ?? 0} deals`)

    // 3. Delete agents
    const { count: agentsDeleted } = await supabase
      .from('agents')
      .delete({ count: 'exact' })
      .in('brokerage_id', brokerageIds)
    results.push(`Deleted ${agentsDeleted ?? 0} agents`)

    // 4. Find and delete user profiles + auth users for brokerage admins
    const { data: profiles } = await supabase
      .from('user_profiles')
      .select('id, email')
      .in('brokerage_id', brokerageIds)
      .eq('role', 'brokerage_admin')

    if (profiles) {
      for (const p of profiles) {
        await supabase.auth.admin.deleteUser(p.id)
        results.push(`Deleted auth user: ${p.email}`)
      }
      await supabase
        .from('user_profiles')
        .delete()
        .in('brokerage_id', brokerageIds)
        .eq('role', 'brokerage_admin')
    }

    // 5. Delete brokerages
    const { count: brokDeleted } = await supabase
      .from('brokerages')
      .delete({ count: 'exact' })
      .in('id', brokerageIds)
    results.push(`Deleted ${brokDeleted ?? 0} brokerages`)

    return Response.json({
      success: true,
      message: 'All seed data deleted',
      details: results,
    })

  } catch (err: any) {
    return Response.json({
      success: false,
      error: err.message,
      details: results,
    }, { status: 500 })
  }
}
