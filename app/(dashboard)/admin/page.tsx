'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import { LogOut, FileText, Users, Building2, DollarSign, Clock, CheckCircle, AlertCircle, ChevronRight, Search, X, ChevronLeft, Trash2, BarChart3 } from 'lucide-react'
import { getStatusBadgeStyle, formatStatusLabel } from '@/lib/constants'
import { deleteDeal } from '@/lib/actions/deal-actions'
import { useTheme } from '@/lib/theme'
import ThemeToggle from '@/components/ThemeToggle'

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
  const [deletingDealId, setDeletingDealId] = useState<string | null>(null)
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

  const handleDeleteDeal = async (e: React.MouseEvent, dealId: string) => {
    e.stopPropagation() // Don't navigate to deal detail
    if (!confirm('Delete this deal? This cannot be undone.')) return
    setDeletingDealId(dealId)
    const result = await deleteDeal({ dealId })
    if (result.success) {
      setAllDeals(prev => prev.filter(d => d.id !== dealId))
      setRecentDeals(prev => prev.filter(d => d.id !== dealId))
      // Update stats
      setStats(prev => {
        const deleted = allDeals.find(d => d.id === dealId)
        if (!deleted) return prev
        return {
          ...prev,
          totalDeals: prev.totalDeals - 1,
          underReviewDeals: deleted.status === 'under_review' ? prev.underReviewDeals - 1 : prev.underReviewDeals,
          approvedDeals: deleted.status === 'approved' ? prev.approvedDeals - 1 : prev.approvedDeals,
          fundedDeals: deleted.status === 'funded' ? prev.fundedDeals - 1 : prev.fundedDeals,
          totalAdvanced: deleted.status === 'funded' ? prev.totalAdvanced - Number(deleted.advance_amount) : prev.totalAdvanced,
        }
      })
    } else {
      alert(result.error || 'Failed to delete deal')
    }
    setDeletingDealId(null)
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

  return (
    <div className="min-h-screen" style={{ background: colors.pageBg }}>
      {/* Header */}
      <header style={{ background: colors.headerBgGradient }}>
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center py-5">
            <div className="flex items-center gap-3">
              <img src="/brand/logo-white.png" alt="Firm Funds" className="h-28 w-auto" />
              <div>
                <p className="text-sm font-medium tracking-wide text-white" style={{ fontFamily: 'var(--font-geist-sans), sans-serif' }}>Admin Dashboard</p>
              </div>
            </div>
            <div className="flex items-center gap-4">
              <span className="text-sm" style={{ color: '#C4B098' }}>{profile?.full_name}</span>
              <ThemeToggle />
              <button
                onClick={handleLogout}
                className="flex items-center gap-2 text-sm px-3 py-2 rounded-lg transition-colors"
                style={{ color: '#888', border: '1px solid rgba(255,255,255,0.1)' }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; e.currentTarget.style.color = '#C4B098' }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#888' }}
              >
                <LogOut size={14} />
                Sign out
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Welcome */}
        <div className="mb-8">
          <h2 className="text-2xl font-bold" style={{ color: colors.textPrimary }}>
            Welcome back, {profile?.full_name?.split(' ')[0]}
          </h2>
          <p className="text-sm mt-1" style={{ color: colors.textMuted }}>Here is what is happening with Firm Funds today.</p>
        </div>

        {/* KPI Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5 mb-8">
          {[
            { label: 'Total Deals', value: stats.totalDeals.toString(), icon: FileText, accent: '#C4B098', link: null },
            { label: 'Total Advanced', value: formatCurrency(stats.totalAdvanced), icon: DollarSign, accent: '#1A7A2E', link: null },
            { label: 'Partner Brokerages', value: stats.totalBrokerages.toString(), icon: Building2, accent: '#3D5A99', link: '/admin/brokerages' },
            { label: 'Registered Agents', value: stats.totalAgents.toString(), icon: Users, accent: '#C4B098', link: '/admin/brokerages' },
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

        {/* Pipeline Status Row — Clickable Filters */}
        <div className="grid grid-cols-3 gap-4 mb-8">
          {[
            { label: 'Under Review', filterValue: 'under_review', value: stats.underReviewDeals, color: '#3D5A99', bg: '#F0F4FF', border: '#C5D3F0' },
            { label: 'Approved', filterValue: 'approved', value: stats.approvedDeals, color: '#1A7A2E', bg: '#EDFAF0', border: '#B8E6C4' },
            { label: 'Funded', filterValue: 'funded', value: stats.fundedDeals, color: '#5B3D99', bg: '#F5F0FF', border: '#D5C5F0' },
          ].map((status) => {
            const isActive = statusFilter === status.filterValue
            return (
              <div
                key={status.label}
                className="rounded-xl p-5 text-center cursor-pointer transition-all"
                style={{
                  background: status.bg,
                  border: isActive ? `2px solid ${status.color}` : `1px solid ${status.border}`,
                  boxShadow: isActive ? `0 2px 12px ${status.color}25` : 'none',
                  transform: isActive ? 'scale(1.02)' : 'scale(1)',
                }}
                onClick={() => { setStatusFilter(isActive ? null : status.filterValue); setCurrentPage(1) }}
              >
                <p className="text-3xl font-black" style={{ color: status.color }}>{status.value}</p>
                <p className="text-xs font-semibold uppercase tracking-wider mt-1" style={{ color: status.color, opacity: 0.7 }}>{status.label}</p>
              </div>
            )
          })}
        </div>

        {/* Action Needed Section */}
        {(() => {
          const needsReview = allDeals.filter(d => d.status === 'under_review')
          const needsFunding = allDeals.filter(d => d.status === 'approved')
          const needsEft = allDeals.filter(d => {
            if (d.status !== 'funded') return false
            const transfers = d.eft_transfers || []
            const totalSent = transfers.reduce((sum: number, t: any) => sum + t.amount, 0)
            return totalSent < d.advance_amount
          })
          const actionItems = [
            ...needsReview.map(d => ({ ...d, actionType: 'review' as const, actionLabel: 'Needs Review', actionColor: '#3D5A99', actionBg: '#F0F4FF', actionBorder: '#C5D3F0' })),
            ...needsFunding.map(d => ({ ...d, actionType: 'fund' as const, actionLabel: 'Ready to Fund', actionColor: '#1A7A2E', actionBg: '#EDFAF0', actionBorder: '#B8E6C4' })),
            ...needsEft.map(d => ({ ...d, actionType: 'eft' as const, actionLabel: 'EFT Incomplete', actionColor: '#5B3D99', actionBg: '#F5F0FF', actionBorder: '#D5C5F0' })),
          ]
          if (actionItems.length === 0) return null
          return (
            <div className="mb-6 rounded-xl overflow-hidden" style={{ background: colors.cardBg, border: `1px solid ${colors.border}` }}>
              <div className="px-5 py-3 flex items-center gap-2" style={{ borderBottom: `1px solid ${colors.border}` }}>
                <AlertCircle size={16} style={{ color: colors.warningText }} />
                <h3 className="text-sm font-bold" style={{ color: colors.textPrimary }}>Action Needed</h3>
                <span className="text-xs font-semibold px-2 py-0.5 rounded-md" style={{ background: colors.warningBg, color: colors.warningText, border: `1px solid ${colors.warningBorder}` }}>
                  {actionItems.length}
                </span>
              </div>
              <div className="divide-y" style={{ borderColor: colors.divider }}>
                {actionItems.slice(0, 8).map(item => (
                  <div
                    key={item.id}
                    className="px-5 py-3 flex items-center justify-between cursor-pointer transition-colors"
                    onClick={() => router.push(`/admin/deals/${item.id}`)}
                    onMouseEnter={(e) => e.currentTarget.style.background = colors.cardHoverBg}
                    onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                  >
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                      <span className="inline-flex items-center px-2 py-0.5 text-xs font-semibold rounded-md whitespace-nowrap"
                        style={{ background: item.actionBg, color: item.actionColor, border: `1px solid ${item.actionBorder}` }}>
                        {item.actionLabel}
                      </span>
                      <span className="text-sm font-medium truncate" style={{ color: colors.textPrimary }}>{item.property_address}</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-sm font-bold" style={{ color: ['denied', 'cancelled'].includes(item.status) ? colors.errorText : colors.successText }}>
                        {new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(item.advance_amount)}
                      </span>
                      <ChevronRight size={14} style={{ color: colors.textFaint }} />
                    </div>
                  </div>
                ))}
                {actionItems.length > 8 && (
                  <div className="px-5 py-2 text-center">
                    <span className="text-xs font-medium" style={{ color: colors.textMuted }}>+{actionItems.length - 8} more items needing attention</span>
                  </div>
                )}
              </div>
            </div>
          )
        })()}

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
          // Filter and search
          let filtered = allDeals
          if (statusFilter) filtered = filtered.filter(d => d.status === statusFilter)
          if (searchQuery.trim()) {
            const q = searchQuery.toLowerCase()
            filtered = filtered.filter(d => d.property_address?.toLowerCase().includes(q))
          }
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
                    onFocus={(e) => { e.currentTarget.style.borderColor = '#C4B098'; e.currentTarget.style.boxShadow = `0 0 0 2px rgba(196,176,152,${isDark ? '0.25' : '0.15'})` }}
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
                        <th className="px-3 py-3.5 w-10"></th>
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
                          <td className="px-3 py-4">
                            <button
                              onClick={(e) => handleDeleteDeal(e, deal.id)}
                              disabled={deletingDealId === deal.id}
                              className="p-1.5 rounded-md transition-colors opacity-40 hover:opacity-100"
                              style={{ color: colors.errorText }}
                              onMouseEnter={(e) => e.currentTarget.style.background = colors.errorBg}
                              onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                              title="Delete deal (testing only)"
                            >
                              {deletingDealId === deal.id ? <span className="text-xs">...</span> : <Trash2 size={14} />}
                            </button>
                          </td>
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
