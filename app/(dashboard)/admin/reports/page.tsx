'use client'

import { useEffect, useState, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import {
  BarChart3, TrendingUp, DollarSign, Clock, ArrowLeft, Download, FileText,
  Building2, Percent, Calendar, Activity, ChevronDown, ChevronUp, ChevronRight,
} from 'lucide-react'
import { getStatusBadgeClass, formatStatusLabel } from '@/lib/constants'
import { fetchReportMetrics, fetchBrokerageDetail, type ReportMetrics, type BrokerageDetail } from '@/lib/actions/report-actions'
import SignOutModal from '@/components/SignOutModal'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'

// ============================================================================
// Types
// ============================================================================

type DateRange = 'last_7' | 'last_30' | 'last_90' | 'ytd' | 'all' | 'custom'

const DATE_RANGE_LABELS: Record<Exclude<DateRange, 'custom'>, string> = {
  last_7: 'Last 7 Days',
  last_30: 'Last 30 Days',
  last_90: 'Last 90 Days',
  ytd: 'Year to Date',
  all: 'All Time',
}

import { formatCurrency as formatCurrencyFull, formatCurrencyWhole as formatCurrency } from '@/lib/formatting'

// ============================================================================
// Mini Bar Chart (SVG) — uses literal dark-theme colors for SVG attrs
// ============================================================================

function BarChartSVG({ data, dataKey, color, height = 200 }: {
  data: { label: string; [key: string]: string | number }[]
  dataKey: string
  color: string
  height?: number
}) {
  if (data.length === 0) return null

  const values = data.map(d => Number(d[dataKey]) || 0)
  const maxVal = Math.max(...values, 1)
  const barWidth = Math.max(16, Math.min(40, (600 - data.length * 4) / data.length))
  const chartWidth = data.length * (barWidth + 4)
  const chartHeight = height - 40

  return (
    <div className="overflow-x-auto">
      <svg width={Math.max(chartWidth, 300)} height={height} viewBox={`0 0 ${Math.max(chartWidth, 300)} ${height}`}>
        {[0.25, 0.5, 0.75, 1].map(pct => (
          <line
            key={pct}
            x1="0"
            y1={chartHeight - chartHeight * pct}
            x2={Math.max(chartWidth, 300)}
            y2={chartHeight - chartHeight * pct}
            stroke="var(--border)"
            strokeDasharray="4 4"
          />
        ))}
        {data.map((d, i) => {
          const val = Number(d[dataKey]) || 0
          const barH = (val / maxVal) * chartHeight
          const x = i * (barWidth + 4) + 2
          return (
            <g key={i}>
              <rect
                x={x}
                y={chartHeight - barH}
                width={barWidth}
                height={Math.max(barH, 1)}
                rx={4}
                fill={color}
                opacity={0.85}
              />
              <text
                x={x + barWidth / 2}
                y={height - 4}
                textAnchor="middle"
                fontSize="9"
                fill="var(--muted-foreground)"
              >
                {d.label.split(' ')[0]}
              </text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}

// ============================================================================
// Mini Line Chart (SVG)
// ============================================================================

function LineChartSVG({ data, dataKey, color, height = 200 }: {
  data: { label: string; [key: string]: string | number }[]
  dataKey: string
  color: string
  height?: number
}) {
  if (data.length < 2) return null

  const values = data.map(d => Number(d[dataKey]) || 0)
  const maxVal = Math.max(...values, 1)
  const padding = 20
  const chartWidth = Math.max(data.length * 50, 300)
  const chartHeight = height - 40

  const points = data.map((_, i) => {
    const x = padding + (i / (data.length - 1)) * (chartWidth - padding * 2)
    const y = chartHeight - (values[i] / maxVal) * chartHeight
    return `${x},${y}`
  }).join(' ')

  const firstX = padding
  const lastX = padding + ((data.length - 1) / (data.length - 1)) * (chartWidth - padding * 2)
  const areaPath = `M${firstX},${chartHeight} L${points.split(' ').map(p => p).join(' L')} L${lastX},${chartHeight} Z`

  return (
    <div className="overflow-x-auto">
      <svg width={chartWidth} height={height} viewBox={`0 0 ${chartWidth} ${height}`}>
        {[0.25, 0.5, 0.75, 1].map(pct => (
          <line
            key={pct}
            x1="0"
            y1={chartHeight - chartHeight * pct}
            x2={chartWidth}
            y2={chartHeight - chartHeight * pct}
            stroke="var(--border)"
            strokeDasharray="4 4"
          />
        ))}
        <path d={areaPath} fill={color} opacity="0.1" />
        <polyline
          points={points}
          fill="none"
          stroke={color}
          strokeWidth="2.5"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {data.map((d, i) => {
          const x = padding + (i / (data.length - 1)) * (chartWidth - padding * 2)
          const y = chartHeight - (values[i] / maxVal) * chartHeight
          return (
            <g key={i}>
              <circle cx={x} cy={y} r={3.5} fill={color} />
              <text
                x={x}
                y={height - 4}
                textAnchor="middle"
                fontSize="9"
                fill="var(--muted-foreground)"
              >
                {d.label.split(' ')[0]}
              </text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}

// ============================================================================
// Pipeline Donut Chart (SVG)
// ============================================================================

function PipelineDonut({ pipeline }: { pipeline: ReportMetrics['pipeline'] }) {
  const segments = [
    { key: 'under_review', value: pipeline.under_review, color: 'var(--action-blue)' },
    { key: 'approved', value: pipeline.approved, color: 'var(--action-green)' },
    { key: 'funded', value: pipeline.funded, color: 'var(--action-purple)' },
    { key: 'completed', value: pipeline.completed, color: 'var(--action-teal)' },
    { key: 'denied', value: pipeline.denied, color: 'var(--action-red)' },
    { key: 'cancelled', value: pipeline.cancelled, color: 'var(--status-amber)' },
  ].filter(s => s.value > 0)

  const total = segments.reduce((s, seg) => s + seg.value, 0)
  if (total === 0) {
    return (
      <div className="flex items-center justify-center py-8">
        <p className="text-sm text-muted-foreground">No deals in pipeline</p>
      </div>
    )
  }

  const size = 160
  const cx = size / 2
  const cy = size / 2
  const radius = 60
  const innerRadius = 40

  let startAngle = -90

  return (
    <div className="flex items-center gap-6">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {segments.map((seg) => {
          const angle = (seg.value / total) * 360
          const endAngle = startAngle + angle

          const startRad = (startAngle * Math.PI) / 180
          const endRad = (endAngle * Math.PI) / 180

          const x1outer = cx + radius * Math.cos(startRad)
          const y1outer = cy + radius * Math.sin(startRad)
          const x2outer = cx + radius * Math.cos(endRad)
          const y2outer = cy + radius * Math.sin(endRad)
          const x1inner = cx + innerRadius * Math.cos(endRad)
          const y1inner = cy + innerRadius * Math.sin(endRad)
          const x2inner = cx + innerRadius * Math.cos(startRad)
          const y2inner = cy + innerRadius * Math.sin(startRad)

          const largeArc = angle > 180 ? 1 : 0

          const path = [
            `M ${x1outer} ${y1outer}`,
            `A ${radius} ${radius} 0 ${largeArc} 1 ${x2outer} ${y2outer}`,
            `L ${x1inner} ${y1inner}`,
            `A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${x2inner} ${y2inner}`,
            'Z',
          ].join(' ')

          startAngle = endAngle

          return <path key={seg.key} d={path} fill={seg.color} />
        })}
        <text x={cx} y={cy - 6} textAnchor="middle" fontSize="22" fontWeight="bold" fill="var(--foreground)">{total}</text>
        <text x={cx} y={cy + 12} textAnchor="middle" fontSize="9" fill="var(--muted-foreground)">DEALS</text>
      </svg>
      <div className="flex flex-col gap-1.5">
        {segments.map(seg => (
          <div key={seg.key} className="flex items-center gap-2">
            <div className="w-2.5 h-2.5 rounded-full" style={{ background: seg.color }} />
            <span className="text-xs text-foreground/80">
              {formatStatusLabel(seg.key)} ({seg.value})
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ============================================================================
// Main Component
// ============================================================================

export default function ReportsPage() {
  const [loading, setLoading] = useState(true)
  const [metrics, setMetrics] = useState<ReportMetrics | null>(null)
  const [dateRange, setDateRange] = useState<DateRange>('all')
  const [customStart, setCustomStart] = useState('')
  const [customEnd, setCustomEnd] = useState('')
  const [showCustomPicker, setShowCustomPicker] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [brokerageExpanded, setBrokerageExpanded] = useState(true)
  const [exporting, setExporting] = useState<'csv' | 'pdf' | null>(null)
  const [selectedBrokerage, setSelectedBrokerage] = useState<BrokerageDetail | null>(null)
  const [brokerageLoading, setBrokerageLoading] = useState(false)
  const router = useRouter()
  const supabase = createClient()

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }

  const loadMetrics = useCallback(async (range: DateRange, startDate?: string, endDate?: string) => {
    setLoading(true)
    setError(null)
    const result = await fetchReportMetrics({
      dateRange: range,
      customStart: startDate,
      customEnd: endDate,
    })
    if (result.success && result.data) {
      setMetrics(result.data)
    } else {
      setError(result.error || 'Failed to load report data')
    }
    setLoading(false)
  }, [])

  const handleBrokerageClick = async (brokerageId: string) => {
    setBrokerageLoading(true)
    const result = await fetchBrokerageDetail({ brokerageId })
    if (result.success && result.data) {
      setSelectedBrokerage(result.data)
    }
    setBrokerageLoading(false)
  }

  useEffect(() => {
    async function init() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }
      const { data: profile } = await supabase.from('user_profiles').select('role').eq('id', user.id).single()
      if (!profile || !['super_admin', 'firm_funds_admin'].includes(profile.role)) {
        router.push('/login')
        return
      }
      loadMetrics(dateRange)
    }
    init()
  }, [])

  const handleDateChange = (range: DateRange) => {
    setDateRange(range)
    setShowCustomPicker(false)
    loadMetrics(range)
  }

  const handleCustomDateApply = () => {
    if (!customStart || !customEnd) return
    setDateRange('custom')
    loadMetrics('custom', customStart, customEnd)
  }

  const handleExportCSV = () => {
    if (!metrics) return
    setExporting('csv')

    const headers = [
      'Property Address', 'Status', 'Agent', 'Brokerage', 'Gross Commission',
      'Brokerage Split %', 'Net Commission', 'Discount Fee', 'Advance Amount',
      'Referral Fee', 'Days to Closing', 'Closing Date', 'Funding Date', 'Created',
    ]

    const rows = metrics.exportDeals.map(d => [
      `"${d.property_address.replace(/"/g, '""')}"`,
      d.status,
      `"${d.agent_name}"`,
      `"${d.brokerage_name}"`,
      d.gross_commission.toFixed(2),
      d.brokerage_split_pct.toFixed(1),
      d.net_commission.toFixed(2),
      d.discount_fee.toFixed(2),
      d.advance_amount.toFixed(2),
      d.brokerage_referral_fee.toFixed(2),
      d.days_until_closing.toString(),
      d.closing_date,
      d.funding_date || '',
      new Date(d.created_at).toLocaleDateString('en-CA'),
    ])

    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `firm-funds-report-${dateRange}-${new Date().toISOString().split('T')[0]}.csv`
    a.click()
    URL.revokeObjectURL(url)
    setExporting(null)
  }

  const handleExportPDF = () => {
    if (!metrics) return
    setExporting('pdf')

    const printContent = buildPrintHTML(metrics, dateRange, customStart, customEnd)
    const printWindow = window.open('', '_blank')
    if (printWindow) {
      printWindow.document.write(printContent)
      printWindow.document.close()
      printWindow.onload = () => {
        printWindow.print()
      }
    }
    setExporting(null)
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-background">
        <header className="bg-card/80 backdrop-blur-sm border-b border-border/50">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-5">
            <Skeleton className="h-6 w-36 bg-white/10" />
          </div>
        </header>
        <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <Skeleton className="h-8 w-64 rounded-lg mb-2" />
          <Skeleton className="h-4 w-48 rounded mb-8" />
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5 mb-8">
            {[1, 2, 3, 4].map(i => (
              <Card key={i}>
                <CardContent className="p-6">
                  <Skeleton className="h-3 w-24 mb-3" />
                  <Skeleton className="h-9 w-20" />
                </CardContent>
              </Card>
            ))}
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            {[1, 2].map(i => (
              <Card key={i}>
                <CardContent className="p-6 h-72">
                  <Skeleton className="h-4 w-40 mb-4" />
                  <Skeleton className="h-48" />
                </CardContent>
              </Card>
            ))}
          </div>
        </main>
      </div>
    )
  }

  if (error || !metrics) {
    return (
      <div className="min-h-screen bg-background">
        <header className="bg-card/80 backdrop-blur-sm border-b border-border/50">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-5">
            <button onClick={() => router.push('/admin')} className="flex items-center gap-2 text-sm text-primary hover:opacity-80 transition-opacity">
              <ArrowLeft size={16} /> Back to Dashboard
            </button>
          </div>
        </header>
        <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16 text-center">
          <FileText className="mx-auto mb-4 text-muted-foreground/30" size={48} />
          <p className="text-lg font-semibold text-foreground">Something went wrong</p>
          <p className="text-sm mt-2 text-muted-foreground">{error || 'Failed to load report data'}</p>
          <Button onClick={() => loadMetrics(dateRange)} className="mt-4">Try Again</Button>
        </main>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="bg-card/80 backdrop-blur-sm border-b border-border/50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center py-5">
            <div className="flex items-center gap-3">
              <img src="/brand/white.png" alt="Firm Funds" className="h-8 sm:h-10 w-auto" />
              <div className="w-px h-6 bg-border/30" />
              <button
                onClick={() => router.push('/admin')}
                className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-white/5 transition-colors"
              >
                <ArrowLeft size={14} /> Back
              </button>
              <div className="w-px h-6 bg-border/30" />
              <p className="text-sm font-semibold tracking-wide text-foreground">Reports</p>
            </div>
            <div className="flex items-center gap-3">
              <Button
                onClick={handleExportCSV}
                disabled={exporting === 'csv'}
                variant="outline"
                size="sm"
                className="gap-1.5 text-green-400 border-green-800 hover:bg-green-950/30"
              >
                <Download size={13} />
                {exporting === 'csv' ? 'Exporting...' : 'CSV'}
              </Button>
              <Button
                onClick={handleExportPDF}
                disabled={exporting === 'pdf'}
                variant="outline"
                size="sm"
                className="gap-1.5 text-blue-400 border-blue-800 hover:bg-blue-950/30"
              >
                <FileText size={13} />
                {exporting === 'pdf' ? 'Generating...' : 'PDF Report'}
              </Button>
              <SignOutModal onConfirm={handleLogout} />
            </div>
          </div>
        </div>
      </header>

      <main id="main-content" className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <h1 className="sr-only">Reports</h1>

        {/* Title + Date Range */}
        <section aria-label="Report controls and metrics" className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-8">
          <div>
            <h2 className="text-2xl font-bold text-foreground">Reporting Dashboard</h2>
            <p className="text-sm mt-1 text-muted-foreground">Financial performance and pipeline analytics</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {(Object.entries(DATE_RANGE_LABELS) as [Exclude<DateRange, 'custom'>, string][]).map(([key, label]) => {
              const isActive = dateRange === key
              return (
                <Button
                  key={key}
                  onClick={() => handleDateChange(key)}
                  variant={isActive ? 'default' : 'outline'}
                  size="sm"
                >
                  {label}
                </Button>
              )
            })}
            <Button
              onClick={() => setShowCustomPicker(!showCustomPicker)}
              variant={dateRange === 'custom' ? 'default' : 'outline'}
              size="sm"
              className="gap-1"
            >
              <Calendar size={12} />
              {dateRange === 'custom' ? `${customStart} — ${customEnd}` : 'Custom'}
            </Button>
          </div>
        </section>

        {/* Custom Date Picker */}
        {showCustomPicker && (
          <Card className="mb-6">
            <CardContent className="p-4 flex flex-wrap items-end gap-4">
              <div>
                <label htmlFor="report-date-start" className="block text-xs font-semibold uppercase tracking-wider mb-1.5 text-muted-foreground">Start Date</label>
                <input
                  id="report-date-start"
                  type="date"
                  value={customStart}
                  onChange={(e) => setCustomStart(e.target.value)}
                  className="px-3 py-2 rounded-lg text-sm outline-none bg-input border border-border text-foreground [color-scheme:dark]"
                />
              </div>
              <div>
                <label htmlFor="report-date-end" className="block text-xs font-semibold uppercase tracking-wider mb-1.5 text-muted-foreground">End Date</label>
                <input
                  id="report-date-end"
                  type="date"
                  value={customEnd}
                  onChange={(e) => setCustomEnd(e.target.value)}
                  className="px-3 py-2 rounded-lg text-sm outline-none bg-input border border-border text-foreground [color-scheme:dark]"
                />
              </div>
              <Button
                onClick={handleCustomDateApply}
                disabled={!customStart || !customEnd}
                size="sm"
              >
                Apply
              </Button>
            </CardContent>
          </Card>
        )}

        {/* KPI Cards Row 1 */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5 mb-6">
          {[
            { label: 'Total Revenue', value: formatCurrency(metrics.totalRevenue), icon: DollarSign, accent: 'var(--primary)', sub: 'Discount fees earned' },
            { label: 'Total Advanced', value: formatCurrency(metrics.totalAdvanced), icon: TrendingUp, accent: 'var(--primary)', sub: 'Capital deployed' },
            { label: 'Net Profit', value: formatCurrency(metrics.totalProfit), icon: DollarSign, accent: 'var(--action-green)', sub: 'After referral fees' },
            { label: 'Referral Fees Paid', value: formatCurrency(metrics.totalReferralFeesPaid), icon: Building2, accent: 'var(--primary)', sub: 'To partner brokerages' },
          ].map((card) => (
            <Card key={card.label}>
              <CardContent className="p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{card.label}</p>
                    <p className="text-2xl font-black mt-2 text-foreground">{card.value}</p>
                    <p className="text-xs mt-1 text-muted-foreground/60">{card.sub}</p>
                  </div>
                  <div className="w-11 h-11 rounded-xl flex items-center justify-center" style={{ background: `color-mix(in srgb, ${card.accent} 7%, transparent)` }}>
                    <card.icon size={20} style={{ color: card.accent }} />
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* KPI Cards Row 2 */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5 mb-8">
          {[
            { label: 'Total Deals', value: metrics.totalDeals.toString(), icon: FileText, accent: 'var(--primary)' },
            { label: 'Avg Discount Fee', value: formatCurrencyFull(metrics.avgDiscountFee), icon: DollarSign, accent: 'var(--primary)' },
            { label: 'Avg Days to Close', value: `${Math.round(metrics.avgDaysToClose)} days`, icon: Clock, accent: 'var(--primary)' },
            { label: 'Conversion Rate', value: `${metrics.conversionRate.toFixed(1)}%`, icon: Percent, accent: 'var(--primary)' },
          ].map((card) => (
            <Card key={card.label}>
              <CardContent className="p-5">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-lg flex items-center justify-center" style={{ background: `color-mix(in srgb, ${card.accent} 7%, transparent)` }}>
                    <card.icon size={16} style={{ color: card.accent }} />
                  </div>
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{card.label}</p>
                    <p className="text-xl font-bold mt-0.5 text-foreground">{card.value}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Charts Row 1 */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-8">
          <Card>
            <CardContent className="p-6">
              <div className="flex items-center gap-2 mb-4">
                <TrendingUp size={16} className="text-primary" />
                <h3 className="text-sm font-bold text-foreground">Monthly Revenue</h3>
              </div>
              {metrics.monthlyTrends.some(m => m.revenue > 0) ? (
                <LineChartSVG data={metrics.monthlyTrends} dataKey="revenue" color="var(--primary)" height={220} />
              ) : (
                <div className="flex items-center justify-center h-48">
                  <p className="text-sm text-muted-foreground">No revenue data yet</p>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6">
              <div className="flex items-center gap-2 mb-4">
                <BarChart3 size={16} style={{ color: 'var(--action-purple)' }} />
                <h3 className="text-sm font-bold text-foreground">Deal Volume by Month</h3>
              </div>
              {metrics.monthlyTrends.some(m => m.deals > 0) ? (
                <BarChartSVG data={metrics.monthlyTrends} dataKey="deals" color="var(--action-purple)" height={220} />
              ) : (
                <div className="flex items-center justify-center h-48">
                  <p className="text-sm text-muted-foreground">No deal data yet</p>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Charts Row 2 */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-8">
          <Card>
            <CardContent className="p-6">
              <div className="flex items-center gap-2 mb-4">
                <Activity size={16} style={{ color: 'var(--action-blue)' }} />
                <h3 className="text-sm font-bold text-foreground">Pipeline Breakdown</h3>
              </div>
              <PipelineDonut pipeline={metrics.pipeline} />
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6">
              <div className="flex items-center gap-2 mb-4">
                <DollarSign size={16} style={{ color: 'var(--action-green)' }} />
                <h3 className="text-sm font-bold text-foreground">Monthly Profit</h3>
              </div>
              {metrics.monthlyTrends.some(m => m.profit > 0) ? (
                <BarChartSVG data={metrics.monthlyTrends} dataKey="profit" color="var(--action-green)" height={220} />
              ) : (
                <div className="flex items-center justify-center h-48">
                  <p className="text-sm text-muted-foreground">No profit data yet</p>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Brokerage Performance Table */}
        <Card className="overflow-hidden">
          <div
            className="px-6 py-5 flex items-center justify-between cursor-pointer hover:bg-muted/20 transition-colors border-b border-border/50"
            onClick={() => setBrokerageExpanded(!brokerageExpanded)}
          >
            <div className="flex items-center gap-2">
              <Building2 size={16} className="text-primary" />
              <h3 className="text-lg font-bold text-foreground">Brokerage Performance</h3>
              <span className="text-xs font-medium text-muted-foreground">
                ({metrics.brokeragePerformance.length} brokerage{metrics.brokeragePerformance.length !== 1 ? 's' : ''})
              </span>
            </div>
            {brokerageExpanded
              ? <ChevronUp size={18} className="text-muted-foreground" />
              : <ChevronDown size={18} className="text-muted-foreground" />
            }
          </div>
          {brokerageExpanded && (
            <>
              {metrics.brokeragePerformance.length === 0 ? (
                <div className="px-6 py-12 text-center">
                  <Building2 className="mx-auto mb-3 text-muted-foreground/30" size={36} />
                  <p className="text-sm font-medium text-muted-foreground">No brokerage data yet</p>
                  <p className="text-xs mt-1 text-muted-foreground/70">Deal activity will populate this table.</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="bg-muted/50 border-b border-border/50">
                        <th className="px-6 py-3.5 text-left text-xs font-bold uppercase tracking-wider text-muted-foreground">#</th>
                        <th className="px-6 py-3.5 text-left text-xs font-bold uppercase tracking-wider text-muted-foreground">Brokerage</th>
                        <th className="px-6 py-3.5 text-right text-xs font-bold uppercase tracking-wider text-muted-foreground">Total Deals</th>
                        <th className="px-6 py-3.5 text-right text-xs font-bold uppercase tracking-wider text-muted-foreground">Funded</th>
                        <th className="px-6 py-3.5 text-right text-xs font-bold uppercase tracking-wider text-muted-foreground">Total Advanced</th>
                        <th className="px-6 py-3.5 text-right text-xs font-bold uppercase tracking-wider text-muted-foreground">Referral Fees</th>
                        <th className="px-6 py-3.5 text-right text-xs font-bold uppercase tracking-wider text-muted-foreground">Avg Deal Size</th>
                      </tr>
                    </thead>
                    <tbody>
                      {metrics.brokeragePerformance.map((brok, i) => (
                        <tr
                          key={brok.id}
                          className="cursor-pointer border-b border-border/30 hover:bg-muted/20 transition-colors last:border-0"
                          onClick={() => handleBrokerageClick(brok.id)}
                        >
                          <td className="px-6 py-4 text-sm font-bold text-muted-foreground/40">{i + 1}</td>
                          <td className="px-6 py-4">
                            <div className="flex items-center gap-2">
                              <div>
                                <p className="text-sm font-semibold text-foreground">{brok.name}</p>
                                {brok.brand && <p className="text-xs text-muted-foreground">{brok.brand}</p>}
                              </div>
                              <ChevronRight size={14} className="text-muted-foreground/40" />
                            </div>
                          </td>
                          <td className="px-6 py-4 text-sm text-right font-medium text-foreground">{brok.totalDeals}</td>
                          <td className="px-6 py-4 text-sm text-right font-medium text-green-400">{brok.fundedDeals}</td>
                          <td className="px-6 py-4 text-sm text-right font-bold text-foreground">{formatCurrency(brok.totalAdvanced)}</td>
                          <td className="px-6 py-4 text-sm text-right font-medium text-blue-400">{formatCurrency(brok.totalReferralFees)}</td>
                          <td className="px-6 py-4 text-sm text-right text-foreground/80">{formatCurrency(brok.avgDealSize)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </Card>
      </main>

      {/* Brokerage Detail Modal */}
      {(selectedBrokerage || brokerageLoading) && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center pt-12 px-4 bg-black/60"
          onClick={() => { if (!brokerageLoading) setSelectedBrokerage(null) }}
        >
          <div
            className="w-full max-w-4xl max-h-[85vh] overflow-y-auto rounded-2xl bg-card border border-border/50 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            {brokerageLoading ? (
              <div className="p-8 text-center">
                <Skeleton className="h-6 w-48 mx-auto mb-4" />
                <Skeleton className="h-4 w-32 mx-auto" />
              </div>
            ) : selectedBrokerage && (
              <>
                {/* Modal Header */}
                <div className="px-6 py-5 flex items-center justify-between border-b border-border/50">
                  <div>
                    <div className="flex items-center gap-3">
                      <h3 className="text-xl font-bold text-foreground">{selectedBrokerage.name}</h3>
                      <span
                        className={`inline-flex px-2 py-0.5 text-xs font-semibold rounded-md ${getStatusBadgeClass(selectedBrokerage.status)}`}
                      >
                        {formatStatusLabel(selectedBrokerage.status)}
                      </span>
                    </div>
                    {selectedBrokerage.brand && <p className="text-sm mt-0.5 text-muted-foreground">{selectedBrokerage.brand}</p>}
                  </div>
                  <Button
                    onClick={() => setSelectedBrokerage(null)}
                    variant="outline"
                    size="sm"
                  >
                    ✕
                  </Button>
                </div>

                {/* KPI Cards */}
                <div className="px-6 py-5">
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
                    {[
                      { label: 'Total Deals', value: selectedBrokerage.totalDeals.toString(), accent: 'var(--primary)' },
                      { label: 'Funded', value: selectedBrokerage.fundedDeals.toString(), accent: 'var(--action-green)' },
                      { label: 'Total Advanced', value: formatCurrency(selectedBrokerage.totalAdvanced), accent: 'var(--primary)' },
                      { label: 'Referral Fees', value: formatCurrency(selectedBrokerage.totalReferralFees), accent: 'var(--primary)' },
                    ].map(card => (
                      <div key={card.label} className="rounded-lg p-4 bg-background border border-border/50">
                        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{card.label}</p>
                        <p className="text-xl font-bold mt-1" style={{ color: card.accent }}>{card.value}</p>
                      </div>
                    ))}
                  </div>

                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
                    {[
                      { label: 'Revenue', value: formatCurrency(selectedBrokerage.totalRevenue) },
                      { label: 'Avg Deal Size', value: formatCurrency(selectedBrokerage.avgDealSize) },
                      { label: 'Avg Days to Close', value: `${Math.round(selectedBrokerage.avgDaysToClose)} days` },
                      { label: 'Referral Rate', value: `${(selectedBrokerage.referralFeePercentage * 100).toFixed(0)}%` },
                    ].map(card => (
                      <div key={card.label} className="rounded-lg p-4 bg-background border border-border/50">
                        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{card.label}</p>
                        <p className="text-lg font-bold mt-1 text-foreground">{card.value}</p>
                      </div>
                    ))}
                  </div>

                  {/* Pipeline */}
                  {Object.keys(selectedBrokerage.pipeline).length > 0 && (
                    <div className="mb-6">
                      <h4 className="text-sm font-bold mb-3 text-foreground">Pipeline</h4>
                      <div className="flex flex-wrap gap-2">
                        {Object.entries(selectedBrokerage.pipeline).map(([status, count]) => (
                          <span
                            key={status}
                            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold ${getStatusBadgeClass(status)}`}
                          >
                            {formatStatusLabel(status)}: {count}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Agent Performance */}
                  {selectedBrokerage.agents.length > 0 && (
                    <div className="mb-6">
                      <h4 className="text-sm font-bold mb-3 text-foreground">Agent Performance</h4>
                      <div className="rounded-lg overflow-hidden border border-border/50">
                        <table className="w-full">
                          <thead>
                            <tr className="bg-muted/50 border-b border-border/50">
                              <th className="px-4 py-2.5 text-left text-xs font-bold uppercase tracking-wider text-muted-foreground">Agent</th>
                              <th className="px-4 py-2.5 text-right text-xs font-bold uppercase tracking-wider text-muted-foreground">Deals</th>
                              <th className="px-4 py-2.5 text-right text-xs font-bold uppercase tracking-wider text-muted-foreground">Funded</th>
                              <th className="px-4 py-2.5 text-right text-xs font-bold uppercase tracking-wider text-muted-foreground">Advanced</th>
                            </tr>
                          </thead>
                          <tbody>
                            {selectedBrokerage.agents.map((agent, i) => (
                              <tr key={agent.id} className="border-b border-border/30 last:border-0">
                                <td className="px-4 py-3 text-sm font-medium text-foreground">{agent.name}</td>
                                <td className="px-4 py-3 text-sm text-right text-foreground/80">{agent.totalDeals}</td>
                                <td className="px-4 py-3 text-sm text-right font-medium text-green-400">{agent.fundedDeals}</td>
                                <td className="px-4 py-3 text-sm text-right font-bold text-foreground">{formatCurrency(agent.totalAdvanced)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {/* Recent Deals */}
                  {selectedBrokerage.recentDeals.length > 0 && (
                    <div>
                      <h4 className="text-sm font-bold mb-3 text-foreground">Recent Deals</h4>
                      <div className="rounded-lg overflow-hidden border border-border/50">
                        <table className="w-full">
                          <thead>
                            <tr className="bg-muted/50 border-b border-border/50">
                              <th className="px-4 py-2.5 text-left text-xs font-bold uppercase tracking-wider text-muted-foreground">Property</th>
                              <th className="px-4 py-2.5 text-left text-xs font-bold uppercase tracking-wider text-muted-foreground">Status</th>
                              <th className="px-4 py-2.5 text-left text-xs font-bold uppercase tracking-wider text-muted-foreground">Agent</th>
                              <th className="px-4 py-2.5 text-right text-xs font-bold uppercase tracking-wider text-muted-foreground">Advance</th>
                              <th className="px-4 py-2.5 text-right text-xs font-bold uppercase tracking-wider text-muted-foreground">Closing</th>
                            </tr>
                          </thead>
                          <tbody>
                            {selectedBrokerage.recentDeals.map((deal, i) => (
                              <tr
                                key={deal.id}
                                className="cursor-pointer border-b border-border/30 last:border-0 hover:bg-muted/20 transition-colors"
                                onClick={() => { setSelectedBrokerage(null); router.push(`/admin/deals/${deal.id}`) }}
                              >
                                <td className="px-4 py-3 text-sm font-medium text-foreground">{deal.property_address}</td>
                                <td className="px-4 py-3">
                                  <span className={`inline-flex px-2 py-0.5 text-xs font-semibold rounded-md ${getStatusBadgeClass(deal.status)}`}>
                                    {formatStatusLabel(deal.status)}
                                  </span>
                                </td>
                                <td className="px-4 py-3 text-sm text-foreground/80">{deal.agent_name}</td>
                                <td className={`px-4 py-3 text-sm text-right font-bold ${['denied', 'cancelled'].includes(deal.status) ? 'text-red-400' : 'text-green-400'}`}>
                                  {formatCurrency(deal.advance_amount)}
                                </td>
                                <td className="px-4 py-3 text-sm text-right text-muted-foreground">
                                  {new Date(deal.closing_date + 'T00:00:00').toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' })}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ============================================================================
// PDF Print Template
// ============================================================================

function buildPrintHTML(metrics: ReportMetrics, dateRange: DateRange, customStart?: string, customEnd?: string): string {
  const rangeLabel = dateRange === 'custom' ? `${customStart} to ${customEnd}` : DATE_RANGE_LABELS[dateRange as Exclude<DateRange, 'custom'>]
  const date = new Date().toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric' })

  const pipelineRows = Object.entries(metrics.pipeline)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `<tr><td style="padding:6px 12px;border-bottom:1px solid #eee;">${k.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}</td><td style="padding:6px 12px;border-bottom:1px solid #eee;text-align:right;font-weight:600;">${v}</td></tr>`)
    .join('')

  const brokerageRows = metrics.brokeragePerformance.map((b, i) =>
    `<tr>
      <td style="padding:6px 12px;border-bottom:1px solid #eee;">${i + 1}</td>
      <td style="padding:6px 12px;border-bottom:1px solid #eee;">${b.name}</td>
      <td style="padding:6px 12px;border-bottom:1px solid #eee;text-align:right;">${b.totalDeals}</td>
      <td style="padding:6px 12px;border-bottom:1px solid #eee;text-align:right;">${b.fundedDeals}</td>
      <td style="padding:6px 12px;border-bottom:1px solid #eee;text-align:right;">$${b.totalAdvanced.toLocaleString('en-CA', { minimumFractionDigits: 0 })}</td>
      <td style="padding:6px 12px;border-bottom:1px solid #eee;text-align:right;">$${b.totalReferralFees.toLocaleString('en-CA', { minimumFractionDigits: 0 })}</td>
    </tr>`
  ).join('')

  const fmtCAD = (n: number) => '$' + n.toLocaleString('en-CA', { minimumFractionDigits: 0, maximumFractionDigits: 0 })

  return `<!DOCTYPE html>
<html>
<head>
  <title>Firm Funds Report - ${rangeLabel}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #1E1E1E; margin: 40px; line-height: 1.5; }
    h1 { font-size: 24px; margin-bottom: 4px; }
    h2 { font-size: 16px; margin-top: 28px; margin-bottom: 12px; color: #333; border-bottom: 2px solid #5FA873; padding-bottom: 4px; }
    .subtitle { color: #888; font-size: 13px; margin-bottom: 24px; }
    .kpi-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 24px; }
    .kpi { padding: 16px; background: #f9f8f6; border-radius: 8px; border: 1px solid #eee; }
    .kpi-label { font-size: 10px; text-transform: uppercase; color: #888; letter-spacing: 0.5px; font-weight: 600; }
    .kpi-value { font-size: 22px; font-weight: 800; margin-top: 4px; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th { background: #f5f3ef; padding: 8px 12px; text-align: left; font-size: 10px; text-transform: uppercase; color: #888; letter-spacing: 0.5px; font-weight: 700; }
    @media print { body { margin: 20px; } .no-print { display: none; } }
  </style>
</head>
<body>
  <h1>Firm Funds Inc. — Report</h1>
  <p class="subtitle">${rangeLabel} &bull; Generated ${date}</p>

  <h2>Financial Summary</h2>
  <div class="kpi-grid">
    <div class="kpi"><div class="kpi-label">Total Revenue</div><div class="kpi-value">${fmtCAD(metrics.totalRevenue)}</div></div>
    <div class="kpi"><div class="kpi-label">Total Advanced</div><div class="kpi-value">${fmtCAD(metrics.totalAdvanced)}</div></div>
    <div class="kpi"><div class="kpi-label">Net Profit</div><div class="kpi-value">${fmtCAD(metrics.totalProfit)}</div></div>
    <div class="kpi"><div class="kpi-label">Referral Fees Paid</div><div class="kpi-value">${fmtCAD(metrics.totalReferralFeesPaid)}</div></div>
  </div>
  <div class="kpi-grid">
    <div class="kpi"><div class="kpi-label">Total Deals</div><div class="kpi-value">${metrics.totalDeals}</div></div>
    <div class="kpi"><div class="kpi-label">Avg Discount Fee</div><div class="kpi-value">${fmtCAD(metrics.avgDiscountFee)}</div></div>
    <div class="kpi"><div class="kpi-label">Avg Days to Close</div><div class="kpi-value">${Math.round(metrics.avgDaysToClose)} days</div></div>
    <div class="kpi"><div class="kpi-label">Conversion Rate</div><div class="kpi-value">${metrics.conversionRate.toFixed(1)}%</div></div>
  </div>

  <h2>Pipeline</h2>
  <table><thead><tr><th>Status</th><th style="text-align:right;">Count</th></tr></thead><tbody>${pipelineRows}</tbody></table>

  <h2>Brokerage Performance</h2>
  <table>
    <thead><tr><th>#</th><th>Brokerage</th><th style="text-align:right;">Deals</th><th style="text-align:right;">Funded</th><th style="text-align:right;">Advanced</th><th style="text-align:right;">Referral Fees</th></tr></thead>
    <tbody>${brokerageRows}</tbody>
  </table>
</body>
</html>`
}
