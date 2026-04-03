'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import { FileText, Users, Building2, DollarSign, Clock, CheckCircle, ChevronRight, Search, X, ChevronLeft, BarChart3 } from 'lucide-react'
import { getStatusBadgeStyle, formatStatusLabel } from '@/lib/constants'

import { useTheme } from '@/lib/theme'
import SignOutModal from '@/components/SignOutModal'

interface DashboardStats {
  totalDeals: number
  underReviewDeals: number
  approvedDeals: number
  fundedDeals: number
  totalAdvanced: number
  totalBrokerages: number
  totalAgents: number
}

export default function AdminDashboard() {
  const [user, setUser] = useState<any>(null)
  const [profile, setProfile] = useState<any>(null)
  const [stats, setStats] = useState<DashboardStats>({
    totalDeals: 0,
    underReviewDeals: 0,
    approvedDeals: 0,
    fundedDeals: 0,
    totalAdvanced: 0,
    totalBrokerages: 0,
    totalAgents: 0,
  })
  const [recentDeals, setRecentDeals] = useState<any[]>([])
  const [allDeals, setAllDeals] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<string | null>(null)
  const [currentPage, setCurrentPage] = useState(1)
  const [kpiRange, setKpiRange] = useState<'day' | 'week' | 'month' | 'year' | 'all'>('all')
  const DEALS_PER_PAGE = 15
  const router = useRouter()
  const supabase = createClient()
  const { colors, isDark } = useTheme()

  useEffect(() => {
    async function loadDashboard() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) {
        router.push('/login')
        return
      }
      setUser(user)

      const { data: profile } = await supabase
        .from('user_profiles')
        .select('*')
        .eq('id', user.id)
        .single()
      setProfile(profile)

      if (profile?.role !== 'super_admin' && profile?.role !== 'firm_funds_admin') {
        router.push('/login')
        return
      }

      // Fetch all deals once and compute stats client-side (replaces 6 separate count queries)
      const [
        { data: deals },
        { count: totalBrokerages },
        { count: totalAgents },
      ] = await Promise.all([
        supabase.from('deals').select('*').order('created_at', { ascending: false }),
        supabase.from('brokerages').select('*', { count: 'exact', head: true }),
        supabase.from('agents').select('*', { count: 'exact', head: true }),
      ])

      const allDealsList = deals || []
      const totalAdvanced = allDealsList
        .filter(d => d.status === 'funded')
        .reduce((sum, d) => sum + Number(d.advance_amount), 0)

      setStats({
        totalDeals: allDealsList.length,
        underReviewDeals: allDealsList.filter(d => d.status === 'under_review').length,
        approvedDeals: allDealsList.filter(d => d.status === 'approved').length,
        fundedDeals: allDealsList.filter(d => d.status === 'funded').length,
        totalAdvanced,
        totalBrokerages: totalBrokerages || 0,
        totalAgents: totalAgents || 0,
      })

      setAllDeals(allDealsList)
      setRecentDeals(allDealsList)

      setLoading(false)
    }
    loadDashboard()
  }, [])

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }

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
            {[1,2,3,4].map(i => (
              <div key={i} className="rounded-xl p-6" style={{ background: colors.cardBg, border: `1px solid ${colors.cardBorder}` }}>
                <div className="h-3 w-24 rounded animate-pulse mb-3" style={{ background: colors.skeletonHighlight }} />
                <div className="h-9 w-20 rounded-lg animate-pulse" style={{ background: colors.skeletonBase }} />
              </div>
            ))}
          </div>
          <div className="rounded-xl p-6" style={{ background: colors.cardBg, border: `1px solid ${colors.cardBorder}` }}>
            {[1,2,3,4,5].map(i => (
              <div key={i} className="flex gap-4 mb-4">
                <div className="h-4 flex-1 rounded animate-pulse" style={{ background: colors.skeletonHighlight }} />
                <div className="h-4 w-20 rounded animate-pulse" style={{ background: colors.skeletonHighlight }} />
                <div className="h-4 w-24 rounded animate-pulse" style={{ background: colors.skeletonHighlight }} />
              </div>
            ))}
          </div>
        </main>
      </div>
    )
  }

  // Status badge styles imported from shared constants (getStatusBadgeStyle)

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(amount)
  }

  // Filter deals by KPI time range
  const getFilteredDeals = () => {
    if (kpiRange === 'all') return allDeals
    const now = new Date()
    let cutoff: Date
    switch (kpiRange) {
      case 'day': cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate()); break
      case 'week': cutoff = new Date(now.getTime() - 7 * 86400000); break
      case 'month': cutoff = new Date(now.getFullYear(), now.getMonth(), 1); break
      case 'year': cutoff = new Date(now.getFullYear(), 0, 1); break
    }
    return allDeals.filter(d => new Date(d.created_at) >= cutoff)
  }

  const filteredDeals = getFilteredDeals()
  const filteredStats = {
    totalDeals: filteredDeals.length,
    totalAdvanced: filteredDeals.filter(d => d.status === 'funded').reduce((sum, d) => sum + Number(d.advance_amount), 0),
    underReviewDeals: filteredDeals.filter(d => d.status === 'under_review').length,
    approvedDeals: filteredDeals.filter(d => d.status === 'approved').length,
    fundedDeals: filteredDeals.filter(d => d.status === 'funded').length,
  }

  const kpiRangeLabel = { day: 'Today', week: 'This Week', month: 'This Month', year: 'This Year', all: 'All Time' }

  return (
    <div className="min-h-screen" style={{ background: colors.pageBg }}>
      {/* Header */}
      <header style={{ background: colors.headerBgGradient }}>
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center py-5">
            <div className="flex items-center gap-4">
              <img src="/brand/white.png" alt="Firm Funds" className="h-16 sm:h-20 md:h-28 w-auto" />
              <div className="w-px h-10" style={{ background: 'rgba(255,255,255,0.15)' }} />
              <p className="text-lg font-medium tracking-wide text-white" style={{ fontFamily: 'var(--font-geist-sans), sans-serif' }}>Admin Dashboard</p>
            </div>
            <div className="flex items-center gap-4">
              <span className="text-sm" style={{ color: '#5FA873' }}>{profile?.full_name}</span>
              <SignOutModal onConfirm={handleLogout} />
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Welcome + Time Range Toggle */}
        <div className="flex items-end justify-between mb-8">
          <div>
            <h2 className="text-2xl font-bold" style={{ color: colors.textPrimary }}>
              Welcome back, {profile?.full_name?.split(' ')[0]}
            </h2>
            <p className="text-sm mt-1" style={{ color: colors.textMuted }}>Here is what is happening with Firm Funds{kpiRange === 'all' ? '' : ` — ${kpiRangeLabel[kpiRange].toLowerCase()}`}.</p>
          </div>
          <div className="flex items-center gap-1 rounded-lg p-1" style={{ background: colors.cardBg, border: `1px solid ${colors.border}` }}>
            {(['day', 'week', 'month', 'year', 'all'] as const).map((range) => (
              <button
                key={range}
                onClick={() => setKpiRange(range)}
                className="px-3 py-1.5 rounded-md text-xs font-medium transition-all"
                style={{
                  background: kpiRange === range ? colors.gold : 'transparent',
                  color: kpiRange === range ? '#FFFFFF' : colors.textMuted,
                }}
                onMouseEnter={(e) => { if (kpiRange !== range) e.currentTarget.style.color = colors.textPrimary }}
                onMouseLeave={(e) => { if (kpiRange !== range) e.currentTarget.style.color = colors.textMuted }}
              >
                {range === 'day' ? 'D' : range === 'week' ? 'W' : range === 'month' ? 'M' : range === 'year' ? 'Y' : 'All'}
              </button>
            ))}
          </div>
        </div>

        {/* KPI Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5 mb-8">
          {[
            { label: 'Total Deals', value: filteredStats.totalDeals.toString(), icon: FileText, accent: '#5FA873', link: null },
            { label: 'Total Advanced', value: formatCurrency(filteredStats.totalAdvanced), icon: DollarSign, accent: '#1A7A2E', link: null },
            { label: 'Partner Brokerages', value: stats.totalBrokerages.toString(), icon: Building2, accent: '#5FA873', link: '/admin/brokerages' },
            { label: 'Registered Agents', value: stats.totalAgents.toString(), icon: Users, accent: '#5FA873', link: '/admin/brokerages' },
          ].map((card) => (
            <div
              key={card.label}
              className={`rounded-xl p-6 transition-all hover:shadow-lg ${card.link ? 'cursor-pointer' : ''}`}
              style={{ background: colors.cardBg, border: `1px solid ${colors.cardBorder}` }}
              onClick={() => { if (card.link) router.push(card.link) }}
              onMouseEnter={(e) => { if (card.link) e.currentTarget.style.borderColor = card.accent }}
              onMouseLeave={(e) => { if (card.link) e.currentTarget.style.borderColor = colors.cardBorder }}
            >
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: colors.textMuted }}>{card.label}</p>
                  <p className="text-3xl font-black mt-2" style={{ color: colors.textPrimary }}>{card.value}</p>
                </div>
                <div className="w-12 h-12 rounded-xl flex items-center justify-center" style={{ background: `${card.accent}12` }}>
                  <card.icon size={22} style={{ color: card.accent }} />
                </div>
              </div>
              {card.link && <p className="text-xs mt-2 font-medium" style={{ color: card.accent }}>Click to manage →</p>}
            </div>
          ))}
        </div>

        {/* Management Quick Links */}
        <div className="flex flex-wrap gap-3 mb-8">
          <button
            onClick={() => router.push('/admin/brokerages')}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-semibold transition-colors"
            style={{ background: colors.cardBg, color: colors.textPrimary, border: `1px solid ${colors.border}` }}
            onMouseEnter={(e) => { e.currentTarget.style.background = colors.cardHoverBg; e.currentTarget.style.borderColor = colors.gold }}
            onMouseLeave={(e) => { e.currentTarget.style.background = colors.cardBg; e.currentTarget.style.borderColor = colors.border }}
          >
            <Building2 size={16} style={{ color: colors.gold }} />
            Manage Brokerages
          </button>
          <button
            onClick={() => router.push('/admin/reports')}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-semibold transition-colors"
            style={{ background: colors.cardBg, color: colors.textPrimary, border: `1px solid ${colors.border}` }}
            onMouseEnter={(e) => { e.currentTarget.style.background = colors.cardHoverBg; e.currentTarget.style.borderColor = colors.gold }}
            onMouseLeave={(e) => { e.currentTarget.style.background = colors.cardBg; e.currentTarget.style.borderColor = colors.border }}
          >
            <BarChart3 size={16} style={{ color: colors.gold }} />
            Reports
          </button>
        </div>

        {/* Pipeline cards + Action Needed section removed — status filter tabs
            and priority-sorted deal table handle the workflow cleanly */}

        {/* Status Filter Tabs */}
        <div className="flex flex-wrap gap-2 mb-6">
          {[
            { label: 'All', value: null },
            { label: 'Under Review', value: 'under_review' },
            { label: 'Approved', value: 'approved' },
            { label: 'Funded', value: 'funded' },
            { label: 'Repaid', value: 'repaid' },
            { label: 'Closed', value: 'closed' },
            { label: 'Denied', value: 'denied' },
            { label: 'Cancelled', value: 'cancelled' },
          ].map((tab) => {
            const isActive = statusFilter === tab.value
            const count = tab.value ? allDeals.filter(d => d.status === tab.value).length : allDeals.length
            return (
              <button
                key={tab.label}
                onClick={() => { setStatusFilter(tab.value); setCurrentPage(1) }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all"
                style={isActive
                  ? { background: colors.textPrimary, color: colors.pageBg }
                  : { background: colors.cardBg, color: colors.textSecondary, border: `1px solid ${colors.border}` }
                }
                onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = colors.cardHoverBg }}
                onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = colors.cardBg }}
              >
                {tab.label}
                <span className="text-xs opacity-60">({count})</span>
              </button>
            )
          })}
        </div>

        {/* Deals Table with Search, Filter & Pagination */}
        {(() => {
          // Status priority for sorting (lower = show first)
          const statusPriority: Record<string, number> = {
            under_review: 0, approved: 1, funded: 2,
            repaid: 3, closed: 4, denied: 5, cancelled: 6,
          }

          // Filter, search, and sort by priority
          let filtered = allDeals
          if (statusFilter) filtered = filtered.filter(d => d.status === statusFilter)
          if (searchQuery.trim()) {
            const q = searchQuery.toLowerCase()
            filtered = filtered.filter(d => d.property_address?.toLowerCase().includes(q))
          }
          // Sort: active statuses first, then by created_at desc within each group
          filtered = [...filtered].sort((a, b) => {
            const pa = statusPriority[a.status] ?? 99
            const pb = statusPriority[b.status] ?? 99
            if (pa !== pb) return pa - pb
            return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
          })
          const totalPages = Math.max(1, Math.ceil(filtered.length / DEALS_PER_PAGE))
          const page = Math.min(currentPage, totalPages)
          const paged = filtered.slice((page - 1) * DEALS_PER_PAGE, page * DEALS_PER_PAGE)

          return (
            <div className="rounded-xl overflow-hidden" style={{ background: colors.cardBg, border: `1px solid ${colors.cardBorder}` }}>
              <div className="px-6 py-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3" style={{ borderBottom: `1px solid ${colors.border}` }}>
                <div className="flex items-center gap-3">
                  <h3 className="text-lg font-bold" style={{ color: colors.textPrimary }}>
                    {statusFilter ? `${statusFilter.replace('_', ' ').replace(/\b\w/g, l => l.toUpperCase())} Deals` : 'All Deals'}
                  </h3>
                  {statusFilter && (
                    <button
                      onClick={() => { setStatusFilter(null); setCurrentPage(1) }}
                      className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md transition-colors"
                      style={{ background: isDark ? '#1A1A1A' : '#F2F2F0', color: colors.textSecondary, border: `1px solid ${colors.border}` }}
                      onMouseEnter={(e) => e.currentTarget.style.background = colors.cardHoverBg}
                      onMouseLeave={(e) => e.currentTarget.style.background = isDark ? '#1A1A1A' : '#F2F2F0'}
                    >
                      <X size={12} /> Clear filter
                    </button>
                  )}
                  <span className="text-xs font-medium" style={{ color: colors.textMuted }}>{filtered.length} deal{filtered.length !== 1 ? 's' : ''}</span>
                </div>
                <div className="relative">
                  <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: colors.textFaint }} />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => { setSearchQuery(e.target.value); setCurrentPage(1) }}
                    placeholder="Search by property address..."
                    className="pl-9 pr-4 py-2 rounded-lg text-sm outline-none w-full sm:w-72"
                    style={{ border: `1px solid ${colors.inputBorder}`, color: colors.inputText, background: colors.inputBg }}
                    onFocus={(e) => { e.currentTarget.style.borderColor = '#5FA873'; e.currentTarget.style.boxShadow = `0 0 0 2px rgba(95,168,115,${isDark ? '0.25' : '0.15'})` }}
                    onBlur={(e) => { e.currentTarget.style.borderColor = colors.inputBorder; e.currentTarget.style.boxShadow = 'none' }}
                  />
                </div>
              </div>
              {paged.length === 0 ? (
                <div className="px-6 py-16 text-center">
                  <FileText className="mx-auto mb-4" size={40} style={{ color: colors.textFaint }} />
                  <p className="text-base font-semibold" style={{ color: colors.textSecondary }}>
                    {searchQuery || statusFilter ? 'No deals match your search' : 'No deals yet'}
                  </p>
                  <p className="text-sm mt-1" style={{ color: colors.textMuted }}>
                    {searchQuery || statusFilter ? 'Try adjusting your search or clearing the filter.' : 'Deals will appear here once agents start submitting advance requests.'}
                  </p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr style={{ background: colors.tableHeaderBg }}>
                        <th className="px-6 py-3.5 text-left text-xs font-bold uppercase tracking-wider" style={{ color: colors.textMuted }}>Property</th>
                        <th className="px-6 py-3.5 text-left text-xs font-bold uppercase tracking-wider" style={{ color: colors.textMuted }}>Status</th>
                        <th className="px-6 py-3.5 text-left text-xs font-bold uppercase tracking-wider" style={{ color: colors.textMuted }}>Commission</th>
                        <th className="px-6 py-3.5 text-left text-xs font-bold uppercase tracking-wider" style={{ color: colors.textMuted }}>Advance</th>
                        <th className="px-6 py-3.5 text-left text-xs font-bold uppercase tracking-wider" style={{ color: colors.textMuted }}>Closing Date</th>
                        <th className="px-6 py-3.5 w-10"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {paged.map((deal, i) => (
                        <tr
                          key={deal.id}
                          className="cursor-pointer transition-colors"
                          style={{ borderBottom: i < paged.length - 1 ? `1px solid ${colors.divider}` : 'none' }}
                          onClick={() => router.push(`/admin/deals/${deal.id}`)}
                          onMouseEnter={(e) => e.currentTarget.style.background = colors.tableRowHoverBg}
                          onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                        >
                          <td className="px-6 py-4 text-sm font-medium" style={{ color: colors.textPrimary }}>{deal.property_address}</td>
                          <td className="px-6 py-4">
                            <span
                              className="inline-flex px-2.5 py-1 text-xs font-semibold rounded-md"
                              style={getStatusBadgeStyle(deal.status)}
                            >
                              {formatStatusLabel(deal.status)}
                            </span>
                          </td>
                          <td className="px-6 py-4 text-sm font-medium" style={{ color: colors.textPrimary }}>{formatCurrency(deal.gross_commission)}</td>
                          <td className="px-6 py-4 text-sm font-bold" style={{ color: ['denied', 'cancelled'].includes(deal.status) ? colors.errorText : colors.successText }}>{formatCurrency(deal.advance_amount)}</td>
                          <td className="px-6 py-4 text-sm" style={{ color: colors.textMuted }}>{new Date(deal.closing_date + 'T00:00:00').toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' })}</td>
                          <td className="px-6 py-4"><ChevronRight size={16} style={{ color: colors.textFaint }} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {/* Pagination */}
              {totalPages > 1 && (
                <div className="px-6 py-4 flex items-center justify-between" style={{ borderTop: `1px solid ${colors.border}` }}>
                  <p className="text-xs" style={{ color: colors.textMuted }}>
                    Showing {(page - 1) * DEALS_PER_PAGE + 1}–{Math.min(page * DEALS_PER_PAGE, filtered.length)} of {filtered.length}
                  </p>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                      disabled={page === 1}
                      className="p-2 rounded-lg transition-colors disabled:opacity-30"
                      style={{ color: colors.textSecondary, border: `1px solid ${colors.border}` }}
                      onMouseEnter={(e) => { if (!e.currentTarget.disabled) e.currentTarget.style.background = colors.cardHoverBg }}
                      onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                    >
                      <ChevronLeft size={14} />
                    </button>
                    {Array.from({ length: Math.min(totalPages, 5) }, (_, i) => {
                      let pageNum: number
                      if (totalPages <= 5) { pageNum = i + 1 }
                      else if (page <= 3) { pageNum = i + 1 }
                      else if (page >= totalPages - 2) { pageNum = totalPages - 4 + i }
                      else { pageNum = page - 2 + i }
                      return (
                        <button
                          key={pageNum}
                          onClick={() => setCurrentPage(pageNum)}
                          className="w-8 h-8 rounded-lg text-xs font-semibold transition-colors"
                          style={pageNum === page
                            ? { background: '#1E1E1E', color: '#FFFFFF' }
                            : { color: colors.textSecondary, border: `1px solid ${colors.border}` }
                          }
                          onMouseEnter={(e) => { if (pageNum !== page) e.currentTarget.style.background = colors.cardHoverBg }}
                          onMouseLeave={(e) => { if (pageNum !== page) e.currentTarget.style.background = 'transparent' }}
                        >
                          {pageNum}
                        </button>
                      )
                    })}
                    <button
                      onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                      disabled={page === totalPages}
                      className="p-2 rounded-lg transition-colors disabled:opacity-30"
                      style={{ color: colors.textSecondary, border: `1px solid ${colors.border}` }}
                      onMouseEnter={(e) => { if (!e.currentTarget.disabled) e.currentTarget.style.background = colors.cardHoverBg }}
                      onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                    >
                      <ChevronRight size={14} />
                    </button>
                  </div>
                </div>
              )}
            </div>
          )
        })()}
      </main>
    </div>
  )
}
