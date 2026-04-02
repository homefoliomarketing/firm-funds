'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import { LogOut, ChevronLeft, Search, X, ChevronRight, Plus, Edit2, CheckCircle, AlertCircle } from 'lucide-react'
import { createAgent, updateAgent, createUserAccount } from '@/lib/actions/admin-actions'
import { useTheme } from '@/lib/theme'
import ThemeToggle from '@/components/ThemeToggle'

interface Agent {
  id: string
  brokerage_id: string
  first_name: string
  last_name: string
  email: string
  phone: string | null
  reco_number: string | null
  status: 'active' | 'suspended' | 'flagged'
  flagged_by_brokerage: boolean
  outstanding_recovery: number
  created_at: string
  updated_at: string
  brokerages: { id: string; name: string } | null
}

interface Brokerage {
  id: string
  name: string
}

export default function AgentsPage() {
  const [user, setUser] = useState<any>(null)
  const [profile, setProfile] = useState<any>(null)
  const [agents, setAgents] = useState<Agent[]>([])
  const [brokerages, setBrokerages] = useState<Brokerage[]>([])
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<string | null>(null)
  const [currentPage, setCurrentPage] = useState(1)
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null)
  const [statusMessage, setStatusMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [isSaving, setIsSaving] = useState(false)

  // Create form state
  const [createForm, setCreateForm] = useState({
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
    recoNumber: '',
    brokerageId: '',
    password: '',
  })

  // Edit form state
  const [editForm, setEditForm] = useState<Agent | null>(null)
  const [editStatus, setEditStatus] = useState('active')
  const [editFlaggedByBrokerage, setEditFlaggedByBrokerage] = useState(false)
  const [editOutstandingRecovery, setEditOutstandingRecovery] = useState(0)

  const AGENTS_PER_PAGE = 15
  const router = useRouter()
  const supabase = createClient()
  const { colors, isDark } = useTheme()

  // Load data on mount
  useEffect(() => {
    async function loadData() {
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

      // Fetch agents and brokerages in parallel
      const [{ data: agentsData }, { data: brokeragesData }] = await Promise.all([
        supabase.from('agents').select('*, brokerages(id, name)').order('last_name'),
        supabase.from('brokerages').select('id, name').eq('status', 'active').order('name'),
      ])

      setAgents(agentsData || [])
      setBrokerages(brokeragesData || [])
      setLoading(false)
    }
    loadData()
  }, [])

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }

  const handleCreateAgent = async () => {
    if (!createForm.firstName.trim() || !createForm.lastName.trim() || !createForm.email.trim() || !createForm.brokerageId) {
      setStatusMessage({ type: 'error', text: 'Please fill in all required fields' })
      return
    }

    setIsSaving(true)
    try {
      const result = await createAgent({
        firstName: createForm.firstName,
        lastName: createForm.lastName,
        email: createForm.email,
        phone: createForm.phone || undefined,
        recoNumber: createForm.recoNumber || undefined,
        brokerageId: createForm.brokerageId,
      })

      if (!result.success) {
        setStatusMessage({ type: 'error', text: result.error || 'Failed to create agent' })
        setIsSaving(false)
        return
      }

      const newAgent = result.data

      // If password provided, create user account
      if (createForm.password.trim() && newAgent) {
        const userResult = await createUserAccount({
          email: createForm.email,
          password: createForm.password,
          fullName: `${createForm.firstName} ${createForm.lastName}`,
          role: 'agent',
          agentId: newAgent.id,
          brokerageId: createForm.brokerageId,
        })

        if (!userResult.success) {
          setStatusMessage({ type: 'error', text: `Agent created but account creation failed: ${userResult.error}` })
          setIsSaving(false)
          return
        }
      }

      // Refresh agent list
      const { data: updatedAgents } = await supabase.from('agents').select('*, brokerages(id, name)').order('last_name')
      setAgents(updatedAgents || [])

      setShowCreateForm(false)
      setCreateForm({ firstName: '', lastName: '', email: '', phone: '', recoNumber: '', brokerageId: '', password: '' })
      setStatusMessage({ type: 'success', text: `Agent ${createForm.firstName} ${createForm.lastName} created successfully` })
      setTimeout(() => setStatusMessage(null), 4000)
    } catch (err: any) {
      setStatusMessage({ type: 'error', text: err?.message || 'An unexpected error occurred' })
    } finally {
      setIsSaving(false)
    }
  }

  const handleEditAgent = async () => {
    if (!editForm) return

    if (!editForm.first_name.trim() || !editForm.last_name.trim() || !editForm.email.trim()) {
      setStatusMessage({ type: 'error', text: 'Please fill in all required fields' })
      return
    }

    setIsSaving(true)
    try {
      const result = await updateAgent({
        id: editForm.id,
        firstName: editForm.first_name,
        lastName: editForm.last_name,
        email: editForm.email,
        phone: editForm.phone || undefined,
        recoNumber: editForm.reco_number || undefined,
        brokerageId: editForm.brokerage_id,
        status: editStatus,
        flaggedByBrokerage: editFlaggedByBrokerage,
        outstandingRecovery: editOutstandingRecovery,
      })

      if (!result.success) {
        setStatusMessage({ type: 'error', text: result.error || 'Failed to update agent' })
        setIsSaving(false)
        return
      }

      // Refresh agent list
      const { data: updatedAgents } = await supabase.from('agents').select('*, brokerages(id, name)').order('last_name')
      setAgents(updatedAgents || [])

      setEditingAgentId(null)
      setEditForm(null)
      setStatusMessage({ type: 'success', text: `Agent ${editForm.first_name} ${editForm.last_name} updated successfully` })
      setTimeout(() => setStatusMessage(null), 4000)
    } catch (err: any) {
      setStatusMessage({ type: 'error', text: err?.message || 'An unexpected error occurred' })
    } finally {
      setIsSaving(false)
    }
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
          <div className="rounded-xl p-6" style={{ background: colors.cardBg, border: `1px solid ${colors.cardBorder}` }}>
            {[1, 2, 3, 4, 5].map(i => (
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

  // Filter and search
  let filtered = agents
  if (statusFilter) filtered = filtered.filter(a => a.status === statusFilter)
  if (searchQuery.trim()) {
    const q = searchQuery.toLowerCase()
    filtered = filtered.filter(a =>
      a.first_name.toLowerCase().includes(q) ||
      a.last_name.toLowerCase().includes(q) ||
      a.email.toLowerCase().includes(q) ||
      a.brokerages?.name.toLowerCase().includes(q)
    )
  }

  const totalPages = Math.max(1, Math.ceil(filtered.length / AGENTS_PER_PAGE))
  const page = Math.min(currentPage, totalPages)
  const paged = filtered.slice((page - 1) * AGENTS_PER_PAGE, page * AGENTS_PER_PAGE)

  const getStatusBadgeStyle = (status: string) => {
    switch (status) {
      case 'active':
        return { background: colors.successBg, color: colors.successText, border: `1px solid ${colors.successBorder}` }
      case 'suspended':
        return { background: colors.errorBg, color: colors.errorText, border: `1px solid ${colors.errorBorder}` }
      case 'flagged':
        return { background: colors.warningBg, color: colors.warningText, border: `1px solid ${colors.warningBorder}` }
      default:
        return { background: colors.infoBg, color: colors.infoText, border: `1px solid ${colors.infoBorder}` }
    }
  }

  return (
    <div className="min-h-screen" style={{ background: colors.pageBg }}>
      {/* Header */}
      <header style={{ background: colors.headerBgGradient }}>
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center py-5">
            <div className="flex items-center gap-3">
              <button
                onClick={() => router.push('/admin')}
                className="p-2 rounded-lg transition-colors"
                style={{ color: colors.textSecondary }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.1)'; e.currentTarget.style.color = '#C4B098' }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = colors.textSecondary }}
              >
                <ChevronLeft size={18} />
              </button>
              <img src="/brand/logo-white.png" alt="Firm Funds" className="h-9 w-auto" />
              <div>
                <p className="text-sm font-medium tracking-wide text-white" style={{ fontFamily: 'var(--font-geist-sans), sans-serif' }}>Manage Agents</p>
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
        {/* Status message */}
        {statusMessage && (
          <div
            className="mb-6 p-4 rounded-lg flex items-center gap-3"
            style={statusMessage.type === 'success'
              ? { background: colors.successBg, border: `1px solid ${colors.successBorder}` }
              : { background: colors.errorBg, border: `1px solid ${colors.errorBorder}` }
            }
          >
            {statusMessage.type === 'success' ? (
              <CheckCircle size={18} style={{ color: colors.successText }} />
            ) : (
              <AlertCircle size={18} style={{ color: colors.errorText }} />
            )}
            <p style={{ color: statusMessage.type === 'success' ? colors.successText : colors.errorText }}>
              {statusMessage.text}
            </p>
          </div>
        )}

        {/* Title */}
        <div className="mb-8">
          <h2 className="text-2xl font-bold" style={{ color: colors.textPrimary }}>
            Agent Management
          </h2>
          <p className="text-sm mt-1" style={{ color: colors.textMuted }}>Create and manage agents across all brokerages.</p>
        </div>

        {/* Create Form Section */}
        {showCreateForm && (
          <div className="mb-8 rounded-xl p-6" style={{ background: colors.cardBg, border: `1px solid ${colors.cardBorder}` }}>
            <h3 className="text-lg font-bold mb-6" style={{ color: colors.textPrimary }}>Add New Agent</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: colors.textMuted }}>First Name *</label>
                <input
                  type="text"
                  value={createForm.firstName}
                  onChange={(e) => setCreateForm({ ...createForm, firstName: e.target.value })}
                  className="w-full px-4 py-2 rounded-lg text-sm outline-none"
                  style={{ border: `1px solid ${colors.inputBorder}`, color: colors.inputText, background: colors.inputBg }}
                  onFocus={(e) => { e.currentTarget.style.borderColor = '#C4B098'; e.currentTarget.style.boxShadow = isDark ? '0 0 0 2px rgba(196,176,152,0.25)' : '0 0 0 2px #C4B098' }}
                  onBlur={(e) => { e.currentTarget.style.borderColor = colors.inputBorder; e.currentTarget.style.boxShadow = 'none' }}
                />
              </div>
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: colors.textMuted }}>Last Name *</label>
                <input
                  type="text"
                  value={createForm.lastName}
                  onChange={(e) => setCreateForm({ ...createForm, lastName: e.target.value })}
                  className="w-full px-4 py-2 rounded-lg text-sm outline-none"
                  style={{ border: `1px solid ${colors.inputBorder}`, color: colors.inputText, background: colors.inputBg }}
                  onFocus={(e) => { e.currentTarget.style.borderColor = '#C4B098'; e.currentTarget.style.boxShadow = isDark ? '0 0 0 2px rgba(196,176,152,0.25)' : '0 0 0 2px #C4B098' }}
                  onBlur={(e) => { e.currentTarget.style.borderColor = colors.inputBorder; e.currentTarget.style.boxShadow = 'none' }}
                />
              </div>
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: colors.textMuted }}>Email *</label>
                <input
                  type="email"
                  value={createForm.email}
                  onChange={(e) => setCreateForm({ ...createForm, email: e.target.value })}
                  className="w-full px-4 py-2 rounded-lg text-sm outline-none"
                  style={{ border: `1px solid ${colors.inputBorder}`, color: colors.inputText, background: colors.inputBg }}
                  onFocus={(e) => { e.currentTarget.style.borderColor = '#C4B098'; e.currentTarget.style.boxShadow = isDark ? '0 0 0 2px rgba(196,176,152,0.25)' : '0 0 0 2px #C4B098' }}
                  onBlur={(e) => { e.currentTarget.style.borderColor = colors.inputBorder; e.currentTarget.style.boxShadow = 'none' }}
                />
              </div>
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: colors.textMuted }}>Phone</label>
                <input
                  type="tel"
                  value={createForm.phone}
                  onChange={(e) => setCreateForm({ ...createForm, phone: e.target.value })}
                  className="w-full px-4 py-2 rounded-lg text-sm outline-none"
                  style={{ border: `1px solid ${colors.inputBorder}`, color: colors.inputText, background: colors.inputBg }}
                  onFocus={(e) => { e.currentTarget.style.borderColor = '#C4B098'; e.currentTarget.style.boxShadow = isDark ? '0 0 0 2px rgba(196,176,152,0.25)' : '0 0 0 2px #C4B098' }}
                  onBlur={(e) => { e.currentTarget.style.borderColor = colors.inputBorder; e.currentTarget.style.boxShadow = 'none' }}
                />
              </div>
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: colors.textMuted }}>RECO Number</label>
                <input
                  type="text"
                  value={createForm.recoNumber}
                  onChange={(e) => setCreateForm({ ...createForm, recoNumber: e.target.value })}
                  className="w-full px-4 py-2 rounded-lg text-sm outline-none"
                  style={{ border: `1px solid ${colors.inputBorder}`, color: colors.inputText, background: colors.inputBg }}
                  onFocus={(e) => { e.currentTarget.style.borderColor = '#C4B098'; e.currentTarget.style.boxShadow = isDark ? '0 0 0 2px rgba(196,176,152,0.25)' : '0 0 0 2px #C4B098' }}
                  onBlur={(e) => { e.currentTarget.style.borderColor = colors.inputBorder; e.currentTarget.style.boxShadow = 'none' }}
                />
              </div>
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: colors.textMuted }}>Brokerage *</label>
                <select
                  value={createForm.brokerageId}
                  onChange={(e) => setCreateForm({ ...createForm, brokerageId: e.target.value })}
                  className="w-full px-4 py-2 rounded-lg text-sm outline-none"
                  style={{ border: `1px solid ${colors.inputBorder}`, color: colors.inputText, background: colors.inputBg }}
                  onFocus={(e) => { e.currentTarget.style.borderColor = '#C4B098'; e.currentTarget.style.boxShadow = isDark ? '0 0 0 2px rgba(196,176,152,0.25)' : '0 0 0 2px #C4B098' }}
                  onBlur={(e) => { e.currentTarget.style.borderColor = colors.inputBorder; e.currentTarget.style.boxShadow = 'none' }}
                >
                  <option value="">Select a brokerage</option>
                  {brokerages.map(b => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Account creation section */}
            <div className="mb-6 pt-6" style={{ borderTop: `1px solid ${colors.border}` }}>
              <h4 className="font-semibold mb-4" style={{ color: colors.textPrimary }}>Create Login Account (Optional)</h4>
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: colors.textMuted }}>Password</label>
                <input
                  type="password"
                  value={createForm.password}
                  onChange={(e) => setCreateForm({ ...createForm, password: e.target.value })}
                  className="w-full px-4 py-2 rounded-lg text-sm outline-none"
                  style={{ border: `1px solid ${colors.inputBorder}`, color: colors.inputText, background: colors.inputBg }}
                  onFocus={(e) => { e.currentTarget.style.borderColor = '#C4B098'; e.currentTarget.style.boxShadow = isDark ? '0 0 0 2px rgba(196,176,152,0.25)' : '0 0 0 2px #C4B098' }}
                  onBlur={(e) => { e.currentTarget.style.borderColor = colors.inputBorder; e.currentTarget.style.boxShadow = 'none' }}
                />
                <p className="text-xs mt-2" style={{ color: colors.textMuted }}>If you provide a password, a login account will be created for this agent. You can also create the account later.</p>
              </div>
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => {
                  setShowCreateForm(false)
                  setCreateForm({ firstName: '', lastName: '', email: '', phone: '', recoNumber: '', brokerageId: '', password: '' })
                }}
                disabled={isSaving}
                className="px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                style={{ border: `1px solid ${colors.border}`, color: colors.textSecondary, background: 'transparent' }}
                onMouseEnter={(e) => { if (!e.currentTarget.disabled) e.currentTarget.style.background = colors.cardHoverBg }}
                onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
              >
                Cancel
              </button>
              <button
                onClick={handleCreateAgent}
                disabled={isSaving}
                className="px-4 py-2 rounded-lg text-sm font-medium text-white transition-colors"
                style={{ background: '#C4B098' }}
                onMouseEnter={(e) => { if (!e.currentTarget.disabled) e.currentTarget.style.background = '#D4C0A8' }}
                onMouseLeave={(e) => e.currentTarget.style.background = '#C4B098'}
              >
                {isSaving ? 'Saving...' : 'Save Agent'}
              </button>
            </div>
          </div>
        )}

        {/* Add Agent Button */}
        {!showCreateForm && (
          <button
            onClick={() => setShowCreateForm(true)}
            className="mb-6 flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white transition-colors"
            style={{ background: '#C4B098' }}
            onMouseEnter={(e) => e.currentTarget.style.background = '#D4C0A8'}
            onMouseLeave={(e) => e.currentTarget.style.background = '#C4B098'}
          >
            <Plus size={16} />
            Add Agent
          </button>
        )}

        {/* Filter Tabs */}
        <div className="flex flex-wrap gap-2 mb-6">
          {[
            { label: 'All', value: null },
            { label: 'Active', value: 'active' },
            { label: 'Suspended', value: 'suspended' },
            { label: 'Flagged', value: 'flagged' },
          ].map((tab) => {
            const isActive = statusFilter === tab.value
            const count = tab.value ? agents.filter(a => a.status === tab.value).length : agents.length
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

        {/* Agents Table */}
        <div className="rounded-xl overflow-hidden" style={{ background: colors.cardBg, border: `1px solid ${colors.cardBorder}` }}>
          <div className="px-6 py-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3" style={{ borderBottom: `1px solid ${colors.border}` }}>
            <div className="flex items-center gap-3">
              <h3 className="text-lg font-bold" style={{ color: colors.textPrimary }}>
                {statusFilter ? `${statusFilter.charAt(0).toUpperCase() + statusFilter.slice(1)} Agents` : 'All Agents'}
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
              <span className="text-xs font-medium" style={{ color: colors.textMuted }}>{filtered.length} agent{filtered.length !== 1 ? 's' : ''}</span>
            </div>
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: colors.textFaint }} />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => { setSearchQuery(e.target.value); setCurrentPage(1) }}
                placeholder="Search by name, email, or brokerage..."
                className="pl-9 pr-4 py-2 rounded-lg text-sm outline-none w-full sm:w-80"
                style={{ border: `1px solid ${colors.inputBorder}`, color: colors.inputText, background: colors.inputBg }}
                onFocus={(e) => { e.currentTarget.style.borderColor = '#C4B098'; e.currentTarget.style.boxShadow = `0 0 0 2px rgba(196,176,152,${isDark ? '0.25' : '0.15'})` }}
                onBlur={(e) => { e.currentTarget.style.borderColor = colors.inputBorder; e.currentTarget.style.boxShadow = 'none' }}
              />
            </div>
          </div>

          {paged.length === 0 ? (
            <div className="px-6 py-16 text-center">
              <p className="text-base font-semibold" style={{ color: colors.textSecondary }}>
                {searchQuery || statusFilter ? 'No agents match your search' : 'No agents yet'}
              </p>
              <p className="text-sm mt-1" style={{ color: colors.textMuted }}>
                {searchQuery || statusFilter ? 'Try adjusting your search or clearing the filter.' : 'Agents will appear here once they are created.'}
              </p>
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr style={{ background: colors.tableHeaderBg }}>
                      <th className="px-6 py-3.5 text-left text-xs font-bold uppercase tracking-wider" style={{ color: colors.textMuted }}>Name</th>
                      <th className="px-6 py-3.5 text-left text-xs font-bold uppercase tracking-wider" style={{ color: colors.textMuted }}>Email</th>
                      <th className="px-6 py-3.5 text-left text-xs font-bold uppercase tracking-wider" style={{ color: colors.textMuted }}>Brokerage</th>
                      <th className="px-6 py-3.5 text-left text-xs font-bold uppercase tracking-wider" style={{ color: colors.textMuted }}>RECO #</th>
                      <th className="px-6 py-3.5 text-left text-xs font-bold uppercase tracking-wider" style={{ color: colors.textMuted }}>Status</th>
                      <th className="px-6 py-3.5 text-left text-xs font-bold uppercase tracking-wider" style={{ color: colors.textMuted }}>Flagged</th>
                      <th className="px-6 py-3.5 w-20"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {paged.map((agent, i) => (
                      <tr
                        key={agent.id}
                        style={{ borderBottom: i < paged.length - 1 ? `1px solid ${colors.divider}` : 'none' }}
                        onMouseEnter={(e) => { if (editingAgentId !== agent.id) e.currentTarget.style.background = colors.tableRowHoverBg }}
                        onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                      >
                        <td className="px-6 py-4 text-sm font-medium" style={{ color: colors.textPrimary }}>
                          {agent.first_name} {agent.last_name}
                        </td>
                        <td className="px-6 py-4 text-sm" style={{ color: colors.textMuted }}>{agent.email}</td>
                        <td className="px-6 py-4 text-sm" style={{ color: colors.textMuted }}>{agent.brokerages?.name || 'N/A'}</td>
                        <td className="px-6 py-4 text-sm" style={{ color: colors.textMuted }}>{agent.reco_number || '—'}</td>
                        <td className="px-6 py-4">
                          <span
                            className="inline-flex px-2.5 py-1 text-xs font-semibold rounded-md"
                            style={getStatusBadgeStyle(agent.status)}
                          >
                            {agent.status.charAt(0).toUpperCase() + agent.status.slice(1)}
                          </span>
                        </td>
                        <td className="px-6 py-4">
                          {agent.flagged_by_brokerage && (
                            <span
                              className="inline-flex px-2.5 py-1 text-xs font-semibold rounded-md"
                              style={{ background: colors.warningBg, color: colors.warningText, border: `1px solid ${colors.warningBorder}` }}
                            >
                              Flagged
                            </span>
                          )}
                        </td>
                        <td className="px-6 py-4">
                          <button
                            onClick={() => {
                              setEditingAgentId(agent.id)
                              setEditForm(agent)
                              setEditStatus(agent.status)
                              setEditFlaggedByBrokerage(agent.flagged_by_brokerage)
                              setEditOutstandingRecovery(agent.outstanding_recovery)
                            }}
                            className="p-1.5 rounded-md transition-colors"
                            style={{ color: colors.textSecondary }}
                            onMouseEnter={(e) => { e.currentTarget.style.background = colors.cardHoverBg; e.currentTarget.style.color = colors.textPrimary }}
                            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = colors.textSecondary }}
                          >
                            <Edit2 size={14} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Edit Form Row */}
              {editingAgentId && editForm && (
                <div className="px-6 py-6" style={{ borderTop: `1px solid ${colors.border}`, background: colors.cardHoverBg }}>
                  <h4 className="font-semibold mb-4" style={{ color: colors.textPrimary }}>Edit Agent</h4>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                    <div>
                      <label className="block text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: colors.textMuted }}>First Name *</label>
                      <input
                        type="text"
                        value={editForm.first_name}
                        onChange={(e) => setEditForm({ ...editForm, first_name: e.target.value })}
                        className="w-full px-4 py-2 rounded-lg text-sm outline-none"
                        style={{ border: `1px solid ${colors.inputBorder}`, color: colors.inputText, background: colors.inputBg }}
                        onFocus={(e) => { e.currentTarget.style.borderColor = '#C4B098'; e.currentTarget.style.boxShadow = isDark ? '0 0 0 2px rgba(196,176,152,0.25)' : '0 0 0 2px #C4B098' }}
                        onBlur={(e) => { e.currentTarget.style.borderColor = colors.inputBorder; e.currentTarget.style.boxShadow = 'none' }}
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: colors.textMuted }}>Last Name *</label>
                      <input
                        type="text"
                        value={editForm.last_name}
                        onChange={(e) => setEditForm({ ...editForm, last_name: e.target.value })}
                        className="w-full px-4 py-2 rounded-lg text-sm outline-none"
                        style={{ border: `1px solid ${colors.inputBorder}`, color: colors.inputText, background: colors.inputBg }}
                        onFocus={(e) => { e.currentTarget.style.borderColor = '#C4B098'; e.currentTarget.style.boxShadow = isDark ? '0 0 0 2px rgba(196,176,152,0.25)' : '0 0 0 2px #C4B098' }}
                        onBlur={(e) => { e.currentTarget.style.borderColor = colors.inputBorder; e.currentTarget.style.boxShadow = 'none' }}
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: colors.textMuted }}>Email *</label>
                      <input
                        type="email"
                        value={editForm.email}
                        onChange={(e) => setEditForm({ ...editForm, email: e.target.value })}
                        className="w-full px-4 py-2 rounded-lg text-sm outline-none"
                        style={{ border: `1px solid ${colors.inputBorder}`, color: colors.inputText, background: colors.inputBg }}
                        onFocus={(e) => { e.currentTarget.style.borderColor = '#C4B098'; e.currentTarget.style.boxShadow = isDark ? '0 0 0 2px rgba(196,176,152,0.25)' : '0 0 0 2px #C4B098' }}
                        onBlur={(e) => { e.currentTarget.style.borderColor = colors.inputBorder; e.currentTarget.style.boxShadow = 'none' }}
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: colors.textMuted }}>Phone</label>
                      <input
                        type="tel"
                        value={editForm.phone || ''}
                        onChange={(e) => setEditForm({ ...editForm, phone: e.target.value || null })}
                        className="w-full px-4 py-2 rounded-lg text-sm outline-none"
                        style={{ border: `1px solid ${colors.inputBorder}`, color: colors.inputText, background: colors.inputBg }}
                        onFocus={(e) => { e.currentTarget.style.borderColor = '#C4B098'; e.currentTarget.style.boxShadow = isDark ? '0 0 0 2px rgba(196,176,152,0.25)' : '0 0 0 2px #C4B098' }}
                        onBlur={(e) => { e.currentTarget.style.borderColor = colors.inputBorder; e.currentTarget.style.boxShadow = 'none' }}
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: colors.textMuted }}>RECO Number</label>
                      <input
                        type="text"
                        value={editForm.reco_number || ''}
                        onChange={(e) => setEditForm({ ...editForm, reco_number: e.target.value || null })}
                        className="w-full px-4 py-2 rounded-lg text-sm outline-none"
                        style={{ border: `1px solid ${colors.inputBorder}`, color: colors.inputText, background: colors.inputBg }}
                        onFocus={(e) => { e.currentTarget.style.borderColor = '#C4B098'; e.currentTarget.style.boxShadow = isDark ? '0 0 0 2px rgba(196,176,152,0.25)' : '0 0 0 2px #C4B098' }}
                        onBlur={(e) => { e.currentTarget.style.borderColor = colors.inputBorder; e.currentTarget.style.boxShadow = 'none' }}
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: colors.textMuted }}>Brokerage</label>
                      <select
                        value={editForm.brokerage_id}
                        onChange={(e) => setEditForm({ ...editForm, brokerage_id: e.target.value })}
                        className="w-full px-4 py-2 rounded-lg text-sm outline-none"
                        style={{ border: `1px solid ${colors.inputBorder}`, color: colors.inputText, background: colors.inputBg }}
                        onFocus={(e) => { e.currentTarget.style.borderColor = '#C4B098'; e.currentTarget.style.boxShadow = isDark ? '0 0 0 2px rgba(196,176,152,0.25)' : '0 0 0 2px #C4B098' }}
                        onBlur={(e) => { e.currentTarget.style.borderColor = colors.inputBorder; e.currentTarget.style.boxShadow = 'none' }}
                      >
                        {brokerages.map(b => (
                          <option key={b.id} value={b.id}>{b.name}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: colors.textMuted }}>Status</label>
                      <select
                        value={editStatus}
                        onChange={(e) => setEditStatus(e.target.value)}
                        className="w-full px-4 py-2 rounded-lg text-sm outline-none"
                        style={{ border: `1px solid ${colors.inputBorder}`, color: colors.inputText, background: colors.inputBg }}
                        onFocus={(e) => { e.currentTarget.style.borderColor = '#C4B098'; e.currentTarget.style.boxShadow = isDark ? '0 0 0 2px rgba(196,176,152,0.25)' : '0 0 0 2px #C4B098' }}
                        onBlur={(e) => { e.currentTarget.style.borderColor = colors.inputBorder; e.currentTarget.style.boxShadow = 'none' }}
                      >
                        <option value="active">Active</option>
                        <option value="suspended">Suspended</option>
                        <option value="flagged">Flagged</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: colors.textMuted }}>Outstanding Recovery</label>
                      <input
                        type="number"
                        value={editOutstandingRecovery}
                        onChange={(e) => setEditOutstandingRecovery(parseFloat(e.target.value) || 0)}
                        className="w-full px-4 py-2 rounded-lg text-sm outline-none"
                        style={{ border: `1px solid ${colors.inputBorder}`, color: colors.inputText, background: colors.inputBg }}
                        onFocus={(e) => { e.currentTarget.style.borderColor = '#C4B098'; e.currentTarget.style.boxShadow = isDark ? '0 0 0 2px rgba(196,176,152,0.25)' : '0 0 0 2px #C4B098' }}
                        onBlur={(e) => { e.currentTarget.style.borderColor = colors.inputBorder; e.currentTarget.style.boxShadow = 'none' }}
                      />
                    </div>
                  </div>
                  <div className="mb-4">
                    <label className="flex items-center gap-3">
                      <input
                        type="checkbox"
                        checked={editFlaggedByBrokerage}
                        onChange={(e) => setEditFlaggedByBrokerage(e.target.checked)}
                        className="w-4 h-4 rounded"
                        style={{ border: `1px solid ${colors.inputBorder}`, accentColor: '#C4B098' }}
                      />
                      <span className="text-sm" style={{ color: colors.textSecondary }}>Flagged by Brokerage</span>
                    </label>
                  </div>
                  <div className="flex gap-3">
                    <button
                      onClick={() => {
                        setEditingAgentId(null)
                        setEditForm(null)
                      }}
                      disabled={isSaving}
                      className="px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                      style={{ border: `1px solid ${colors.border}`, color: colors.textSecondary, background: 'transparent' }}
                      onMouseEnter={(e) => { if (!e.currentTarget.disabled) e.currentTarget.style.background = colors.cardBg }}
                      onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleEditAgent}
                      disabled={isSaving}
                      className="px-4 py-2 rounded-lg text-sm font-medium text-white transition-colors"
                      style={{ background: '#C4B098' }}
                      onMouseEnter={(e) => { if (!e.currentTarget.disabled) e.currentTarget.style.background = '#D4C0A8' }}
                      onMouseLeave={(e) => e.currentTarget.style.background = '#C4B098'}
                    >
                      {isSaving ? 'Saving...' : 'Save Changes'}
                    </button>
                  </div>
                </div>
              )}
            </>
          )}

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="px-6 py-4 flex items-center justify-between" style={{ borderTop: `1px solid ${colors.border}` }}>
              <p className="text-xs" style={{ color: colors.textMuted }}>
                Showing {(page - 1) * AGENTS_PER_PAGE + 1}–{Math.min(page * AGENTS_PER_PAGE, filtered.length)} of {filtered.length}
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
      </main>
    </div>
  )
}
