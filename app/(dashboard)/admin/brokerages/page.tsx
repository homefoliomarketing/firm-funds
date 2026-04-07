'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import { Plus, Edit2, Search, ChevronLeft, AlertCircle, CheckCircle, ChevronDown, ChevronRight, Users, UserPlus, X, Upload, Download, FileSpreadsheet, Archive, Eye, EyeOff, FileText, Trash2, Shield, ExternalLink, XCircle, Mail, CreditCard, KeyRound, AtSign } from 'lucide-react'
import { createBrokerage, updateBrokerage, createAgent, updateAgent, bulkImportAgents, inviteAgent, archiveAgent, permanentlyDeleteAgent, resendAgentWelcomeEmail, sendWelcomeToAllBrokerageAgents, adminResetUserPassword, adminChangeUserEmail, getBrokerageUserProfiles, inviteBrokerageAdmin, resendBrokerageSetupLink } from '@/lib/actions/admin-actions'
import { updateAgentBanking, approveAgentBanking, rejectAgentBanking } from '@/lib/actions/profile-actions'
import { verifyBrokerageKyc, revokeBrokerageKyc, verifyAgentKyc, rejectAgentKyc, getAgentKycDocumentUrl } from '@/lib/actions/kyc-actions'
import * as XLSX from 'xlsx'
import { getStatusBadgeClass as getSharedStatusBadgeClass, formatStatusLabel, getKycBadgeClass, RECO_PUBLIC_REGISTER_URL } from '@/lib/constants'
import SignOutModal from '@/components/SignOutModal'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'

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
  status: 'active' | 'suspended' | 'archived'
  flagged_by_brokerage: boolean
  outstanding_recovery: number
  kyc_status: 'pending' | 'submitted' | 'verified' | 'rejected'
  // Banking fields
  bank_transit_number: string | null
  bank_institution_number: string | null
  bank_account_number: string | null
  banking_verified: boolean
  // Banking self-service submission
  banking_submitted_transit: string | null
  banking_submitted_institution: string | null
  banking_submitted_account: string | null
  banking_submitted_at: string | null
  banking_approval_status: 'none' | 'pending' | 'approved' | 'rejected'
  banking_rejection_reason: string | null
  preauth_form_path: string | null
  preauth_form_uploaded_at: string | null
  created_at: string
}

interface Deal {
  id: string
  property_address: string
  status: string
  advance_amount: number
  closing_date: string
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
  broker_of_record_name: string | null
  broker_of_record_email: string | null
  logo_url: string | null
  brand_color: string | null
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
  brokerOfRecordName: string
  brokerOfRecordEmail: string
  logoUrl: string
  brandColor: string
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
// Status badge helper (local — no colors dependency)
// ============================================================================

function getLocalStatusBadgeClass(status: string): string {
  switch (status) {
    case 'active': return 'bg-green-950/50 text-green-400 border border-green-800'
    case 'suspended': return 'bg-yellow-950/50 text-yellow-400 border border-yellow-800'
    case 'inactive': return 'bg-muted text-muted-foreground border border-border'
    case 'archived': return 'bg-muted text-muted-foreground border border-border'
    default: return 'bg-muted text-muted-foreground border border-border'
  }
}

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
    name: '', email: '', brand: '', address: '', phone: '', referralFeePercentage: '', transactionSystem: '', notes: '', brokerOfRecordName: '', brokerOfRecordEmail: '', logoUrl: '', brandColor: '#5FA873',
  })
  const [editFormData, setEditFormData] = useState<BrokerageFormData & { status: 'active' | 'suspended' | 'inactive' }>({
    name: '', email: '', brand: '', address: '', phone: '', referralFeePercentage: '', transactionSystem: '', notes: '', brokerOfRecordName: '', brokerOfRecordEmail: '', logoUrl: '', brandColor: '#5FA873', status: 'active',
  })
  const [agentForm, setAgentForm] = useState<AgentFormData>(emptyAgentForm)
  const [sendInvite, setSendInvite] = useState(true)
  const [showArchived, setShowArchived] = useState(false)
  const [archivingAgentId, setArchivingAgentId] = useState<string | null>(null)
  const [importingFor, setImportingFor] = useState<string | null>(null)
  const [importResult, setImportResult] = useState<{ imported: number; skipped: number; errors: string[] } | null>(null)
  const [createRosterFile, setCreateRosterFile] = useState<File | null>(null)
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null)
  const [expandedAgentId, setExpandedAgentId] = useState<string | null>(null)
  const [agentDeals, setAgentDeals] = useState<Record<string, Deal[]>>({})
  const [editAgentForm, setEditAgentForm] = useState<AgentFormData & { status: string; flaggedByBrokerage: boolean; outstandingRecovery: string }>(
    { firstName: '', lastName: '', email: '', phone: '', recoNumber: '', status: 'active', flaggedByBrokerage: false, outstandingRecovery: '0' }
  )
  const [brokerageDocs, setBrokerageDocs] = useState<Record<string, { id: string; file_name: string; document_type: string; file_path: string; file_size: number; created_at: string }[]>>({})
  const [uploadingBrokerageDoc, setUploadingBrokerageDoc] = useState(false)
  const [uploadingLogo, setUploadingLogo] = useState(false)
  // KYC state
  const [kycRecoNumber, setKycRecoNumber] = useState('')
  const [kycNotes, setKycNotes] = useState('')
  const [kycSubmitting, setKycSubmitting] = useState(false)
  const [kycRejectingAgentId, setKycRejectingAgentId] = useState<string | null>(null)
  const [kycRejectReason, setKycRejectReason] = useState('')
  const [kycViewingUrl, setKycViewingUrl] = useState<string | null>(null)
  const [kycPreviewPanel, setKycPreviewPanel] = useState<{ blobUrls: string[]; originalUrls: string[]; fileName: string; agentName: string; agentId: string } | null>(null)
  const [kycPreviewLoading, setKycPreviewLoading] = useState<string | null>(null)
  // Banking state
  const [bankingForm, setBankingForm] = useState<{ transit: string; institution: string; account: string }>({ transit: '', institution: '', account: '' })
  const [bankingEditingAgentId, setBankingEditingAgentId] = useState<string | null>(null)
  const [bankingSaving, setBankingSaving] = useState(false)
  const [bankingMessage, setBankingMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [bankingApprovingId, setBankingApprovingId] = useState<string | null>(null)
  const [bankingRejectingId, setBankingRejectingId] = useState<string | null>(null)
  const [bankingRejectReason, setBankingRejectReason] = useState('')
  const [preauthViewingAgentId, setPreauthViewingAgentId] = useState<string | null>(null)
  const [preauthViewUrl, setPreauthViewUrl] = useState<string | null>(null)
  // User management state (password reset, email change)
  const [resettingPasswordForUserId, setResettingPasswordForUserId] = useState<string | null>(null)
  const [changingEmailForUserId, setChangingEmailForUserId] = useState<string | null>(null)
  const [changeEmailValue, setChangeEmailValue] = useState('')
  const [changingEmailSaving, setChangingEmailSaving] = useState(false)
  const [brokerageUserProfiles, setBrokerageUserProfiles] = useState<Record<string, { brokerageAdmins: any[]; agents: any[] }>>({})
  const [loadingUserProfiles, setLoadingUserProfiles] = useState<string | null>(null)
  const [showUserManagement, setShowUserManagement] = useState<string | null>(null)
  const [showCreateBrokerageLogin, setShowCreateBrokerageLogin] = useState(false)
  const [brokerageLoginForm, setBrokerageLoginForm] = useState({ fullName: '', email: '' })
  const [creatingBrokerageLogin, setCreatingBrokerageLogin] = useState(false)
  const [resendingSetupLink, setResendingSetupLink] = useState<string | null>(null)
  const kycPanelWidth = 520
  const closeKycPanel = () => {
    if (kycPreviewPanel) {
      for (const url of kycPreviewPanel.blobUrls) URL.revokeObjectURL(url)
    }
    setKycPreviewPanel(null)
  }

  const router = useRouter()
  const supabase = createClient()

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

  // Auto-expand the first brokerage with pending actions
  useEffect(() => {
    if (loading || brokerages.length === 0 || expandedId) return
    const brokerageWithAction = brokerages.find(b =>
      b.agents.some(a => a.kyc_status === 'submitted' || a.banking_approval_status === 'pending')
    )
    if (brokerageWithAction) {
      setExpandedId(brokerageWithAction.id)
    }
  }, [loading, brokerages.length])

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
      brokerOfRecordName: createFormData.brokerOfRecordName || undefined, brokerOfRecordEmail: createFormData.brokerOfRecordEmail || undefined,
      logoUrl: createFormData.logoUrl || undefined, brandColor: createFormData.brandColor || undefined,
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
          // Auto-detect header row (skip branded header rows in premium template)
          const rawRows: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' })
          let headerRowIdx = 0
          for (let i = 0; i < Math.min(rawRows.length, 10); i++) {
            const rowText = rawRows[i].join(' ').toLowerCase()
            if (rowText.includes('first') && rowText.includes('email')) { headerRowIdx = i; break }
          }
          const rows: any[] = XLSX.utils.sheet_to_json(sheet, { defval: '', range: headerRowIdx })

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
                addressStreet: find(['street', 'addressstreet', 'streetaddress', 'address']) || undefined,
                addressCity: find(['city', 'addresscity']) || undefined,
                addressProvince: find(['province', 'addressprovince', 'state', 'prov']) || undefined,
                addressPostalCode: find(['postal', 'postalcode', 'zip', 'addresspostalcode']) || undefined,
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
      setCreateFormData({ name: '', email: '', brand: '', address: '', phone: '', referralFeePercentage: '', transactionSystem: '', notes: '', brokerOfRecordName: '', brokerOfRecordEmail: '', logoUrl: '', brandColor: '#5FA873' })
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
      brokerOfRecordName: editFormData.brokerOfRecordName || undefined, brokerOfRecordEmail: editFormData.brokerOfRecordEmail || undefined,
      logoUrl: editFormData.logoUrl || undefined, brandColor: editFormData.brandColor || undefined,
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
      brokerOfRecordName: brokerage.broker_of_record_name || '', brokerOfRecordEmail: brokerage.broker_of_record_email || '',
      logoUrl: brokerage.logo_url || '', brandColor: brokerage.brand_color || '#5FA873',
      status: brokerage.status,
    })
    setEditingBrokerageId(brokerage.id)
    setExpandedId(brokerage.id)
  }

  // ---- Logo Upload ----
  const handleLogoUpload = async (file: File, brokerageId: string, isCreate: boolean) => {
    const allowed = ['image/jpeg', 'image/png', 'image/svg+xml', 'image/webp']
    if (!allowed.includes(file.type)) {
      setStatusMessage({ type: 'error', text: 'Logo must be JPEG, PNG, SVG, or WebP' }); return
    }
    if (file.size > 2 * 1024 * 1024) {
      setStatusMessage({ type: 'error', text: 'Logo must be under 2MB' }); return
    }
    setUploadingLogo(true)
    try {
      const ext = file.name.split('.').pop() || 'png'
      const path = `${brokerageId}/logo.${ext}`
      const { error: uploadErr } = await supabase.storage.from('brokerage-logos').upload(path, file, { upsert: true })
      if (uploadErr) { setStatusMessage({ type: 'error', text: 'Failed to upload logo' }); setUploadingLogo(false); return }
      const { data: { publicUrl } } = supabase.storage.from('brokerage-logos').getPublicUrl(path)
      // Add cache-busting param
      const logoUrl = `${publicUrl}?t=${Date.now()}`
      if (isCreate) {
        setCreateFormData(prev => ({ ...prev, logoUrl }))
      } else {
        setEditFormData(prev => ({ ...prev, logoUrl }))
      }
      setStatusMessage({ type: 'success', text: 'Logo uploaded' })
      setTimeout(() => setStatusMessage(null), 2000)
    } catch {
      setStatusMessage({ type: 'error', text: 'Logo upload failed' })
    }
    setUploadingLogo(false)
  }

  // ---- Agent CRUD ----
  const handleAddAgent = async (e: React.FormEvent, brokerageId: string) => {
    e.preventDefault()
    if (!agentForm.firstName.trim() || !agentForm.lastName.trim() || !agentForm.email.trim()) {
      setStatusMessage({ type: 'error', text: 'First name, last name, and email are required' }); return
    }
    setSubmitting(true)

    if (sendInvite) {
      // Create agent record + auth user (no email yet — send in bulk when brokerage is ready)
      const result = await inviteAgent({
        brokerageId,
        firstName: agentForm.firstName, lastName: agentForm.lastName,
        email: agentForm.email, phone: agentForm.phone || undefined,
        recoNumber: agentForm.recoNumber || undefined,
        skipEmail: true,
      })
      if (result.success) {
        setStatusMessage({ type: 'success', text: `Agent added with login created. Use "Send Welcome to All" when ready.` })
        setAgentForm(emptyAgentForm)
        setSendInvite(true)
        setShowAddAgentFor(null)
        await loadBrokerages()
      } else {
        // Check if agent was created but login failed
        if (result.data?.agentCreated && !result.data?.loginCreated) {
          setStatusMessage({ type: 'error', text: result.error || 'Agent added to roster but login creation failed. See error for details.' })
          await loadBrokerages()
        } else {
          setStatusMessage({ type: 'error', text: result.error || 'Failed to invite agent' })
        }
      }
    } else {
      // Just create the agent record (no login, no email)
      const result = await createAgent({
        brokerageId,
        firstName: agentForm.firstName, lastName: agentForm.lastName,
        email: agentForm.email, phone: agentForm.phone || undefined,
        recoNumber: agentForm.recoNumber || undefined,
      })
      if (result.success) {
        setStatusMessage({ type: 'success', text: 'Agent added to roster (no login created)' })
        setAgentForm(emptyAgentForm)
        setShowAddAgentFor(null)
        await loadBrokerages()
      } else {
        setStatusMessage({ type: 'error', text: result.error || 'Failed to add agent' })
      }
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
      // Auto-detect header row (skip branded header rows in premium template)
      const rawRows: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' })
      let headerRowIdx = 0
      for (let i = 0; i < Math.min(rawRows.length, 10); i++) {
        const rowText = rawRows[i].join(' ').toLowerCase()
        if (rowText.includes('first') && rowText.includes('email')) { headerRowIdx = i; break }
      }
      const rows: any[] = XLSX.utils.sheet_to_json(sheet, { defval: '', range: headerRowIdx })

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
          addressStreet: find(['street', 'addressstreet', 'streetaddress', 'address']) || undefined,
          addressCity: find(['city', 'addresscity']) || undefined,
          addressProvince: find(['province', 'addressprovince', 'state', 'prov']) || undefined,
          addressPostalCode: find(['postal', 'postalcode', 'zip', 'addresspostalcode']) || undefined,
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

  // ---- Brokerage document handlers ----
  const BROKERAGE_DOC_TYPES = [
    { value: 'cooperation_agreement', label: 'Brokerage Cooperation Agreement' },
    { value: 'white_label_agreement', label: 'White-Label Licensing Agreement' },
    { value: 'banking_info', label: 'Banking / EFT Details' },
    { value: 'kyc_business', label: 'Business KYC / Verification' },
    { value: 'other', label: 'Other' },
  ]

  const loadBrokerageDocs = async (brokerageId: string) => {
    const { data } = await supabase.from('brokerage_documents').select('*').eq('brokerage_id', brokerageId).order('created_at', { ascending: false })
    setBrokerageDocs(prev => ({ ...prev, [brokerageId]: data || [] }))
  }

  const handleBrokerageDocUpload = async (e: React.ChangeEvent<HTMLInputElement>, brokerageId: string, docType: string) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > 10 * 1024 * 1024) { setStatusMessage({ type: 'error', text: 'File must be under 10MB' }); return }
    setUploadingBrokerageDoc(true)
    const filePath = `brokerages/${brokerageId}/${Date.now()}_${file.name}`
    const { error: uploadErr } = await supabase.storage.from('deal-documents').upload(filePath, file)
    if (uploadErr) { setStatusMessage({ type: 'error', text: `Upload failed: ${uploadErr.message}` }); setUploadingBrokerageDoc(false); return }
    const { error: dbErr } = await supabase.from('brokerage_documents').insert({
      brokerage_id: brokerageId,
      document_type: docType,
      file_name: file.name,
      file_path: filePath,
      file_size: file.size,
      uploaded_by: user?.id,
    })
    if (dbErr) { setStatusMessage({ type: 'error', text: `Failed to save record: ${dbErr.message}` }); setUploadingBrokerageDoc(false); return }
    setStatusMessage({ type: 'success', text: `${file.name} uploaded` })
    await loadBrokerageDocs(brokerageId)
    setUploadingBrokerageDoc(false)
    e.target.value = ''
  }

  const handleBrokerageDocDelete = async (doc: { id: string; file_path: string; file_name: string }, brokerageId: string) => {
    if (!confirm(`Delete "${doc.file_name}"? This cannot be undone.`)) return
    await supabase.storage.from('deal-documents').remove([doc.file_path])
    await supabase.from('brokerage_documents').delete().eq('id', doc.id)
    setStatusMessage({ type: 'success', text: 'Document deleted' })
    await loadBrokerageDocs(brokerageId)
  }

  const handleBrokerageDocView = async (doc: { file_path: string }) => {
    const { data } = await supabase.storage.from('deal-documents').createSignedUrl(doc.file_path, 3600)
    if (data?.signedUrl) window.open(data.signedUrl, '_blank')
  }

  const downloadTemplate = () => {
    const link = document.createElement('a')
    link.href = '/firm-funds-agent-import-template.xlsx'
    link.download = 'firm-funds-agent-import-template.xlsx'
    link.click()
  }

  const handleArchiveAgent = async (agentId: string, agentName: string) => {
    if (!confirm(`Archive "${agentName}"? They will be removed from the active roster and their login will be deactivated. Their deal history will be preserved.`)) return
    setArchivingAgentId(agentId)
    const result = await archiveAgent({ agentId })
    if (result.success) {
      setStatusMessage({ type: 'success', text: `${agentName} has been archived` })
      await loadBrokerages()
    } else {
      setStatusMessage({ type: 'error', text: result.error || 'Failed to archive agent' })
    }
    setArchivingAgentId(null)
  }

  const [deletingAgentId, setDeletingAgentId] = useState<string | null>(null)

  const handlePermanentlyDeleteAgent = async (agentId: string, agentName: string) => {
    if (!confirm(`PERMANENTLY DELETE "${agentName}"?\n\nThis will delete the agent and ALL associated data (deals, transactions, invoices, messages). This cannot be undone!`)) return
    setDeletingAgentId(agentId)
    const result = await permanentlyDeleteAgent({ agentId })
    if (result.success) {
      setStatusMessage({ type: 'success', text: `${agentName} has been permanently deleted` })
      await loadBrokerages()
    } else {
      setStatusMessage({ type: 'error', text: result.error || 'Failed to delete agent' })
    }
    setDeletingAgentId(null)
  }

  const [resendingAgentId, setResendingAgentId] = useState<string | null>(null)
  const [sendingAllFor, setSendingAllFor] = useState<string | null>(null)

  const handleSendWelcomeToAll = async (brokerageId: string, brokerageName: string) => {
    if (!confirm(`Send welcome emails to ALL active agents at ${brokerageName}? Each agent will receive a magic link to set up their account.`)) return
    setSendingAllFor(brokerageId)
    const result = await sendWelcomeToAllBrokerageAgents({ brokerageId })
    if (result.success) {
      const sent = result.data?.sent || 0
      const failed = result.data?.failed || 0
      if (failed > 0) {
        setStatusMessage({ type: 'success', text: `Welcome emails sent to ${sent} agent${sent !== 1 ? 's' : ''}. ${failed} failed — use individual resend for those.` })
      } else {
        setStatusMessage({ type: 'success', text: `Welcome emails sent to ${sent} agent${sent !== 1 ? 's' : ''}!` })
      }
    } else {
      setStatusMessage({ type: 'error', text: result.error || 'Failed to send welcome emails' })
    }
    setSendingAllFor(null)
  }

  const handleResendWelcome = async (agentId: string, agentName: string) => {
    if (!confirm(`Resend welcome email to ${agentName}? This will generate a new magic link.`)) return
    setResendingAgentId(agentId)
    const result = await resendAgentWelcomeEmail({ agentId })
    if (result.success) {
      setStatusMessage({ type: 'success', text: `Welcome email resent to ${agentName}` })
    } else {
      setStatusMessage({ type: 'error', text: result.error || 'Failed to resend email' })
    }
    setResendingAgentId(null)
  }

  const handleResetPassword = async (id: string, userName: string, type: 'agent' | 'user' = 'agent') => {
    if (!confirm(`Reset password for ${userName}? They will receive an email with a link to set a new password.`)) return
    setResettingPasswordForUserId(id)
    const result = await adminResetUserPassword(type === 'agent' ? { agentId: id } : { userId: id })
    if (result.success) {
      setStatusMessage({ type: 'success', text: `Password reset email sent to ${userName}` })
    } else {
      setStatusMessage({ type: 'error', text: result.error || 'Failed to reset password' })
    }
    setResettingPasswordForUserId(null)
  }

  const handleChangeEmail = async (id: string, userName: string, type: 'agent' | 'user' = 'agent', brokerageId?: string) => {
    if (!changeEmailValue.trim()) {
      setStatusMessage({ type: 'error', text: 'Enter a new email address' })
      return
    }
    if (!confirm(`Change login email for ${userName} to ${changeEmailValue}? They will be notified at their old email.`)) return
    setChangingEmailSaving(true)
    const result = await adminChangeUserEmail(type === 'agent' ? { agentId: id, newEmail: changeEmailValue } : { userId: id, newEmail: changeEmailValue })
    if (result.success) {
      setStatusMessage({ type: 'success', text: `Email changed for ${userName}. Notification sent to old address.` })
      setChangingEmailForUserId(null)
      setChangeEmailValue('')
      loadBrokerages()
      // Also refresh the manage logins panel if open for a brokerage
      if (brokerageId) {
        const refreshed = await getBrokerageUserProfiles(brokerageId)
        if (refreshed.success && refreshed.data) {
          setBrokerageUserProfiles(prev => ({ ...prev, [brokerageId]: refreshed.data as { brokerageAdmins: any[]; agents: any[] } }))
        }
      }
    } else {
      setStatusMessage({ type: 'error', text: result.error || 'Failed to change email' })
    }
    setChangingEmailSaving(false)
  }

  const handleLoadUserProfiles = async (brokerageId: string) => {
    if (showUserManagement === brokerageId) {
      setShowUserManagement(null)
      return
    }
    setLoadingUserProfiles(brokerageId)
    const result = await getBrokerageUserProfiles(brokerageId)
    if (result.success && result.data) {
      setBrokerageUserProfiles(prev => ({ ...prev, [brokerageId]: result.data as { brokerageAdmins: any[]; agents: any[] } }))
    }
    setShowUserManagement(brokerageId)
    setLoadingUserProfiles(null)
  }

  const handleCreateBrokerageLogin = async (brokerageId: string, brokerageName: string) => {
    if (!brokerageLoginForm.fullName.trim() || !brokerageLoginForm.email.trim()) {
      setStatusMessage({ type: 'error', text: 'Full name and email are required' })
      return
    }
    setCreatingBrokerageLogin(true)
    const result = await inviteBrokerageAdmin({
      brokerageId,
      fullName: brokerageLoginForm.fullName,
      email: brokerageLoginForm.email,
    })
    if (result.success) {
      setStatusMessage({ type: 'success', text: `Setup link sent to ${brokerageLoginForm.email} for ${brokerageName}` })
      setShowCreateBrokerageLogin(false)
      setBrokerageLoginForm({ fullName: '', email: '' })
      // Reload the user profiles to show the new login
      const refreshed = await getBrokerageUserProfiles(brokerageId)
      if (refreshed.success && refreshed.data) {
        setBrokerageUserProfiles(prev => ({ ...prev, [brokerageId]: refreshed.data as { brokerageAdmins: any[]; agents: any[] } }))
      }
    } else {
      setStatusMessage({ type: 'error', text: result.error || 'Failed to invite brokerage admin' })
    }
    setCreatingBrokerageLogin(false)
  }

  const handleResendSetupLink = async (userId: string, adminName: string) => {
    if (!confirm(`Resend setup link to ${adminName}? This will generate a new magic link and email it to them.`)) return
    setResendingSetupLink(userId)
    const result = await resendBrokerageSetupLink({ userId })
    if (result.success) {
      setStatusMessage({ type: 'success', text: `New setup link sent to ${adminName}` })
    } else {
      setStatusMessage({ type: 'error', text: result.error || 'Failed to resend setup link' })
    }
    setResendingSetupLink(null)
  }

  const handleExpandAgent = async (agentId: string) => {
    if (expandedAgentId === agentId) {
      setExpandedAgentId(null)
      return
    }

    // Fetch deals for this agent
    const { data, error } = await supabase
      .from('deals')
      .select('id, property_address, status, advance_amount, closing_date, created_at')
      .eq('agent_id', agentId)
      .order('created_at', { ascending: false })

    if (error) {
      console.error('Error loading agent deals:', error)
      setStatusMessage({ type: 'error', text: 'Failed to load agent deals' })
      return
    }

    setAgentDeals({ ...agentDeals, [agentId]: data || [] })
    setExpandedAgentId(agentId)
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

  // ---- Input class helper (replaces inputStyle object) ----
  const inputCls = 'w-full px-3 py-2 rounded-lg text-sm bg-input border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition-colors'
  const inputSmCls = 'rounded px-2 py-1.5 text-xs bg-input border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/40 focus:border-primary transition-colors font-mono'

  // ---- Render a form input (DRY helper) ----
  const renderInput = (
    label: string, value: string, onChange: (val: string) => void,
    opts?: { required?: boolean; placeholder?: string; type?: string; step?: string; min?: string; max?: string }
  ) => (
    <div>
      <label className="block text-sm font-medium mb-2 text-muted-foreground">
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
        className={inputCls}
      />
    </div>
  )

  // ---- Loading skeleton ----
  if (loading) {
    return (
      <div className="min-h-screen bg-background">
        <header className="bg-card/80 backdrop-blur-sm border-b border-border/50">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-5">
            <Skeleton className="h-6 w-36" />
          </div>
        </header>
        <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <Skeleton className="h-8 w-64 rounded-lg mb-2" />
          <Skeleton className="h-4 w-48 rounded mb-8" />
          <div className="bg-card border border-border/40 rounded-xl p-6 shadow-lg shadow-black/20">
            {[1, 2, 3, 4, 5].map(i => (
              <div key={i} className="flex gap-4 mb-4">
                <Skeleton className="h-4 flex-1 rounded" />
                <Skeleton className="h-4 w-20 rounded" />
                <Skeleton className="h-4 w-24 rounded" />
              </div>
            ))}
          </div>
        </main>
      </div>
    )
  }

  // ============================================================================
  // RENDER
  // ============================================================================

  return (
    <div className="min-h-screen bg-background">
      {/* Main content area — shrinks when KYC panel is open */}
      <div style={{ marginRight: kycPreviewPanel ? kycPanelWidth : 0, transition: 'margin-right 0.2s ease-out' }}>
      {/* Header */}
      <header className="bg-card/80 backdrop-blur-sm border-b border-border/50 sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center py-5">
            <div className="flex items-center gap-4">
              <button
                onClick={() => router.push('/admin')}
                className="p-1.5 rounded-lg transition-colors text-primary hover:bg-primary/10"
              >
                <ChevronLeft size={20} />
              </button>
              <img src="/brand/white.png" alt="Firm Funds" className="h-16 sm:h-20 md:h-28 w-auto" />
              <div className="w-px h-10 bg-white/15" />
              <p className="text-lg font-medium tracking-wide text-white" style={{ fontFamily: 'var(--font-geist-sans), sans-serif' }}>Manage Brokerages</p>
            </div>
            <div className="flex items-center gap-4">
              <span className="text-sm text-primary">{profile?.full_name}</span>
              <SignOutModal onConfirm={handleLogout} />
            </div>
          </div>
        </div>
      </header>

      <main id="main-content" className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Status Message */}
        {statusMessage && (
          <div className={`mb-6 p-4 rounded-lg flex items-center gap-3 animate-in fade-in border ${
            statusMessage.type === 'success'
              ? 'bg-green-950/50 border-green-800'
              : 'bg-red-950/50 border-red-800'
          }`}>
            {statusMessage.type === 'success'
              ? <CheckCircle size={18} className="text-green-400 flex-shrink-0" />
              : <AlertCircle size={18} className="text-red-400 flex-shrink-0" />
            }
            <p className={statusMessage.type === 'success' ? 'text-green-400' : 'text-red-400'}>
              {statusMessage.text}
            </p>
          </div>
        )}

        {/* Title + Search */}
        <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 mb-6">
          <div>
            <h2 className="text-2xl font-bold text-foreground">Brokerages</h2>
            <p className="text-sm mt-1 text-muted-foreground">
              {brokerages.length} brokerage{brokerages.length !== 1 ? 's' : ''} · {brokerages.reduce((sum, b) => sum + b.agents.length, 0)} total agents
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search brokerages or agents..."
                className="pl-9 pr-4 py-2 rounded-lg text-sm bg-input border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary w-full sm:w-72 transition-colors"
              />
            </div>
            {!showCreateForm && (
              <Button
                onClick={() => setShowCreateForm(true)}
                className="bg-primary text-primary-foreground hover:bg-primary/90 whitespace-nowrap"
              >
                <Plus size={16} />
                Add Brokerage
              </Button>
            )}
          </div>
        </div>

        {/* Create Brokerage Form */}
        {showCreateForm && (
          <div className="mb-8 rounded-xl overflow-hidden bg-card border border-border/40 shadow-lg shadow-black/20">
            <div className="px-6 py-5 border-b border-border/40 bg-card/80">
              <h3 className="text-lg font-bold text-foreground">Create New Brokerage</h3>
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
                {renderInput('Broker of Record', createFormData.brokerOfRecordName, (v) => setCreateFormData({ ...createFormData, brokerOfRecordName: v }), { placeholder: 'Full legal name' })}
                {renderInput('Broker of Record Email', createFormData.brokerOfRecordEmail, (v) => setCreateFormData({ ...createFormData, brokerOfRecordEmail: v }), { placeholder: 'broker@brokerage.com', type: 'email' })}
                <div>
                  <label className="block text-sm font-medium mb-2 text-muted-foreground">Brokerage Logo</label>
                  <div className="flex items-center gap-3">
                    {createFormData.logoUrl && <img src={createFormData.logoUrl} alt="Logo" className="h-10 w-auto rounded bg-muted" />}
                    <label className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold cursor-pointer transition-colors bg-input border border-border text-foreground hover:bg-muted ${uploadingLogo ? 'opacity-50' : ''}`}>
                      <Upload size={14} />
                      {uploadingLogo ? 'Uploading...' : createFormData.logoUrl ? 'Replace Logo' : 'Upload Logo'}
                      <input type="file" accept="image/jpeg,image/png,image/svg+xml,image/webp" className="hidden" disabled={uploadingLogo}
                        onChange={(e) => { const f = e.target.files?.[0]; if (f) handleLogoUpload(f, 'new-brokerage-' + Date.now(), true); e.target.value = '' }} />
                    </label>
                  </div>
                  <p className="text-[10px] mt-1 text-muted-foreground/60">JPEG, PNG, SVG, or WebP. Max 2MB.</p>
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium mb-2 text-muted-foreground">Notes</label>
                <textarea
                  value={createFormData.notes}
                  onChange={(e) => setCreateFormData({ ...createFormData, notes: e.target.value })}
                  placeholder="Any additional notes..."
                  rows={3}
                  className="w-full px-4 py-2 rounded-lg text-sm bg-input border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary resize-none transition-colors"
                />
              </div>
              {/* Agent Roster Upload */}
              <div className="p-4 rounded-lg bg-background border border-dashed border-border">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <FileSpreadsheet size={16} className="text-primary" />
                    <label className="text-sm font-medium text-muted-foreground">Agent Roster (optional)</label>
                  </div>
                  <button type="button" onClick={downloadTemplate}
                    className="flex items-center gap-1 text-xs font-semibold px-2 py-1 rounded transition-colors text-primary hover:bg-muted"
                  >
                    <Download size={12} /> Download Template
                  </button>
                </div>
                <p className="text-xs mb-3 text-muted-foreground">
                  Upload an .xlsx or .csv with columns: First Name, Last Name, Email, Phone, RECO Number. Agents will be imported automatically when the brokerage is created.
                </p>
                <div className="flex items-center gap-3">
                  <label
                    className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold cursor-pointer transition-colors bg-card text-foreground border border-border hover:border-primary"
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
                      <span className="text-sm text-green-400">{createRosterFile.name}</span>
                      <button type="button" onClick={() => setCreateRosterFile(null)}
                        className="p-0.5 rounded text-muted-foreground hover:text-red-400"
                      ><X size={14} /></button>
                    </div>
                  )}
                </div>
              </div>

              <div className="flex gap-3 pt-4">
                <Button type="button" variant="outline" className="flex-1" onClick={() => { setShowCreateForm(false); setCreateRosterFile(null) }}>
                  Cancel
                </Button>
                <Button type="submit" disabled={submitting} className="flex-1 bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
                  {submitting ? 'Saving...' : createRosterFile ? 'Save Brokerage & Import Agents' : 'Save Brokerage'}
                </Button>
              </div>
            </form>
          </div>
        )}

        {/* Brokerage List */}
        {filteredBrokerages.length === 0 ? (
          <div className="rounded-xl px-6 py-16 text-center bg-card border border-border/40 shadow-lg shadow-black/20">
            <p className="text-base font-semibold text-muted-foreground">
              {searchQuery ? 'No brokerages match your search' : 'No brokerages yet'}
            </p>
            <p className="text-sm mt-1 text-muted-foreground/60">
              {searchQuery ? 'Try adjusting your search.' : 'Click "Add Brokerage" to create the first one.'}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {filteredBrokerages.map((brokerage) => {
              const isExpanded = expandedId === brokerage.id
              const isEditing = editingBrokerageId === brokerage.id
              const allAgents = brokerage.agents
              const nonArchivedAgents = allAgents.filter(a => a.status !== 'archived')
              const archivedAgents = allAgents.filter(a => a.status === 'archived')
              const visibleAgents = showArchived ? allAgents : nonArchivedAgents
              const agentCount = visibleAgents.length
              const activeAgents = allAgents.filter(a => a.status === 'active').length
              // Count agents needing attention in this brokerage
              const pendingKycInBrokerage = allAgents.filter(a => a.kyc_status === 'submitted').length
              const pendingBankingInBrokerage = allAgents.filter(a => a.banking_approval_status === 'pending').length
              const actionCount = pendingKycInBrokerage + pendingBankingInBrokerage

              return (
                <div key={brokerage.id} className={`rounded-xl overflow-hidden transition-all bg-card shadow-lg shadow-black/20 ${isExpanded ? 'border border-primary/50' : 'border border-border/40'}`}>
                  {/* Brokerage Row (click to expand) */}
                  <div
                    className={`flex items-center gap-4 px-6 py-4 cursor-pointer transition-colors ${isExpanded ? 'bg-muted/30' : 'hover:bg-muted/20'}`}
                    onClick={() => {
                      if (isEditing) return
                      const newId = isExpanded ? null : brokerage.id
                      setExpandedId(newId)
                      setEditingBrokerageId(null)
                      setShowAddAgentFor(null)
                      if (newId && !brokerageDocs[newId]) loadBrokerageDocs(newId)
                    }}
                  >
                    <div className="flex-shrink-0 text-primary">
                      {isExpanded ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-bold truncate text-foreground">{brokerage.name}</p>
                        {brokerage.brand && (
                          <span className="text-xs px-2 py-0.5 rounded bg-primary/10 text-primary">{brokerage.brand}</span>
                        )}
                        {actionCount > 0 && (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold bg-red-600 text-white">
                            <AlertCircle size={10} />
                            {actionCount} pending
                          </span>
                        )}
                      </div>
                      <p className="text-xs mt-0.5 text-muted-foreground">{brokerage.email}</p>
                    </div>
                    <div className="flex items-center gap-4 flex-shrink-0">
                      <span className={`inline-flex px-2.5 py-1 text-xs font-semibold rounded-md ${getLocalStatusBadgeClass(brokerage.status)}`}>
                        {brokerage.status.charAt(0).toUpperCase() + brokerage.status.slice(1)}
                      </span>
                      {(brokerage as any).kyc_verified ? (
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs font-semibold rounded ${getKycBadgeClass('verified')}`}
                          title={`KYC verified${(brokerage as any).kyc_verified_at ? ' on ' + new Date((brokerage as any).kyc_verified_at).toLocaleDateString('en-CA') : ''}`}
                        >
                          <Shield size={11} /> KYC
                        </span>
                      ) : (
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs font-semibold rounded ${getKycBadgeClass('pending')}`}
                          title="KYC not verified"
                        >
                          <Shield size={11} /> No KYC
                        </span>
                      )}
                      <span className="text-xs font-medium text-muted-foreground">
                        {(brokerage.referral_fee_percentage * 100).toFixed(1)}% fee
                      </span>
                      <div className="flex items-center gap-1.5">
                        <Users size={13} className="text-muted-foreground" />
                        <span className="text-xs font-semibold text-foreground">{agentCount}</span>
                      </div>
                      <button
                        onClick={(e) => { e.stopPropagation(); openEditForm(brokerage) }}
                        className="p-1.5 rounded-md transition-colors text-muted-foreground hover:bg-muted hover:text-foreground"
                      >
                        <Edit2 size={14} />
                      </button>
                    </div>
                  </div>

                  {/* Expanded Content */}
                  {isExpanded && (
                    <div className="border-t border-border/50">
                      {/* Brokerage Details (or Edit Form) */}
                      {isEditing ? (
                        <form onSubmit={(e) => handleEditSubmit(e, brokerage.id)} className="p-6 space-y-4 border-b border-border/50">
                          <div className="flex items-center justify-between mb-2">
                            <h4 className="text-sm font-bold uppercase tracking-wider text-primary">Edit Brokerage</h4>
                            <button type="button" onClick={() => setEditingBrokerageId(null)} className="text-muted-foreground hover:text-foreground">
                              <X size={16} />
                            </button>
                          </div>
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            {renderInput('Name', editFormData.name, (v) => setEditFormData({ ...editFormData, name: v }), { required: true })}
                            {renderInput('Email', editFormData.email, (v) => setEditFormData({ ...editFormData, email: v }), { required: true, type: 'email' })}
                            {renderInput('Brand', editFormData.brand, (v) => setEditFormData({ ...editFormData, brand: v }))}
                            <div>
                              <label className="block text-sm font-medium mb-2 text-muted-foreground">Status *</label>
                              <select
                                value={editFormData.status}
                                onChange={(e) => setEditFormData({ ...editFormData, status: e.target.value as 'active' | 'suspended' | 'inactive' })}
                                className={inputCls}
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
                            {renderInput('Broker of Record', editFormData.brokerOfRecordName, (v) => setEditFormData({ ...editFormData, brokerOfRecordName: v }), { placeholder: 'Full legal name' })}
                            {renderInput('Broker of Record Email', editFormData.brokerOfRecordEmail, (v) => setEditFormData({ ...editFormData, brokerOfRecordEmail: v }), { placeholder: 'broker@brokerage.com', type: 'email' })}
                            <div>
                              <label className="block text-sm font-medium mb-2 text-muted-foreground">Brokerage Logo</label>
                              <div className="flex items-center gap-3">
                                {editFormData.logoUrl && <img src={editFormData.logoUrl} alt="Logo" className="h-10 w-auto rounded bg-muted" />}
                                <label className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold cursor-pointer transition-colors bg-input border border-border text-foreground hover:bg-muted ${uploadingLogo ? 'opacity-50' : ''}`}>
                                  <Upload size={14} />
                                  {uploadingLogo ? 'Uploading...' : editFormData.logoUrl ? 'Replace Logo' : 'Upload Logo'}
                                  <input type="file" accept="image/jpeg,image/png,image/svg+xml,image/webp" className="hidden" disabled={uploadingLogo}
                                    onChange={(e) => { const f = e.target.files?.[0]; if (f && editingBrokerageId) handleLogoUpload(f, editingBrokerageId, false); e.target.value = '' }} />
                                </label>
                                {editFormData.logoUrl && (
                                  <button type="button" onClick={() => setEditFormData(prev => ({ ...prev, logoUrl: '' }))}
                                    className="text-xs text-muted-foreground hover:text-foreground">Remove</button>
                                )}
                              </div>
                              <p className="text-[10px] mt-1 text-muted-foreground/60">JPEG, PNG, SVG, or WebP. Max 2MB.</p>
                            </div>
                          </div>
                          <div>
                            <label className="block text-sm font-medium mb-2 text-muted-foreground">Notes</label>
                            <textarea value={editFormData.notes} onChange={(e) => setEditFormData({ ...editFormData, notes: e.target.value })}
                              rows={3} className="w-full px-4 py-2 rounded-lg text-sm bg-input border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary resize-none transition-colors" />
                          </div>
                          <div className="flex gap-3 pt-2">
                            <Button type="button" variant="outline" className="flex-1" onClick={() => setEditingBrokerageId(null)}>
                              Cancel
                            </Button>
                            <Button type="submit" disabled={submitting} className="flex-1 bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
                              {submitting ? 'Saving...' : 'Save Changes'}
                            </Button>
                          </div>
                        </form>
                      ) : (
                        <div className="px-6 py-4 grid grid-cols-2 md:grid-cols-4 gap-4 text-sm border-b border-border/50">
                          <div>
                            <p className="text-xs font-semibold uppercase tracking-wider mb-1 text-muted-foreground">Address</p>
                            <p className="text-foreground">{brokerage.address || '—'}</p>
                          </div>
                          <div>
                            <p className="text-xs font-semibold uppercase tracking-wider mb-1 text-muted-foreground">Phone</p>
                            <p className="text-foreground">{brokerage.phone || '—'}</p>
                          </div>
                          <div>
                            <p className="text-xs font-semibold uppercase tracking-wider mb-1 text-muted-foreground">Transaction System</p>
                            <p className="text-foreground">{brokerage.transaction_system || '—'}</p>
                          </div>
                          <div>
                            <p className="text-xs font-semibold uppercase tracking-wider mb-1 text-muted-foreground">Notes</p>
                            <p className="text-foreground">{brokerage.notes || '—'}</p>
                          </div>
                          <div>
                            <p className="text-xs font-semibold uppercase tracking-wider mb-1 text-muted-foreground">Broker of Record</p>
                            <p className="text-foreground">{brokerage.broker_of_record_name || '—'}</p>
                            {brokerage.broker_of_record_email && (
                              <p className="text-xs mt-0.5 text-muted-foreground">{brokerage.broker_of_record_email}</p>
                            )}
                          </div>
                        </div>
                      )}

                      {/* FINTRAC KYC Verification */}
                      <div className="px-6 py-4 border-b border-border/50">
                        <div className="flex items-center gap-2 mb-3">
                          <Shield size={15} className={(brokerage as any).kyc_verified ? 'text-primary' : 'text-primary'} />
                          <h4 className="text-sm font-bold text-foreground">
                            FINTRAC — RECO Verification
                          </h4>
                          {(brokerage as any).kyc_verified && (
                            <span className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs font-semibold rounded ml-2 ${getKycBadgeClass('verified')}`}>
                              <CheckCircle size={11} /> Verified
                            </span>
                          )}
                        </div>

                        {(brokerage as any).kyc_verified ? (
                          /* Verified state — show verification details */
                          <div className="space-y-2">
                            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                              <div>
                                <p className="text-xs font-semibold uppercase tracking-wider mb-1 text-muted-foreground">RECO Reg #</p>
                                <p className="text-foreground">{(brokerage as any).reco_registration_number || '—'}</p>
                              </div>
                              <div>
                                <p className="text-xs font-semibold uppercase tracking-wider mb-1 text-muted-foreground">Verified On</p>
                                <p className="text-foreground">
                                  {(brokerage as any).reco_verification_date
                                    ? new Date((brokerage as any).reco_verification_date).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' })
                                    : '—'}
                                </p>
                              </div>
                              <div>
                                <p className="text-xs font-semibold uppercase tracking-wider mb-1 text-muted-foreground">Verified By</p>
                                <p className="text-foreground">{(brokerage as any).kyc_verified_by || '—'}</p>
                              </div>
                              <div>
                                <p className="text-xs font-semibold uppercase tracking-wider mb-1 text-muted-foreground">Notes</p>
                                <p className="text-foreground">{(brokerage as any).reco_verification_notes || '—'}</p>
                              </div>
                            </div>
                            <button
                              onClick={async () => {
                                if (!confirm('Revoke KYC verification for this brokerage? This will require re-verification.')) return
                                setKycSubmitting(true)
                                const result = await revokeBrokerageKyc({ brokerageId: brokerage.id })
                                if (result.success) {
                                  setStatusMessage({ type: 'success', text: 'KYC verification revoked' })
                                  await loadBrokerages()
                                } else {
                                  setStatusMessage({ type: 'error', text: result.error || 'Failed to revoke KYC' })
                                }
                                setKycSubmitting(false)
                              }}
                              disabled={kycSubmitting}
                              className="text-xs px-3 py-1 rounded transition-colors mt-1 bg-red-950/50 text-red-400 border border-red-800 hover:bg-red-950/70 disabled:opacity-50"
                            >
                              Revoke Verification
                            </button>
                          </div>
                        ) : (
                          /* Not verified — show verification form */
                          <div className="space-y-3">
                            <p className="text-xs text-muted-foreground">
                              Verify this brokerage on the RECO Public Register, then record the verification below.
                            </p>
                            <a
                              href={RECO_PUBLIC_REGISTER_URL}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-opacity hover:opacity-85"
                              style={{ background: 'var(--status-blue-muted)', color: 'var(--status-blue)', border: '1px solid var(--status-blue-border)' }}
                            >
                              <ExternalLink size={12} /> Open RECO Public Register
                            </a>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                              <div>
                                <label className="block text-xs font-medium mb-1 text-muted-foreground">RECO Registration Number *</label>
                                <input
                                  type="text"
                                  value={kycRecoNumber}
                                  onChange={(e) => setKycRecoNumber(e.target.value)}
                                  placeholder="e.g. 12345"
                                  className={inputCls}
                                />
                              </div>
                              <div>
                                <label className="block text-xs font-medium mb-1 text-muted-foreground">Verification Notes</label>
                                <input
                                  type="text"
                                  value={kycNotes}
                                  onChange={(e) => setKycNotes(e.target.value)}
                                  placeholder="e.g. Confirmed active on RECO register"
                                  className={inputCls}
                                />
                              </div>
                            </div>
                            <button
                              onClick={async () => {
                                if (!kycRecoNumber.trim()) { setStatusMessage({ type: 'error', text: 'RECO registration number is required' }); return }
                                setKycSubmitting(true)
                                const result = await verifyBrokerageKyc({
                                  brokerageId: brokerage.id,
                                  recoRegistrationNumber: kycRecoNumber,
                                  verificationNotes: kycNotes,
                                })
                                if (result.success) {
                                  setStatusMessage({ type: 'success', text: `${brokerage.name} KYC verified successfully` })
                                  setKycRecoNumber('')
                                  setKycNotes('')
                                  await loadBrokerages()
                                } else {
                                  setStatusMessage({ type: 'error', text: result.error || 'Verification failed' })
                                }
                                setKycSubmitting(false)
                              }}
                              disabled={kycSubmitting || !kycRecoNumber.trim()}
                              className="flex items-center gap-2 text-xs font-semibold px-4 py-2 rounded-lg transition-colors disabled:opacity-50 bg-primary text-primary-foreground hover:bg-primary/90"
                            >
                              <CheckCircle size={13} /> {kycSubmitting ? 'Verifying...' : 'Mark as KYC Verified'}
                            </button>
                          </div>
                        )}
                      </div>

                      {/* Brokerage Documents */}
                      <div className="px-6 py-4 border-b border-border/50">
                        <div className="flex items-center justify-between mb-3">
                          <div className="flex items-center gap-2">
                            <FileText size={15} className="text-primary" />
                            <h4 className="text-sm font-bold text-foreground">
                              Documents
                              <span className="font-normal ml-1.5 text-muted-foreground">
                                ({(brokerageDocs[brokerage.id] || []).length})
                              </span>
                            </h4>
                          </div>
                          <div className="flex items-center gap-2">
                            <select
                              id={`brokDocType-${brokerage.id}`}
                              className="text-xs px-2 py-1 rounded border border-border bg-input text-foreground focus:outline-none focus:border-primary"
                              defaultValue="cooperation_agreement"
                            >
                              {BROKERAGE_DOC_TYPES.map(dt => (
                                <option key={dt.value} value={dt.value}>{dt.label}</option>
                              ))}
                            </select>
                            <label
                              className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors cursor-pointer bg-primary text-primary-foreground hover:bg-primary/90"
                            >
                              <Upload size={13} /> Upload
                              <input
                                type="file"
                                accept=".pdf,.doc,.docx,.jpg,.jpeg,.png"
                                className="hidden"
                                disabled={uploadingBrokerageDoc}
                                onChange={(e) => {
                                  const select = document.getElementById(`brokDocType-${brokerage.id}`) as HTMLSelectElement
                                  handleBrokerageDocUpload(e, brokerage.id, select?.value || 'cooperation_agreement')
                                }}
                              />
                            </label>
                          </div>
                        </div>
                        {(brokerageDocs[brokerage.id] || []).length > 0 ? (
                          <div className="space-y-1.5">
                            {(brokerageDocs[brokerage.id] || []).map(doc => (
                              <div key={doc.id} className="flex items-center justify-between px-3 py-2 rounded-lg bg-input border border-border">
                                <div className="flex items-center gap-2 min-w-0">
                                  <FileText size={14} className="text-primary" />
                                  <div className="min-w-0">
                                    <p className="text-sm font-medium truncate text-foreground">{doc.file_name}</p>
                                    <p className="text-xs text-muted-foreground">
                                      {BROKERAGE_DOC_TYPES.find(d => d.value === doc.document_type)?.label || doc.document_type}
                                      {' \u2022 '}{new Date(doc.created_at).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' })}
                                    </p>
                                  </div>
                                </div>
                                <div className="flex items-center gap-1.5 flex-shrink-0">
                                  <button onClick={() => handleBrokerageDocView(doc)} className="px-2 py-1 rounded text-xs font-medium transition bg-primary text-primary-foreground hover:bg-primary/90">
                                    <Eye size={13} />
                                  </button>
                                  <button onClick={() => handleBrokerageDocDelete(doc, brokerage.id)} className="px-2 py-1 rounded text-xs font-medium transition bg-red-950/50 text-red-400 hover:bg-red-950/70">
                                    <Trash2 size={13} />
                                  </button>
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <p className="text-xs text-muted-foreground">No documents uploaded. Upload the signed Brokerage Cooperation Agreement and other onboarding docs here.</p>
                        )}
                      </div>

                      {/* Agent Roster */}
                      <div className="px-6 py-4">
                        <div className="flex items-center justify-between mb-4">
                          <div className="flex items-center gap-2">
                            <Users size={15} className="text-primary" />
                            <h4 className="text-sm font-bold text-foreground">
                              Agent Roster
                              <span className="font-normal ml-1.5 text-muted-foreground">
                                ({activeAgents} active{nonArchivedAgents.length !== activeAgents ? `, ${nonArchivedAgents.length} total` : ''}{archivedAgents.length > 0 ? `, ${archivedAgents.length} archived` : ''})
                              </span>
                            </h4>
                            {archivedAgents.length > 0 && (
                              <button
                                onClick={() => setShowArchived(!showArchived)}
                                className="flex items-center gap-1 text-xs px-2 py-1 rounded-md transition-colors text-muted-foreground border border-border hover:bg-muted"
                              >
                                {showArchived ? <EyeOff size={11} /> : <Eye size={11} />}
                                {showArchived ? 'Hide Archived' : 'Show Archived'}
                              </button>
                            )}
                          </div>
                          {showAddAgentFor !== brokerage.id && (
                            <div className="flex items-center gap-2 flex-wrap">
                              <button
                                onClick={() => { setShowAddAgentFor(brokerage.id); setAgentForm(emptyAgentForm) }}
                                className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors text-primary border border-border hover:bg-muted hover:border-primary"
                              >
                                <UserPlus size={13} /> Add Agent
                              </button>
                              <label
                                className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors cursor-pointer text-primary border border-border hover:bg-muted hover:border-primary"
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
                                className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors text-muted-foreground border border-border hover:bg-muted hover:text-foreground"
                                title="Download template spreadsheet"
                              >
                                <Download size={13} /> Template
                              </button>
                              <button
                                onClick={() => handleSendWelcomeToAll(brokerage.id, brokerage.name)}
                                disabled={sendingAllFor === brokerage.id}
                                className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors text-primary border border-border hover:bg-muted hover:border-primary disabled:opacity-60"
                                title="Send welcome email with magic link to all agents in this brokerage"
                              >
                                <Mail size={13} /> {sendingAllFor === brokerage.id ? 'Sending...' : 'Send Welcome to All'}
                              </button>
                              <button
                                onClick={() => handleLoadUserProfiles(brokerage.id)}
                                disabled={loadingUserProfiles === brokerage.id}
                                className={`flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors border disabled:opacity-60 ${
                                  showUserManagement === brokerage.id
                                    ? 'bg-primary text-primary-foreground border-primary'
                                    : 'text-primary border-border hover:bg-muted hover:border-primary'
                                }`}
                                title="Manage brokerage admin logins"
                              >
                                <KeyRound size={13} /> {loadingUserProfiles === brokerage.id ? 'Loading...' : 'Manage Logins'}
                              </button>
                            </div>
                          )}
                        </div>

                        {/* Brokerage Admin Login Management Panel */}
                        {showUserManagement === brokerage.id && brokerageUserProfiles[brokerage.id] && (
                          <div className="mb-4 p-4 rounded-lg bg-blue-950/20 border border-blue-800/50">
                            <h4 className="text-xs font-bold uppercase tracking-wider mb-3 flex items-center gap-2 text-blue-400">
                              <KeyRound size={14} /> Brokerage Admin Login{brokerageUserProfiles[brokerage.id].brokerageAdmins.length !== 1 ? 's' : ''}
                            </h4>
                            {brokerageUserProfiles[brokerage.id].brokerageAdmins.length === 0 ? (
                              <div>
                                {!showCreateBrokerageLogin ? (
                                  <div className="flex items-center justify-between">
                                    <p className="text-xs text-muted-foreground">No brokerage admin login found.</p>
                                    <button
                                      onClick={() => { setShowCreateBrokerageLogin(true); setBrokerageLoginForm({ fullName: '', email: brokerage.email || '' }) }}
                                      className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-md transition-colors bg-primary text-primary-foreground hover:bg-primary/90"
                                    >
                                      <Plus size={13} /> Create Login
                                    </button>
                                  </div>
                                ) : (
                                  <div className="p-3 rounded-lg space-y-3 bg-card border border-border">
                                    <div className="flex items-center justify-between">
                                      <p className="text-xs font-bold uppercase tracking-wider text-primary">Create Brokerage Admin Login</p>
                                      <button onClick={() => setShowCreateBrokerageLogin(false)} className="text-muted-foreground hover:text-foreground"><X size={14} /></button>
                                    </div>
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                      <div>
                                        <label className="block text-[10px] font-semibold mb-0.5 text-muted-foreground">Full Name *</label>
                                        <input
                                          type="text" value={brokerageLoginForm.fullName}
                                          onChange={(e) => setBrokerageLoginForm({ ...brokerageLoginForm, fullName: e.target.value })}
                                          className="w-full rounded-md px-2 py-1.5 text-xs bg-input border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary" placeholder="e.g. John Smith"
                                        />
                                      </div>
                                      <div>
                                        <label className="block text-[10px] font-semibold mb-0.5 text-muted-foreground">Email *</label>
                                        <input
                                          type="email" value={brokerageLoginForm.email}
                                          onChange={(e) => setBrokerageLoginForm({ ...brokerageLoginForm, email: e.target.value })}
                                          className="w-full rounded-md px-2 py-1.5 text-xs bg-input border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary" placeholder="admin@brokerage.com"
                                        />
                                      </div>
                                    </div>
                                    <div className="flex items-center gap-2">
                                      <button
                                        onClick={() => handleCreateBrokerageLogin(brokerage.id, brokerage.name)}
                                        disabled={creatingBrokerageLogin || !brokerageLoginForm.fullName.trim() || !brokerageLoginForm.email.trim()}
                                        className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-md disabled:opacity-50 bg-primary text-primary-foreground hover:bg-primary/90"
                                      >
                                        <Mail size={13} /> {creatingBrokerageLogin ? 'Sending...' : 'Create Login & Send Setup Link'}
                                      </button>
                                      <button
                                        onClick={() => setShowCreateBrokerageLogin(false)}
                                        className="text-xs px-3 py-1.5 rounded-md text-muted-foreground border border-border hover:bg-muted"
                                      >
                                        Cancel
                                      </button>
                                    </div>
                                    <p className="text-[10px] text-muted-foreground/60">
                                      <Mail size={10} className="inline mr-1" style={{ verticalAlign: 'middle' }} />
                                      A branded setup email will be sent with a magic link. They&apos;ll set their own password — no credentials to share.
                                    </p>
                                  </div>
                                )}
                              </div>
                            ) : (
                              <div className="space-y-2">
                                {brokerageUserProfiles[brokerage.id].brokerageAdmins.map((admin: any) => (
                                  <div key={admin.id} className="flex items-center justify-between gap-3 p-3 rounded-lg bg-card border border-border/50">
                                    <div className="flex-1 min-w-0">
                                      <p className="text-sm font-medium truncate text-foreground">{admin.full_name}</p>
                                      <p className="text-xs truncate text-muted-foreground">{admin.email}</p>
                                      <p className="text-[10px] text-muted-foreground/60">
                                        Last login: {admin.last_login ? new Date(admin.last_login).toLocaleString('en-CA') : 'Never'}
                                      </p>
                                    </div>
                                    <div className="flex items-center gap-1.5">
                                      <button
                                        onClick={() => handleResetPassword(admin.id, admin.full_name, 'user')}
                                        disabled={resettingPasswordForUserId === admin.id}
                                        className="flex items-center gap-1 text-xs font-semibold px-2.5 py-1.5 rounded-md transition-colors disabled:opacity-50 bg-yellow-950/50 text-yellow-400 border border-yellow-800 hover:bg-yellow-950/70"
                                      >
                                        <KeyRound size={12} /> Reset Password
                                      </button>
                                      <button
                                        onClick={() => { setChangingEmailForUserId(changingEmailForUserId === admin.id ? null : admin.id); setChangeEmailValue(admin.email) }}
                                        className={`flex items-center gap-1 text-xs font-semibold px-2.5 py-1.5 rounded-md transition-colors border ${
                                          changingEmailForUserId === admin.id
                                            ? 'bg-primary/20 text-blue-400 border-primary'
                                            : 'text-blue-400 bg-card border-border hover:bg-blue-950/30'
                                        }`}
                                      >
                                        <AtSign size={12} /> Change Email
                                      </button>
                                      <button
                                        onClick={() => handleResendSetupLink(admin.id, admin.full_name)}
                                        disabled={resendingSetupLink === admin.id}
                                        className="flex items-center gap-1 text-xs font-semibold px-2.5 py-1.5 rounded-md transition-colors disabled:opacity-50 text-primary bg-card border border-border hover:bg-muted hover:border-primary"
                                      >
                                        <Mail size={12} /> {resendingSetupLink === admin.id ? 'Sending...' : 'Resend Setup Link'}
                                      </button>
                                    </div>
                                  </div>
                                ))}
                                {/* Inline email change for brokerage admin */}
                                {brokerageUserProfiles[brokerage.id].brokerageAdmins.some((a: any) => changingEmailForUserId === a.id) && (
                                  <div className="flex items-center gap-2 p-2 rounded-lg bg-card border border-border">
                                    <input
                                      type="email"
                                      value={changeEmailValue}
                                      onChange={(e) => setChangeEmailValue(e.target.value)}
                                      className="rounded-md px-2 py-1 text-xs flex-1 bg-input border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary"
                                      placeholder="New login email"
                                    />
                                    <button
                                      onClick={() => {
                                        const admin = brokerageUserProfiles[brokerage.id].brokerageAdmins.find((a: any) => a.id === changingEmailForUserId)
                                        if (admin) handleChangeEmail(admin.id, admin.full_name, 'user', brokerage.id)
                                      }}
                                      disabled={changingEmailSaving || !changeEmailValue.trim()}
                                      className="text-xs font-semibold px-3 py-1 rounded-md disabled:opacity-50 bg-primary text-primary-foreground hover:bg-primary/90"
                                    >
                                      {changingEmailSaving ? 'Saving...' : 'Save'}
                                    </button>
                                    <button
                                      onClick={() => { setChangingEmailForUserId(null); setChangeEmailValue('') }}
                                      className="text-xs px-2 py-1 rounded-md text-muted-foreground hover:text-foreground"
                                    >
                                      Cancel
                                    </button>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        )}

                        {/* Add Agent Form */}
                        {showAddAgentFor === brokerage.id && (
                          <form onSubmit={(e) => handleAddAgent(e, brokerage.id)}
                            className="mb-4 p-4 rounded-lg space-y-3 bg-background border border-border"
                          >
                            <div className="flex items-center justify-between">
                              <p className="text-xs font-bold uppercase tracking-wider text-primary">New Agent</p>
                              <button type="button" onClick={() => setShowAddAgentFor(null)} className="text-muted-foreground hover:text-foreground">
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
                            <div className="flex items-center gap-2 pt-1">
                              <input
                                type="checkbox"
                                id={`invite-${brokerage.id}`}
                                checked={sendInvite}
                                onChange={(e) => setSendInvite(e.target.checked)}
                                className="rounded accent-primary"
                              />
                              <label htmlFor={`invite-${brokerage.id}`} className="text-xs font-medium cursor-pointer text-foreground">
                                Create login
                              </label>
                              <span className="text-xs text-muted-foreground">
                                {sendInvite ? '(login created — send welcome email later)' : '(roster only — no login)'}
                              </span>
                            </div>
                            <div className="flex gap-3 pt-1">
                              <Button type="button" variant="outline" onClick={() => { setShowAddAgentFor(null); setSendInvite(true) }}>
                                Cancel
                              </Button>
                              <Button type="submit" disabled={submitting} className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
                                {submitting ? (sendInvite ? 'Creating...' : 'Adding...') : (sendInvite ? 'Add Agent + Login' : 'Add Agent')}
                              </Button>
                            </div>
                          </form>
                        )}

                        {/* Import Results */}
                        {importingFor === brokerage.id && importResult && (
                          <div className="mb-4 p-4 rounded-lg space-y-2 bg-background border border-border">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-2">
                                <FileSpreadsheet size={15} className="text-primary" />
                                <p className="text-sm font-bold text-foreground">
                                  Import Results
                                </p>
                              </div>
                              <button onClick={() => { setImportResult(null); setImportingFor(null) }}
                                className="text-muted-foreground hover:text-foreground"><X size={14} /></button>
                            </div>
                            <div className="flex gap-4 text-sm">
                              <span className="text-green-400">{importResult.imported} imported</span>
                              {importResult.skipped > 0 && (
                                <span className="text-yellow-400">{importResult.skipped} skipped</span>
                              )}
                            </div>
                            {importResult.errors.length > 0 && (
                              <div className="text-xs space-y-1 max-h-32 overflow-y-auto mt-2 p-2 rounded bg-card border border-border">
                                {importResult.errors.map((err, i) => (
                                  <p key={i} className="text-yellow-400">{err}</p>
                                ))}
                              </div>
                            )}
                          </div>
                        )}

                        {/* Agent List */}
                        {agentCount === 0 ? (
                          <p className="text-sm py-4 text-center text-muted-foreground">
                            No agents registered yet.
                          </p>
                        ) : (
                          <div className="overflow-x-auto rounded-lg border border-border">
                            <table className="w-full">
                              <thead>
                                <tr className="bg-muted/50">
                                  <th className="px-4 py-2.5 text-left text-xs font-bold uppercase tracking-wider text-muted-foreground">Name</th>
                                  <th className="px-4 py-2.5 text-left text-xs font-bold uppercase tracking-wider text-muted-foreground">Email</th>
                                  <th className="px-4 py-2.5 text-left text-xs font-bold uppercase tracking-wider text-muted-foreground">Phone</th>
                                  <th className="px-4 py-2.5 text-left text-xs font-bold uppercase tracking-wider text-muted-foreground">RECO #</th>
                                  <th className="px-4 py-2.5 text-left text-xs font-bold uppercase tracking-wider text-muted-foreground">Status</th>
                                  <th className="px-4 py-2.5 text-left text-xs font-bold uppercase tracking-wider text-muted-foreground">KYC</th>
                                  <th className="px-4 py-2.5 text-right text-xs font-bold uppercase tracking-wider text-muted-foreground"></th>
                                </tr>
                              </thead>
                              <tbody>
                                {visibleAgents
                                  .sort((a, b) => a.last_name.localeCompare(b.last_name))
                                  .map((agent, idx) => {
                                    const isAgentMatch = q && (
                                      `${agent.first_name} ${agent.last_name}`.toLowerCase().includes(q) ||
                                      agent.email.toLowerCase().includes(q)
                                    )
                                    const isEditingAgent = editingAgentId === agent.id

                                    if (isEditingAgent) {
                                      return (
                                        <tr key={agent.id} className="bg-primary/5 border-b border-border">
                                          <td className="px-3 py-2" colSpan={7}>
                                            <form onSubmit={(e) => handleEditAgentSubmit(e, agent.id, brokerage.id)} className="space-y-3">
                                              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
                                                <div>
                                                  <label className="block text-xs font-semibold mb-1 text-muted-foreground">First Name *</label>
                                                  <input value={editAgentForm.firstName} onChange={(e) => setEditAgentForm({ ...editAgentForm, firstName: e.target.value })}
                                                    className={inputCls} />
                                                </div>
                                                <div>
                                                  <label className="block text-xs font-semibold mb-1 text-muted-foreground">Last Name *</label>
                                                  <input value={editAgentForm.lastName} onChange={(e) => setEditAgentForm({ ...editAgentForm, lastName: e.target.value })}
                                                    className={inputCls} />
                                                </div>
                                                <div>
                                                  <label className="block text-xs font-semibold mb-1 text-muted-foreground">Email *</label>
                                                  <input type="email" value={editAgentForm.email} onChange={(e) => setEditAgentForm({ ...editAgentForm, email: e.target.value })}
                                                    className={inputCls} />
                                                </div>
                                                <div>
                                                  <label className="block text-xs font-semibold mb-1 text-muted-foreground">Phone</label>
                                                  <input value={editAgentForm.phone} onChange={(e) => setEditAgentForm({ ...editAgentForm, phone: e.target.value })}
                                                    className={inputCls} />
                                                </div>
                                                <div>
                                                  <label className="block text-xs font-semibold mb-1 text-muted-foreground">RECO #</label>
                                                  <input value={editAgentForm.recoNumber} onChange={(e) => setEditAgentForm({ ...editAgentForm, recoNumber: e.target.value })}
                                                    className={inputCls} />
                                                </div>
                                              </div>
                                              <div className="flex items-center gap-4">
                                                <div className="flex items-center gap-2">
                                                  <label className="text-xs font-semibold text-muted-foreground">Status:</label>
                                                  <select value={editAgentForm.status} onChange={(e) => setEditAgentForm({ ...editAgentForm, status: e.target.value })}
                                                    className="px-2 py-1 rounded text-xs bg-input border border-border text-foreground focus:outline-none focus:border-primary">
                                                    <option value="active">Active</option>
                                                    <option value="suspended">Suspended</option>
                                                    <option value="archived">Archived</option>
                                                  </select>
                                                </div>
                                                <label className="flex items-center gap-1.5 text-xs cursor-pointer text-muted-foreground">
                                                  <input type="checkbox" checked={editAgentForm.flaggedByBrokerage}
                                                    onChange={(e) => setEditAgentForm({ ...editAgentForm, flaggedByBrokerage: e.target.checked })} />
                                                  Flagged by Brokerage
                                                </label>
                                                <div className="flex items-center gap-1.5">
                                                  <label className="text-xs font-semibold text-muted-foreground">Recovery $:</label>
                                                  <input type="number" step="0.01" min="0" value={editAgentForm.outstandingRecovery}
                                                    onChange={(e) => setEditAgentForm({ ...editAgentForm, outstandingRecovery: e.target.value })}
                                                    className="w-24 px-2 py-1 rounded text-xs bg-input border border-border text-foreground focus:outline-none focus:border-primary" />
                                                </div>
                                                <div className="flex-1" />
                                                <button type="button" onClick={() => setEditingAgentId(null)}
                                                  className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors text-muted-foreground border border-border hover:bg-muted">
                                                  Cancel
                                                </button>
                                                <button type="submit" disabled={submitting}
                                                  className="px-3 py-1.5 rounded-lg text-xs font-semibold text-white transition-colors disabled:opacity-50 bg-primary hover:bg-primary/90">
                                                  {submitting ? 'Saving...' : 'Save'}
                                                </button>
                                              </div>
                                            </form>
                                          </td>
                                        </tr>
                                      )
                                    }

                                    const needsAction = agent.kyc_status === 'submitted' || agent.banking_approval_status === 'pending'
                                    return [
                                      <tr key={agent.id}
                                        className={`transition-colors ${isAgentMatch ? 'bg-primary/5 border-l-2 border-l-primary' : needsAction ? 'bg-amber-500/5 border-l-2 border-l-amber-500' : 'hover:bg-muted/20'} ${idx < agentCount - 1 ? 'border-b border-border' : ''}`}
                                      >
                                        <td className="px-4 py-3 text-sm font-medium text-foreground">
                                          <button
                                            onClick={() => handleExpandAgent(agent.id)}
                                            className="flex items-center gap-2 cursor-pointer transition-colors text-primary hover:underline"
                                            title="Click to view deals"
                                          >
                                            <span>{agent.first_name} {agent.last_name}</span>
                                            {expandedAgentId === agent.id && <ChevronDown size={14} />}
                                            {expandedAgentId !== agent.id && <ChevronRight size={14} />}
                                          </button>
                                          {agent.flagged_by_brokerage && (
                                            <span className="inline-block text-xs px-1.5 py-0.5 rounded font-semibold mt-1 bg-red-950/50 text-red-400 border border-red-800">
                                              Flagged
                                            </span>
                                          )}
                                          {agent.kyc_status === 'submitted' && (
                                            <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded font-bold mt-1 bg-amber-500/15 text-amber-400 border border-amber-500/30">
                                              <Shield size={9} /> ID needs review
                                            </span>
                                          )}
                                          {agent.banking_approval_status === 'pending' && (
                                            <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded font-bold mt-1 bg-blue-500/15 text-blue-400 border border-blue-500/30">
                                              <CreditCard size={9} /> Banking needs review
                                            </span>
                                          )}
                                        </td>
                                        <td className="px-4 py-3 text-sm text-muted-foreground">{agent.email}</td>
                                        <td className="px-4 py-3 text-sm text-muted-foreground">{agent.phone || '—'}</td>
                                        <td className="px-4 py-3 text-sm text-muted-foreground">{agent.reco_number || '—'}</td>
                                        <td className="px-4 py-3">
                                          <span className={`inline-flex px-2 py-0.5 text-xs font-semibold rounded ${getLocalStatusBadgeClass(agent.status)}`}>
                                            {agent.status.charAt(0).toUpperCase() + agent.status.slice(1)}
                                          </span>
                                        </td>
                                        <td className="px-4 py-3">
                                          {(() => {
                                            const kycStatus = agent.kyc_status || 'pending'
                                            const kycBadgeClass = getKycBadgeClass(kycStatus)
                                            return (
                                              <div className="flex flex-col gap-1">
                                                <span className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs font-semibold rounded w-fit ${kycBadgeClass}`}
                                                >
                                                  <Shield size={10} />
                                                  {kycStatus === 'pending' ? 'Pending' : kycStatus === 'submitted' ? 'Submitted' : kycStatus === 'verified' ? 'Verified' : 'Rejected'}
                                                </span>
                                                {kycStatus === 'submitted' && (
                                                  <div className="flex flex-col gap-1.5 mt-1.5">
                                                    {/* VIEW ID — large button */}
                                                    <button
                                                      onClick={async (e) => {
                                                        e.stopPropagation()
                                                        setKycPreviewLoading(agent.id)
                                                        const urlRes = await getAgentKycDocumentUrl({ agentId: agent.id })
                                                        if (urlRes.success && urlRes.data?.urls) {
                                                          const urls: string[] = urlRes.data.urls
                                                          try {
                                                            // Fetch all as blobs to bypass content-blocking headers
                                                            const blobUrls: string[] = []
                                                            for (const url of urls) {
                                                              const response = await fetch(url)
                                                              const arrayBuffer = await response.arrayBuffer()
                                                              const mimeType = response.headers.get('content-type') || 'image/png'
                                                              const blob = new Blob([arrayBuffer], { type: mimeType })
                                                              blobUrls.push(URL.createObjectURL(blob))
                                                            }
                                                            if (kycPreviewPanel) {
                                                              for (const u of kycPreviewPanel.blobUrls) URL.revokeObjectURL(u)
                                                            }
                                                            setKycPreviewPanel({
                                                              blobUrls,
                                                              originalUrls: urls,
                                                              fileName: `${agent.first_name}_${agent.last_name}_ID`,
                                                              agentName: `${agent.first_name} ${agent.last_name}`,
                                                              agentId: agent.id,
                                                            })
                                                          } catch {
                                                            window.open(urls[0], '_blank')
                                                          }
                                                        } else {
                                                          setStatusMessage({ type: 'error', text: urlRes.error || 'Failed to load ID' })
                                                        }
                                                        setKycPreviewLoading(null)
                                                      }}
                                                      disabled={kycPreviewLoading === agent.id}
                                                      className="flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-all disabled:opacity-50 hover:opacity-90"
                                                      style={{ color: 'var(--status-blue)', background: 'var(--status-blue-muted)', border: '1px solid var(--status-blue-border)' }}
                                                    >
                                                      <Eye size={13} />
                                                      {kycPreviewLoading === agent.id ? 'Loading...' : 'View ID'}
                                                    </button>
                                                    {/* APPROVE / REJECT row */}
                                                    <div className="flex items-center gap-1.5">
                                                      <button
                                                        onClick={async (e) => {
                                                          e.stopPropagation()
                                                          setKycSubmitting(true)
                                                          const result = await verifyAgentKyc({ agentId: agent.id })
                                                          if (result.success) {
                                                            setStatusMessage({ type: 'success', text: `${agent.first_name} ${agent.last_name} KYC verified` })
                                                            setKycPreviewPanel(null)
                                                            await loadBrokerages()
                                                          } else {
                                                            setStatusMessage({ type: 'error', text: result.error || 'Verification failed' })
                                                          }
                                                          setKycSubmitting(false)
                                                        }}
                                                        disabled={kycSubmitting}
                                                        className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-bold transition-all disabled:opacity-50 text-white hover:opacity-90"
                                                        style={{ background: 'var(--action-green)', border: '1px solid var(--action-green-border)' }}
                                                      >
                                                        <CheckCircle size={13} />
                                                        Approve
                                                      </button>
                                                      <button
                                                        onClick={(e) => {
                                                          e.stopPropagation()
                                                          setKycRejectingAgentId(agent.id)
                                                          setKycRejectReason('')
                                                        }}
                                                        className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-bold transition-all text-white hover:opacity-90"
                                                        style={{ background: 'var(--action-red)', border: '1px solid var(--action-red-border)' }}
                                                      >
                                                        <XCircle size={13} />
                                                        Reject
                                                      </button>
                                                    </div>
                                                  </div>
                                                )}
                                                {kycRejectingAgentId === agent.id && (
                                                  <div className="flex flex-col gap-1.5 mt-1.5" onClick={(e) => e.stopPropagation()}>
                                                    <input
                                                      type="text"
                                                      value={kycRejectReason}
                                                      onChange={(e) => setKycRejectReason(e.target.value)}
                                                      placeholder="Reason for rejection..."
                                                      className="text-xs px-3 py-2 rounded-md bg-input border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary w-full"
                                                      autoFocus
                                                      onKeyDown={(e) => {
                                                        if (e.key === 'Escape') setKycRejectingAgentId(null)
                                                      }}
                                                    />
                                                    <div className="flex items-center gap-1.5">
                                                      <button
                                                        onClick={async () => {
                                                          if (!kycRejectReason.trim()) return
                                                          setKycSubmitting(true)
                                                          const result = await rejectAgentKyc({ agentId: agent.id, reason: kycRejectReason })
                                                          if (result.success) {
                                                            setStatusMessage({ type: 'success', text: `${agent.first_name} ${agent.last_name} KYC rejected` })
                                                            setKycRejectingAgentId(null)
                                                            await loadBrokerages()
                                                          } else {
                                                            setStatusMessage({ type: 'error', text: result.error || 'Rejection failed' })
                                                          }
                                                          setKycSubmitting(false)
                                                        }}
                                                        disabled={kycSubmitting || !kycRejectReason.trim()}
                                                        className="flex-1 flex items-center justify-center gap-1 px-3 py-1.5 rounded-md text-xs font-bold disabled:opacity-50 transition-all text-white hover:opacity-90"
                                                        style={{ background: 'var(--action-red)', border: '1px solid var(--action-red-border)' }}
                                                      >
                                                        Confirm Reject
                                                      </button>
                                                      <button
                                                        onClick={() => setKycRejectingAgentId(null)}
                                                        className="px-3 py-1.5 rounded-md text-xs transition-all text-muted-foreground border border-border hover:bg-muted"
                                                      >
                                                        Cancel
                                                      </button>
                                                    </div>
                                                  </div>
                                                )}
                                              </div>
                                            )
                                          })()}
                                        </td>
                                        <td className="px-4 py-3 text-right">
                                          <div className="flex items-center justify-end gap-1">
                                            <button
                                              onClick={() => openEditAgent(agent, brokerage.id)}
                                              className="text-xs px-2 py-1 rounded transition-colors text-muted-foreground hover:text-primary hover:bg-primary/10"
                                              title="Edit agent"
                                            >
                                              <Edit2 size={13} />
                                            </button>
                                            {agent.status !== 'archived' && (
                                              <button
                                                onClick={() => handleResendWelcome(agent.id, `${agent.first_name} ${agent.last_name}`)}
                                                disabled={resendingAgentId === agent.id}
                                                className="text-xs px-2 py-1 rounded transition-colors disabled:opacity-50 text-muted-foreground hover:text-green-400 hover:bg-green-950/30"
                                                title="Resend welcome email"
                                              >
                                                <Mail size={13} />
                                              </button>
                                            )}
                                            {agent.status !== 'archived' && (
                                              <button
                                                onClick={() => handleResetPassword(agent.id, `${agent.first_name} ${agent.last_name}`)}
                                                disabled={resettingPasswordForUserId === agent.id}
                                                className="text-xs px-2 py-1 rounded transition-colors disabled:opacity-50 text-muted-foreground hover:text-yellow-400 hover:bg-yellow-950/30"
                                                title="Reset password"
                                              >
                                                <KeyRound size={13} />
                                              </button>
                                            )}
                                            {agent.status !== 'archived' && (
                                              <button
                                                onClick={() => { setChangingEmailForUserId(changingEmailForUserId === agent.id ? null : agent.id); setChangeEmailValue(agent.email) }}
                                                className={`text-xs px-2 py-1 rounded transition-colors ${
                                                  changingEmailForUserId === agent.id ? 'text-primary' : 'text-muted-foreground hover:text-blue-400 hover:bg-blue-950/30'
                                                }`}
                                                title="Change login email"
                                              >
                                                <AtSign size={13} />
                                              </button>
                                            )}
                                            {agent.status !== 'archived' && (
                                              <button
                                                onClick={() => handleArchiveAgent(agent.id, `${agent.first_name} ${agent.last_name}`)}
                                                disabled={archivingAgentId === agent.id}
                                                className="text-xs px-2 py-1 rounded transition-colors disabled:opacity-50 text-muted-foreground hover:text-red-400 hover:bg-red-950/30"
                                                title="Archive agent"
                                              >
                                                <Archive size={13} />
                                              </button>
                                            )}
                                            {agent.status === 'archived' && (
                                              <button
                                                onClick={() => handlePermanentlyDeleteAgent(agent.id, `${agent.first_name} ${agent.last_name}`)}
                                                disabled={deletingAgentId === agent.id}
                                                className="flex items-center gap-1 text-xs px-2 py-1 rounded transition-colors disabled:opacity-50 bg-red-950/50 text-red-400 border border-red-800 hover:bg-red-950/70"
                                                title="Permanently delete agent and all associated data"
                                              >
                                                <Trash2 size={12} /> {deletingAgentId === agent.id ? 'Deleting...' : 'Delete'}
                                              </button>
                                            )}
                                          </div>
                                        </td>
                                      </tr>,
                                      // Inline email change row
                                      changingEmailForUserId === agent.id && (
                                        <tr key={`email-${agent.id}`} className="bg-blue-950/20 border-b border-border">
                                          <td colSpan={7} className="px-4 py-2">
                                            <div className="flex items-center gap-2 flex-wrap">
                                              <AtSign size={14} className="text-blue-400" />
                                              <span className="text-xs font-semibold text-blue-400">Change login email for {agent.first_name} {agent.last_name}:</span>
                                              <input
                                                type="email"
                                                value={changeEmailValue}
                                                onChange={(e) => setChangeEmailValue(e.target.value)}
                                                className="rounded-md px-2 py-1 text-xs flex-1 min-w-[200px] bg-input border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary"
                                                placeholder="New email address"
                                              />
                                              <button
                                                onClick={() => handleChangeEmail(agent.id, `${agent.first_name} ${agent.last_name}`)}
                                                disabled={changingEmailSaving || !changeEmailValue.trim() || changeEmailValue === agent.email}
                                                className="text-xs font-semibold px-3 py-1 rounded-md disabled:opacity-50 bg-primary text-primary-foreground hover:bg-primary/90"
                                              >
                                                {changingEmailSaving ? 'Saving...' : 'Save'}
                                              </button>
                                              <button
                                                onClick={() => { setChangingEmailForUserId(null); setChangeEmailValue('') }}
                                                className="text-xs px-2 py-1 rounded-md text-muted-foreground hover:text-foreground"
                                              >
                                                Cancel
                                              </button>
                                            </div>
                                          </td>
                                        </tr>
                                      ),
                                      // Expanded deals row
                                      expandedAgentId === agent.id && (
                                        <tr key={`deals-${agent.id}`} className={`bg-card ${idx < agentCount - 1 ? 'border-b border-border' : ''}`}>
                                          <td colSpan={7} className="px-4 py-4">
                                            <div style={{ marginLeft: '20px' }}>
                                              {/* Banking Information */}
                                              <div className="mb-5 p-3 rounded-lg bg-muted/20 border border-border">
                                                <div className="flex items-center justify-between mb-2">
                                                  <h4 className="text-xs font-semibold flex items-center gap-1.5 text-foreground">
                                                    <CreditCard size={13} className="text-primary" />
                                                    Banking Information
                                                  </h4>
                                                  <div className="flex items-center gap-2">
                                                    {agent.preauth_form_path && (
                                                      <button
                                                        onClick={async () => {
                                                          try {
                                                            setPreauthViewingAgentId(agent.id)
                                                            const { data } = await supabase.storage.from('agent-preauth-forms').createSignedUrl(agent.preauth_form_path!, 300)
                                                            if (data?.signedUrl) setPreauthViewUrl(data.signedUrl)
                                                          } catch { /* ignore */ }
                                                          setPreauthViewingAgentId(null)
                                                        }}
                                                        disabled={preauthViewingAgentId === agent.id}
                                                        className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors bg-input text-primary border border-border hover:bg-muted disabled:opacity-50"
                                                      >
                                                        <Eye size={12} />
                                                        {preauthViewingAgentId === agent.id ? 'Loading...' : 'View Pre-Auth Form'}
                                                      </button>
                                                    )}
                                                    {!agent.preauth_form_path && (
                                                      <span className="text-xs text-muted-foreground">No pre-auth form uploaded</span>
                                                    )}
                                                  </div>
                                                </div>
                                                {/* Pending banking approval banner */}
                                                {agent.banking_approval_status === 'pending' && agent.banking_submitted_transit && (
                                                  <div className="mb-2 rounded-lg p-3" style={{ background: 'var(--status-blue-muted)', border: '1px solid var(--status-blue-border)' }}>
                                                    <div className="flex items-center justify-between mb-2">
                                                      <div className="flex items-center gap-1.5">
                                                        <AlertCircle size={13} style={{ color: 'var(--status-blue)' }} />
                                                        <span className="text-xs font-semibold" style={{ color: 'var(--status-blue)' }}>Pending Approval</span>
                                                        <span className="text-[10px] text-muted-foreground">
                                                          Submitted {agent.banking_submitted_at ? new Date(agent.banking_submitted_at).toLocaleDateString('en-CA') : ''}
                                                        </span>
                                                      </div>
                                                    </div>
                                                    <div className="flex items-center gap-4 mb-2">
                                                      <span className="text-xs font-mono text-muted-foreground">
                                                        Transit: {agent.banking_submitted_transit} · Inst: {agent.banking_submitted_institution} · Acct: {agent.banking_submitted_account}
                                                      </span>
                                                    </div>
                                                    {bankingRejectingId === agent.id ? (
                                                      <div className="flex items-center gap-2 flex-wrap">
                                                        <input
                                                          type="text"
                                                          value={bankingRejectReason}
                                                          onChange={(e) => setBankingRejectReason(e.target.value)}
                                                          placeholder="Reason for rejection..."
                                                          className="flex-1 min-w-[200px] rounded px-2 py-1.5 text-xs bg-input border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary"
                                                        />
                                                        <button
                                                          disabled={!bankingRejectReason.trim() || bankingApprovingId === agent.id}
                                                          onClick={async () => {
                                                            setBankingApprovingId(agent.id)
                                                            const res = await rejectAgentBanking({ agentId: agent.id, reason: bankingRejectReason })
                                                            if (res.success) {
                                                              setBrokerages(prev => prev.map(b => ({
                                                                ...b,
                                                                agents: b.agents.map((a: Agent) => a.id === agent.id ? { ...a, banking_approval_status: 'rejected' as const, banking_rejection_reason: bankingRejectReason } : a),
                                                              })))
                                                              setBankingRejectingId(null)
                                                              setBankingRejectReason('')
                                                            }
                                                            setBankingApprovingId(null)
                                                          }}
                                                          className="px-3 py-1.5 rounded text-xs font-semibold text-white disabled:opacity-40 hover:opacity-90"
                                                          style={{ background: 'var(--action-red)' }}
                                                        >
                                                          Confirm Reject
                                                        </button>
                                                        <button onClick={() => { setBankingRejectingId(null); setBankingRejectReason('') }} className="text-xs text-muted-foreground hover:text-foreground">Cancel</button>
                                                      </div>
                                                    ) : (
                                                      <div className="flex items-center gap-2">
                                                        <button
                                                          disabled={bankingApprovingId === agent.id}
                                                          onClick={async () => {
                                                            setBankingApprovingId(agent.id)
                                                            const res = await approveAgentBanking({ agentId: agent.id })
                                                            if (res.success) {
                                                              setBrokerages(prev => prev.map(b => ({
                                                                ...b,
                                                                agents: b.agents.map((a: Agent) => a.id === agent.id ? {
                                                                  ...a,
                                                                  bank_transit_number: a.banking_submitted_transit,
                                                                  bank_institution_number: a.banking_submitted_institution,
                                                                  bank_account_number: a.banking_submitted_account,
                                                                  banking_verified: true,
                                                                  banking_approval_status: 'approved' as const,
                                                                } : a),
                                                              })))
                                                            }
                                                            setBankingApprovingId(null)
                                                          }}
                                                          className="px-3 py-1.5 rounded text-xs font-semibold text-white disabled:opacity-40 hover:opacity-90"
                                                          style={{ background: 'var(--action-green)' }}
                                                        >
                                                          {bankingApprovingId === agent.id ? 'Approving...' : 'Approve'}
                                                        </button>
                                                        <button
                                                          onClick={() => setBankingRejectingId(agent.id)}
                                                          className="px-3 py-1.5 rounded text-xs font-semibold transition-colors"
                                                          style={{ background: 'var(--status-red-muted)', color: 'var(--status-red)', border: '1px solid var(--status-red-border)' }}
                                                        >
                                                          Reject
                                                        </button>
                                                      </div>
                                                    )}
                                                  </div>
                                                )}
                                                {agent.banking_verified && agent.bank_transit_number ? (
                                                  <div className="flex items-center gap-4">
                                                    <div className="flex items-center gap-1.5">
                                                      <CheckCircle size={13} className="text-primary" />
                                                      <span className="text-xs font-medium text-primary">Verified</span>
                                                    </div>
                                                    <span className="text-xs font-mono text-muted-foreground">
                                                      Transit: {agent.bank_transit_number} · Inst: {agent.bank_institution_number} · Acct: {'•'.repeat(Math.max(0, (agent.bank_account_number?.length || 4) - 4))}{agent.bank_account_number?.slice(-4)}
                                                    </span>
                                                    <button
                                                      onClick={() => {
                                                        setBankingEditingAgentId(agent.id)
                                                        setBankingForm({
                                                          transit: agent.bank_transit_number || '',
                                                          institution: agent.bank_institution_number || '',
                                                          account: agent.bank_account_number || '',
                                                        })
                                                        setBankingMessage(null)
                                                      }}
                                                      className="text-xs font-medium transition-colors text-muted-foreground hover:text-primary"
                                                    >
                                                      Edit
                                                    </button>
                                                  </div>
                                                ) : bankingEditingAgentId === agent.id ? null : (
                                                  <button
                                                    onClick={() => {
                                                      setBankingEditingAgentId(agent.id)
                                                      setBankingForm({ transit: '', institution: '', account: '' })
                                                      setBankingMessage(null)
                                                    }}
                                                    className="text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors bg-primary text-primary-foreground hover:bg-primary/90"
                                                  >
                                                    Enter Banking Info
                                                  </button>
                                                )}
                                                {bankingEditingAgentId === agent.id && (
                                                  <div className="mt-3 flex items-end gap-2 flex-wrap">
                                                    <div>
                                                      <label className="block text-xs font-semibold mb-1 text-muted-foreground">Transit (5 digits)</label>
                                                      <input
                                                        type="text"
                                                        maxLength={5}
                                                        value={bankingForm.transit}
                                                        onChange={(e) => setBankingForm(f => ({ ...f, transit: e.target.value.replace(/\D/g, '').slice(0, 5) }))}
                                                        placeholder="12345"
                                                        className={`w-24 ${inputSmCls}`}
                                                      />
                                                    </div>
                                                    <div>
                                                      <label className="block text-xs font-semibold mb-1 text-muted-foreground">Institution (3 digits)</label>
                                                      <input
                                                        type="text"
                                                        maxLength={3}
                                                        value={bankingForm.institution}
                                                        onChange={(e) => setBankingForm(f => ({ ...f, institution: e.target.value.replace(/\D/g, '').slice(0, 3) }))}
                                                        placeholder="001"
                                                        className={`w-16 ${inputSmCls}`}
                                                      />
                                                    </div>
                                                    <div>
                                                      <label className="block text-xs font-semibold mb-1 text-muted-foreground">Account (7-12 digits)</label>
                                                      <input
                                                        type="text"
                                                        maxLength={12}
                                                        value={bankingForm.account}
                                                        onChange={(e) => setBankingForm(f => ({ ...f, account: e.target.value.replace(/\D/g, '').slice(0, 12) }))}
                                                        placeholder="1234567"
                                                        className={`w-36 ${inputSmCls}`}
                                                      />
                                                    </div>
                                                    <button
                                                      disabled={bankingSaving || bankingForm.transit.length !== 5 || bankingForm.institution.length !== 3 || bankingForm.account.length < 7}
                                                      onClick={async () => {
                                                        setBankingSaving(true)
                                                        setBankingMessage(null)
                                                        const res = await updateAgentBanking({
                                                          agentId: agent.id,
                                                          transitNumber: bankingForm.transit,
                                                          institutionNumber: bankingForm.institution,
                                                          accountNumber: bankingForm.account,
                                                        })
                                                        if (res.success) {
                                                          // Update local state
                                                          setBrokerages(prev => prev.map(b => ({
                                                            ...b,
                                                            agents: b.agents.map((a: Agent) => a.id === agent.id ? {
                                                              ...a,
                                                              bank_transit_number: bankingForm.transit,
                                                              bank_institution_number: bankingForm.institution,
                                                              bank_account_number: bankingForm.account,
                                                              banking_verified: true,
                                                            } : a),
                                                          })))
                                                          setBankingEditingAgentId(null)
                                                          setBankingMessage({ type: 'success', text: 'Banking info saved' })
                                                          setTimeout(() => setBankingMessage(null), 3000)
                                                        } else {
                                                          setBankingMessage({ type: 'error', text: res.error || 'Failed to save' })
                                                        }
                                                        setBankingSaving(false)
                                                      }}
                                                      className="px-3 py-1.5 rounded text-xs font-semibold text-white transition-colors disabled:opacity-40 bg-primary hover:bg-primary/90"
                                                    >
                                                      {bankingSaving ? 'Saving...' : 'Save'}
                                                    </button>
                                                    <button
                                                      onClick={() => setBankingEditingAgentId(null)}
                                                      className="px-2 py-1.5 rounded text-xs font-medium transition-colors text-muted-foreground hover:text-foreground"
                                                    >
                                                      Cancel
                                                    </button>
                                                    {bankingMessage && (
                                                      <span className={`text-xs font-medium ${bankingMessage.type === 'success' ? 'text-primary' : 'text-red-400'}`}>
                                                        {bankingMessage.text}
                                                      </span>
                                                    )}
                                                  </div>
                                                )}
                                              </div>

                                              <h4 className="text-xs font-semibold mb-3 text-foreground">Deal History</h4>
                                              {(agentDeals[agent.id]?.length ?? 0) === 0 ? (
                                                <p className="text-xs text-muted-foreground">No deals yet</p>
                                              ) : (
                                                <div className="space-y-2">
                                                  {agentDeals[agent.id]?.map((deal) => {
                                                    const dealBadgeClass = getSharedStatusBadgeClass(deal.status)
                                                    return (
                                                      <div key={deal.id} className="flex items-center justify-between p-2 rounded bg-muted/20 border border-border">
                                                        <div className="flex-1">
                                                          <p className="text-xs font-medium text-foreground">{deal.property_address}</p>
                                                          <div className="flex items-center gap-3 mt-1">
                                                            <span className={`inline-flex px-2 py-0.5 text-xs font-semibold rounded ${dealBadgeClass}`}
                                                            >
                                                              {formatStatusLabel(deal.status)}
                                                            </span>
                                                            <span className="text-xs text-muted-foreground">
                                                              Advance: ${deal.advance_amount.toLocaleString('en-CA', { maximumFractionDigits: 0 })}
                                                            </span>
                                                            <span className="text-xs text-muted-foreground">
                                                              Closing: {new Date(deal.closing_date).toLocaleDateString('en-CA')}
                                                            </span>
                                                          </div>
                                                        </div>
                                                      </div>
                                                    )
                                                  })}
                                                </div>
                                              )}
                                            </div>
                                          </td>
                                        </tr>
                                      ),
                                    ].filter(Boolean)
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
      </div>{/* end of content area that shrinks */}

      {/* KYC Document Side Panel — sits beside main content, not on top */}
      {kycPreviewPanel && (
        <div
          className="fixed top-0 right-0 z-30 h-full flex flex-col shadow-xl bg-card border-l-2 border-l-primary"
          style={{
            width: kycPanelWidth,
            animation: 'slideInRight 0.2s ease-out',
          }}
        >
          {/* Panel Header */}
          <div className="flex items-center justify-between px-3 py-2.5 flex-shrink-0 border-b border-border">
            <div className="flex flex-col gap-0.5 min-w-0">
              <p className="text-sm font-semibold truncate text-foreground">
                <Shield size={13} className="inline mr-1 text-primary" />
                {kycPreviewPanel.agentName}
              </p>
              <p className="text-xs text-muted-foreground">ID Verification</p>
            </div>
            <div className="flex items-center gap-1.5 flex-shrink-0">
              <button
                onClick={() => { for (const u of kycPreviewPanel.originalUrls) window.open(u, '_blank') }}
                className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition bg-input text-primary border border-border hover:bg-muted"
                title="Open in new tab"
              >
                <ExternalLink size={11} />
              </button>
              <button
                onClick={closeKycPanel}
                className="p-1 rounded transition text-muted-foreground hover:bg-red-950/50 hover:text-red-400"
              >
                <X size={16} />
              </button>
            </div>
          </div>
          {/* Panel Content — shows all uploaded ID images */}
          <div className="flex-1 overflow-auto p-3">
            {kycPreviewPanel.blobUrls.map((blobUrl, i) => {
              const ext = kycPreviewPanel.originalUrls[i]?.split('?')[0].split('.').pop()?.toLowerCase() || ''
              const isPdf = ext === 'pdf'
              return (
                <div key={i} style={{ marginBottom: i < kycPreviewPanel.blobUrls.length - 1 ? 12 : 0 }}>
                  {kycPreviewPanel.blobUrls.length > 1 && (
                    <p className="text-xs font-semibold mb-1.5 text-muted-foreground">
                      {i === 0 ? 'Front' : i === 1 ? 'Back' : `Photo ${i + 1}`}
                    </p>
                  )}
                  {isPdf ? (
                    <iframe
                      src={blobUrl}
                      className="w-full border-0 rounded-lg border border-border"
                      style={{ height: 400 }}
                      title={`${kycPreviewPanel.fileName} ${i + 1}`}
                    />
                  ) : (
                    <img
                      src={blobUrl}
                      alt={`${kycPreviewPanel.fileName} ${i + 1}`}
                      className="w-full rounded-lg border border-border"
                    />
                  )}
                </div>
              )
            })}
          </div>
          {/* Panel Footer — Approve/Reject actions */}
          <div className="flex items-center gap-2 px-3 py-2.5 flex-shrink-0 border-t border-border bg-background">
            <button
              onClick={async () => {
                setKycSubmitting(true)
                const result = await verifyAgentKyc({ agentId: kycPreviewPanel.agentId })
                if (result.success) {
                  setStatusMessage({ type: 'success', text: `${kycPreviewPanel.agentName} KYC verified` })
                  closeKycPanel()
                  await loadBrokerages()
                } else {
                  setStatusMessage({ type: 'error', text: result.error || 'Verification failed' })
                }
                setKycSubmitting(false)
              }}
              disabled={kycSubmitting}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-bold transition-all disabled:opacity-50 text-white hover:opacity-90"
              style={{ background: 'var(--action-green)', border: '1px solid var(--action-green-border)' }}
            >
              <CheckCircle size={16} />
              Approve ID
            </button>
            <button
              onClick={() => {
                setKycRejectingAgentId(kycPreviewPanel.agentId)
                setKycRejectReason('')
                closeKycPanel()
              }}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-bold transition-all text-white hover:opacity-90"
              style={{ background: 'var(--action-red)', border: '1px solid var(--action-red-border)' }}
            >
              <XCircle size={16} />
              Reject ID
            </button>
          </div>
        </div>
      )}
      {/* Pre-auth form inline viewer */}
      {preauthViewUrl && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 backdrop-blur-sm"
          onClick={() => setPreauthViewUrl(null)}>
          <div className="relative w-full max-w-3xl mx-4 bg-card rounded-xl overflow-hidden border border-border/50" style={{ height: '80vh' }} onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-border/50">
              <h3 className="text-sm font-semibold text-foreground">Pre-Authorization Form</h3>
              <button onClick={() => setPreauthViewUrl(null)} className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors">
                <X size={16} /> Close
              </button>
            </div>
            <iframe src={preauthViewUrl} className="w-full" style={{ height: 'calc(80vh - 52px)' }} />
          </div>
        </div>
      )}
      <style>{`
        @keyframes slideInRight {
          from { transform: translateX(100%); }
          to { transform: translateX(0); }
        }
      `}</style>
    </div>
  )
}
