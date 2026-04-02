'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import { LogOut, FileText, DollarSign, Clock, CheckCircle, Upload, ChevronDown, ChevronUp, PlusCircle, Eye } from 'lucide-react'

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
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-gray-500 text-lg">Loading your dashboard...</div>
      </div>
    )
  }

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(amount)
  }

  const formatDate = (date: string) => {
    return new Date(date).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' })
  }

  const statusColor = (status: string) => {
    switch (status) {
      case 'submitted': return 'bg-yellow-100 text-yellow-800'
      case 'under_review': return 'bg-blue-100 text-blue-800'
      case 'approved': return 'bg-green-100 text-green-800'
      case 'funded': return 'bg-purple-100 text-purple-800'
      case 'repaid': return 'bg-emerald-100 text-emerald-800'
      case 'closed': return 'bg-gray-100 text-gray-800'
      case 'denied': return 'bg-red-100 text-red-800'
      case 'cancelled': return 'bg-orange-100 text-orange-800'
      default: return 'bg-gray-100 text-gray-800'
    }
  }

  const statusLabel = (status: string) => {
    return status.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())
  }

  const totalAdvanced = deals.filter(d => d.status === 'funded' || d.status === 'repaid' || d.status === 'closed').reduce((sum, d) => sum + d.advance_amount, 0)
  const activeDeals = deals.filter(d => ['submitted', 'under_review', 'approved', 'funded'].includes(d.status)).length
  const completedDeals = deals.filter(d => ['repaid', 'closed'].includes(d.status)).length

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white shadow-sm border-b">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center py-4">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Firm Funds</h1>
              <p className="text-sm text-gray-500">Agent Portal</p>
            </div>
            <div className="flex items-center gap-4">
              <span className="text-sm text-gray-600">{profile?.full_name}</span>
              <button onClick={handleLogout} className="flex items-center gap-2 text-sm text-gray-500 hover:text-gray-700 px-3 py-2 rounded-md hover:bg-gray-100">
                <LogOut size={16} />
                Sign out
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-8 flex justify-between items-start">
          <div>
            <h2 className="text-xl font-semibold text-gray-900">Welcome, {profile?.full_name?.split(' ')[0]}</h2>
            {agent?.brokerages && (
              <p className="text-sm text-gray-500 mt-1">{agent.brokerages.name}</p>
            )}
          </div>
          <button
            onClick={() => router.push('/agent/new-deal')}
            className="flex items-center gap-2 bg-gray-900 text-white px-4 py-2.5 rounded-lg hover:bg-gray-800 font-medium text-sm"
          >
            <PlusCircle size={16} />
            New Advance Request
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
          <div className="bg-white rounded-lg shadow-sm border p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-500">Total Advanced</p>
                <p className="text-2xl font-bold text-gray-900 mt-1">{formatCurrency(totalAdvanced)}</p>
              </div>
              <DollarSign className="text-green-500" size={28} />
            </div>
          </div>
          <div className="bg-white rounded-lg shadow-sm border p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-500">Active Deals</p>
                <p className="text-2xl font-bold text-gray-900 mt-1">{activeDeals}</p>
              </div>
              <Clock className="text-blue-500" size={28} />
            </div>
          </div>
          <div className="bg-white rounded-lg shadow-sm border p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-500">Completed Deals</p>
                <p className="text-2xl font-bold text-gray-900 mt-1">{completedDeals}</p>
              </div>
              <CheckCircle className="text-emerald-500" size={28} />
            </div>
          </div>
        </div>

        <div className="bg-white rounded-lg shadow-sm border">
          <div className="px-6 py-4 border-b">
            <h3 className="text-lg font-semibold text-gray-900">Your Deals</h3>
          </div>
          {deals.length === 0 ? (
            <div className="px-6 py-12 text-center text-gray-500">
              <FileText className="mx-auto mb-4 text-gray-300" size={48} />
              <p className="text-lg font-medium">No deals yet</p>
              <p className="text-sm mt-1">Your commission advance requests will appear here.</p>
              <button
                onClick={() => router.push('/agent/new-deal')}
                className="mt-4 inline-flex items-center gap-2 bg-gray-900 text-white px-4 py-2.5 rounded-lg hover:bg-gray-800 font-medium text-sm"
              >
                <PlusCircle size={16} />
                Submit Your First Advance Request
              </button>
            </div>
          ) : (
            <div className="divide-y divide-gray-200">
              {deals.map((deal) => (
                <div key={deal.id}>
                  <div className="px-6 py-4 flex items-center justify-between cursor-pointer hover:bg-gray-50" onClick={() => setExpandedDeal(expandedDeal === deal.id ? null : deal.id)}>
                    <div className="flex-1">
                      <p className="text-sm font-medium text-gray-900">{deal.property_address}</p>
                      <p className="text-xs text-gray-500 mt-1">Submitted {formatDate(deal.created_at)}</p>
                    </div>
                    <div className="flex items-center gap-4">
                      <span className={`inline-flex px-2 py-1 text-xs font-medium rounded-full ${statusColor(deal.status)}`}>
                        {statusLabel(deal.status)}
                      </span>
                      <p className="text-sm font-semibold text-gray-900 w-28 text-right">{formatCurrency(deal.advance_amount)}</p>
                      {expandedDeal === deal.id ? <ChevronUp size={16} className="text-gray-400" /> : <ChevronDown size={16} className="text-gray-400" />}
                    </div>
                  </div>

                  {expandedDeal === deal.id && (
                    <div className="px-6 pb-6 bg-gray-50 border-t">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-4">
                        <div>
                          <h4 className="text-sm font-semibold text-gray-700 mb-3">Deal Details</h4>
                          <div className="space-y-2 text-sm">
                            <div className="flex justify-between">
                              <span className="text-gray-500">Property Address</span>
                              <span className="text-gray-900 font-medium">{deal.property_address}</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-gray-500">Closing Date</span>
                              <span className="text-gray-900 font-medium">{formatDate(deal.closing_date)}</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-gray-500">Days Until Closing</span>
                              <span className="text-gray-900 font-medium">{deal.days_until_closing} days</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-gray-500">Status</span>
                              <span className={`inline-flex px-2 py-0.5 text-xs font-medium rounded-full ${statusColor(deal.status)}`}>{statusLabel(deal.status)}</span>
                            </div>
                            {deal.funding_date && (
                              <div className="flex justify-between">
                                <span className="text-gray-500">Funded On</span>
                                <span className="text-gray-900 font-medium">{formatDate(deal.funding_date)}</span>
                              </div>
                            )}
                          </div>
                        </div>

                        <div>
                          <h4 className="text-sm font-semibold text-gray-700 mb-3">Financial Summary</h4>
                          <div className="space-y-2 text-sm">
                            <div className="flex justify-between">
                              <span className="text-gray-500">Gross Commission</span>
                              <span className="text-gray-900 font-medium">{formatCurrency(deal.gross_commission)}</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-gray-500">Brokerage Split</span>
                              <span className="text-gray-900 font-medium">{deal.brokerage_split_pct}%</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-gray-500">Your Net Commission</span>
                              <span className="text-gray-900 font-medium">{formatCurrency(deal.net_commission)}</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-gray-500">Discount Fee</span>
                              <span className="text-red-600 font-medium">-{formatCurrency(deal.discount_fee)}</span>
                            </div>
                            <div className="flex justify-between border-t pt-2 mt-2">
                              <span className="text-gray-700 font-semibold">Advance Amount</span>
                              <span className="text-green-700 font-bold">{formatCurrency(deal.advance_amount)}</span>
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* View Deal & Upload button */}
                      <div className="mt-4 pt-4 border-t border-gray-200 md:col-span-2">
                        <button
                          onClick={(e) => { e.stopPropagation(); router.push(`/agent/deals/${deal.id}`) }}
                          className="flex items-center gap-2 bg-gray-900 text-white px-4 py-2.5 rounded-lg hover:bg-gray-800 font-medium text-sm"
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
