'use client'

import { useEffect, useState, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import {
  BarChart3, TrendingUp, DollarSign, Clock, ArrowLeft, Download, FileText,
  Building2, Percent, Calendar, Activity, ChevronDown, ChevronUp,
} from 'lucide-react'
import { useTheme } from '@/lib/theme'
import { getStatusBadgeStyle, formatStatusLabel } from '@/lib/constants'
import { fetchReportMetrics, type ReportMetrics } from '@/lib/actions/report-actions'
import ThemeToggle from '@/components/ThemeToggle'

// ============================================================================
// Types
// ============================================================================

type DateRange = 'last_7' | 'last_30' | 'last_90' | 'ytd' | 'all'

const DATE_RANGE_LABELS: Record<DateRange, string> = {
  last_7: 'Last 7 Days',
  last_30: 'Last 30 Days',
  last_90: 'Last 90 Days',
  ytd: 'Year to Date',
  all: 'All Time',
}

// ============================================================================
// Helpers
// ============================================================================

const formatCurrency = (amount: number) =>
  new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 }).format(amount)

const formatCurrencyFull = (amount: number) =>
  new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(amount)

// ============================================================================
// Mini Bar Chart (SVG)
// ============================================================================

function BarChartSVG({ data, dataKey, color, height = 200 }: {
  data: { label: string; [key: string]: string | number }[]
  dataKey: string
  color: string
  height?: number
}) {
  const { colors } = useTheme()
  if (data.length === 0) return null

  const values = data.map(d => Number(d[dataKey]) || 0)
  const maxVal = Math.max(...values, 1)
  const barWidth = Math.max(16, Math.min(40, (600 - data.length * 4) / data.length))
  const chartWidth = data.length * (barWidth + 4)
  const chartHeight = height - 40

  return (
    <div className="overflow-x-auto">
      <svg width={Math.max(chartWidth, 300)} height={height} viewBox={`0 0 ${Math.max(chartWidth, 300)} ${height}`}>
        {/* Grid lines */}
        {[0.25, 0.5, 0.75, 1].map(pct => (
          <line
            key={pct}
            x1="0"
            y1={chartHeight - chartHeight * pct}
            x2={Math.max(chartWidth, 300)}
            y2={chartHeight - chartHeight * pct}
            stroke={colors.divider}
            strokeDasharray="4 4"
          />
        ))}
        {/* Bars */}
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
                fill={colors.textMuted}
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
  const { colors } = useTheme()
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

  // Area under the line
  const firstX = padding
  const lastX = padding + ((data.length - 1) / (data.length - 1)) * (chartWidth - padding * 2)
  const areaPath = `M${firstX},${chartHeight} L${points.split(' ').map(p => p).join(' L')} L${lastX},${chartHeight} Z`

  return (
    <div className="overflow-x-auto">
      <svg width={chartWidth} height={height} viewBox={`0 0 ${chartWidth} ${height}`}>
        {/* Grid lines */}
        {[0.25, 0.5, 0.75, 1].map(pct => (
          <line
            key={pct}
            x1="0"
            y1={chartHeight - chartHeight * pct}
            x2={chartWidth}
            y2={chartHeight - chartHeight * pct}
            stroke={colors.divider}
            strokeDasharray="4 4"
          />
        ))}
        {/* Area fill */}
        <path d={areaPath} fill={color} opacity="0.1" />
        {/* Line */}
        <polyline
          points={points}
          fill="none"
          stroke={color}
          strokeWidth="2.5"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {/* Dots + labels */}
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
                fill={colors.textMuted}
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
  const { colors } = useTheme()
  const segments = [
    { key: 'under_review', value: pipeline.under_review, color: '#3D5A99' },
    { key: 'approved', value: pipeline.approved, color: '#1A7A2E' },
    { key: 'funded', value: pipeline.funded, color: '#5B3D99' },
    { key: 'repaid', value: pipeline.repaid, color: '#0D7A5F' },
    { key: 'closed', value: pipeline.closed, color: '#5A5A5A' },
    { key: 'denied', value: pipeline.denied, color: '#993D3D' },
    { key: 'cancelled', value: pipeline.cancelled, color: '#995C1A' },
  ].filter(s => s.value > 0)

  const total = segments.reduce((s, seg) => s + seg.value, 0)
  if (total === 0) {
    return (
      <div className="flex items-center justify-center py-8">
        <p className="text-sm" style={{ color: colors.textMuted }}>No deals in pipeline</p>
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
        {/* Center text */}
        <text x={cx} y={cy - 6} textAnchor="middle" fontSize="22" fontWeight="bold" fill={colors.textPrimary}>{total}</text>
        <text x={cx} y={cy + 12} textAnchor="middle" fontSize="9" fill={colors.textMuted}>DEALS</text>
      </svg>
      <div className="flex flex-col gap-1.5">
        {segments.map(seg => (
          <div key={seg.key} className="flex items-center gap-2">
            <div className="w-2.5 h-2.5 rounded-full" style={{ background: seg.color }} />
            <span className="text-xs" style={{ color: colors.textSecondary }}>
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
  const [error, setError] = useState<string | null>(null)
  const [brokerageExpanded, setBrokerageExpanded] = useState(true)
  const [exporting, setExporting] = useState<'csv' | 'pdf' | null>(null)
  const router = useRouter()
  const supabase = createClient()
  const { colors, isDark } = useTheme()

  const loadMetrics = useCallback(async (range: DateRange) => {
    setLoading(true)
    setError(null)
    const result = await fetchReportMetrics({ dateRange: range })
    if (result.success && result.data) {
      setMetrics(result.data)
    } else {
      setError(result.error || 'Failed to load report data')
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    // Auth check
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
    loadMetrics(range)
  }

  // CSV Export
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

  // PDF Export
  const handleExportPDF = () => {
    if (!metrics) return
    setExporting('pdf')

    // Build a printable HTML document and trigger print
    const printContent = buildPrintHTML(metrics, dateRange)
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

  // ============================================================================
  // Loading State
  // ============================================================================

  if (loading) {
    return (
      <div className="min-h-screen" style={{ background: colors.pageBg }}>
        <header style={{ background: colors.headerBgGradient }}>
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-5">
            <div className="h-6 w-36 rounded-md animate-pulse" style={{ background: 'rgba(255,255,255,0.1)' }} />
          </div>
        </header>
        <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="h-8 w-64 rounded-lg mb-2 animate-pulse" style={{ background: colors.skeletonBase }} />
          <div className="h-4 w-48 rounded mb-8 animate-pulse" style={{ background: colors.skeletonHighlight }} />
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5 mb-8">
            {[1, 2, 3, 4].map(i => (
              <div key={i} className="rounded-xl p-6" style={{ background: colors.cardBg, border: `1px solid ${colors.cardBorder}` }}>
                <div className="h-3 w-24 rounded animate-pulse mb-3" style={{ background: colors.skeletonHighlight }} />
                <div className="h-9 w-20 rounded-lg animate-pulse" style={{ background: colors.skeletonBase }} />
              </div>
            ))}
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            {[1, 2].map(i => (
              <div key={i} className="rounded-xl p-6 h-72" style={{ background: colors.cardBg, border: `1px solid ${colors.cardBorder}` }}>
                <div className="h-4 w-40 rounded animate-pulse mb-4" style={{ background: colors.skeletonHighlight }} />
                <div className="h-48 rounded-lg animate-pulse" style={{ background: colors.skeletonBase }} />
              </div>
            ))}
          </div>
        </main>
      </div>
    )
  }

  // ============================================================================
  // Error State
  // ============================================================================

  if (error || !metrics) {
    return (
      <div className="min-h-screen" style={{ background: colors.pageBg }}>
        <header style={{ background: colors.headerBgGradient }}>
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-5">
            <button onClick={() => router.push('/admin')} className="flex items-center gap-2 text-sm" style={{ color: '#C4B098' }}>
              <ArrowLeft size={16} /> Back to Dashboard
            </button>
          </div>
        </header>
        <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16 text-center">
          <FileText className="mx-auto mb-4" size={48} style={{ color: colors.textFaint }} />
          <p className="text-lg font-semibold" style={{ color: colors.textPrimary }}>Something went wrong</p>
          <p className="text-sm mt-2" style={{ color: colors.textMuted }}>{error || 'Failed to load report data'}</p>
          <button
            onClick={() => loadMetrics(dateRange)}
            className="mt-4 px-4 py-2 rounded-lg text-sm font-semibold"
            style={{ background: colors.gold, color: '#1E1E1E' }}
          >
            Try Again
          </button>
        </main>
      </div>
    )
  }

  // ============================================================================
  // Main Render
  // ============================================================================

  return (
    <div className="min-h-screen" style={{ background: colors.pageBg }}>
      {/* Header */}
      <header style={{ background: colors.headerBgGradient }}>
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center py-5">
            <div className="flex items-center gap-4">
              <button
                onClick={() => router.push('/admin')}
                className="flex items-center gap-2 text-sm transition-colors"
                style={{ color: '#888' }}
                onMouseEnter={(e) => { e.currentTarget.style.color = '#C4B098' }}
                onMouseLeave={(e) => { e.currentTarget.style.color = '#888' }}
              >
                <ArrowLeft size={16} /> Dashboard
              </button>
              <div className="w-px h-6" style={{ background: 'rgba(255,255,255,0.15)' }} />
              <div className="flex items-center gap-2">
                <BarChart3 size={18} style={{ color: '#C4B098' }} />
                <p className="text-sm font-medium tracking-wide text-white">Reports</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              {/* Export buttons */}
              <button
                onClick={handleExportCSV}
                disabled={exporting === 'csv'}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold transition-colors"
                style={{ color: colors.successText, border: `1px solid ${colors.successBorder}`, background: 'transparent' }}
                onMouseEnter={(e) => e.currentTarget.style.background = colors.successBg}
                onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
              >
                <Download size={13} />
                {exporting === 'csv' ? 'Exporting...' : 'CSV'}
              </button>
              <button
                onClick={handleExportPDF}
                disabled={exporting === 'pdf'}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold transition-colors"
                style={{ color: colors.infoText, border: `1px solid ${colors.infoBorder}`, background: 'transparent' }}
                onMouseEnter={(e) => e.currentTarget.style.background = colors.infoBg}
                onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
              >
                <FileText size={13} />
                {exporting === 'pdf' ? 'Generating...' : 'PDF Report'}
              </button>
              <ThemeToggle />
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Title + Date Range */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-8">
          <div>
            <h2 className="text-2xl font-bold" style={{ color: colors.textPrimary }}>
              Reporting Dashboard
            </h2>
            <p className="text-sm mt-1" style={{ color: colors.textMuted }}>
              Financial performance and pipeline analytics
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {(Object.entries(DATE_RANGE_LABELS) as [DateRange, string][]).map(([key, label]) => {
              const isActive = dateRange === key
              return (
                <button
                  key={key}
                  onClick={() => handleDateChange(key)}
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-all"
                  style={isActive
                    ? { background: colors.gold, color: '#1E1E1E' }
                    : { background: colors.cardBg, color: colors.textSecondary, border: `1px solid ${colors.border}` }
                  }
                  onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = colors.cardHoverBg }}
                  onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = isActive ? colors.gold : colors.cardBg }}
                >
                  {label}
                </button>
              )
            })}
          </div>
        </div>

        {/* KPI Cards Row 1: Revenue Metrics */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5 mb-6">
          {[
            { label: 'Total Revenue', value: formatCurrency(metrics.totalRevenue), icon: DollarSign, accent: '#C4B098', sub: 'Discount fees earned' },
            { label: 'Total Advanced', value: formatCurrency(metrics.totalAdvanced), icon: TrendingUp, accent: '#5B3D99', sub: 'Capital deployed' },
            { label: 'Net Profit', value: formatCurrency(metrics.totalProfit), icon: DollarSign, accent: '#1A7A2E', sub: 'After referral fees' },
            { label: 'Referral Fees Paid', value: formatCurrency(metrics.totalReferralFeesPaid), icon: Building2, accent: '#3D5A99', sub: 'To partner brokerages' },
          ].map((card) => (
            <div
              key={card.label}
              className="rounded-xl p-6"
              style={{ background: colors.cardBg, border: `1px solid ${colors.cardBorder}` }}
            >
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: colors.textMuted }}>{card.label}</p>
                  <p className="text-2xl font-black mt-2" style={{ color: colors.textPrimary }}>{card.value}</p>
                  <p className="text-xs mt-1" style={{ color: colors.textFaint }}>{card.sub}</p>
                </div>
                <div className="w-11 h-11 rounded-xl flex items-center justify-center" style={{ background: `${card.accent}12` }}>
                  <card.icon size={20} style={{ color: card.accent }} />
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* KPI Cards Row 2: Performance Metrics */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5 mb-8">
          {[
            { label: 'Total Deals', value: metrics.totalDeals.toString(), icon: FileText, accent: '#C4B098' },
            { label: 'Avg Discount Fee', value: formatCurrencyFull(metrics.avgDiscountFee), icon: DollarSign, accent: '#995C1A' },
            { label: 'Avg Days to Close', value: `${Math.round(metrics.avgDaysToClose)} days`, icon: Clock, accent: '#0D7A5F' },
            { label: 'Conversion Rate', value: `${metrics.conversionRate.toFixed(1)}%`, icon: Percent, accent: '#5B3D99' },
          ].map((card) => (
            <div
              key={card.label}
              className="rounded-xl p-5"
              style={{ background: colors.cardBg, border: `1px solid ${colors.cardBorder}` }}
            >
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-lg flex items-center justify-center" style={{ background: `${card.accent}12` }}>
                  <card.icon size={16} style={{ color: card.accent }} />
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: colors.textMuted }}>{card.label}</p>
                  <p className="text-xl font-bold mt-0.5" style={{ color: colors.textPrimary }}>{card.value}</p>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Charts Row */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-8">
          {/* Revenue Chart */}
          <div className="rounded-xl p-6" style={{ background: colors.cardBg, border: `1px solid ${colors.cardBorder}` }}>
            <div className="flex items-center gap-2 mb-4">
              <TrendingUp size={16} style={{ color: colors.gold }} />
              <h3 className="text-sm font-bold" style={{ color: colors.textPrimary }}>Monthly Revenue</h3>
            </div>
            {metrics.monthlyTrends.some(m => m.revenue > 0) ? (
              <LineChartSVG
                data={metrics.monthlyTrends}
                dataKey="revenue"
                color={colors.gold}
                height={220}
              />
            ) : (
              <div className="flex items-center justify-center h-48">
                <p className="text-sm" style={{ color: colors.textMuted }}>No revenue data yet</p>
              </div>
            )}
          </div>

          {/* Deal Volume Chart */}
          <div className="rounded-xl p-6" style={{ background: colors.cardBg, border: `1px solid ${colors.cardBorder}` }}>
            <div className="flex items-center gap-2 mb-4">
              <BarChart3 size={16} style={{ color: '#5B3D99' }} />
              <h3 className="text-sm font-bold" style={{ color: colors.textPrimary }}>Deal Volume by Month</h3>
            </div>
            {metrics.monthlyTrends.some(m => m.deals > 0) ? (
              <BarChartSVG
                data={metrics.monthlyTrends}
                dataKey="deals"
                color="#5B3D99"
                height={220}
              />
            ) : (
              <div className="flex items-center justify-center h-48">
                <p className="text-sm" style={{ color: colors.textMuted }}>No deal data yet</p>
              </div>
            )}
          </div>
        </div>

        {/* Second Charts Row */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-8">
          {/* Pipeline Donut */}
          <div className="rounded-xl p-6" style={{ background: colors.cardBg, border: `1px solid ${colors.cardBorder}` }}>
            <div className="flex items-center gap-2 mb-4">
              <Activity size={16} style={{ color: '#3D5A99' }} />
              <h3 className="text-sm font-bold" style={{ color: colors.textPrimary }}>Pipeline Breakdown</h3>
            </div>
            <PipelineDonut pipeline={metrics.pipeline} />
          </div>

          {/* Profit Trend */}
          <div className="rounded-xl p-6" style={{ background: colors.cardBg, border: `1px solid ${colors.cardBorder}` }}>
            <div className="flex items-center gap-2 mb-4">
              <DollarSign size={16} style={{ color: '#1A7A2E' }} />
              <h3 className="text-sm font-bold" style={{ color: colors.textPrimary }}>Monthly Profit</h3>
            </div>
            {metrics.monthlyTrends.some(m => m.profit > 0) ? (
              <BarChartSVG
                data={metrics.monthlyTrends}
                dataKey="profit"
                color="#1A7A2E"
                height={220}
              />
            ) : (
              <div className="flex items-center justify-center h-48">
                <p className="text-sm" style={{ color: colors.textMuted }}>No profit data yet</p>
              </div>
            )}
          </div>
        </div>

        {/* Brokerage Performance Table */}
        <div className="rounded-xl overflow-hidden" style={{ background: colors.cardBg, border: `1px solid ${colors.cardBorder}` }}>
          <div
            className="px-6 py-5 flex items-center justify-between cursor-pointer"
            style={{ borderBottom: `1px solid ${colors.border}` }}
            onClick={() => setBrokerageExpanded(!brokerageExpanded)}
          >
            <div className="flex items-center gap-2">
              <Building2 size={16} style={{ color: colors.gold }} />
              <h3 className="text-lg font-bold" style={{ color: colors.textPrimary }}>Brokerage Performance</h3>
              <span className="text-xs font-medium" style={{ color: colors.textMuted }}>
                ({metrics.brokeragePerformance.length} brokerage{metrics.brokeragePerformance.length !== 1 ? 's' : ''})
              </span>
            </div>
            {brokerageExpanded ? <ChevronUp size={18} style={{ color: colors.textMuted }} /> : <ChevronDown size={18} style={{ color: colors.textMuted }} />}
          </div>
          {brokerageExpanded && (
            <>
              {metrics.brokeragePerformance.length === 0 ? (
                <div className="px-6 py-12 text-center">
                  <Building2 className="mx-auto mb-3" size={36} style={{ color: colors.textFaint }} />
                  <p className="text-sm font-medium" style={{ color: colors.textSecondary }}>No brokerage data yet</p>
                  <p className="text-xs mt-1" style={{ color: colors.textMuted }}>Deal activity will populate this table.</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr style={{ background: colors.tableHeaderBg }}>
                        <th className="px-6 py-3.5 text-left text-xs font-bold uppercase tracking-wider" style={{ color: colors.textMuted }}>#</th>
                        <th className="px-6 py-3.5 text-left text-xs font-bold uppercase tracking-wider" style={{ color: colors.textMuted }}>Brokerage</th>
                        <th className="px-6 py-3.5 text-right text-xs font-bold uppercase tracking-wider" style={{ color: colors.textMuted }}>Total Deals</th>
                        <th className="px-6 py-3.5 text-right text-xs font-bold uppercase tracking-wider" style={{ color: colors.textMuted }}>Funded</th>
                        <th className="px-6 py-3.5 text-right text-xs font-bold uppercase tracking-wider" style={{ color: colors.textMuted }}>Total Advanced</th>
                        <th className="px-6 py-3.5 text-right text-xs font-bold uppercase tracking-wider" style={{ color: colors.textMuted }}>Referral Fees</th>
                        <th className="px-6 py-3.5 text-right text-xs font-bold uppercase tracking-wider" style={{ color: colors.textMuted }}>Avg Deal Size</th>
                      </tr>
                    </thead>
                    <tbody>
                      {metrics.brokeragePerformance.map((brok, i) => (
                        <tr
                          key={brok.id}
                          style={{ borderBottom: i < metrics.brokeragePerformance.length - 1 ? `1px solid ${colors.divider}` : 'none' }}
                          onMouseEnter={(e) => e.currentTarget.style.background = colors.tableRowHoverBg}
                          onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                        >
                          <td className="px-6 py-4 text-sm font-bold" style={{ color: colors.textFaint }}>{i + 1}</td>
                          <td className="px-6 py-4">
                            <p className="text-sm font-semibold" style={{ color: colors.textPrimary }}>{brok.name}</p>
                            {brok.brand && <p className="text-xs" style={{ color: colors.textMuted }}>{brok.brand}</p>}
                          </td>
                          <td className="px-6 py-4 text-sm text-right font-medium" style={{ color: colors.textPrimary }}>{brok.totalDeals}</td>
                          <td className="px-6 py-4 text-sm text-right font-medium" style={{ color: colors.successText }}>{brok.fundedDeals}</td>
                          <td className="px-6 py-4 text-sm text-right font-bold" style={{ color: colors.textPrimary }}>{formatCurrency(brok.totalAdvanced)}</td>
                          <td className="px-6 py-4 text-sm text-right font-medium" style={{ color: colors.infoText }}>{formatCurrency(brok.totalReferralFees)}</td>
                          <td className="px-6 py-4 text-sm text-right" style={{ color: colors.textSecondary }}>{formatCurrency(brok.avgDealSize)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  )
}

// ============================================================================
// PDF Print Template
// ============================================================================

function buildPrintHTML(metrics: ReportMetrics, dateRange: DateRange): string {
  const rangeLabel = DATE_RANGE_LABELS[dateRange]
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
    h2 { font-size: 16px; margin-top: 28px; margin-bottom: 12px; color: #333; border-bottom: 2px solid #C4B098; padding-bottom: 4px; }
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

  <h2>Pipeline Breakdown</h2>
  <table>
    <thead><tr><th>Status</th><th style="text-align:right;">Count</th></tr></thead>
    <tbody>${pipelineRows || '<tr><td colspan="2" style="padding:12px;text-align:center;color:#888;">No deals in pipeline</td></tr>'}</tbody>
  </table>

  <h2>Brokerage Performance</h2>
  <table>
    <thead><tr><th>#</th><th>Brokerage</th><th style="text-align:right;">Total Deals</th><th style="text-align:right;">Funded</th><th style="text-align:right;">Total Advanced</th><th style="text-align:right;">Referral Fees</th></tr></thead>
    <tbody>${brokerageRows || '<tr><td colspan="6" style="padding:12px;text-align:center;color:#888;">No brokerage data</td></tr>'}</tbody>
  </table>

  <p style="margin-top:32px;font-size:10px;color:#aaa;">firmfunds.ca &bull; Confidential</p>
</body>
</html>`
}
