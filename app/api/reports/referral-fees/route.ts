import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib'
import { DEFAULT_BROKERAGE_REFERRAL_PCT } from '@/lib/constants'

// =============================================================================
// GET /api/reports/referral-fees?month=YYYY-MM (optional)
// Generates a branded PDF referral fee report for the authenticated brokerage.
// =============================================================================

export async function GET(request: Request) {
  // Authenticate
  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll() },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch { /* middleware handles refresh */ }
        },
      },
    }
  )

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return new Response('Unauthorized', { status: 401 })
  }

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('role, brokerage_id')
    .eq('id', user.id)
    .single()

  if (!profile || profile.role !== 'brokerage_admin' || !profile.brokerage_id) {
    return new Response('Forbidden', { status: 403 })
  }

  // Get brokerage info
  const { data: brokerage } = await supabase
    .from('brokerages')
    .select('name, referral_fee_percentage')
    .eq('id', profile.brokerage_id)
    .single()

  if (!brokerage) {
    return new Response('Brokerage not found', { status: 404 })
  }

  // Parse optional month filter from query params
  const url = new URL(request.url)
  const monthParam = url.searchParams.get('month') // YYYY-MM format
  const allTime = url.searchParams.get('all') === 'true'

  // Build query — funded/repaid/closed deals only (earned referral fees)
  let query = supabase
    .from('deals')
    .select('*, agent:agents(first_name, last_name, email)')
    .eq('brokerage_id', profile.brokerage_id)
    .in('status', ['funded', 'repaid', 'closed'])
    .order('closing_date', { ascending: false })

  // Apply month filter if provided
  if (monthParam && !allTime) {
    const [year, month] = monthParam.split('-').map(Number)
    const startDate = new Date(year, month - 1, 1).toISOString().slice(0, 10)
    const endDate = new Date(year, month, 0).toISOString().slice(0, 10)
    query = query.gte('closing_date', startDate).lte('closing_date', endDate)
  }

  const { data: deals, error } = await query
  if (error) {
    return new Response('Failed to fetch deals', { status: 500 })
  }

  // =========================================================================
  // Generate PDF
  // =========================================================================
  const pdfDoc = await PDFDocument.create()
  const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica)
  const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold)

  const PAGE_WIDTH = 792 // Letter landscape
  const PAGE_HEIGHT = 612
  const MARGIN = 40
  const GREEN = rgb(95 / 255, 168 / 255, 115 / 255) // #5FA873
  const DARK_BG = rgb(30 / 255, 30 / 255, 30 / 255)
  const WHITE = rgb(1, 1, 1)
  const GREY = rgb(0.6, 0.6, 0.6)
  const LIGHT_GREY = rgb(0.85, 0.85, 0.85)

  const formatCurrency = (amount: number) =>
    new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(amount)

  const formatDate = (date: string) =>
    new Date(date).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' })

  // Period label
  let periodLabel = 'All Time'
  if (monthParam && !allTime) {
    const [year, month] = monthParam.split('-').map(Number)
    const monthName = new Date(year, month - 1, 1).toLocaleDateString('en-CA', { month: 'long', year: 'numeric' })
    periodLabel = monthName
  }

  // Calculate totals
  const totalReferralFees = (deals || []).reduce((sum, d: any) => sum + (d.brokerage_referral_fee || 0), 0)
  const totalDiscountFees = (deals || []).reduce((sum, d: any) => sum + (d.discount_fee || 0), 0)
  const referralPct = brokerage.referral_fee_percentage ?? DEFAULT_BROKERAGE_REFERRAL_PCT

  // --- Page creation helper ---
  let currentPage = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT])
  let yPos = PAGE_HEIGHT - MARGIN

  function addNewPage() {
    currentPage = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT])
    yPos = PAGE_HEIGHT - MARGIN
    // Mini header on continuation pages
    currentPage.drawText('Firm Funds — Referral Fee Report', {
      x: MARGIN,
      y: yPos,
      size: 10,
      font: helveticaBold,
      color: GREEN,
    })
    currentPage.drawText(`${brokerage!.name} | ${periodLabel}`, {
      x: MARGIN,
      y: yPos - 12,
      size: 8,
      font: helvetica,
      color: GREY,
    })
    yPos -= 35
  }

  // =========================================================================
  // HEADER
  // =========================================================================
  // Green accent bar
  currentPage.drawRectangle({
    x: 0, y: PAGE_HEIGHT - 4, width: PAGE_WIDTH, height: 4,
    color: GREEN,
  })

  // Title
  currentPage.drawText('REFERRAL FEE REPORT', {
    x: MARGIN,
    y: yPos - 10,
    size: 22,
    font: helveticaBold,
    color: rgb(0.12, 0.12, 0.12),
  })
  yPos -= 32

  // Brokerage name + period
  currentPage.drawText(brokerage.name, {
    x: MARGIN,
    y: yPos,
    size: 12,
    font: helveticaBold,
    color: rgb(0.3, 0.3, 0.3),
  })
  yPos -= 16

  currentPage.drawText(`Period: ${periodLabel}  |  Generated: ${new Date().toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric' })}`, {
    x: MARGIN,
    y: yPos,
    size: 9,
    font: helvetica,
    color: GREY,
  })
  yPos -= 10

  // Divider line
  currentPage.drawLine({
    start: { x: MARGIN, y: yPos },
    end: { x: PAGE_WIDTH - MARGIN, y: yPos },
    thickness: 1,
    color: LIGHT_GREY,
  })
  yPos -= 20

  // =========================================================================
  // SUMMARY BOX
  // =========================================================================
  const boxY = yPos - 50
  const boxWidth = (PAGE_WIDTH - MARGIN * 2 - 20) / 3

  // Total Referral Fees
  currentPage.drawRectangle({
    x: MARGIN, y: boxY, width: boxWidth, height: 50,
    color: rgb(0.95, 0.98, 0.95),
    borderColor: rgb(0.85, 0.93, 0.87),
    borderWidth: 1,
  })
  currentPage.drawText('TOTAL REFERRAL FEES', {
    x: MARGIN + 10, y: boxY + 33, size: 7, font: helveticaBold, color: GREY,
  })
  currentPage.drawText(formatCurrency(totalReferralFees), {
    x: MARGIN + 10, y: boxY + 12, size: 16, font: helveticaBold, color: GREEN,
  })

  // Total Deals
  const box2X = MARGIN + boxWidth + 10
  currentPage.drawRectangle({
    x: box2X, y: boxY, width: boxWidth, height: 50,
    color: rgb(0.95, 0.95, 0.98),
    borderColor: rgb(0.87, 0.87, 0.93),
    borderWidth: 1,
  })
  currentPage.drawText('FUNDED DEALS', {
    x: box2X + 10, y: boxY + 33, size: 7, font: helveticaBold, color: GREY,
  })
  currentPage.drawText(`${(deals || []).length}`, {
    x: box2X + 10, y: boxY + 12, size: 16, font: helveticaBold, color: rgb(0.24, 0.35, 0.6),
  })

  // Referral Rate
  const box3X = MARGIN + (boxWidth + 10) * 2
  currentPage.drawRectangle({
    x: box3X, y: boxY, width: boxWidth, height: 50,
    color: rgb(0.98, 0.97, 0.95),
    borderColor: rgb(0.93, 0.91, 0.87),
    borderWidth: 1,
  })
  currentPage.drawText('REFERRAL FEE RATE', {
    x: box3X + 10, y: boxY + 33, size: 7, font: helveticaBold, color: GREY,
  })
  currentPage.drawText(`${(referralPct * 100).toFixed(0)}% of Discount Fee`, {
    x: box3X + 10, y: boxY + 12, size: 12, font: helveticaBold, color: rgb(0.57, 0.44, 0.1),
  })

  yPos = boxY - 25

  // =========================================================================
  // TABLE HEADER
  // =========================================================================
  if (!deals || deals.length === 0) {
    currentPage.drawText('No funded deals found for this period.', {
      x: MARGIN, y: yPos, size: 11, font: helvetica, color: GREY,
    })
  } else {
    // Column positions (landscape letter = 792 wide)
    const cols = {
      property: MARGIN,
      agent: MARGIN + 175,
      closingDate: MARGIN + 320,
      grossComm: MARGIN + 400,
      netComm: MARGIN + 480,
      discountFee: MARGIN + 560,
      referralFee: MARGIN + 640,
    }

    function drawTableHeader() {
      // Header background
      currentPage.drawRectangle({
        x: MARGIN, y: yPos - 4, width: PAGE_WIDTH - MARGIN * 2, height: 18,
        color: rgb(0.94, 0.94, 0.94),
      })
      const headerY = yPos
      const hSize = 7
      currentPage.drawText('PROPERTY', { x: cols.property + 4, y: headerY, size: hSize, font: helveticaBold, color: GREY })
      currentPage.drawText('AGENT', { x: cols.agent, y: headerY, size: hSize, font: helveticaBold, color: GREY })
      currentPage.drawText('CLOSING', { x: cols.closingDate, y: headerY, size: hSize, font: helveticaBold, color: GREY })
      currentPage.drawText('GROSS COMM.', { x: cols.grossComm, y: headerY, size: hSize, font: helveticaBold, color: GREY })
      currentPage.drawText('NET COMM.', { x: cols.netComm, y: headerY, size: hSize, font: helveticaBold, color: GREY })
      currentPage.drawText('DISCOUNT FEE', { x: cols.discountFee, y: headerY, size: hSize, font: helveticaBold, color: GREY })
      currentPage.drawText('REFERRAL FEE', { x: cols.referralFee, y: headerY, size: hSize, font: helveticaBold, color: GREY })
      yPos -= 22
    }

    drawTableHeader()

    // Table rows
    for (let i = 0; i < deals.length; i++) {
      if (yPos < MARGIN + 40) {
        addNewPage()
        drawTableHeader()
      }

      const deal = deals[i] as any
      const rowColor = i % 2 === 0 ? rgb(1, 1, 1) : rgb(0.98, 0.98, 0.98)

      // Alternating row bg
      currentPage.drawRectangle({
        x: MARGIN, y: yPos - 4, width: PAGE_WIDTH - MARGIN * 2, height: 18,
        color: rowColor,
      })

      const rSize = 8
      const textColor = rgb(0.15, 0.15, 0.15)

      // Truncate property address if too long
      const maxAddrLen = 30
      const addr = deal.property_address.length > maxAddrLen
        ? deal.property_address.slice(0, maxAddrLen - 2) + '...'
        : deal.property_address

      currentPage.drawText(addr, { x: cols.property + 4, y: yPos, size: rSize, font: helvetica, color: textColor })
      currentPage.drawText(`${deal.agent?.first_name || ''} ${deal.agent?.last_name || ''}`.trim(), {
        x: cols.agent, y: yPos, size: rSize, font: helvetica, color: textColor,
      })
      currentPage.drawText(formatDate(deal.closing_date), { x: cols.closingDate, y: yPos, size: rSize, font: helvetica, color: textColor })
      currentPage.drawText(formatCurrency(deal.gross_commission), { x: cols.grossComm, y: yPos, size: rSize, font: helvetica, color: textColor })
      currentPage.drawText(formatCurrency(deal.net_commission), { x: cols.netComm, y: yPos, size: rSize, font: helvetica, color: textColor })
      currentPage.drawText(formatCurrency(deal.discount_fee), { x: cols.discountFee, y: yPos, size: rSize, font: helvetica, color: textColor })
      currentPage.drawText(formatCurrency(deal.brokerage_referral_fee), {
        x: cols.referralFee, y: yPos, size: rSize, font: helveticaBold, color: GREEN,
      })

      yPos -= 18
    }

    // Totals row
    if (yPos < MARGIN + 40) {
      addNewPage()
    }

    yPos -= 4
    currentPage.drawLine({
      start: { x: MARGIN, y: yPos + 2 },
      end: { x: PAGE_WIDTH - MARGIN, y: yPos + 2 },
      thickness: 1.5,
      color: rgb(0.3, 0.3, 0.3),
    })

    currentPage.drawText(`TOTALS (${deals.length} deal${deals.length !== 1 ? 's' : ''})`, {
      x: MARGIN + 4, y: yPos - 12, size: 8, font: helveticaBold, color: rgb(0.2, 0.2, 0.2),
    })
    currentPage.drawText(formatCurrency(totalDiscountFees), {
      x: cols.discountFee, y: yPos - 12, size: 8, font: helveticaBold, color: rgb(0.2, 0.2, 0.2),
    })
    currentPage.drawText(formatCurrency(totalReferralFees), {
      x: cols.referralFee, y: yPos - 12, size: 9, font: helveticaBold, color: GREEN,
    })
  }

  // =========================================================================
  // FOOTER on every page
  // =========================================================================
  const pages = pdfDoc.getPages()
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i]
    page.drawText(`Firm Funds Incorporated  •  firmfunds.ca  •  Confidential`, {
      x: MARGIN, y: 20, size: 7, font: helvetica, color: GREY,
    })
    page.drawText(`Page ${i + 1} of ${pages.length}`, {
      x: PAGE_WIDTH - MARGIN - 60, y: 20, size: 7, font: helvetica, color: GREY,
    })
    // Bottom green accent
    page.drawRectangle({
      x: 0, y: 0, width: PAGE_WIDTH, height: 3, color: GREEN,
    })
  }

  // Serialize
  const pdfBytes = await pdfDoc.save()

  const filename = `Firm_Funds_Referral_Fees_${brokerage.name.replace(/[^a-zA-Z0-9]/g, '_')}_${monthParam || 'All_Time'}.pdf`

  return new Response(Buffer.from(pdfBytes), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  })
}
