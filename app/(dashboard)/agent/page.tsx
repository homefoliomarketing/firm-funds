'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import { LogOut, FileText, DollarSign, Clock, CheckCircle, ChevronDown, ChevronUp, PlusCircle, Eye, ChevronRight } from 'lucide-react'
import { useTheme } from '@/lib/theme'
import ThemeToggle from '@/components/ThemeToggle'

interface Deal {
  id: string
  status: string
  property_address: string
  closing_date: string
  gross_commission: number
  brokerage_split_pct: number
  net_commission: number
  days_until_closing: number
  discount_fee: number
  advance_amount: number
  brokerage_referral_fee: number
  amount_due_from_brokerage: number
  funding_date: string | null
  repayment_date: string | null
  source: string
  created_at: string
}

export default function AgentDashboard() {
  const [profile, setProfile] = useState<any>(null)
  const [agent, setAgent] = useState<any>(null)
  const [deals, setDeals] = useState<Deal[]>([])
  const [expandedDeal, setExpandedDeal] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const router = useRouter()
  const supabase = createClient()
  const { colors, isDark } = useTheme()

  useEffect(() => {
    async function loadAgent() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) {
        router.push('/login')
        return
      }

      const { data: profile } = await supabase
        .from('user_profiles')
        .select('*')
        .eq('id', user.id)
        .single()
      setProfile(profile)

      if (profile?.role !== 'agent') {
        router.push('/login')
        return
      }

      if (profile?.agent_id) {
        const { data: agentData } = await supabase
          .from('agents')
          .select('*, brokerages(*)')
          .eq('id', profile.agent_id)
          .single()
        setAgent(agentData)

        const { data: dealData } = await supabase
          .from('deals')
          .select('*')
          .eq('agent_id', profile.agent_id)
          .order('created_at', { ascending: false })
        setDeals(dealData || [])
      }

      setLoading(false)
    }
    loadAgent()
  }, [])

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: colors.pageBg }}>
        <div style={{ color: colors.textMuted }} className="text-lg">Loading your dashboard...</div>
      </div>
    )
  }

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(amount)
  }

  const formatDate = (date: string) => {
    return new Date(date).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' })
  }

  const statusBadge = (status: string) => {
    const styles: Record<string, { bg: string; text: string; border: string }> = {
      under_review: { bg: '#F0F4FF', text: '#3D5A99', border: '#C5D3F0' },
      approved:     { bg: '#EDFAF0', text: '#1A7A2E', border: '#B8E6C4' },
      funded:       { bg: '#F5F0FF', text: '#5B3D99', border: '#D5C5F0' },
      repaid:       { bg: '#EDFAF5', text: '#0D7A5F', border: '#B8E6D8' },
      closed:       { bg: '#F2F2F0', text: '#5A5A5A', border: '#D0D0CC' },
      denied:       { bg: '#FFF0F0', text: '#993D3D', border: '#F0C5C5' },
      cancelled:    { bg: '#FFF5ED', text: '#995C1A', border: '#F0D5B8' },
    }
    const s = styles[status] || styles.closed
    return { backgroundColor: s.bg, color: s.text, border: `1px solid ${s.border}` }
  }

  const statusLabel = (status: string) => {
    return status.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())
  }

  const totalAdvanced = deals.filter(d => d.status === 'funded' || d.status === 'repaid' || d.status === 'closed').reduce((sum, d) => sum + d.advance_amount, 0)
  const activeDeals = deals.filter(d => ['under_review', 'approved', 'funded'].includes(d.status)).length
  const completedDeals = deals.filter(d => ['repaid', 'closed'].includes(d.status)).length

  return (
    <div className="min-h-screen" style={{ background: colors.pageBg }}>
      {/* Header */}
      <header style={{ background: colors.headerBgGradient }}>
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center py-5">
            <div className="flex items-center gap-3">
              <img src="/brand/logo-white.png" alt="Firm Funds" className="h-28 w-auto" />
              <div>
                <p className="text-sm font-medium tracking-wide text-white" style={{ fontFamily: 'var(--font-geist-sans), sans-serif' }}>Agent Portal</p>
              </div>
            </div>
            <div className="flex items-center gap-4">
              <span className="text-sm" style={{ color: colors.gold }}>{profile?.full_name}</span>
              <ThemeToggle />
              <button
                onClick={handleLogout}
                className="flex items-center gap-2 text-sm px-3 py-2 rounded-lg transition-colors"
                style={{ color: colors.textSecondary, border: '1px solid rgba(255,255,255,0.1)' }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; e.currentTarget.style.color = colors.gold }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = colors.textSecondary }}
              >
                <LogOut size={14} />
                Sign out
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Welcome + New Deal Button */}
        <div className="mb-8 flex justify-between items-start">
          <div>
            <h2 className="text-2xl font-bold" style={{ color: colors.textPrimary }}>
              Welcome back, {profile?.full_name?.split(' ')[0]}
            </h2>
            {agent?.brokerages && (
              <p className="text-sm mt-1" style={{ color: colors.textMuted }}>{agent.brokerages.name}</p>
            )}
          </div>
          <button
            onClick={() => router.push('/agent/new-deal')}
            className="flex items-center gap-2 text-white px-5 py-2.5 rounded-lg font-medium text-sm transition-colors"
            style={{ background: colors.headerBgGradient }}
            onMouseEnter={(e) => e.currentTarget.style.background = 'linear-gradient(135deg, #2D2D2D, #3D3D3D)'}
            onMouseLeave={(e) => e.currentTarget.style.background = colors.headerBgGradient}
          >
            <PlusCircle size={16} />
            New Advance Request
          </button>
        </div>

        {/* KPI Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5 mb-8">
          {[
            { label: 'Total Advanced', value: formatCurrency(totalAdvanced), icon: DollarSign, accent: colors.successText },
            { label: 'Active Deals', value: activeDeals.toString(), icon: Clock, accent: colors.gold },
            { label: 'Completed Deals', value: completedDeals.toString(), icon: CheckCircle, accent: '#0D7A5F' },
          ].map((card) => (
            <div
              key={card.label}
              className="rounded-xl p-6 transition-shadow hover:shadow-lg"
              style={{ background: colors.cardBg, border: `1px solid ${colors.border}` }}
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
            </div>
          ))}
        </div>

        {/* Deals List */}
        <div className="rounded-xl overflow-hidden" style={{ background: colors.cardBg, border: `1px solid ${colors.border}` }}>
          <div className="px-6 py-5" style={{ borderBottom: `1px solid ${colors.border}` }}>
            <h3 className="text-lg font-bold" style={{ color: colors.textPrimary }}>Your Deals</h3>
          </div>
          {deals.length === 0 ? (
            <div className="px-6 py-16 text-center">
              <FileText className="mx-auto mb-4" size={40} style={{ color: colors.textFaint }} />
              <p className="text-base font-semibold" style={{ color: colors.textSecondary }}>No deals yet</p>
              <p className="text-sm mt-1 mb-5" style={{ color: colors.textMuted }}>Your commission advance requests will appear here.</p>
              <button
                onClick={() => router.push('/agent/new-deal')}
                className="inline-flex items-center gap-2 text-white px-5 py-2.5 rounded-lg font-medium text-sm"
                style={{ background: colors.headerBgGradient }}
              >
                <PlusCircle size={16} />
                Submit Your First Advance Request
              </button>
            </div>
          ) : (
            <div>
              {deals.map((deal, i) => (
                <div key={deal.id}>
                  <div
                    className="px-6 py-4 flex items-center justify-between cursor-pointer transition-colors"
                    style={{ borderBottom: i < deals.length - 1 && expandedDeal !== deal.id ? `1px solid ${colors.divider}` : 'none' }}
                    onClick={() => setExpandedDeal(expandedDeal === deal.id ? null : deal.id)}
                    onMouseEnter={(e) => e.currentTarget.style.background = colors.cardHoverBg}
                    onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                  >
                    <div className="flex-1">
                      <p className="text-sm font-medium" style={{ color: colors.textPrimary }}>{deal.property_address}</p>
                      <p className="text-xs mt-1" style={{ color: colors.textMuted }}>Submitted {formatDate(deal.created_at)}</p>
                    </div>
                    <div className="flex items-center gap-4">
                      <span
                        className="inline-flex px-2.5 py-1 text-xs font-semibold rounded-md"
                        style={statusBadge(deal.status)}
                      >
                        {statusLabel(deal.status)}
                      </span>
                      <p className="text-sm font-bold w-28 text-right" style={{ color: colors.successText }}>{formatCurrency(deal.advance_amount)}</p>
                      {expandedDeal === deal.id
                        ? <ChevronUp size={16} style={{ color: colors.textFaint }} />
                        : <ChevronDown size={16} style={{ color: colors.textFaint }} />
                      }
                    </div>
                  </div>

                  {expandedDeal === deal.id && (
                    <div className="px-6 pb-6" style={{ background: colors.tableHeaderBg, borderBottom: `1px solid ${colors.divider}` }}>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-5">
                        <div>
                          <h4 className="text-xs font-bold uppercase tracking-wider mb-3" style={{ color: colors.gold }}>Deal Details</h4>
                          <div className="space-y-2.5 text-sm">
                            <div className="flex justify-between">
                              <span style={{ color: colors.textMuted }}>Property Address</span>
                              <span className="font-medium" style={{ color: colors.textPrimary }}>{deal.property_address}</span>
                            </div>
                            <div className="flex justify-between">
                              <span style={{ color: colors.textMuted }}>Closing Date</span>
                              <span className="font-medium" style={{ color: colors.textPrimary }}>{formatDate(deal.closing_date)}</span>
                            </div>
                            <div className="flex justify-between">
                              <span style={{ color: colors.textMuted }}>Days Until Closing</span>
                              <span className="font-medium" style={{ color: colors.textPrimary }}>{deal.days_until_closing} days</span>
                            </div>
                            <div className="flex justify-between items-center">
                              <span style={{ color: colors.textMuted }}>Status</span>
                              <span
                                className="inline-flex px-2 py-0.5 text-xs font-semibold rounded-md"
                                style={statusBadge(deal.status)}
                              >
                                {statusLabel(deal.status)}
                              </span>
                            </div>
                            {deal.funding_date && (
                              <div className="flex justify-between">
                                <span style={{ color: colors.textMuted }}>Funded On</span>
                                <span className="font-medium" style={{ color: colors.textPrimary }}>{formatDate(deal.funding_date)}</span>
                              </div>
                            )}
                          </div>
                        </div>

                        <div>
                          <h4 className="text-xs font-bold uppercase tracking-wider mb-3" style={{ color: colors.gold }}>Financial Summary</h4>
                          <div className="space-y-2.5 text-sm">
                            <div className="flex justify-between">
                              <span style={{ color: colors.textMuted }}>Gross Commission</span>
                              <span className="font-medium" style={{ color: colors.textPrimary }}>{formatCurrency(deal.gross_commission)}</span>
                            </div>
                            <div className="flex justify-between">
                              <span style={{ color: colors.textMuted }}>Brokerage Split</span>
                              <span className="font-medium" style={{ color: colors.textPrimary }}>{deal.brokerage_split_pct}%</span>
                            </div>
                            <div className="flex justify-between">
                              <span style={{ color: colors.textMuted }}>Your Net Commission</span>
                              <span className="font-medium" style={{ color: colors.textPrimary }}>{formatCurrency(deal.net_commission)}</span>
                            </div>
                            <div className="flex justify-between">
                              <span style={{ color: colors.textMuted }}>Discount Fee</span>
                              <span className="font-medium" style={{ color: colors.errorText }}>-{formatCurrency(deal.discount_fee)}</span>
                            </div>
                            <div className="flex justify-between pt-2.5 mt-2.5" style={{ borderTop: `1px solid ${colors.border}` }}>
                              <span className="font-bold" style={{ color: colors.textPrimary }}>Advance Amount</span>
                              <span className="font-bold" style={{ color: colors.successText }}>{formatCurrency(deal.advance_amount)}</span>
                            </div>
                          </div>
                        </div>
                      </div>

                      <div className="mt-5 pt-4" style={{ borderTop: `1px solid ${colors.border}` }}>
                        <button
                          onClick={(e) => { e.stopPropagation(); router.push(`/agent/deals/${deal.id}`) }}
                          className="flex items-center gap-2 text-white px-4 py-2.5 rounded-lg font-medium text-sm transition-colors"
                          style={{ background: colors.headerBgGradient }}
                          onMouseEnter={(e) => e.currentTarget.style.background = 'linear-gradient(135deg, #2D2D2D, #3D3D3D)'}
                          onMouseLeave={(e) => e.currentTarget.style.background = colors.headerBgGradient}
                        >
                          <Eye size={16} />
                          View Deal & Upload Documents
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
