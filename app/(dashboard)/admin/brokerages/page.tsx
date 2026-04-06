'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import { Plus, Edit2, Search, ChevronLeft, AlertCircle, CheckCircle, ChevronDown, ChevronRight, Users, UserPlus, X, Upload, Download, FileSpreadsheet, Archive, Eye, EyeOff, FileText, Trash2, Shield, ExternalLink, XCircle, Mail, CreditCard, KeyRound, AtSign } from 'lucide-react'
import { createBrokerage, updateBrokerage, createAgent, updateAgent, bulkImportAgents, inviteAgent, archiveAgent, permanentlyDeleteAgent, resendAgentWelcomeEmail, sendWelcomeToAllBrokerageAgents, adminResetUserPassword, adminChangeUserEmail, getBrokerageUserProfiles, inviteBrokerageAdmin, resendBrokerageSetupLink } from '@/lib/actions/admin-actions'
import { updateAgentBanking, approveAgentBanking, rejectAgentBanking } from '@/lib/actions/profile-actions'
import { verifyBrokerageKyc, revokeBrokerageKyc, verifyAgentKyc, rejectAgentKyc, getAgentKycDocumentUrl } from '@/lib/actions/kyc-actions'
import * as XLSX from 'xlsx'
import { useTheme } from '@/lib/theme'
import { getStatusBadgeStyle as getSharedStatusBadgeStyle, formatStatusLabel, getKycBadgeStyle, RECO_PUBLIC_REGISTER_URL } from '@/lib/constants'
import SignOutModal from '@/components/SignOutModal'

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
  const { colors, isDark } = useTheme()

  // ---- Input style helpers ----
  const inputStyle = { background: colors.inputBg, border: `1px solid ${colors.inputBorder}`, color: colors.inputText }
  const onFocus = (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    e.currentTarget.style.borderColor = '#5FA873'
    e.currentTarget.style.boxShadow = isDark ? '0 0 0 2px rgba(95,168,115,0.25)' : '0 0 0 2px #5FA873'
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
      case 'archived': return { bg: '#F2F2F0', text: '#5A5A5A', border: '#D0D0CC' }
      default: return { bg: colors.cardBg, text: colors.textMuted, border: colors.border }
    }
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
      {/* Main content area — shrinks when KYC panel is open */}
      <div style={{ marginRight: kycPreviewPanel ? kycPanelWidth : 0, transition: 'margin-right 0.2s ease-out' }}>
      {/* Header */}
      <header style={{ background: colors.headerBgGradient }}>
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center py-5">
            <div className="flex items-center gap-4">
              <button
                onClick={() => router.push('/admin')}
                className="p-1.5 rounded-lg transition-colors"
                style={{ color: '#5FA873' }}
                onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(95,168,115,0.1)'}
                onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
              >
                <ChevronLeft size={20} />
              </button>
              <img src="/brand/white.png" alt="Firm Funds" className="h-16 sm:h-20 md:h-28 w-auto" />
              <div className="w-px h-10" style={{ background: 'rgba(255,255,255,0.15)' }} />
              <p className="text-lg font-medium tracking-wide text-white" style={{ fontFamily: 'var(--font-geist-sans), sans-serif' }}>Manage Brokerages</p>
            </div>
            <div className="flex items-center gap-4">
              <span className="text-sm" style={{ color: '#5FA873' }}>{profile?.full_name}</span>
              <SignOutModal onConfirm={handleLogout} />
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
                style={{ background: '#5FA873', color: '#1E1E1E' }}
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
                {renderInput('Broker of Record', createFormData.brokerOfRecordName, (v) => setCreateFormData({ ...createFormData, brokerOfRecordName: v }), { placeholder: 'Full legal name' })}
                {renderInput('Broker of Record Email', createFormData.brokerOfRecordEmail, (v) => setCreateFormData({ ...createFormData, brokerOfRecordEmail: v }), { placeholder: 'broker@brokerage.com', type: 'email' })}
                {renderInput('Logo URL', createFormData.logoUrl, (v) => setCreateFormData({ ...createFormData, logoUrl: v }), { placeholder: 'https://... (public image URL)' })}
                <div>
                  <label className="block text-sm font-medium mb-2" style={{ color: colors.textSecondary }}>Brand Color</label>
                  <div className="flex items-center gap-2">
                    <input type="color" value={createFormData.brandColor || '#5FA873'} onChange={(e) => setCreateFormData({ ...createFormData, brandColor: e.target.value })} className="w-10 h-10 rounded-lg cursor-pointer border-0" style={{ background: 'transparent' }} />
                    <input type="text" value={createFormData.brandColor || '#5FA873'} onChange={(e) => setCreateFormData({ ...createFormData, brandColor: e.target.value })} placeholder="#5FA873" maxLength={7} className="flex-1 px-4 py-2 rounded-lg text-sm outline-none font-mono" style={inputStyle} onFocus={onFocus} onBlur={onBlur} />
                  </div>
                </div>
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
                  style={{ background: '#5FA873', color: '#1E1E1E' }}
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
              const allAgents = brokerage.agents
              const nonArchivedAgents = allAgents.filter(a => a.status !== 'archived')
              const archivedAgents = allAgents.filter(a => a.status === 'archived')
              const visibleAgents = showArchived ? allAgents : nonArchivedAgents
              const agentCount = visibleAgents.length
              const activeAgents = allAgents.filter(a => a.status === 'active').length

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
                      const newId = isExpanded ? null : brokerage.id
                      setExpandedId(newId)
                      setEditingBrokerageId(null)
                      setShowAddAgentFor(null)
                      if (newId && !brokerageDocs[newId]) loadBrokerageDocs(newId)
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
                      {(brokerage as any).kyc_verified ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-semibold rounded"
                          style={getKycBadgeStyle('verified')}
                          title={`KYC verified${(brokerage as any).kyc_verified_at ? ' on ' + new Date((brokerage as any).kyc_verified_at).toLocaleDateString('en-CA') : ''}`}
                        >
                          <Shield size={11} /> KYC
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-semibold rounded"
                          style={getKycBadgeStyle('pending')}
                          title="KYC not verified"
                        >
                          <Shield size={11} /> No KYC
                        </span>
                      )}
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
                            {renderInput('Broker of Record', editFormData.brokerOfRecordName, (v) => setEditFormData({ ...editFormData, brokerOfRecordName: v }), { placeholder: 'Full legal name' })}
                            {renderInput('Broker of Record Email', editFormData.brokerOfRecordEmail, (v) => setEditFormData({ ...editFormData, brokerOfRecordEmail: v }), { placeholder: 'broker@brokerage.com', type: 'email' })}
                            {renderInput('Logo URL', editFormData.logoUrl, (v) => setEditFormData({ ...editFormData, logoUrl: v }), { placeholder: 'https://... (public image URL)' })}
                            <div>
                              <label className="block text-sm font-medium mb-2" style={{ color: colors.textSecondary }}>Brand Color</label>
                              <div className="flex items-center gap-2">
                                <input
                                  type="color"
                                  value={editFormData.brandColor || '#5FA873'}
                                  onChange={(e) => setEditFormData({ ...editFormData, brandColor: e.target.value })}
                                  className="w-10 h-10 rounded-lg cursor-pointer border-0"
                                  style={{ background: 'transparent' }}
                                />
                                <input
                                  type="text"
                                  value={editFormData.brandColor || '#5FA873'}
                                  onChange={(e) => setEditFormData({ ...editFormData, brandColor: e.target.value })}
                                  placeholder="#5FA873"
                                  maxLength={7}
                                  className="flex-1 px-4 py-2 rounded-lg text-sm outline-none font-mono"
                                  style={inputStyle}
                                  onFocus={onFocus}
                                  onBlur={onBlur}
                                />
                              </div>
                            </div>
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
                              style={{ background: '#5FA873', color: '#1E1E1E' }}
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
                          <div>
                            <p className="text-xs font-semibold uppercase tracking-wider mb-1" style={{ color: colors.textMuted }}>Broker of Record</p>
                            <p style={{ color: colors.textPrimary }}>{brokerage.broker_of_record_name || '—'}</p>
                            {brokerage.broker_of_record_email && (
                              <p className="text-xs mt-0.5" style={{ color: colors.textSecondary }}>{brokerage.broker_of_record_email}</p>
                            )}
                          </div>
                        </div>
                      )}

                      {/* FINTRAC KYC Verification */}
                      <div className="px-6 py-4" style={{ borderBottom: `1px solid ${colors.border}` }}>
                        <div className="flex items-center gap-2 mb-3">
                          <Shield size={15} style={{ color: (brokerage as any).kyc_verified ? '#5FA873' : colors.gold }} />
                          <h4 className="text-sm font-bold" style={{ color: colors.textPrimary }}>
                            FINTRAC — RECO Verification
                          </h4>
                          {(brokerage as any).kyc_verified && (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-semibold rounded ml-2"
                              style={getKycBadgeStyle('verified')}>
                              <CheckCircle size={11} /> Verified
                            </span>
                          )}
                        </div>

                        {(brokerage as any).kyc_verified ? (
                          /* Verified state — show verification details */
                          <div className="space-y-2">
                            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                              <div>
                                <p className="text-xs font-semibold uppercase tracking-wider mb-1" style={{ color: colors.textMuted }}>RECO Reg #</p>
                                <p style={{ color: colors.textPrimary }}>{(brokerage as any).reco_registration_number || '—'}</p>
                              </div>
                              <div>
                                <p className="text-xs font-semibold uppercase tracking-wider mb-1" style={{ color: colors.textMuted }}>Verified On</p>
                                <p style={{ color: colors.textPrimary }}>
                                  {(brokerage as any).reco_verification_date
                                    ? new Date((brokerage as any).reco_verification_date).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' })
                                    : '—'}
                                </p>
                              </div>
                              <div>
                                <p className="text-xs font-semibold uppercase tracking-wider mb-1" style={{ color: colors.textMuted }}>Verified By</p>
                                <p style={{ color: colors.textPrimary }}>{(brokerage as any).kyc_verified_by || '—'}</p>
                              </div>
                              <div>
                                <p className="text-xs font-semibold uppercase tracking-wider mb-1" style={{ color: colors.textMuted }}>Notes</p>
                                <p style={{ color: colors.textPrimary }}>{(brokerage as any).reco_verification_notes || '—'}</p>
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
                              className="text-xs px-3 py-1 rounded transition-colors mt-1"
                              style={{ color: colors.errorText, background: colors.errorBg, border: `1px solid ${colors.errorBorder}` }}
                            >
                              Revoke Verification
                            </button>
                          </div>
                        ) : (
                          /* Not verified — show verification form */
                          <div className="space-y-3">
                            <p className="text-xs" style={{ color: colors.textMuted }}>
                              Verify this brokerage on the RECO Public Register, then record the verification below.
                            </p>
                            <a
                              href={RECO_PUBLIC_REGISTER_URL}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-opacity"
                              style={{ background: '#1A2240', color: '#7B9FE0', border: '1px solid #2D3A5C' }}
                              onMouseEnter={(e) => e.currentTarget.style.opacity = '0.85'}
                              onMouseLeave={(e) => e.currentTarget.style.opacity = '1'}
                            >
                              <ExternalLink size={12} /> Open RECO Public Register
                            </a>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                              <div>
                                <label className="block text-xs font-medium mb-1" style={{ color: colors.textSecondary }}>RECO Registration Number *</label>
                                <input
                                  type="text"
                                  value={kycRecoNumber}
                                  onChange={(e) => setKycRecoNumber(e.target.value)}
                                  placeholder="e.g. 12345"
                                  className="w-full px-3 py-2 rounded-lg text-sm outline-none"
                                  style={inputStyle}
                                  onFocus={onFocus}
                                  onBlur={onBlur}
                                />
                              </div>
                              <div>
                                <label className="block text-xs font-medium mb-1" style={{ color: colors.textSecondary }}>Verification Notes</label>
                                <input
                                  type="text"
                                  value={kycNotes}
                                  onChange={(e) => setKycNotes(e.target.value)}
                                  placeholder="e.g. Confirmed active on RECO register"
                                  className="w-full px-3 py-2 rounded-lg text-sm outline-none"
                                  style={inputStyle}
                                  onFocus={onFocus}
                                  onBlur={onBlur}
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
                              className="flex items-center gap-2 text-xs font-semibold px-4 py-2 rounded-lg transition-colors disabled:opacity-50"
                              style={{ background: '#5FA873', color: '#fff' }}
                            >
                              <CheckCircle size={13} /> {kycSubmitting ? 'Verifying...' : 'Mark as KYC Verified'}
                            </button>
                          </div>
                        )}
                      </div>

                      {/* Brokerage Documents */}
                      <div className="px-6 py-4" style={{ borderBottom: `1px solid ${colors.border}` }}>
                        <div className="flex items-center justify-between mb-3">
                          <div className="flex items-center gap-2">
                            <FileText size={15} style={{ color: colors.gold }} />
                            <h4 className="text-sm font-bold" style={{ color: colors.textPrimary }}>
                              Documents
                              <span className="font-normal ml-1.5" style={{ color: colors.textMuted }}>
                                ({(brokerageDocs[brokerage.id] || []).length})
                              </span>
                            </h4>
                          </div>
                          <div className="flex items-center gap-2">
                            <select
                              id={`brokDocType-${brokerage.id}`}
                              className="text-xs px-2 py-1 rounded border focus:outline-none"
                              style={{ background: colors.inputBg, borderColor: colors.inputBorder, color: colors.inputText }}
                              defaultValue="cooperation_agreement"
                            >
                              {BROKERAGE_DOC_TYPES.map(dt => (
                                <option key={dt.value} value={dt.value}>{dt.label}</option>
                              ))}
                            </select>
                            <label
                              className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors cursor-pointer"
                              style={{ color: '#fff', background: colors.gold }}
                              onMouseEnter={(e) => e.currentTarget.style.opacity = '0.9'}
                              onMouseLeave={(e) => e.currentTarget.style.opacity = '1'}
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
                              <div key={doc.id} className="flex items-center justify-between px-3 py-2 rounded-lg" style={{ background: colors.inputBg, border: `1px solid ${colors.inputBorder}` }}>
                                <div className="flex items-center gap-2 min-w-0">
                                  <FileText size={14} style={{ color: colors.gold }} />
                                  <div className="min-w-0">
                                    <p className="text-sm font-medium truncate" style={{ color: colors.textPrimary }}>{doc.file_name}</p>
                                    <p className="text-xs" style={{ color: colors.textMuted }}>
                                      {BROKERAGE_DOC_TYPES.find(d => d.value === doc.document_type)?.label || doc.document_type}
                                      {' \u2022 '}{new Date(doc.created_at).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' })}
                                    </p>
                                  </div>
                                </div>
                                <div className="flex items-center gap-1.5 flex-shrink-0">
                                  <button onClick={() => handleBrokerageDocView(doc)} className="px-2 py-1 rounded text-xs font-medium transition" style={{ background: colors.gold, color: '#fff' }}>
                                    <Eye size={13} />
                                  </button>
                                  <button onClick={() => handleBrokerageDocDelete(doc, brokerage.id)} className="px-2 py-1 rounded text-xs font-medium transition" style={{ background: colors.errorBg, color: colors.errorText }}>
                                    <Trash2 size={13} />
                                  </button>
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <p className="text-xs" style={{ color: colors.textMuted }}>No documents uploaded. Upload the signed Brokerage Cooperation Agreement and other onboarding docs here.</p>
                        )}
                      </div>

                      {/* Agent Roster */}
                      <div className="px-6 py-4">
                        <div className="flex items-center justify-between mb-4">
                          <div className="flex items-center gap-2">
                            <Users size={15} style={{ color: colors.gold }} />
                            <h4 className="text-sm font-bold" style={{ color: colors.textPrimary }}>
                              Agent Roster
                              <span className="font-normal ml-1.5" style={{ color: colors.textMuted }}>
                                ({activeAgents} active{nonArchivedAgents.length !== activeAgents ? `, ${nonArchivedAgents.length} total` : ''}{archivedAgents.length > 0 ? `, ${archivedAgents.length} archived` : ''})
                              </span>
                            </h4>
                            {archivedAgents.length > 0 && (
                              <button
                                onClick={() => setShowArchived(!showArchived)}
                                className="flex items-center gap-1 text-xs px-2 py-1 rounded-md transition-colors"
                                style={{ color: colors.textMuted, border: `1px solid ${colors.border}` }}
                                onMouseEnter={(e) => { e.currentTarget.style.background = colors.cardHoverBg }}
                                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
                              >
                                {showArchived ? <EyeOff size={11} /> : <Eye size={11} />}
                                {showArchived ? 'Hide Archived' : 'Show Archived'}
                              </button>
                            )}
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
                              <button
                                onClick={() => handleSendWelcomeToAll(brokerage.id, brokerage.name)}
                                disabled={sendingAllFor === brokerage.id}
                                className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors"
                                style={{ color: colors.gold, border: `1px solid ${colors.border}`, opacity: sendingAllFor === brokerage.id ? 0.6 : 1 }}
                                onMouseEnter={(e) => { if (sendingAllFor !== brokerage.id) { e.currentTarget.style.background = colors.cardHoverBg; e.currentTarget.style.borderColor = colors.gold } }}
                                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = colors.border }}
                                title="Send welcome email with magic link to all agents in this brokerage"
                              >
                                <Mail size={13} /> {sendingAllFor === brokerage.id ? 'Sending...' : 'Send Welcome to All'}
                              </button>
                              <button
                                onClick={() => handleLoadUserProfiles(brokerage.id)}
                                disabled={loadingUserProfiles === brokerage.id}
                                className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors"
                                style={{ color: showUserManagement === brokerage.id ? '#fff' : colors.gold, background: showUserManagement === brokerage.id ? colors.gold : 'transparent', border: `1px solid ${showUserManagement === brokerage.id ? colors.gold : colors.border}`, opacity: loadingUserProfiles === brokerage.id ? 0.6 : 1 }}
                                onMouseEnter={(e) => { if (showUserManagement !== brokerage.id) { e.currentTarget.style.background = colors.cardHoverBg; e.currentTarget.style.borderColor = colors.gold } }}
                                onMouseLeave={(e) => { if (showUserManagement !== brokerage.id) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = colors.border } }}
                                title="Manage brokerage admin logins"
                              >
                                <KeyRound size={13} /> {loadingUserProfiles === brokerage.id ? 'Loading...' : 'Manage Logins'}
                              </button>
                            </div>
                          )}
                        </div>

                        {/* Brokerage Admin Login Management Panel */}
                        {showUserManagement === brokerage.id && brokerageUserProfiles[brokerage.id] && (
                          <div className="mb-4 p-4 rounded-lg" style={{ background: colors.infoBg, border: `1px solid ${colors.infoBorder}` }}>
                            <h4 className="text-xs font-bold uppercase tracking-wider mb-3 flex items-center gap-2" style={{ color: colors.infoText }}>
                              <KeyRound size={14} /> Brokerage Admin Login{brokerageUserProfiles[brokerage.id].brokerageAdmins.length !== 1 ? 's' : ''}
                            </h4>
                            {brokerageUserProfiles[brokerage.id].brokerageAdmins.length === 0 ? (
                              <div>
                                {!showCreateBrokerageLogin ? (
                                  <div className="flex items-center justify-between">
                                    <p className="text-xs" style={{ color: colors.textMuted }}>No brokerage admin login found.</p>
                                    <button
                                      onClick={() => { setShowCreateBrokerageLogin(true); setBrokerageLoginForm({ fullName: '', email: brokerage.email || '' }) }}
                                      className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-md transition-colors"
                                      style={{ background: colors.gold, color: '#fff' }}
                                    >
                                      <Plus size={13} /> Create Login
                                    </button>
                                  </div>
                                ) : (
                                  <div className="p-3 rounded-lg space-y-3" style={{ background: colors.cardBg, border: `1px solid ${colors.border}` }}>
                                    <div className="flex items-center justify-between">
                                      <p className="text-xs font-bold uppercase tracking-wider" style={{ color: colors.gold }}>Create Brokerage Admin Login</p>
                                      <button onClick={() => setShowCreateBrokerageLogin(false)} style={{ color: colors.textMuted }}><X size={14} /></button>
                                    </div>
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                      <div>
                                        <label className="block text-[10px] font-semibold mb-0.5" style={{ color: colors.textMuted }}>Full Name *</label>
                                        <input
                                          type="text" value={brokerageLoginForm.fullName}
                                          onChange={(e) => setBrokerageLoginForm({ ...brokerageLoginForm, fullName: e.target.value })}
                                          className="w-full rounded-md px-2 py-1.5 text-xs" style={inputStyle} placeholder="e.g. John Smith"
                                        />
                                      </div>
                                      <div>
                                        <label className="block text-[10px] font-semibold mb-0.5" style={{ color: colors.textMuted }}>Email *</label>
                                        <input
                                          type="email" value={brokerageLoginForm.email}
                                          onChange={(e) => setBrokerageLoginForm({ ...brokerageLoginForm, email: e.target.value })}
                                          className="w-full rounded-md px-2 py-1.5 text-xs" style={inputStyle} placeholder="admin@brokerage.com"
                                        />
                                      </div>
                                    </div>
                                    <div className="flex items-center gap-2">
                                      <button
                                        onClick={() => handleCreateBrokerageLogin(brokerage.id, brokerage.name)}
                                        disabled={creatingBrokerageLogin || !brokerageLoginForm.fullName.trim() || !brokerageLoginForm.email.trim()}
                                        className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-md disabled:opacity-50"
                                        style={{ background: colors.gold, color: '#fff' }}
                                      >
                                        <Mail size={13} /> {creatingBrokerageLogin ? 'Sending...' : 'Create Login & Send Setup Link'}
                                      </button>
                                      <button
                                        onClick={() => setShowCreateBrokerageLogin(false)}
                                        className="text-xs px-3 py-1.5 rounded-md"
                                        style={{ color: colors.textMuted, border: `1px solid ${colors.border}` }}
                                      >
                                        Cancel
                                      </button>
                                    </div>
                                    <p className="text-[10px]" style={{ color: colors.textFaint }}>
                                      <Mail size={10} className="inline mr-1" style={{ verticalAlign: 'middle' }} />
                                      A branded setup email will be sent with a magic link. They&apos;ll set their own password — no credentials to share.
                                    </p>
                                  </div>
                                )}
                              </div>
                            ) : (
                              <div className="space-y-2">
                                {brokerageUserProfiles[brokerage.id].brokerageAdmins.map((admin: any) => (
                                  <div key={admin.id} className="flex items-center justify-between gap-3 p-3 rounded-lg" style={{ background: colors.cardBg, border: `1px solid ${colors.cardBorder}` }}>
                                    <div className="flex-1 min-w-0">
                                      <p className="text-sm font-medium truncate" style={{ color: colors.textPrimary }}>{admin.full_name}</p>
                                      <p className="text-xs truncate" style={{ color: colors.textMuted }}>{admin.email}</p>
                                      <p className="text-[10px]" style={{ color: colors.textFaint }}>
                                        Last login: {admin.last_login ? new Date(admin.last_login).toLocaleString('en-CA') : 'Never'}
                                      </p>
                                    </div>
                                    <div className="flex items-center gap-1.5">
                                      <button
                                        onClick={() => handleResetPassword(admin.id, admin.full_name, 'user')}
                                        disabled={resettingPasswordForUserId === admin.id}
                                        className="flex items-center gap-1 text-xs font-semibold px-2.5 py-1.5 rounded-md transition-colors disabled:opacity-50"
                                        style={{ color: colors.warningText, background: colors.warningBg, border: `1px solid ${colors.warningBorder}` }}
                                      >
                                        <KeyRound size={12} /> Reset Password
                                      </button>
                                      <button
                                        onClick={() => { setChangingEmailForUserId(changingEmailForUserId === admin.id ? null : admin.id); setChangeEmailValue(admin.email) }}
                                        className="flex items-center gap-1 text-xs font-semibold px-2.5 py-1.5 rounded-md transition-colors"
                                        style={{ color: colors.infoText, background: changingEmailForUserId === admin.id ? colors.gold + '30' : colors.cardBg, border: `1px solid ${changingEmailForUserId === admin.id ? colors.gold : colors.border}` }}
                                      >
                                        <AtSign size={12} /> Change Email
                                      </button>
                                      <button
                                        onClick={() => handleResendSetupLink(admin.id, admin.full_name)}
                                        disabled={resendingSetupLink === admin.id}
                                        className="flex items-center gap-1 text-xs font-semibold px-2.5 py-1.5 rounded-md transition-colors disabled:opacity-50"
                                        style={{ color: colors.gold, background: colors.cardBg, border: `1px solid ${colors.border}` }}
                                      >
                                        <Mail size={12} /> {resendingSetupLink === admin.id ? 'Sending...' : 'Resend Setup Link'}
                                      </button>
                                    </div>
                                  </div>
                                ))}
                                {/* Inline email change for brokerage admin */}
                                {brokerageUserProfiles[brokerage.id].brokerageAdmins.some((a: any) => changingEmailForUserId === a.id) && (
                                  <div className="flex items-center gap-2 p-2 rounded-lg" style={{ background: colors.cardBg, border: `1px solid ${colors.border}` }}>
                                    <input
                                      type="email"
                                      value={changeEmailValue}
                                      onChange={(e) => setChangeEmailValue(e.target.value)}
                                      className="rounded-md px-2 py-1 text-xs flex-1"
                                      style={inputStyle}
                                      placeholder="New login email"
                                    />
                                    <button
                                      onClick={() => {
                                        const admin = brokerageUserProfiles[brokerage.id].brokerageAdmins.find((a: any) => a.id === changingEmailForUserId)
                                        if (admin) handleChangeEmail(admin.id, admin.full_name, 'user', brokerage.id)
                                      }}
                                      disabled={changingEmailSaving || !changeEmailValue.trim()}
                                      className="text-xs font-semibold px-3 py-1 rounded-md disabled:opacity-50"
                                      style={{ background: colors.gold, color: '#fff' }}
                                    >
                                      {changingEmailSaving ? 'Saving...' : 'Save'}
                                    </button>
                                    <button
                                      onClick={() => { setChangingEmailForUserId(null); setChangeEmailValue('') }}
                                      className="text-xs px-2 py-1 rounded-md"
                                      style={{ color: colors.textMuted }}
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
                            <div className="flex items-center gap-2 pt-1">
                              <input
                                type="checkbox"
                                id={`invite-${brokerage.id}`}
                                checked={sendInvite}
                                onChange={(e) => setSendInvite(e.target.checked)}
                                className="rounded"
                                style={{ accentColor: '#5FA873' }}
                              />
                              <label htmlFor={`invite-${brokerage.id}`} className="text-xs font-medium cursor-pointer" style={{ color: colors.textPrimary }}>
                                Create login
                              </label>
                              <span className="text-xs" style={{ color: colors.textMuted }}>
                                {sendInvite ? '(login created — send welcome email later)' : '(roster only — no login)'}
                              </span>
                            </div>
                            <div className="flex gap-3 pt-1">
                              <button type="button" onClick={() => { setShowAddAgentFor(null); setSendInvite(true) }}
                                className="px-4 py-2 rounded-lg text-sm font-semibold transition-colors"
                                style={{ background: colors.cardBg, color: colors.textPrimary, border: `1px solid ${colors.border}` }}
                              >Cancel</button>
                              <button type="submit" disabled={submitting}
                                className="px-4 py-2 rounded-lg text-sm font-semibold transition-colors disabled:opacity-50"
                                style={{ background: '#5FA873', color: '#1E1E1E' }}
                              >{submitting ? (sendInvite ? 'Creating...' : 'Adding...') : (sendInvite ? 'Add Agent + Login' : 'Add Agent')}</button>
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
                                  <th className="px-4 py-2.5 text-left text-xs font-bold uppercase tracking-wider" style={{ color: colors.textMuted }}>KYC</th>
                                  <th className="px-4 py-2.5 text-right text-xs font-bold uppercase tracking-wider" style={{ color: colors.textMuted }}></th>
                                </tr>
                              </thead>
                              <tbody>
                                {visibleAgents
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
                                          <td className="px-3 py-2" colSpan={7}>
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
                                                    <option value="archived">Archived</option>
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

                                    return [
                                      <tr key={agent.id}
                                        style={{
                                          borderBottom: expandedAgentId === agent.id ? `1px solid ${colors.divider}` : (idx < agentCount - 1 ? `1px solid ${colors.divider}` : 'none'),
                                          background: isAgentMatch ? colors.goldBg : undefined,
                                          borderLeft: isAgentMatch ? `3px solid ${colors.gold}` : undefined,
                                        }}
                                        onMouseEnter={(e) => e.currentTarget.style.background = isAgentMatch ? colors.goldBg : colors.tableRowHoverBg}
                                        onMouseLeave={(e) => e.currentTarget.style.background = isAgentMatch ? colors.goldBg : 'transparent'}
                                      >
                                        <td className="px-4 py-3 text-sm font-medium" style={{ color: colors.textPrimary }}>
                                          <button
                                            onClick={() => handleExpandAgent(agent.id)}
                                            className="flex items-center gap-2 cursor-pointer transition-colors"
                                            style={{ color: '#5FA873' }}
                                            onMouseEnter={(e) => { e.currentTarget.style.textDecoration = 'underline' }}
                                            onMouseLeave={(e) => { e.currentTarget.style.textDecoration = 'none' }}
                                            title="Click to view deals"
                                          >
                                            <span>{agent.first_name} {agent.last_name}</span>
                                            {expandedAgentId === agent.id && <ChevronDown size={14} />}
                                            {expandedAgentId !== agent.id && <ChevronRight size={14} />}
                                          </button>
                                          {agent.flagged_by_brokerage && (
                                            <span className="inline-block text-xs px-1.5 py-0.5 rounded font-semibold mt-1"
                                              style={{ background: colors.errorBg, color: colors.errorText, border: `1px solid ${colors.errorBorder}` }}
                                            >Flagged</span>
                                          )}
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
                                        <td className="px-4 py-3">
                                          {(() => {
                                            const kycStatus = (agent as any).kyc_status || 'pending'
                                            const kycBadge = getKycBadgeStyle(kycStatus)
                                            return (
                                              <div className="flex flex-col gap-1">
                                                <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-semibold rounded w-fit"
                                                  style={kycBadge}
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
                                                      className="flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-all disabled:opacity-50"
                                                      style={{ color: '#7B9FE0', background: '#1A2240', border: '1px solid #2D3A5C' }}
                                                      onMouseEnter={(e) => { e.currentTarget.style.background = '#243060'; e.currentTarget.style.borderColor = '#3D5A9C' }}
                                                      onMouseLeave={(e) => { e.currentTarget.style.background = '#1A2240'; e.currentTarget.style.borderColor = '#2D3A5C' }}
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
                                                        className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-bold transition-all disabled:opacity-50"
                                                        style={{ color: '#fff', background: '#1A7A2E', border: '1px solid #25A03C' }}
                                                        onMouseEnter={(e) => { e.currentTarget.style.background = '#1E8C34' }}
                                                        onMouseLeave={(e) => { e.currentTarget.style.background = '#1A7A2E' }}
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
                                                        className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-bold transition-all"
                                                        style={{ color: '#fff', background: '#993D3D', border: '1px solid #B84A4A' }}
                                                        onMouseEnter={(e) => { e.currentTarget.style.background = '#AA4545' }}
                                                        onMouseLeave={(e) => { e.currentTarget.style.background = '#993D3D' }}
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
                                                      className="text-xs px-3 py-2 rounded-md outline-none w-full"
                                                      style={{ ...inputStyle }}
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
                                                        className="flex-1 flex items-center justify-center gap-1 px-3 py-1.5 rounded-md text-xs font-bold disabled:opacity-50 transition-all"
                                                        style={{ background: '#993D3D', color: '#fff', border: '1px solid #B84A4A' }}
                                                      >
                                                        Confirm Reject
                                                      </button>
                                                      <button
                                                        onClick={() => setKycRejectingAgentId(null)}
                                                        className="px-3 py-1.5 rounded-md text-xs transition-all"
                                                        style={{ color: colors.textMuted, border: `1px solid ${colors.border}` }}
                                                        onMouseEnter={(e) => e.currentTarget.style.background = colors.cardHoverBg}
                                                        onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
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
                                              className="text-xs px-2 py-1 rounded transition-colors"
                                              style={{ color: colors.textMuted }}
                                              onMouseEnter={(e) => { e.currentTarget.style.color = colors.gold; e.currentTarget.style.background = colors.goldBg }}
                                              onMouseLeave={(e) => { e.currentTarget.style.color = colors.textMuted; e.currentTarget.style.background = 'transparent' }}
                                              title="Edit agent"
                                            >
                                              <Edit2 size={13} />
                                            </button>
                                            {agent.status !== 'archived' && (
                                              <button
                                                onClick={() => handleResendWelcome(agent.id, `${agent.first_name} ${agent.last_name}`)}
                                                disabled={resendingAgentId === agent.id}
                                                className="text-xs px-2 py-1 rounded transition-colors disabled:opacity-50"
                                                style={{ color: colors.textMuted }}
                                                onMouseEnter={(e) => { if (!e.currentTarget.disabled) { e.currentTarget.style.color = '#5FA873'; e.currentTarget.style.background = 'rgba(95,168,115,0.1)' } }}
                                                onMouseLeave={(e) => { e.currentTarget.style.color = colors.textMuted; e.currentTarget.style.background = 'transparent' }}
                                                title="Resend welcome email"
                                              >
                                                <Mail size={13} />
                                              </button>
                                            )}
                                            {agent.status !== 'archived' && (
                                              <button
                                                onClick={() => handleResetPassword(agent.id, `${agent.first_name} ${agent.last_name}`)}
                                                disabled={resettingPasswordForUserId === agent.id}
                                                className="text-xs px-2 py-1 rounded transition-colors disabled:opacity-50"
                                                style={{ color: colors.textMuted }}
                                                onMouseEnter={(e) => { if (!e.currentTarget.disabled) { e.currentTarget.style.color = colors.warningText; e.currentTarget.style.background = colors.warningBg } }}
                                                onMouseLeave={(e) => { e.currentTarget.style.color = colors.textMuted; e.currentTarget.style.background = 'transparent' }}
                                                title="Reset password"
                                              >
                                                <KeyRound size={13} />
                                              </button>
                                            )}
                                            {agent.status !== 'archived' && (
                                              <button
                                                onClick={() => { setChangingEmailForUserId(changingEmailForUserId === agent.id ? null : agent.id); setChangeEmailValue(agent.email) }}
                                                className="text-xs px-2 py-1 rounded transition-colors"
                                                style={{ color: changingEmailForUserId === agent.id ? colors.gold : colors.textMuted }}
                                                onMouseEnter={(e) => { e.currentTarget.style.color = colors.infoText; e.currentTarget.style.background = colors.infoBg }}
                                                onMouseLeave={(e) => { e.currentTarget.style.color = changingEmailForUserId === agent.id ? colors.gold : colors.textMuted; e.currentTarget.style.background = 'transparent' }}
                                                title="Change login email"
                                              >
                                                <AtSign size={13} />
                                              </button>
                                            )}
                                            {agent.status !== 'archived' && (
                                              <button
                                                onClick={() => handleArchiveAgent(agent.id, `${agent.first_name} ${agent.last_name}`)}
                                                disabled={archivingAgentId === agent.id}
                                                className="text-xs px-2 py-1 rounded transition-colors disabled:opacity-50"
                                                style={{ color: colors.textMuted }}
                                                onMouseEnter={(e) => { if (!e.currentTarget.disabled) { e.currentTarget.style.color = colors.errorText; e.currentTarget.style.background = colors.errorBg } }}
                                                onMouseLeave={(e) => { e.currentTarget.style.color = colors.textMuted; e.currentTarget.style.background = 'transparent' }}
                                                title="Archive agent"
                                              >
                                                <Archive size={13} />
                                              </button>
                                            )}
                                            {agent.status === 'archived' && (
                                              <button
                                                onClick={() => handlePermanentlyDeleteAgent(agent.id, `${agent.first_name} ${agent.last_name}`)}
                                                disabled={deletingAgentId === agent.id}
                                                className="flex items-center gap-1 text-xs px-2 py-1 rounded transition-colors disabled:opacity-50"
                                                style={{ color: colors.errorText, background: colors.errorBg, border: `1px solid ${colors.errorBorder || 'rgba(220,50,50,0.3)'}` }}
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
                                        <tr key={`email-${agent.id}`} style={{ background: colors.infoBg, borderBottom: `1px solid ${colors.divider}` }}>
                                          <td colSpan={7} className="px-4 py-2">
                                            <div className="flex items-center gap-2 flex-wrap">
                                              <AtSign size={14} style={{ color: colors.infoText }} />
                                              <span className="text-xs font-semibold" style={{ color: colors.infoText }}>Change login email for {agent.first_name} {agent.last_name}:</span>
                                              <input
                                                type="email"
                                                value={changeEmailValue}
                                                onChange={(e) => setChangeEmailValue(e.target.value)}
                                                className="rounded-md px-2 py-1 text-xs flex-1 min-w-[200px]"
                                                style={inputStyle}
                                                placeholder="New email address"
                                              />
                                              <button
                                                onClick={() => handleChangeEmail(agent.id, `${agent.first_name} ${agent.last_name}`)}
                                                disabled={changingEmailSaving || !changeEmailValue.trim() || changeEmailValue === agent.email}
                                                className="text-xs font-semibold px-3 py-1 rounded-md disabled:opacity-50"
                                                style={{ background: colors.gold, color: '#fff' }}
                                              >
                                                {changingEmailSaving ? 'Saving...' : 'Save'}
                                              </button>
                                              <button
                                                onClick={() => { setChangingEmailForUserId(null); setChangeEmailValue('') }}
                                                className="text-xs px-2 py-1 rounded-md"
                                                style={{ color: colors.textMuted }}
                                              >
                                                Cancel
                                              </button>
                                            </div>
                                          </td>
                                        </tr>
                                      ),
                                      // Expanded deals row
                                      expandedAgentId === agent.id && (
                                        <tr key={`deals-${agent.id}`} style={{ background: colors.cardBg, borderBottom: idx < agentCount - 1 ? `1px solid ${colors.divider}` : 'none' }}>
                                          <td colSpan={7} className="px-4 py-4">
                                            <div style={{ marginLeft: '20px' }}>
                                              {/* Banking Information */}
                                              <div className="mb-5 p-3 rounded-lg" style={{ background: colors.tableRowHoverBg, border: `1px solid ${colors.border}` }}>
                                                <div className="flex items-center justify-between mb-2">
                                                  <h4 className="text-xs font-semibold flex items-center gap-1.5" style={{ color: colors.textPrimary }}>
                                                    <CreditCard size={13} style={{ color: colors.gold }} />
                                                    Banking Information
                                                  </h4>
                                                  <div className="flex items-center gap-2">
                                                    {agent.preauth_form_path && (
                                                      <button
                                                        onClick={async () => {
                                                          try {
                                                            setPreauthViewingAgentId(agent.id)
                                                            const { data } = await supabase.storage.from('agent-preauth-forms').createSignedUrl(agent.preauth_form_path!, 300)
                                                            if (data?.signedUrl) window.open(data.signedUrl, '_blank')
                                                          } catch { /* ignore */ }
                                                          setPreauthViewingAgentId(null)
                                                        }}
                                                        disabled={preauthViewingAgentId === agent.id}
                                                        className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors"
                                                        style={{ background: colors.inputBg, color: colors.gold, border: `1px solid ${colors.border}` }}
                                                      >
                                                        <Eye size={12} />
                                                        {preauthViewingAgentId === agent.id ? 'Loading...' : 'View Pre-Auth Form'}
                                                      </button>
                                                    )}
                                                    {!agent.preauth_form_path && (
                                                      <span className="text-xs" style={{ color: colors.textMuted }}>No pre-auth form uploaded</span>
                                                    )}
                                                  </div>
                                                </div>
                                                {/* Pending banking approval banner */}
                                                {agent.banking_approval_status === 'pending' && agent.banking_submitted_transit && (
                                                  <div className="mb-2 rounded-lg p-3" style={{ background: '#1A2240', border: '1px solid #2D3A5C' }}>
                                                    <div className="flex items-center justify-between mb-2">
                                                      <div className="flex items-center gap-1.5">
                                                        <AlertCircle size={13} style={{ color: '#7B9FE0' }} />
                                                        <span className="text-xs font-semibold" style={{ color: '#7B9FE0' }}>Pending Approval</span>
                                                        <span className="text-[10px]" style={{ color: colors.textMuted }}>
                                                          Submitted {agent.banking_submitted_at ? new Date(agent.banking_submitted_at).toLocaleDateString('en-CA') : ''}
                                                        </span>
                                                      </div>
                                                    </div>
                                                    <div className="flex items-center gap-4 mb-2">
                                                      <span className="text-xs font-mono" style={{ color: colors.textSecondary }}>
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
                                                          className="flex-1 min-w-[200px] rounded px-2 py-1.5 text-xs outline-none"
                                                          style={{ background: colors.inputBg, border: `1px solid ${colors.inputBorder}`, color: colors.inputText }}
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
                                                          className="px-3 py-1.5 rounded text-xs font-semibold text-white disabled:opacity-40"
                                                          style={{ background: '#993D3D' }}
                                                        >
                                                          Confirm Reject
                                                        </button>
                                                        <button onClick={() => { setBankingRejectingId(null); setBankingRejectReason('') }} className="text-xs" style={{ color: colors.textMuted }}>Cancel</button>
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
                                                          className="px-3 py-1.5 rounded text-xs font-semibold text-white disabled:opacity-40"
                                                          style={{ background: '#1A7A2E' }}
                                                        >
                                                          {bankingApprovingId === agent.id ? 'Approving...' : 'Approve'}
                                                        </button>
                                                        <button
                                                          onClick={() => setBankingRejectingId(agent.id)}
                                                          className="px-3 py-1.5 rounded text-xs font-semibold transition-colors"
                                                          style={{ background: '#2A1212', color: '#E07B7B', border: '1px solid #4A2020' }}
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
                                                      <CheckCircle size={13} style={{ color: colors.gold }} />
                                                      <span className="text-xs font-medium" style={{ color: colors.gold }}>Verified</span>
                                                    </div>
                                                    <span className="text-xs font-mono" style={{ color: colors.textSecondary }}>
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
                                                      className="text-xs font-medium transition-colors"
                                                      style={{ color: colors.textMuted }}
                                                      onMouseEnter={(e) => e.currentTarget.style.color = colors.gold}
                                                      onMouseLeave={(e) => e.currentTarget.style.color = colors.textMuted}
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
                                                    className="text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors"
                                                    style={{ background: colors.gold, color: '#FFFFFF' }}
                                                  >
                                                    Enter Banking Info
                                                  </button>
                                                )}
                                                {bankingEditingAgentId === agent.id && (
                                                  <div className="mt-3 flex items-end gap-2 flex-wrap">
                                                    <div>
                                                      <label className="block text-xs font-semibold mb-1" style={{ color: colors.textMuted }}>Transit (5 digits)</label>
                                                      <input
                                                        type="text"
                                                        maxLength={5}
                                                        value={bankingForm.transit}
                                                        onChange={(e) => setBankingForm(f => ({ ...f, transit: e.target.value.replace(/\D/g, '').slice(0, 5) }))}
                                                        placeholder="12345"
                                                        className="w-24 rounded px-2 py-1.5 text-xs font-mono outline-none"
                                                        style={{ background: colors.inputBg, border: `1px solid ${colors.inputBorder}`, color: colors.inputText }}
                                                        onFocus={(e) => e.currentTarget.style.borderColor = colors.gold}
                                                        onBlur={(e) => e.currentTarget.style.borderColor = colors.inputBorder}
                                                      />
                                                    </div>
                                                    <div>
                                                      <label className="block text-xs font-semibold mb-1" style={{ color: colors.textMuted }}>Institution (3 digits)</label>
                                                      <input
                                                        type="text"
                                                        maxLength={3}
                                                        value={bankingForm.institution}
                                                        onChange={(e) => setBankingForm(f => ({ ...f, institution: e.target.value.replace(/\D/g, '').slice(0, 3) }))}
                                                        placeholder="001"
                                                        className="w-16 rounded px-2 py-1.5 text-xs font-mono outline-none"
                                                        style={{ background: colors.inputBg, border: `1px solid ${colors.inputBorder}`, color: colors.inputText }}
                                                        onFocus={(e) => e.currentTarget.style.borderColor = colors.gold}
                                                        onBlur={(e) => e.currentTarget.style.borderColor = colors.inputBorder}
                                                      />
                                                    </div>
                                                    <div>
                                                      <label className="block text-xs font-semibold mb-1" style={{ color: colors.textMuted }}>Account (7-12 digits)</label>
                                                      <input
                                                        type="text"
                                                        maxLength={12}
                                                        value={bankingForm.account}
                                                        onChange={(e) => setBankingForm(f => ({ ...f, account: e.target.value.replace(/\D/g, '').slice(0, 12) }))}
                                                        placeholder="1234567"
                                                        className="w-36 rounded px-2 py-1.5 text-xs font-mono outline-none"
                                                        style={{ background: colors.inputBg, border: `1px solid ${colors.inputBorder}`, color: colors.inputText }}
                                                        onFocus={(e) => e.currentTarget.style.borderColor = colors.gold}
                                                        onBlur={(e) => e.currentTarget.style.borderColor = colors.inputBorder}
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
                                                      className="px-3 py-1.5 rounded text-xs font-semibold text-white transition-colors disabled:opacity-40"
                                                      style={{ background: '#1A7A2E' }}
                                                    >
                                                      {bankingSaving ? 'Saving...' : 'Save'}
                                                    </button>
                                                    <button
                                                      onClick={() => setBankingEditingAgentId(null)}
                                                      className="px-2 py-1.5 rounded text-xs font-medium transition-colors"
                                                      style={{ color: colors.textMuted }}
                                                      onMouseEnter={(e) => e.currentTarget.style.color = colors.textPrimary}
                                                      onMouseLeave={(e) => e.currentTarget.style.color = colors.textMuted}
                                                    >
                                                      Cancel
                                                    </button>
                                                    {bankingMessage && (
                                                      <span className="text-xs font-medium" style={{ color: bankingMessage.type === 'success' ? colors.gold : colors.errorText }}>
                                                        {bankingMessage.text}
                                                      </span>
                                                    )}
                                                  </div>
                                                )}
                                              </div>

                                              <h4 className="text-xs font-semibold mb-3" style={{ color: colors.textPrimary }}>Deal History</h4>
                                              {(agentDeals[agent.id]?.length ?? 0) === 0 ? (
                                                <p className="text-xs" style={{ color: colors.textMuted }}>No deals yet</p>
                                              ) : (
                                                <div className="space-y-2">
                                                  {agentDeals[agent.id]?.map((deal) => {
                                                    const dealBadgeStyle = getSharedStatusBadgeStyle(deal.status)
                                                    return (
                                                      <div key={deal.id} className="flex items-center justify-between p-2 rounded" style={{ background: colors.tableRowHoverBg, border: `1px solid ${colors.border}` }}>
                                                        <div className="flex-1">
                                                          <p className="text-xs font-medium" style={{ color: colors.textPrimary }}>{deal.property_address}</p>
                                                          <div className="flex items-center gap-3 mt-1">
                                                            <span className="inline-flex px-2 py-0.5 text-xs font-semibold rounded"
                                                              style={dealBadgeStyle}
                                                            >
                                                              {formatStatusLabel(deal.status)}
                                                            </span>
                                                            <span className="text-xs" style={{ color: colors.textMuted }}>
                                                              Advance: ${deal.advance_amount.toLocaleString('en-CA', { maximumFractionDigits: 0 })}
                                                            </span>
                                                            <span className="text-xs" style={{ color: colors.textMuted }}>
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
          className="fixed top-0 right-0 z-30 h-full flex flex-col shadow-xl"
          style={{
            width: kycPanelWidth,
            background: colors.cardBg,
            borderLeft: `2px solid ${colors.gold}`,
            animation: 'slideInRight 0.2s ease-out',
          }}
        >
          {/* Panel Header */}
          <div className="flex items-center justify-between px-3 py-2.5 flex-shrink-0" style={{ borderBottom: `1px solid ${colors.border}` }}>
            <div className="flex flex-col gap-0.5 min-w-0">
              <p className="text-sm font-semibold truncate" style={{ color: colors.textPrimary }}>
                <Shield size={13} className="inline mr-1" style={{ color: colors.gold }} />
                {kycPreviewPanel.agentName}
              </p>
              <p className="text-xs" style={{ color: colors.textMuted }}>ID Verification</p>
            </div>
            <div className="flex items-center gap-1.5 flex-shrink-0">
              <button
                onClick={() => { for (const u of kycPreviewPanel.originalUrls) window.open(u, '_blank') }}
                className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition"
                style={{ background: colors.inputBg, color: colors.gold, border: `1px solid ${colors.border}` }}
                onMouseEnter={(e) => e.currentTarget.style.background = colors.cardHoverBg}
                onMouseLeave={(e) => e.currentTarget.style.background = colors.inputBg}
                title="Open in new tab"
              >
                <ExternalLink size={11} />
              </button>
              <button
                onClick={closeKycPanel}
                className="p-1 rounded transition"
                style={{ color: colors.textMuted }}
                onMouseEnter={(e) => { e.currentTarget.style.background = colors.errorBg; e.currentTarget.style.color = colors.errorText }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = colors.textMuted }}
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
                    <p className="text-xs font-semibold mb-1.5" style={{ color: colors.textMuted }}>
                      {i === 0 ? 'Front' : i === 1 ? 'Back' : `Photo ${i + 1}`}
                    </p>
                  )}
                  {isPdf ? (
                    <iframe
                      src={blobUrl}
                      className="w-full border-0 rounded-lg"
                      style={{ height: 400, border: `1px solid ${colors.border}` }}
                      title={`${kycPreviewPanel.fileName} ${i + 1}`}
                    />
                  ) : (
                    <img
                      src={blobUrl}
                      alt={`${kycPreviewPanel.fileName} ${i + 1}`}
                      className="w-full rounded-lg"
                      style={{ border: `1px solid ${colors.border}` }}
                    />
                  )}
                </div>
              )
            })}
          </div>
          {/* Panel Footer — Approve/Reject actions */}
          <div className="flex items-center gap-2 px-3 py-2.5 flex-shrink-0" style={{ borderTop: `1px solid ${colors.border}`, background: colors.pageBg }}>
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
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-bold transition-all disabled:opacity-50"
              style={{ color: '#fff', background: '#1A7A2E', border: '1px solid #25A03C' }}
              onMouseEnter={(e) => { e.currentTarget.style.background = '#1E8C34' }}
              onMouseLeave={(e) => { e.currentTarget.style.background = '#1A7A2E' }}
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
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-bold transition-all"
              style={{ color: '#fff', background: '#993D3D', border: '1px solid #B84A4A' }}
              onMouseEnter={(e) => { e.currentTarget.style.background = '#AA4545' }}
              onMouseLeave={(e) => { e.currentTarget.style.background = '#993D3D' }}
            >
              <XCircle size={16} />
              Reject ID
            </button>
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
