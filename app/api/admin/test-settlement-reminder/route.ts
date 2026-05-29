/**
 * /api/admin/test-settlement-reminder
 *
 * One-shot smoke test for the Real Resend roundtrip on settlement reminder
 * emails. Sends a hard-coded fixture payload through the production Resend
 * client so we can confirm:
 *   - The render output renders in the recipient's mail client
 *   - The Firm Funds logo loads
 *   - The deal-detail CTA opens correctly on mobile
 *   - The from-address is configured correctly and doesn't spam-trap
 *
 * Admin-gated: caller must be super_admin or firm_funds_admin. Recipient
 * defaults to the caller's profile email; ?to=<email> overrides for cases
 * where Bud wants to fire it at a personal inbox to test deliverability.
 *
 * Scenario param controls which renderer to test:
 *   ?scenario=closing_day        (default) — closing-day payment reminder
 *   ?scenario=payment_check_in   — post-deadline payment check-in
 *
 * Not registered in PUBLIC_PATHS — middleware will bounce non-authenticated
 * callers to /login like any other admin route.
 *
 * Build out as needed: once Bud confirms one channel works, the other
 * fixtures (KYC, invoice, amendment) can pile on with the same pattern.
 */
import { NextResponse } from 'next/server'
import { getAuthenticatedAdmin } from '@/lib/auth-helpers'
import { sendSettlementReminderClosingDay, sendSettlementReminderPaymentCheckIn } from '@/lib/email'

export async function GET(request: Request) {
  const auth = await getAuthenticatedAdmin()
  if (auth.error || !auth.profile) {
    return NextResponse.json({ error: auth.error ?? 'Not authorized' }, { status: 401 })
  }

  const url = new URL(request.url)
  const scenario = url.searchParams.get('scenario') ?? 'closing_day'
  const to = url.searchParams.get('to') ?? auth.profile.email
  if (!to) {
    return NextResponse.json({ error: 'No recipient email (set ?to= or fill profile.email).' }, { status: 400 })
  }

  // Fixture payload. Numbers picked to look like a realistic deal but with
  // round-ish values so a reader can eyeball the math fast.
  const params = {
    dealId: '00000000-0000-0000-0000-000000000000',
    propertyAddress: '123 Example Street, Toronto, Ontario, M5A 1A1',
    agentEmail: to,
    agentFirstName: auth.profile.full_name?.split(' ')[0] ?? 'Bud',
    brokerageEmail: null,           // skip the brokerage copy on the test path
    brokerageName: 'Test Brokerage',
    advanceAmount: 8000,
    dueDate: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10),
    amountDueFromBrokerage: 9_350.00,
    daysRemaining: 7,
  }

  try {
    if (scenario === 'payment_check_in') {
      // Post-deadline check-in fixture. dueDate moves to 5 days ago to mirror
      // the day-12 trigger on a 7-day brokerage (the most common case).
      const checkInParams = {
        ...params,
        dueDate: new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10),
        daysRemaining: 0,
        daysSinceDue: 5,
      }
      await sendSettlementReminderPaymentCheckIn(checkInParams)
    } else {
      await sendSettlementReminderClosingDay(params)
    }
    return NextResponse.json({
      ok: true,
      scenario,
      sent_to: to,
      note: 'Resend doesn\'t reply with a delivery confirmation here — check your inbox. If nothing arrives in ~30s check spam.',
    })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'send threw' },
      { status: 500 }
    )
  }
}
