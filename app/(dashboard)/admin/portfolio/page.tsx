'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { ArrowLeft, DollarSign, TrendingUp, Clock, AlertTriangle, ChevronDown, ChevronUp } from 'lucide-react'
import { useTheme } from '@/lib/theme'
import { formatCurrency, formatDate } from '@/lib/formatting'
import SignOutModal from '@/components/SignOutModal'

interface PortfolioDeal {
  id: string
  property_address: string
  status: string
  closing_date: string
  funding_date: string | null
  advance_amount: number
  discount_fee: number
  amount_due_from_brokerage: number
  brokerage_referral_fee: number
  net_commission: number
  agents: { first_name: string; last_name: string } | null
  brokerages: { name: string } | null
}

type SortKey = 'aging' | 'amount' | 'closing' | 'property'
type SortDir = 'asc' | 'desc'

export default function PortfolioPage() {
  const [deals, setDeals] = useState<PortfolioDeal[]>([])
  const [loading, setLoading] = useState(true)
  const [sortKey, setSortKey] = useState<SortKey>('closing')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const router = useRouter()
  const supabase = createClient()
  const { colors } = useTheme()

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }

      const { data: profile } = await supabase
        .from('user_profiles')
        .select('role')
        .eq('id', user.id)
        .single()

      if (!profile || !['super_admin', 'firm_funds_admin'].includes(profile.role)) {
        router.push('/login')
        return
      }

      const { data: fundedDeals } = await supabase
        .from('deals')
        .select('id, property_address, status, closing_date, funding_date, advance_amount, discount_fee, amount_due_from_brokerage, brokerage_referral_fee, net_commission, agent_id, brokerage_id, agents(first_name, last_name), brokerages(name)')
        .eq('status', 'funded')
        .order('funding_date', { ascending: true })

      setDeals((fundedDeals as unknown as PortfolioDeal[]) || [])
      setLoading(false)
    }
    load()
  }, [])

  const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' })
  const todayMs = new Date(todayET + 'T00:00:00Z').getTime()

  const getDaysSinceFunded = (fundingDate: string | null): number => {
    if (!fundingDate) return 0
    const fundMs = new Date(fundingDate + 'T00:00:00Z').getTime()
    return Math.floor((todayMs - fundMs) / (1000 * 60 * 60 * 24))
  }

  const getDaysToClosing = (closingDate: string): number => {
    const closeMs = new Date(closingDate + 'T00:00:00Z').getTime()
    return Math.ceil((closeMs - todayMs) / (1000 * 60 * 60 * 24))
  }

  const getAgingColor = (days: number): string => {
    if (days < 30) return '#5FA873'  // green
    if (days < 60) return '#D4A04A'  // yellow
    if (days < 90) return '#E88A3A'  // orange
    return '#E07B7B'                 // red
  }

  const getClosingStatus = (daysToClose: number): { label: string; color: string } => {
    if (daysToClose < 0) return { label: 'Overdue', color: '#E07B7B' }
    if (daysToClose <= 7) return { label: 'Closing Soon', color: '#D4A04A' }
    return { label: 'On Track', color: '#5FA873' }
  }

  // Summary stats
  const totalDeployed = deals.reduce((sum, d) => sum + d.advance_amount, 0)
  const totalExpectedReturns = deals.reduce((sum, d) => sum + d.amount_due_from_brokerage, 0)
  const totalFees = deals.reduce((sum, d) => sum + d.discount_fee, 0)
  const totalBrokerageReferrals = deals.reduce((sum, d) => sum + d.brokerage_referral_fee, 0)
  const totalProfit = totalFees - totalBrokerageReferrals
  const overdueCount = deals.filter(d => getDaysToClosing(d.closing_date) < 0).length
  const avgAging = deals.length > 0
    ? Math.round(deals.reduce((sum, d) => sum + getDaysSinceFunded(d.funding_date), 0) / deals.length)
    : 0

  // Sorting
  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('asc') }
  }

  const sorted = [...deals].sort((a, b) => {
    let cmp = 0
    switch (sortKey) {
      case 'aging': cmp = getDaysSinceFunded(a.funding_date) - getDaysSinceFunded(b.funding_date); break
      case 'amount': cmp = a.advance_amount - b.advance_amount; break
      case 'closing': cmp = getDaysToClosing(a.closing_date) - getDaysToClosing(b.closing_date); break
      case 'property': cmp = a.property_address.localeCompare(b.property_address); break
    }
    return sortDir === 'desc' ? -cmp : cmp
  })

  const SortIcon = ({ k }: { k: SortKey }) => sortKey === k
    ? (sortDir === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />)
    : null

  if (loading) return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: colors.pageBg }}>
      <div style={{ color: colors.textMuted }}>Loading portfolio...</div>
    </div>
  )

  return (
    <div className="min-h-screen" style={{ background: colors.pageBg }}>
      {/* Header */}
      <header style={{ background: colors.headerBgGradient }}>
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <img src="/brand/white.png" alt="Firm Funds" className="h-10 sm:h-12 w-auto" />
              <div className="w-px h-8" style={{ background: 'rgba(255,255,255,0.15)' }} />
              <button onClick={() => router.push('/admin')} className="flex items-center gap-1.5 px-2 py-1 rounded-lg transition-colors text-sm font-medium" style={{ color: 'white' }}
                onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.1)'}
                onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}>
                <ArrowLeft className="w-3.5 h-3.5" />
                Back to Dashboard
              </button>
            </div>
            <SignOutModal onConfirm={async () => { await supabase.auth.signOut(); router.push('/login') }} />
          </div>
          <h1 className="text-xl font-bold mt-2" style={{ color: '#FFFFFF' }}>Portfolio</h1>
          <p className="text-xs mt-0.5" style={{ color: 'rgba(255,255,255,0.5)' }}>Active funded deals and capital deployment</p>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {/* Summary Cards */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
          {[
            { label: 'Capital Deployed', value: formatCurrency(totalDeployed), color: '#A385D0', icon: DollarSign },
            { label: 'Expected Returns', value: formatCurrency(totalExpectedReturns), color: '#7B9FE0', icon: TrendingUp },
            { label: 'Firm Funds Profit', value: formatCurrency(totalProfit), color: '#5FA873', icon: DollarSign },
            { label: 'Active Deals', value: String(deals.length), color: colors.textPrimary, icon: Clock },
            { label: 'Avg Aging', value: `${avgAging}d`, color: getAgingColor(avgAging), icon: Clock },
            { label: 'Overdue', value: String(overdueCount), color: overdueCount > 0 ? '#E07B7B' : '#5FA873', icon: AlertTriangle },
          ].map(card => {
            const Icon = card.icon
            return (
              <div key={card.label} className="rounded-lg p-3" style={{ background: colors.cardBg, border: `1px solid ${colors.border}` }}>
                <div className="flex items-center gap-1.5 mb-1">
                  <Icon size={12} style={{ color: card.color }} />
                  <p className="text-[10px] uppercase tracking-wider font-semibold" style={{ color: colors.textMuted }}>{card.label}</p>
                </div>
                <p className="text-lg font-bold font-mono" style={{ color: card.color }}>{card.value}</p>
              </div>
            )
          })}
        </div>

        {/* Deals Table */}
        {deals.length === 0 ? (
          <div className="text-center py-16 rounded-lg" style={{ background: colors.cardBg, border: `1px solid ${colors.border}` }}>
            <DollarSign size={40} style={{ color: colors.textFaint }} className="mx-auto mb-3 opacity-40" />
            <p className="text-sm font-medium" style={{ color: colors.textMuted }}>No funded deals yet</p>
            <p className="text-xs mt-1" style={{ color: colors.textFaint }}>Funded deals will appear here with aging and return tracking</p>
          </div>
        ) : (
          <div className="rounded-lg overflow-hidden" style={{ background: colors.cardBg, border: `1px solid ${colors.border}` }}>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr style={{ background: colors.tableHeaderBg }}>
                    {[
                      { key: 'property' as SortKey, label: 'Property' },
                      { key: null, label: 'Agent / Brokerage' },
                      { key: 'amount' as SortKey, label: 'Advanced' },
                      { key: null, label: 'Fee / Profit' },
                      { key: 'aging' as SortKey, label: 'Days Since Funded' },
                      { key: 'closing' as SortKey, label: 'Closing Date' },
                      { key: null, label: 'Status' },
                    ].map(col => (
                      <th key={col.label}
                        className={`px-3 py-2.5 text-left font-semibold uppercase tracking-wider ${col.key ? 'cursor-pointer select-none' : ''}`}
                        style={{ color: colors.textMuted, fontSize: '10px' }}
                        onClick={() => col.key && toggleSort(col.key)}
                      >
                        <span className="flex items-center gap-1">
                          {col.label}
                          {col.key && <SortIcon k={col.key} />}
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((deal, i) => {
                    const aging = getDaysSinceFunded(deal.funding_date)
                    const daysToClose = getDaysToClosing(deal.closing_date)
                    const status = getClosingStatus(daysToClose)
                    const profit = deal.discount_fee - deal.brokerage_referral_fee
                    return (
                      <tr key={deal.id}
                        className="transition-colors cursor-pointer"
                        style={{ borderBottom: `1px solid ${colors.divider}` }}
                        onMouseEnter={(e) => e.currentTarget.style.background = colors.tableRowHoverBg}
                        onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                        onClick={() => router.push(`/admin/deals/${deal.id}`)}
                      >
                        <td className="px-3 py-2.5 font-medium" style={{ color: colors.textPrimary, maxWidth: '200px' }}>
                          <div className="truncate">{deal.property_address}</div>
                        </td>
                        <td className="px-3 py-2.5" style={{ color: colors.textSecondary }}>
                          <div>{deal.agents ? `${deal.agents.first_name} ${deal.agents.last_name}` : '—'}</div>
                          <div className="text-[10px]" style={{ color: colors.textFaint }}>{deal.brokerages?.name || '—'}</div>
                        </td>
                        <td className="px-3 py-2.5 font-mono font-medium" style={{ color: '#A385D0' }}>
                          {formatCurrency(deal.advance_amount)}
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="font-mono" style={{ color: colors.textSecondary }}>{formatCurrency(deal.discount_fee)}</div>
                          <div className="font-mono text-[10px]" style={{ color: '#5FA873' }}>{formatCurrency(profit)} profit</div>
                        </td>
                        <td className="px-3 py-2.5">
                          <span className="font-mono font-bold" style={{ color: getAgingColor(aging) }}>{aging}d</span>
                        </td>
                        <td className="px-3 py-2.5">
                          <div style={{ color: colors.textPrimary }}>{formatDate(deal.closing_date)}</div>
                          <div className="text-[10px]" style={{ color: colors.textFaint }}>
                            {daysToClose > 0 ? `${daysToClose}d away` : `${Math.abs(daysToClose)}d overdue`}
                          </div>
                        </td>
                        <td className="px-3 py-2.5">
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold"
                            style={{
                              background: status.color === '#E07B7B' ? '#2A1212' : status.color === '#D4A04A' ? '#2A1F0F' : '#0F2A18',
                              color: status.color,
                              border: `1px solid ${status.color}30`,
                            }}>
                            {status.label}
                          </span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
