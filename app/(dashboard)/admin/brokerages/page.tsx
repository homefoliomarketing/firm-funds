'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import { LogOut, Plus, Edit2, Search, ChevronLeft, AlertCircle, CheckCircle, ChevronDown, ChevronRight, Users, UserPlus, X, Upload, Download, FileSpreadsheet } from 'lucide-react'
import { createBrokerage, updateBrokerage, createAgent, updateAgent, bulkImportAgents } from '@/lib/actions/admin-actions'
import * as XLSX from 'xlsx'
import { useTheme } from '@/lib/theme'
import ThemeToggle from '@/components/ThemeToggle'

// ============================================================================
// Types
// ============================================================================

interface Agent {
  id: string
  first_name: string
  last_name: string
  email: string
  phone: string | null
  reco_number: string | null
  status: 'active' | 'suspended'
  flagged_by_brokerage: boolean
  outstanding_recovery: number
  created_at: string
}

interface Brokerage {
  id: string
  name: string
  brand: string | null
  address: string | null
  phone: string | null
  email: string
  status: 'active' | 'suspended' | 'inactive'
  referral_fee_percentage: number
  transaction_system: string | null
  notes: string | null
  created_at: string
  updated_at: string
}

interface BrokerageWithAgents extends Brokerage {
  agents: Agent[]
}

interface BrokerageFormData {
  name: string
  email: string
  brand: string
  address: string
  phone: string
  referralFeePercentage: string
  transactionSystem: string
  notes: string
  status?: 'active' | 'suspended' | 'inactive'
}

interface AgentFormData {
  firstName: string
  lastName: string
  email: string
  phone: string
  recoNumber: string
}

const emptyAgentForm: AgentFormData = { firstName: '', lastName: '', email: '', phone: '', recoNumber: '' }

// ============================================================================
// Component
// ============================================================================

export default function BrokeragesPage() {
  const [user, setUser] = useState<any>(null)
  const [profile, setProfile] = useState<any>(null)
  const [brokerages, setBrokerages] = useState<BrokerageWithAgents[]>([])
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [editingBrokerageId, setEditingBrokerageId] = useState<string | null>(null)
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [showAddAgentFor, setShowAddAgentFor] = useState<string | null>(null)
  const [statusMessage, setStatusMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [createFormData, setCreateFormData] = useState<BrokerageFormData>({
    name: '', email: '', brand: '', address: '', phone: '', referralFeePercentage: '', transactionSystem: '', notes: '',
  })
  const [editFormData, setEditFormData] = useState<BrokerageFormData & { status: 'active' | 'suspended' | 'inactive' }>({
    name: '', email: '', brand: '', address: '', phone: '', referralFeePercentage: '', transactionSystem: '', notes: '', status: 'active',
  })
  const [agentForm, setAgentForm] = useState<AgentFormData>(emptyAgentForm)
  const [importingFor, setImportingFor] = useState<string | null>(null)
  const [importResult, setImportResult] = useState<{ imported: number; skipped: number; errors: string[] } | null>(null)
  const [createRosterFile, setCreateRosterFile] = useState<File | null>(null)
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null)
  const [editAgentForm, setEditAgentForm] = useState<AgentFormData & { status: string; flaggedByBrokerage: boolean; outstandingRecovery: string }>(
    { firstName: '', lastName: '', email: '', phone: '', recoNumber: '', status: 'active', flaggedByBrokerage: false, outstandingRecovery: '0' }
  )

  const router = useRouter()
  const supabase = createClient()
  const { colors, isDark } = useTheme()

  // ---- Input style helpers ----
  const inputStyle = { background: colors.inputBg, border: `1px solid ${colors.inputBorder}`, color: colors.inputText }
  const onFocus = (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    e.currentTarget.style.borderColor = '#C4B098'
    e.currentTarget.style.boxShadow = isDark ? '0 0 0 2px rgba(196,176,152,0.25)' : '0 0 0 2px #C4B098'
  }
  const onBlur = (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    e.currentTarget.style.borderColor = colors.inputBorder
    e.currentTarget.style.boxShadow = 'none'
  }

  // ---- Load data ----
  useEffect(() => {
    async function loadPage() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }
      setUser(user)

      const { data: profile } = await supabase.from('user_profiles').select('*').eq('id', user.id).single()
      setProfile(profile)

      if (profile?.role !== 'super_admin' && profile?.role !== 'firm_funds_admin') {
        router.push('/login'); return
      }

      await loadBrokerages()
      setLoading(false)
    }
    loadPage()
  }, [])

  async function loadBrokerages() {
    const { data, error } = await supabase
      .from('brokerages')
      .select('*, agents(*)')
      .order('name')

    if (error) {
      console.error('Error loading brokerages:', error)
      setStatusMessage({ type: 'error', text: 'Failed to load brokerages' })
      return
    }

    setBrokerages((data || []) as BrokerageWithAgents[])
  }

  const handleLogout = async () => { await supabase.auth.signOut(); router.push('/login') }

  // ---- Brokerage CRUD ----
  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!createFormData.name.trim() || !createFormData.email.trim() || !createFormData.referralFeePercentage) {
      setStatusMessage({ type: 'error', text: 'Please fill in all required fields' }); return
    }
    setSubmitting(true)
    const result = await createBrokerage({
      name: createFormData.name, email: createFormData.email,
      brand: createFormData.brand || undefined, address: createFormData.address || undefined,
      phone: createFormData.phone || undefined,
      referralFeePercentage: parseFloat(createFormData.referralFeePercentage) / 100,
      transactionSystem: createFormData.transactionSystem || undefined, notes: createFormData.notes || undefined,
    })
    if (result.success) {
      const newBrokerageId = result.data?.id
      let rosterMsg = ''

      // If a roster file was attached, import it now
      if (createRosterFile && newBrokerageId) {
        try {
          const fileData = await createRosterFile.arrayBuffer()
          const workbook = XLSX.read(fileData, { type: 'array' })
          const sheet = workbook.Sheets[workbook.SheetNames[0]]
          const rows: any[] = XLSX.utils.sheet_to_json(sheet, { defval: '' })

          if (rows.length > 0) {
            const agents = rows.map((row) => {
              const keys = Object.keys(row)
              const find = (needles: string[]) => {
                const key = keys.find(k => needles.some(n => k.toLowerCase().replace(/[^a-z]/g, '').includes(n)))
                return key ? String(row[key]).trim() : ''
              }
              return {
                firstName: find(['firstname', 'first']),
                lastName: find(['lastname', 'last']),
                email: find(['email', 'mail']),
                phone: find(['phone', 'cell', 'mobile', 'tel']) || undefined,
                recoNumber: find(['reco', 'license', 'licence', 'registration']) || undefined,
              }
            })

            const importRes = await bulkImportAgents({ brokerageId: newBrokerageId, agents })
            if (importRes.success && importRes.data) {
              rosterMsg = ` — ${importRes.data.imported} agent${importRes.data.imported !== 1 ? 's' : ''} imported`
              if (importRes.data.skipped > 0) rosterMsg += ` (${importRes.data.skipped} skipped)`
              if (importRes.data.errors.length > 0) {
                setImportResult(importRes.data)
                setImportingFor(newBrokerageId)
                setExpandedId(newBrokerageId)
              }
            }
          }
        } catch (err) {
          console.error('Roster import error during create:', err)
          rosterMsg = ' — roster import failed, you can re-upload from the brokerage view'
        }
      }

      setStatusMessage({ type: 'success', text: `Brokerage created successfully${rosterMsg}` })
      setCreateFormData({ name: '', email: '', brand: '', address: '', phone: '', referralFeePercentage: '', transactionSystem: '', notes: '' })
      setCreateRosterFile(null)
      setShowCreateForm(false)
      await loadBrokerages()
      if (newBrokerageId) setExpandedId(newBrokerageId)
    } else {
      setStatusMessage({ type: 'error', text: result.error || 'Failed to create brokerage' })
    }
    setSubmitting(false)
  }

  const handleEditSubmit = async (e: React.FormEvent, brokerageId: string) => {
    e.preventDefault()
    if (!editFormData.name.trim() || !editFormData.email.trim() || !editFormData.referralFeePercentage) {
      setStatusMessage({ type: 'error', text: 'Please fill in all required fields' }); return
    }
    setSubmitting(true)
    const result = await updateBrokerage({
      id: brokerageId, name: editFormData.name, email: editFormData.email,
      brand: editFormData.brand || undefined, address: editFormData.address || undefined,
      phone: editFormData.phone || undefined,
      referralFeePercentage: parseFloat(editFormData.referralFeePercentage) / 100,
      transactionSystem: editFormData.transactionSystem || undefined, notes: editFormData.notes || undefined,
      status: editFormData.status,
    })
    if (result.success) {
      setStatusMessage({ type: 'success', text: 'Brokerage updated successfully' })
      setEditingBrokerageId(null)
      await loadBrokerages()
    } else {
      setStatusMessage({ type: 'error', text: result.error || 'Failed to update brokerage' })
    }
    setSubmitting(false)
  }

  const openEditForm = (brokerage: BrokerageWithAgents) => {
    setEditFormData({
      name: brokerage.name, email: brokerage.email,
      brand: brokerage.brand || '', address: brokerage.address || '',
      phone: brokerage.phone || '',
      referralFeePercentage: (brokerage.referral_fee_percentage * 100).toString(),
      transactionSystem: brokerage.transaction_system || '', notes: brokerage.notes || '',
      status: brokerage.status,
    })
    setEditingBrokerageId(brokerage.id)
    setExpandedId(brokerage.id)
  }

  // ---- Agent CRUD ----
  const handleAddAgent = async (e: React.FormEvent, brokerageId: string) => {
    e.preventDefault()
    if (!agentForm.firstName.trim() || !agentForm.lastName.trim() || !agentForm.email.trim()) {
      setStatusMessage({ type: 'error', text: 'First name, last name, and email are required' }); return
    }
    setSubmitting(true)
    const result = await createAgent({
      brokerageId,
      firstName: agentForm.firstName, lastName: agentForm.lastName,
      email: agentForm.email, phone: agentForm.phone || undefined,
      recoNumber: agentForm.recoNumber || undefined,
    })
    if (result.success) {
      setStatusMessage({ type: 'success', text: 'Agent added successfully' })
      setAgentForm(emptyAgentForm)
      setShowAddAgentFor(null)
      await loadBrokerages()
    } else {
      setStatusMessage({ type: 'error', text: result.error || 'Failed to add agent' })
    }
    setSubmitting(false)
  }

  const openEditAgent = (agent: Agent, brokerageId: string) => {
    setEditAgentForm({
      firstName: agent.first_name, lastName: agent.last_name, email: agent.email,
      phone: agent.phone || '', recoNumber: agent.reco_number || '',
      status: agent.status, flaggedByBrokerage: agent.flagged_by_brokerage,
      outstandingRecovery: (agent.outstanding_recovery || 0).toString(),
    })
    setEditingAgentId(agent.id)
  }

  const handleEditAgentSubmit = async (e: React.FormEvent, agentId: string, brokerageId: string) => {
    e.preventDefault()
    if (!editAgentForm.firstName.trim() || !editAgentForm.lastName.trim() || !editAgentForm.email.trim()) {
      setStatusMessage({ type: 'error', text: 'First name, last name, and email are required' }); return
    }
    setSubmitting(true)
    const result = await updateAgent({
      id: agentId, brokerageId,
      firstName: editAgentForm.firstName, lastName: editAgentForm.lastName,
      email: editAgentForm.email, phone: editAgentForm.phone || undefined,
      recoNumber: editAgentForm.recoNumber || undefined,
      status: editAgentForm.status, flaggedByBrokerage: editAgentForm.flaggedByBrokerage,
      outstandingRecovery: parseFloat(editAgentForm.outstandingRecovery) || 0,
    })
    if (result.success) {
      setStatusMessage({ type: 'success', text: 'Agent updated successfully' })
      setEditingAgentId(null)
      await loadBrokerages()
    } else {
      setStatusMessage({ type: 'error', text: result.error || 'Failed to update agent' })
    }
    setSubmitting(false)
  }

  // ---- Bulk import ----
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>, brokerageId: string) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = '' // reset so same file can be re-selected

    setSubmitting(true)
    setImportResult(null)
    setImportingFor(brokerageId)

    try {
      const data = await file.arrayBuffer()
      const workbook = XLSX.read(data, { type: 'array' })
      const sheet = workbook.Sheets[workbook.SheetNames[0]]
      const rows: any[] = XLSX.utils.sheet_to_json(sheet, { defval: '' })

      if (rows.length === 0) {
        setStatusMessage({ type: 'error', text: 'The file appears to be empty. Make sure row 1 has headers.' })
        setSubmitting(false)
        setImportingFor(null)
        return
      }

      // Map columns (flexible matching)
      const agents = rows.map((row) => {
        const keys = Object.keys(row)
        const find = (needles: string[]) => {
          const key = keys.find(k => needles.some(n => k.toLowerCase().replace(/[^a-z]/g, '').includes(n)))
          return key ? String(row[key]).trim() : ''
        }
        return {
          firstName: find(['firstname', 'first']),
          lastName: find(['lastname', 'last']),
          email: find(['email', 'mail']),
          phone: find(['phone', 'cell', 'mobile', 'tel']) || undefined,
          recoNumber: find(['reco', 'license', 'licence', 'registration']) || undefined,
        }
      })

      const result = await bulkImportAgents({ brokerageId, agents })

      if (result.success && result.data) {
        setImportResult(result.data)
        if (result.data.imported > 0) {
          setStatusMessage({ type: 'success', text: `Imported ${result.data.imported} agent${result.data.imported !== 1 ? 's' : ''}${result.data.skipped > 0 ? ` (${result.data.skipped} skipped)` : ''}` })
          await loadBrokerages()
        } else {
          setStatusMessage({ type: 'error', text: `No agents imported. ${result.data.skipped} row${result.data.skipped !== 1 ? 's' : ''} skipped.` })
        }
      } else {
        setStatusMessage({ type: 'error', text: result.error || 'Import failed' })
      }
    } catch (err: any) {
      console.error('File parse error:', err)
      setStatusMessage({ type: 'error', text: 'Failed to read the file. Make sure it\'s a valid .xlsx or .csv file.' })
    }
    setSubmitting(false)
  }

  const downloadTemplate = () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ['First Name', 'Last Name', 'Email', 'Phone', 'RECO Number'],
      ['Jane', 'Smith', 'jane.smith@example.com', '(416) 555-0100', '12345'],
      ['John', 'Doe', 'john.doe@example.com', '(905) 555-0200', '67890'],
    ])
    ws['!cols'] = [{ wch: 15 }, { wch: 15 }, { wch: 30 }, { wch: 18 }, { wch: 15 }]
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Agents')
    XLSX.writeFile(wb, 'agent-import-template.xlsx')
  }

  // ---- Status badge ----
  const getStatusBadgeStyle = (status: string) => {
    switch (status) {
      case 'active': return { bg: colors.successBg, text: colors.successText, border: colors.successBorder }
      case 'suspended': return { bg: colors.warningBg, text: colors.warningText, border: colors.warningBorder }
      case 'inactive': return { bg: colors.cardBg, text: colors.textMuted, border: colors.border }
      default: return { bg: colors.cardBg, text: colors.textMuted, border: colors.border }
    }
  }

  // ---- Filtering (searches brokerage name/email AND agent names) ----
  const q = searchQuery.toLowerCase().trim()
  const filteredBrokerages = brokerages.filter(b => {
    if (!q) return true
    // Match brokerage fields
    if (b.name.toLowerCase().includes(q) || b.email.toLowerCase().includes(q)) return true
    if (b.brand && b.brand.toLowerCase().includes(q)) return true
    // Match agent names within this brokerage
    if (b.agents.some(a =>
      `${a.first_name} ${a.last_name}`.toLowerCase().includes(q) ||
      a.email.toLowerCase().includes(q)
    )) return true
    return false
  })

  // Auto-expand brokerages where the match is on an agent (not the brokerage itself)
  const agentMatchBrokerageIds = q ? brokerages
    .filter(b => {
      const brokerageMatch = b.name.toLowerCase().includes(q) || b.email.toLowerCase().includes(q) || (b.brand && b.brand.toLowerCase().includes(q))
      if (brokerageMatch) return false // don't auto-expand if the brokerage itself matches
      return b.agents.some(a =>
        `${a.first_name} ${a.last_name}`.toLowerCase().includes(q) ||
        a.email.toLowerCase().includes(q)
      )
    })
    .map(b => b.id)
    : []

  // If searching and we have agent matches, auto-expand those
  useEffect(() => {
    if (agentMatchBrokerageIds.length === 1) {
      setExpandedId(agentMatchBrokerageIds[0])
    }
  }, [searchQuery])

  // ---- Loading skeleton ----
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

  // ---- Render a form input (DRY helper) ----
  const renderInput = (
    label: string, value: string, onChange: (val: string) => void,
    opts?: { required?: boolean; placeholder?: string; type?: string; step?: string; min?: string; max?: string }
  ) => (
    <div>
      <label className="block text-sm font-medium mb-2" style={{ color: colors.textSecondary }}>
        {label}{opts?.required ? ' *' : ''}
      </label>
      <input
        type={opts?.type || 'text'}
        step={opts?.step}
        min={opts?.min}
        max={opts?.max}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={opts?.placeholder || ''}
        className="w-full px-4 py-2 rounded-lg text-sm outline-none"
        style={inputStyle}
        onFocus={onFocus}
        onBlur={onBlur}
      />
    </div>
  )

  // ============================================================================
  // RENDER
  // ============================================================================

  return (
    <div className="min-h-screen" style={{ background: colors.pageBg }}>
      {/* Header */}
      <header style={{ background: colors.headerBgGradient }}>
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center py-5">
            <div className="flex items-center gap-3">
              <button
                onClick={() => router.push('/admin')}
                className="p-1.5 rounded-lg transition-colors"
                style={{ color: '#C4B098' }}
                onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(196,176,152,0.1)'}
                onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
              >
                <ChevronLeft size={20} />
              </button>
              <img src="/brand/white.png" alt="Firm Funds" className="h-28 w-auto" />
              <div>
                <p className="text-sm font-medium tracking-wide text-white" style={{ fontFamily: 'var(--font-geist-sans), sans-serif' }}>Manage Brokerages</p>
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
        {/* Status Message */}
        {statusMessage && (
          <div
            className="mb-6 p-4 rounded-lg flex items-center gap-3 animate-in fade-in"
            style={{
              background: statusMessage.type === 'success' ? colors.successBg : colors.errorBg,
              border: `1px solid ${statusMessage.type === 'success' ? colors.successBorder : colors.errorBorder}`,
            }}
          >
            {statusMessage.type === 'success'
              ? <CheckCircle size={18} style={{ color: colors.successText }} />
              : <AlertCircle size={18} style={{ color: colors.errorText }} />
            }
            <p style={{ color: statusMessage.type === 'success' ? colors.successText : colors.errorText }}>
              {statusMessage.text}
            </p>
          </div>
        )}

        {/* Title + Search */}
        <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 mb-6">
          <div>
            <h2 className="text-2xl font-bold" style={{ color: colors.textPrimary }}>Brokerages</h2>
            <p className="text-sm mt-1" style={{ color: colors.textMuted }}>
              {brokerages.length} brokerage{brokerages.length !== 1 ? 's' : ''} · {brokerages.reduce((sum, b) => sum + b.agents.length, 0)} total agents
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: colors.textFaint }} />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search brokerages or agents..."
                className="pl-9 pr-4 py-2 rounded-lg text-sm outline-none w-full sm:w-72"
                style={{ border: `1px solid ${colors.inputBorder}`, color: colors.inputText, background: colors.inputBg }}
                onFocus={onFocus}
                onBlur={onBlur}
              />
            </div>
            {!showCreateForm && (
              <button
                onClick={() => setShowCreateForm(true)}
                className="flex items-center gap-2 px-4 py-2 rounded-lg font-semibold text-sm transition-colors whitespace-nowrap"
                style={{ background: '#C4B098', color: '#1E1E1E' }}
                onMouseEnter={(e) => e.currentTarget.style.opacity = '0.9'}
                onMouseLeave={(e) => e.currentTarget.style.opacity = '1'}
              >
                <Plus size={16} />
                Add Brokerage
              </button>
            )}
          </div>
        </div>

        {/* Create Brokerage Form */}
        {showCreateForm && (
          <div className="mb-8 rounded-xl overflow-hidden" style={{ background: colors.cardBg, border: `1px solid ${colors.cardBorder}` }}>
            <div className="px-6 py-5" style={{ borderBottom: `1px solid ${colors.border}` }}>
              <h3 className="text-lg font-bold" style={{ color: colors.textPrimary }}>Create New Brokerage</h3>
            </div>
            <form onSubmit={handleCreateSubmit} className="p-6 space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {renderInput('Name', createFormData.name, (v) => setCreateFormData({ ...createFormData, name: v }), { required: true, placeholder: 'e.g., Acme Realty' })}
                {renderInput('Email', createFormData.email, (v) => setCreateFormData({ ...createFormData, email: v }), { required: true, placeholder: 'contact@acmerealty.com', type: 'email' })}
                {renderInput('Brand', createFormData.brand, (v) => setCreateFormData({ ...createFormData, brand: v }), { placeholder: 'e.g., ACME' })}
                {renderInput('Referral Fee %', createFormData.referralFeePercentage, (v) => setCreateFormData({ ...createFormData, referralFeePercentage: v }), { required: true, placeholder: '20', type: 'number', step: '0.1', min: '0', max: '100' })}
                {renderInput('Address', createFormData.address, (v) => setCreateFormData({ ...createFormData, address: v }), { placeholder: '123 Main St, Toronto, ON' })}
                {renderInput('Phone', createFormData.phone, (v) => setCreateFormData({ ...createFormData, phone: v }), { placeholder: '(416) 555-0123', type: 'tel' })}
                {renderInput('Transaction System', createFormData.transactionSystem, (v) => setCreateFormData({ ...createFormData, transactionSystem: v }), { placeholder: 'e.g., Nexone' })}
              </div>
              <div>
                <label className="block text-sm font-medium mb-2" style={{ color: colors.textSecondary }}>Notes</label>
                <textarea
                  value={createFormData.notes}
                  onChange={(e) => setCreateFormData({ ...createFormData, notes: e.target.value })}
                  placeholder="Any additional notes..."
                  rows={3}
                  className="w-full px-4 py-2 rounded-lg text-sm outline-none resize-none"
                  style={inputStyle}
                  onFocus={onFocus}
                  onBlur={onBlur}
                />
              </div>
              {/* Agent Roster Upload */}
              <div className="p-4 rounded-lg" style={{ background: colors.pageBg, border: `1px dashed ${colors.border}` }}>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <FileSpreadsheet size={16} style={{ color: colors.gold }} />
                    <label className="text-sm font-medium" style={{ color: colors.textSecondary }}>Agent Roster (optional)</label>
                  </div>
                  <button type="button" onClick={downloadTemplate}
                    className="flex items-center gap-1 text-xs font-semibold px-2 py-1 rounded transition-colors"
                    style={{ color: colors.gold }}
                    onMouseEnter={(e) => e.currentTarget.style.background = colors.cardHoverBg}
                    onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                  >
                    <Download size={12} /> Download Template
                  </button>
                </div>
                <p className="text-xs mb-3" style={{ color: colors.textMuted }}>
                  Upload an .xlsx or .csv with columns: First Name, Last Name, Email, Phone, RECO Number. Agents will be imported automatically when the brokerage is created.
                </p>
                <div className="flex items-center gap-3">
                  <label
                    className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold cursor-pointer transition-colors"
                    style={{ background: colors.cardBg, color: colors.textPrimary, border: `1px solid ${colors.border}` }}
                    onMouseEnter={(e) => { e.currentTarget.style.borderColor = colors.gold }}
                    onMouseLeave={(e) => { e.currentTarget.style.borderColor = colors.border }}
                  >
                    <Upload size={14} />
                    {createRosterFile ? 'Change File' : 'Choose File'}
                    <input
                      type="file"
                      accept=".xlsx,.xls,.csv"
                      className="hidden"
                      onChange={(e) => setCreateRosterFile(e.target.files?.[0] || null)}
                    />
                  </label>
                  {createRosterFile && (
                    <div className="flex items-center gap-2">
                      <span className="text-sm" style={{ color: colors.successText }}>{createRosterFile.name}</span>
                      <button type="button" onClick={() => setCreateRosterFile(null)}
                        className="p-0.5 rounded" style={{ color: colors.textMuted }}
                        onMouseEnter={(e) => e.currentTarget.style.color = colors.errorText}
                        onMouseLeave={(e) => e.currentTarget.style.color = colors.textMuted}
                      ><X size={14} /></button>
                    </div>
                  )}
                </div>
              </div>

              <div className="flex gap-3 pt-4">
                <button type="button" onClick={() => { setShowCreateForm(false); setCreateRosterFile(null) }}
                  className="flex-1 px-4 py-2.5 rounded-lg font-semibold transition-colors"
                  style={{ background: colors.cardHoverBg, color: colors.textPrimary, border: `1px solid ${colors.border}` }}
                >Cancel</button>
                <button type="submit" disabled={submitting}
                  className="flex-1 px-4 py-2.5 rounded-lg font-semibold transition-colors disabled:opacity-50"
                  style={{ background: '#C4B098', color: '#1E1E1E' }}
                >{submitting ? 'Saving...' : createRosterFile ? 'Save Brokerage & Import Agents' : 'Save Brokerage'}</button>
              </div>
            </form>
          </div>
        )}

        {/* Brokerage List */}
        {filteredBrokerages.length === 0 ? (
          <div className="rounded-xl px-6 py-16 text-center" style={{ background: colors.cardBg, border: `1px solid ${colors.cardBorder}` }}>
            <p className="text-base font-semibold" style={{ color: colors.textSecondary }}>
              {searchQuery ? 'No brokerages match your search' : 'No brokerages yet'}
            </p>
            <p className="text-sm mt-1" style={{ color: colors.textMuted }}>
              {searchQuery ? 'Try adjusting your search.' : 'Click "Add Brokerage" to create the first one.'}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {filteredBrokerages.map((brokerage) => {
              const isExpanded = expandedId === brokerage.id
              const isEditing = editingBrokerageId === brokerage.id
              const badgeStyle = getStatusBadgeStyle(brokerage.status)
              const agentCount = brokerage.agents.length
              const activeAgents = brokerage.agents.filter(a => a.status === 'active').length

              return (
                <div key={brokerage.id} className="rounded-xl overflow-hidden transition-all"
                  style={{ background: colors.cardBg, border: `1px solid ${isExpanded ? colors.gold : colors.cardBorder}` }}
                >
                  {/* Brokerage Row (click to expand) */}
                  <div
                    className="flex items-center gap-4 px-6 py-4 cursor-pointer transition-colors"
                    style={{ background: isExpanded ? colors.cardHoverBg : 'transparent' }}
                    onClick={() => {
                      if (isEditing) return
                      setExpandedId(isExpanded ? null : brokerage.id)
                      setEditingBrokerageId(null)
                      setShowAddAgentFor(null)
                    }}
                    onMouseEnter={(e) => { if (!isExpanded) e.currentTarget.style.background = colors.cardHoverBg }}
                    onMouseLeave={(e) => { if (!isExpanded) e.currentTarget.style.background = 'transparent' }}
                  >
                    <div className="flex-shrink-0" style={{ color: colors.gold }}>
                      {isExpanded ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-bold truncate" style={{ color: colors.textPrimary }}>{brokerage.name}</p>
                        {brokerage.brand && (
                          <span className="text-xs px-2 py-0.5 rounded" style={{ background: colors.goldBg, color: colors.gold }}>{brokerage.brand}</span>
                        )}
                      </div>
                      <p className="text-xs mt-0.5" style={{ color: colors.textMuted }}>{brokerage.email}</p>
                    </div>
                    <div className="flex items-center gap-4 flex-shrink-0">
                      <span className="inline-flex px-2.5 py-1 text-xs font-semibold rounded-md"
                        style={{ background: badgeStyle.bg, color: badgeStyle.text, border: `1px solid ${badgeStyle.border}` }}
                      >
                        {brokerage.status.charAt(0).toUpperCase() + brokerage.status.slice(1)}
                      </span>
                      <span className="text-xs font-medium" style={{ color: colors.textMuted }}>
                        {(brokerage.referral_fee_percentage * 100).toFixed(1)}% fee
                      </span>
                      <div className="flex items-center gap-1.5">
                        <Users size={13} style={{ color: colors.textMuted }} />
                        <span className="text-xs font-semibold" style={{ color: colors.textPrimary }}>{agentCount}</span>
                      </div>
                      <button
                        onClick={(e) => { e.stopPropagation(); openEditForm(brokerage) }}
                        className="p-1.5 rounded-md transition-colors"
                        style={{ color: colors.textSecondary }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = colors.cardHoverBg; e.currentTarget.style.color = colors.textPrimary }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = colors.textSecondary }}
                      >
                        <Edit2 size={14} />
                      </button>
                    </div>
                  </div>

                  {/* Expanded Content */}
                  {isExpanded && (
                    <div style={{ borderTop: `1px solid ${colors.border}` }}>
                      {/* Brokerage Details (or Edit Form) */}
                      {isEditing ? (
                        <form onSubmit={(e) => handleEditSubmit(e, brokerage.id)} className="p-6 space-y-4" style={{ borderBottom: `1px solid ${colors.border}` }}>
                          <div className="flex items-center justify-between mb-2">
                            <h4 className="text-sm font-bold uppercase tracking-wider" style={{ color: colors.gold }}>Edit Brokerage</h4>
                            <button type="button" onClick={() => setEditingBrokerageId(null)} style={{ color: colors.textMuted }}>
                              <X size={16} />
                            </button>
                          </div>
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            {renderInput('Name', editFormData.name, (v) => setEditFormData({ ...editFormData, name: v }), { required: true })}
                            {renderInput('Email', editFormData.email, (v) => setEditFormData({ ...editFormData, email: v }), { required: true, type: 'email' })}
                            {renderInput('Brand', editFormData.brand, (v) => setEditFormData({ ...editFormData, brand: v }))}
                            <div>
                              <label className="block text-sm font-medium mb-2" style={{ color: colors.textSecondary }}>Status *</label>
                              <select
                                value={editFormData.status}
                                onChange={(e) => setEditFormData({ ...editFormData, status: e.target.value as 'active' | 'suspended' | 'inactive' })}
                                className="w-full px-4 py-2 rounded-lg text-sm outline-none"
                                style={inputStyle}
                                onFocus={onFocus as any}
                                onBlur={onBlur as any}
                              >
                                <option value="active">Active</option>
                                <option value="suspended">Suspended</option>
                                <option value="inactive">Inactive</option>
                              </select>
                            </div>
                            {renderInput('Referral Fee %', editFormData.referralFeePercentage, (v) => setEditFormData({ ...editFormData, referralFeePercentage: v }), { required: true, type: 'number', step: '0.1', min: '0', max: '100' })}
                            {renderInput('Address', editFormData.address, (v) => setEditFormData({ ...editFormData, address: v }))}
                            {renderInput('Phone', editFormData.phone, (v) => setEditFormData({ ...editFormData, phone: v }), { type: 'tel' })}
                            {renderInput('Transaction System', editFormData.transactionSystem, (v) => setEditFormData({ ...editFormData, transactionSystem: v }))}
                          </div>
                          <div>
                            <label className="block text-sm font-medium mb-2" style={{ color: colors.textSecondary }}>Notes</label>
                            <textarea value={editFormData.notes} onChange={(e) => setEditFormData({ ...editFormData, notes: e.target.value })}
                              rows={3} className="w-full px-4 py-2 rounded-lg text-sm outline-none resize-none"
                              style={inputStyle} onFocus={onFocus} onBlur={onBlur} />
                          </div>
                          <div className="flex gap-3 pt-2">
                            <button type="button" onClick={() => setEditingBrokerageId(null)}
                              className="flex-1 px-4 py-2.5 rounded-lg font-semibold transition-colors"
                              style={{ background: colors.cardHoverBg, color: colors.textPrimary, border: `1px solid ${colors.border}` }}
                            >Cancel</button>
                            <button type="submit" disabled={submitting}
                              className="flex-1 px-4 py-2.5 rounded-lg font-semibold transition-colors disabled:opacity-50"
                              style={{ background: '#C4B098', color: '#1E1E1E' }}
                            >{submitting ? 'Saving...' : 'Save Changes'}</button>
                          </div>
                        </form>
                      ) : (
                        <div className="px-6 py-4 grid grid-cols-2 md:grid-cols-4 gap-4 text-sm" style={{ borderBottom: `1px solid ${colors.border}` }}>
                          <div>
                            <p className="text-xs font-semibold uppercase tracking-wider mb-1" style={{ color: colors.textMuted }}>Address</p>
                            <p style={{ color: colors.textPrimary }}>{brokerage.address || '—'}</p>
                          </div>
                          <div>
                            <p className="text-xs font-semibold uppercase tracking-wider mb-1" style={{ color: colors.textMuted }}>Phone</p>
                            <p style={{ color: colors.textPrimary }}>{brokerage.phone || '—'}</p>
                          </div>
                          <div>
                            <p className="text-xs font-semibold uppercase tracking-wider mb-1" style={{ color: colors.textMuted }}>Transaction System</p>
                            <p style={{ color: colors.textPrimary }}>{brokerage.transaction_system || '—'}</p>
                          </div>
                          <div>
                            <p className="text-xs font-semibold uppercase tracking-wider mb-1" style={{ color: colors.textMuted }}>Notes</p>
                            <p style={{ color: colors.textPrimary }}>{brokerage.notes || '—'}</p>
                          </div>
                        </div>
                      )}

                      {/* Agent Roster */}
                      <div className="px-6 py-4">
                        <div className="flex items-center justify-between mb-4">
                          <div className="flex items-center gap-2">
                            <Users size={15} style={{ color: colors.gold }} />
                            <h4 className="text-sm font-bold" style={{ color: colors.textPrimary }}>
                              Agent Roster
                              <span className="font-normal ml-1.5" style={{ color: colors.textMuted }}>
                                ({activeAgents} active{agentCount !== activeAgents ? `, ${agentCount} total` : ''})
                              </span>
                            </h4>
                          </div>
                          {showAddAgentFor !== brokerage.id && (
                            <div className="flex items-center gap-2">
                              <button
                                onClick={() => { setShowAddAgentFor(brokerage.id); setAgentForm(emptyAgentForm) }}
                                className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors"
                                style={{ color: colors.gold, border: `1px solid ${colors.border}` }}
                                onMouseEnter={(e) => { e.currentTarget.style.background = colors.cardHoverBg; e.currentTarget.style.borderColor = colors.gold }}
                                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = colors.border }}
                              >
                                <UserPlus size={13} /> Add Agent
                              </button>
                              <label
                                className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors cursor-pointer"
                                style={{ color: colors.gold, border: `1px solid ${colors.border}` }}
                                onMouseEnter={(e) => { e.currentTarget.style.background = colors.cardHoverBg; e.currentTarget.style.borderColor = colors.gold }}
                                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = colors.border }}
                              >
                                <Upload size={13} /> Import Roster
                                <input
                                  type="file"
                                  accept=".xlsx,.xls,.csv"
                                  className="hidden"
                                  onChange={(e) => handleFileUpload(e, brokerage.id)}
                                  disabled={submitting}
                                />
                              </label>
                              <button
                                onClick={downloadTemplate}
                                className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors"
                                style={{ color: colors.textMuted, border: `1px solid ${colors.border}` }}
                                onMouseEnter={(e) => { e.currentTarget.style.background = colors.cardHoverBg; e.currentTarget.style.color = colors.textPrimary }}
                                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = colors.textMuted }}
                                title="Download template spreadsheet"
                              >
                                <Download size={13} /> Template
                              </button>
                            </div>
                          )}
                        </div>

                        {/* Add Agent Form */}
                        {showAddAgentFor === brokerage.id && (
                          <form onSubmit={(e) => handleAddAgent(e, brokerage.id)}
                            className="mb-4 p-4 rounded-lg space-y-3"
                            style={{ background: colors.pageBg, border: `1px solid ${colors.border}` }}
                          >
                            <div className="flex items-center justify-between">
                              <p className="text-xs font-bold uppercase tracking-wider" style={{ color: colors.gold }}>New Agent</p>
                              <button type="button" onClick={() => setShowAddAgentFor(null)} style={{ color: colors.textMuted }}>
                                <X size={14} />
                              </button>
                            </div>
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                              {renderInput('First Name', agentForm.firstName, (v) => setAgentForm({ ...agentForm, firstName: v }), { required: true })}
                              {renderInput('Last Name', agentForm.lastName, (v) => setAgentForm({ ...agentForm, lastName: v }), { required: true })}
                              {renderInput('Email', agentForm.email, (v) => setAgentForm({ ...agentForm, email: v }), { required: true, type: 'email' })}
                            </div>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                              {renderInput('Phone', agentForm.phone, (v) => setAgentForm({ ...agentForm, phone: v }), { type: 'tel' })}
                              {renderInput('RECO Number', agentForm.recoNumber, (v) => setAgentForm({ ...agentForm, recoNumber: v }))}
                            </div>
                            <div className="flex gap-3 pt-1">
                              <button type="button" onClick={() => setShowAddAgentFor(null)}
                                className="px-4 py-2 rounded-lg text-sm font-semibold transition-colors"
                                style={{ background: colors.cardBg, color: colors.textPrimary, border: `1px solid ${colors.border}` }}
                              >Cancel</button>
                              <button type="submit" disabled={submitting}
                                className="px-4 py-2 rounded-lg text-sm font-semibold transition-colors disabled:opacity-50"
                                style={{ background: '#C4B098', color: '#1E1E1E' }}
                              >{submitting ? 'Adding...' : 'Add Agent'}</button>
                            </div>
                          </form>
                        )}

                        {/* Import Results */}
                        {importingFor === brokerage.id && importResult && (
                          <div className="mb-4 p-4 rounded-lg space-y-2"
                            style={{ background: colors.pageBg, border: `1px solid ${colors.border}` }}
                          >
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-2">
                                <FileSpreadsheet size={15} style={{ color: colors.gold }} />
                                <p className="text-sm font-bold" style={{ color: colors.textPrimary }}>
                                  Import Results
                                </p>
                              </div>
                              <button onClick={() => { setImportResult(null); setImportingFor(null) }}
                                style={{ color: colors.textMuted }}><X size={14} /></button>
                            </div>
                            <div className="flex gap-4 text-sm">
                              <span style={{ color: colors.successText }}>{importResult.imported} imported</span>
                              {importResult.skipped > 0 && (
                                <span style={{ color: colors.warningText }}>{importResult.skipped} skipped</span>
                              )}
                            </div>
                            {importResult.errors.length > 0 && (
                              <div className="text-xs space-y-1 max-h-32 overflow-y-auto mt-2 p-2 rounded"
                                style={{ background: colors.cardBg, border: `1px solid ${colors.border}` }}
                              >
                                {importResult.errors.map((err, i) => (
                                  <p key={i} style={{ color: colors.warningText }}>{err}</p>
                                ))}
                              </div>
                            )}
                          </div>
                        )}

                        {/* Agent List */}
                        {agentCount === 0 ? (
                          <p className="text-sm py-4 text-center" style={{ color: colors.textMuted }}>
                            No agents registered yet.
                          </p>
                        ) : (
                          <div className="overflow-x-auto rounded-lg" style={{ border: `1px solid ${colors.border}` }}>
                            <table className="w-full">
                              <thead>
                                <tr style={{ background: colors.tableHeaderBg }}>
                                  <th className="px-4 py-2.5 text-left text-xs font-bold uppercase tracking-wider" style={{ color: colors.textMuted }}>Name</th>
                                  <th className="px-4 py-2.5 text-left text-xs font-bold uppercase tracking-wider" style={{ color: colors.textMuted }}>Email</th>
                                  <th className="px-4 py-2.5 text-left text-xs font-bold uppercase tracking-wider" style={{ color: colors.textMuted }}>Phone</th>
                                  <th className="px-4 py-2.5 text-left text-xs font-bold uppercase tracking-wider" style={{ color: colors.textMuted }}>RECO #</th>
                                  <th className="px-4 py-2.5 text-left text-xs font-bold uppercase tracking-wider" style={{ color: colors.textMuted }}>Status</th>
                                  <th className="px-4 py-2.5 text-right text-xs font-bold uppercase tracking-wider" style={{ color: colors.textMuted }}></th>
                                </tr>
                              </thead>
                              <tbody>
                                {brokerage.agents
                                  .sort((a, b) => a.last_name.localeCompare(b.last_name))
                                  .map((agent, idx) => {
                                    const agentBadge = getStatusBadgeStyle(agent.status)
                                    const isAgentMatch = q && (
                                      `${agent.first_name} ${agent.last_name}`.toLowerCase().includes(q) ||
                                      agent.email.toLowerCase().includes(q)
                                    )
                                    const isEditing = editingAgentId === agent.id

                                    if (isEditing) {
                                      return (
                                        <tr key={agent.id} style={{ background: colors.goldBg, borderBottom: idx < agentCount - 1 ? `1px solid ${colors.divider}` : 'none' }}>
                                          <td className="px-3 py-2" colSpan={6}>
                                            <form onSubmit={(e) => handleEditAgentSubmit(e, agent.id, brokerage.id)} className="space-y-3">
                                              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
                                                <div>
                                                  <label className="block text-xs font-semibold mb-1" style={{ color: colors.textMuted }}>First Name *</label>
                                                  <input value={editAgentForm.firstName} onChange={(e) => setEditAgentForm({ ...editAgentForm, firstName: e.target.value })}
                                                    className="w-full px-3 py-1.5 rounded-lg text-sm outline-none" style={inputStyle} onFocus={onFocus} onBlur={onBlur} />
                                                </div>
                                                <div>
                                                  <label className="block text-xs font-semibold mb-1" style={{ color: colors.textMuted }}>Last Name *</label>
                                                  <input value={editAgentForm.lastName} onChange={(e) => setEditAgentForm({ ...editAgentForm, lastName: e.target.value })}
                                                    className="w-full px-3 py-1.5 rounded-lg text-sm outline-none" style={inputStyle} onFocus={onFocus} onBlur={onBlur} />
                                                </div>
                                                <div>
                                                  <label className="block text-xs font-semibold mb-1" style={{ color: colors.textMuted }}>Email *</label>
                                                  <input type="email" value={editAgentForm.email} onChange={(e) => setEditAgentForm({ ...editAgentForm, email: e.target.value })}
                                                    className="w-full px-3 py-1.5 rounded-lg text-sm outline-none" style={inputStyle} onFocus={onFocus} onBlur={onBlur} />
                                                </div>
                                                <div>
                                                  <label className="block text-xs font-semibold mb-1" style={{ color: colors.textMuted }}>Phone</label>
                                                  <input value={editAgentForm.phone} onChange={(e) => setEditAgentForm({ ...editAgentForm, phone: e.target.value })}
                                                    className="w-full px-3 py-1.5 rounded-lg text-sm outline-none" style={inputStyle} onFocus={onFocus} onBlur={onBlur} />
                                                </div>
                                                <div>
                                                  <label className="block text-xs font-semibold mb-1" style={{ color: colors.textMuted }}>RECO #</label>
                                                  <input value={editAgentForm.recoNumber} onChange={(e) => setEditAgentForm({ ...editAgentForm, recoNumber: e.target.value })}
                                                    className="w-full px-3 py-1.5 rounded-lg text-sm outline-none" style={inputStyle} onFocus={onFocus} onBlur={onBlur} />
                                                </div>
                                              </div>
                                              <div className="flex items-center gap-4">
                                                <div className="flex items-center gap-2">
                                                  <label className="text-xs font-semibold" style={{ color: colors.textMuted }}>Status:</label>
                                                  <select value={editAgentForm.status} onChange={(e) => setEditAgentForm({ ...editAgentForm, status: e.target.value })}
                                                    className="px-2 py-1 rounded text-xs outline-none" style={inputStyle} onFocus={onFocus} onBlur={onBlur}>
                                                    <option value="active">Active</option>
                                                    <option value="suspended">Suspended</option>
                                                  </select>
                                                </div>
                                                <label className="flex items-center gap-1.5 text-xs cursor-pointer" style={{ color: colors.textSecondary }}>
                                                  <input type="checkbox" checked={editAgentForm.flaggedByBrokerage}
                                                    onChange={(e) => setEditAgentForm({ ...editAgentForm, flaggedByBrokerage: e.target.checked })} />
                                                  Flagged by Brokerage
                                                </label>
                                                <div className="flex items-center gap-1.5">
                                                  <label className="text-xs font-semibold" style={{ color: colors.textMuted }}>Recovery $:</label>
                                                  <input type="number" step="0.01" min="0" value={editAgentForm.outstandingRecovery}
                                                    onChange={(e) => setEditAgentForm({ ...editAgentForm, outstandingRecovery: e.target.value })}
                                                    className="w-24 px-2 py-1 rounded text-xs outline-none" style={inputStyle} onFocus={onFocus} onBlur={onBlur} />
                                                </div>
                                                <div className="flex-1" />
                                                <button type="button" onClick={() => setEditingAgentId(null)}
                                                  className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors"
                                                  style={{ color: colors.textSecondary, border: `1px solid ${colors.border}` }}
                                                  onMouseEnter={(e) => e.currentTarget.style.background = colors.cardHoverBg}
                                                  onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}>
                                                  Cancel
                                                </button>
                                                <button type="submit" disabled={submitting}
                                                  className="px-3 py-1.5 rounded-lg text-xs font-semibold text-white transition-colors disabled:opacity-50"
                                                  style={{ background: '#1A7A2E' }}
                                                  onMouseEnter={(e) => { if (!e.currentTarget.disabled) e.currentTarget.style.background = '#156A24' }}
                                                  onMouseLeave={(e) => e.currentTarget.style.background = '#1A7A2E'}>
                                                  {submitting ? 'Saving...' : 'Save'}
                                                </button>
                                              </div>
                                            </form>
                                          </td>
                                        </tr>
                                      )
                                    }

                                    return (
                                      <tr key={agent.id}
                                        style={{
                                          borderBottom: idx < agentCount - 1 ? `1px solid ${colors.divider}` : 'none',
                                          background: isAgentMatch ? colors.goldBg : undefined,
                                          borderLeft: isAgentMatch ? `3px solid ${colors.gold}` : undefined,
                                        }}
                                        onMouseEnter={(e) => e.currentTarget.style.background = isAgentMatch ? colors.goldBg : colors.tableRowHoverBg}
                                        onMouseLeave={(e) => e.currentTarget.style.background = isAgentMatch ? colors.goldBg : 'transparent'}
                                      >
                                        <td className="px-4 py-3 text-sm font-medium" style={{ color: colors.textPrimary }}>
                                          <div className="flex items-center gap-2">
                                            {agent.first_name} {agent.last_name}
                                            {agent.flagged_by_brokerage && (
                                              <span className="text-xs px-1.5 py-0.5 rounded font-semibold"
                                                style={{ background: colors.errorBg, color: colors.errorText, border: `1px solid ${colors.errorBorder}` }}
                                              >Flagged</span>
                                            )}
                                          </div>
                                        </td>
                                        <td className="px-4 py-3 text-sm" style={{ color: colors.textSecondary }}>{agent.email}</td>
                                        <td className="px-4 py-3 text-sm" style={{ color: colors.textSecondary }}>{agent.phone || '—'}</td>
                                        <td className="px-4 py-3 text-sm" style={{ color: colors.textMuted }}>{agent.reco_number || '—'}</td>
                                        <td className="px-4 py-3">
                                          <span className="inline-flex px-2 py-0.5 text-xs font-semibold rounded"
                                            style={{ background: agentBadge.bg, color: agentBadge.text, border: `1px solid ${agentBadge.border}` }}
                                          >
                                            {agent.status.charAt(0).toUpperCase() + agent.status.slice(1)}
                                          </span>
                                        </td>
                                        <td className="px-4 py-3 text-right">
                                          <button
                                            onClick={() => openEditAgent(agent, brokerage.id)}
                                            className="text-xs px-2 py-1 rounded transition-colors"
                                            style={{ color: colors.textMuted }}
                                            onMouseEnter={(e) => { e.currentTarget.style.color = colors.gold; e.currentTarget.style.background = colors.goldBg }}
                                            onMouseLeave={(e) => { e.currentTarget.style.color = colors.textMuted; e.currentTarget.style.background = 'transparent' }}
                                          >
                                            <Edit2 size={13} />
                                          </button>
                                        </td>
                                      </tr>
                                    )
                                  })}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </main>
    </div>
  )
}
