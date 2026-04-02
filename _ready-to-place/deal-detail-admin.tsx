'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter, useParams } from 'next/navigation'
import {
  ArrowLeft, CheckCircle2, Circle, FileText, DollarSign, MapPin,
  User, Building2, AlertTriangle, XCircle, Shield, ChevronDown,
  ChevronUp, Banknote, RefreshCw, Trash2, Download, Paperclip
} from 'lucide-react'

interface Deal {
  id: string; agent_id: string; brokerage_id: string; status: string
  property_address: string; closing_date: string; gross_commission: number
  brokerage_split_pct: number; net_commission: number; days_until_closing: number
  discount_fee: number; advance_amount: number; brokerage_referral_fee: number
  amount_due_from_brokerage: number; funding_date: string | null
  repayment_date: string | null; source: string; denial_reason: string | null
  notes: string | null; created_at: string; updated_at: string
}

interface ChecklistItem {
  id: string; deal_id: string; checklist_item: string; is_checked: boolean
  checked_by: string | null; checked_at: string | null; notes: string | null
}

interface DealDocument {
  id: string; deal_id: string; uploaded_by: string; document_type: string
  file_name: string; file_path: string; file_size: number
  upload_source: string; notes: string | null; created_at: string
}

const DOCUMENT_TYPES = [
  { value: 'agreement_of_purchase_sale', label: 'Agreement of Purchase and Sale' },
  { value: 'trade_record_sheet', label: 'Trade Record Sheet / Deal Sheet' },
  { value: 'commission_invoice', label: 'Commission Invoice' },
  { value: 'notice_of_fulfillment', label: 'Notice of Fulfillment/Waiver' },
  { value: 'kyc_fintrac', label: 'KYC / FINTRAC Documents' },
  { value: 'agent_id', label: 'Agent ID Verification' },
  { value: 'commission_direction_letter', label: 'Commission Direction Letter' },
  { value: 'void_cheque', label: 'Void Cheque / Banking Info' },
  { value: 'signed_agreement', label: 'Signed Commission Purchase Agreement' },
  { value: 'other', label: 'Other' },
]

interface Agent {
  id: string; first_name: string; last_name: string; email: string
  phone: string | null; reco_number: string | null; status: string
  flagged_by_brokerage: boolean; outstanding_recovery: number | null
}

interface Brokerage {
  id: string; name: string; brand: string | null; address: string | null
  phone: string | null; email: string | null; status: string
  referral_fee_percentage: number | null; transaction_system: string | null
}

const STATUS_FLOW: Record<string, string[]> = {
  submitted: ['under_review', 'denied'], under_review: ['approved', 'denied'],
  approved: ['funded', 'denied'], funded: ['repaid'], repaid: ['closed'],
}

const STATUS_LABELS: Record<string, string> = {
  submitted: 'Submitted', under_review: 'Under Review', approved: 'Approved',
  funded: 'Funded', repaid: 'Repaid', closed: 'Closed', denied: 'Denied', cancelled: 'Cancelled',
}

const STATUS_COLORS: Record<string, string> = {
  submitted: 'bg-yellow-100 text-yellow-800 border-yellow-200',
  under_review: 'bg-blue-100 text-blue-800 border-blue-200',
  approved: 'bg-green-100 text-green-800 border-green-200',
  funded: 'bg-purple-100 text-purple-800 border-purple-200',
  repaid: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  closed: 'bg-gray-100 text-gray-800 border-gray-200',
  denied: 'bg-red-100 text-red-800 border-red-200',
  cancelled: 'bg-orange-100 text-orange-800 border-orange-200',
}

const ACTION_LABELS: Record<string, { label: string; icon: any; color: string }> = {
  under_review: { label: 'Start Review', icon: RefreshCw, color: 'bg-blue-600 hover:bg-blue-700' },
  approved: { label: 'Approve Deal', icon: CheckCircle2, color: 'bg-green-600 hover:bg-green-700' },
  funded: { label: 'Mark as Funded', icon: Banknote, color: 'bg-purple-600 hover:bg-purple-700' },
  repaid: { label: 'Mark as Repaid', icon: DollarSign, color: 'bg-emerald-600 hover:bg-emerald-700' },
  closed: { label: 'Close Deal', icon: CheckCircle2, color: 'bg-gray-600 hover:bg-gray-700' },
  denied: { label: 'Deny Deal', icon: XCircle, color: 'bg-red-600 hover:bg-red-700' },
}

export default function DealDetailPage() {
  const [deal, setDeal] = useState<Deal | null>(null)
  const [agent, setAgent] = useState<Agent | null>(null)
  const [brokerage, setBrokerage] = useState<Brokerage | null>(null)
  const [checklist, setChecklist] = useState<ChecklistItem[]>([])
  const [documents, setDocuments] = useState<DealDocument[]>([])
  const [loading, setLoading] = useState(true)
  const [updating, setUpdating] = useState(false)
  const [denialReason, setDenialReason] = useState('')
  const [showDenialInput, setShowDenialInput] = useState(false)
  const [statusMessage, setStatusMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [checklistExpanded, setChecklistExpanded] = useState(true)
  const [docsExpanded, setDocsExpanded] = useState(true)
  const router = useRouter()
  const params = useParams()
  const dealId = params.id as string
  const supabase = createClient()

  useEffect(() => { loadDealData() }, [dealId])

  async function loadDealData() {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { router.push('/login'); return }
    const { data: profile } = await supabase.from('user_profiles').select('*').eq('id', user.id).single()
    if (!profile || (profile.role !== 'super_admin' && profile.role !== 'firm_funds_admin')) { router.push('/login'); return }
    const { data: dealData, error: dealError } = await supabase.from('deals').select('*').eq('id', dealId).single()
    if (dealError || !dealData) { router.push('/admin'); return }
    setDeal(dealData)
    const { data: agentData } = await supabase.from('agents').select('*').eq('id', dealData.agent_id).single()
    setAgent(agentData)
    const { data: brokerageData } = await supabase.from('brokerages').select('*').eq('id', dealData.brokerage_id).single()
    setBrokerage(brokerageData)
    const { data: checklistData } = await supabase.from('underwriting_checklist').select('*').eq('deal_id', dealId).order('id', { ascending: true })
    setChecklist(checklistData || [])
    const { data: docsData } = await supabase.from('deal_documents').select('*').eq('deal_id', dealId).order('created_at', { ascending: false })
    setDocuments(docsData || [])
    setLoading(false)
  }

  const handleChecklistToggle = async (item: ChecklistItem) => {
    const newChecked = !item.is_checked
    const { data: { user } } = await supabase.auth.getUser()
    const { error } = await supabase.from('underwriting_checklist').update({
      is_checked: newChecked, checked_by: newChecked ? user?.id : null, checked_at: newChecked ? new Date().toISOString() : null,
    }).eq('id', item.id)
    if (!error) {
      setChecklist(prev => prev.map(c => c.id === item.id ? { ...c, is_checked: newChecked, checked_by: newChecked ? user?.id || null : null, checked_at: newChecked ? new Date().toISOString() : null } : c))
    }
  }

  const handleStatusChange = async (newStatus: string) => {
    if (!deal) return
    if (newStatus === 'denied' && !denialReason.trim()) { setShowDenialInput(true); return }
    setUpdating(true); setStatusMessage(null)
    const updateData: any = { status: newStatus }
    if (newStatus === 'funded') updateData.funding_date = new Date().toISOString().split('T')[0]
    if (newStatus === 'repaid') updateData.repayment_date = new Date().toISOString().split('T')[0]
    if (newStatus === 'denied') updateData.denial_reason = denialReason.trim()
    if (newStatus === 'funded') {
      const today = new Date(); today.setHours(0, 0, 0, 0)
      const closing = new Date(deal.closing_date + 'T00:00:00')
      const actualDays = Math.max(1, Math.ceil((closing.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)))
      const discountFee = (deal.net_commission / 1000) * 0.75 * actualDays
      updateData.days_until_closing = actualDays
      updateData.discount_fee = Math.round(discountFee * 100) / 100
      updateData.advance_amount = Math.round((deal.net_commission - discountFee) * 100) / 100
      updateData.brokerage_referral_fee = Math.round(discountFee * (brokerage?.referral_fee_percentage || 0.20) * 100) / 100
      updateData.amount_due_from_brokerage = deal.net_commission
    }
    const { error } = await supabase.from('deals').update(updateData).eq('id', deal.id)
    if (error) { setStatusMessage({ type: 'error', text: `Failed to update: ${error.message}` }) }
    else { setStatusMessage({ type: 'success', text: `Deal status updated to ${STATUS_LABELS[newStatus]}` }); setDeal(prev => prev ? { ...prev, ...updateData } : null); setShowDenialInput(false); setDenialReason('') }
    setUpdating(false)
  }

  const handleDocumentDownload = async (doc: DealDocument) => {
    const { data, error } = await supabase.storage.from('deal-documents').createSignedUrl(doc.file_path, 60)
    if (error) { setStatusMessage({ type: 'error', text: 'Failed to generate download link' }); return }
    window.open(data.signedUrl, '_blank')
  }

  const handleDocumentDelete = async (doc: DealDocument) => {
    if (!confirm(`Delete "${doc.file_name}"? This cannot be undone.`)) return
    await supabase.storage.from('deal-documents').remove([doc.file_path])
    const { error: dbError } = await supabase.from('deal_documents').delete().eq('id', doc.id)
    if (dbError) { setStatusMessage({ type: 'error', text: `Failed to delete: ${dbError.message}` }); return }
    setDocuments(prev => prev.filter(d => d.id !== doc.id))
    setStatusMessage({ type: 'success', text: 'Document deleted' })
  }

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }
  const getDocTypeLabel = (type: string) => DOCUMENT_TYPES.find(d => d.value === type)?.label || type
  const formatCurrency = (amount: number) => new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(amount)
  const formatDate = (date: string) => new Date(date).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' })
  const formatDateTime = (date: string) => new Date(date).toLocaleString('en-CA', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

  const checkedCount = checklist.filter(c => c.is_checked).length
  const totalChecklist = checklist.length
  const checklistPct = totalChecklist > 0 ? Math.round((checkedCount / totalChecklist) * 100) : 0

  if (loading) return (<div className="min-h-screen flex items-center justify-center bg-gray-50"><div className="text-gray-500 text-lg">Loading deal...</div></div>)
  if (!deal) return (<div className="min-h-screen flex items-center justify-center bg-gray-50"><div className="text-gray-500 text-lg">Deal not found</div></div>)

  const availableActions = STATUS_FLOW[deal.status] || []

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white shadow-sm border-b">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center py-4">
            <div className="flex items-center gap-3">
              <button onClick={() => router.push('/admin')} className="text-gray-400 hover:text-gray-600"><ArrowLeft size={20} /></button>
              <div>
                <h1 className="text-xl font-bold text-gray-900">{deal.property_address}</h1>
                <p className="text-sm text-gray-500">Deal submitted {formatDateTime(deal.created_at)}</p>
              </div>
            </div>
            <span className={`inline-flex px-3 py-1.5 text-sm font-semibold rounded-full border ${STATUS_COLORS[deal.status]}`}>{STATUS_LABELS[deal.status]}</span>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {statusMessage && (
          <div className={`mb-6 p-4 rounded-lg border ${statusMessage.type === 'success' ? 'bg-green-50 border-green-200 text-green-800' : 'bg-red-50 border-red-200 text-red-800'}`}>
            <p className="text-sm font-medium">{statusMessage.text}</p>
          </div>
        )}

        <div className="bg-white rounded-lg shadow-sm border mb-6 p-6">
          <h3 className="text-sm font-semibold text-gray-700 mb-3">Deal Pipeline</h3>
          <div className="flex items-center gap-1">
            {['submitted', 'under_review', 'approved', 'funded', 'repaid', 'closed'].map((status, index) => {
              const isActive = status === deal.status
              const isPast = ['submitted', 'under_review', 'approved', 'funded', 'repaid', 'closed'].indexOf(deal.status) > index
              const isDenied = deal.status === 'denied'
              return (
                <div key={status} className="flex-1">
                  <div className={`h-2 rounded-full ${isDenied ? 'bg-red-200' : isActive ? 'bg-blue-500' : isPast ? 'bg-green-500' : 'bg-gray-200'}`} />
                  <p className={`text-xs mt-1.5 text-center ${isActive ? 'text-blue-700 font-semibold' : isPast ? 'text-green-700' : 'text-gray-400'}`}>{STATUS_LABELS[status]}</p>
                </div>
              )
            })}
          </div>
          {deal.status === 'denied' && (<div className="mt-3 p-3 bg-red-50 rounded-lg border border-red-200"><p className="text-sm text-red-700"><strong>Denied:</strong> {deal.denial_reason || 'No reason provided'}</p></div>)}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">

            <div className="bg-white rounded-lg shadow-sm border">
              <div className="px-6 py-4 border-b"><h3 className="text-lg font-semibold text-gray-900 flex items-center gap-2"><MapPin size={18} className="text-gray-400" />Deal Details</h3></div>
              <div className="p-6">
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div><span className="text-gray-500">Property Address</span><p className="text-gray-900 font-medium mt-0.5">{deal.property_address}</p></div>
                  <div><span className="text-gray-500">Closing Date</span><p className="text-gray-900 font-medium mt-0.5">{formatDate(deal.closing_date)}</p></div>
                  <div><span className="text-gray-500">Days Until Closing</span><p className="text-gray-900 font-medium mt-0.5">{deal.days_until_closing} days</p></div>
                  <div><span className="text-gray-500">Source</span><p className="text-gray-900 font-medium mt-0.5">{deal.source === 'manual_portal' ? 'Agent Portal' : deal.source === 'nexone_auto' ? 'Nexone Auto' : deal.source}</p></div>
                  {deal.funding_date && (<div><span className="text-gray-500">Funding Date</span><p className="text-gray-900 font-medium mt-0.5">{formatDate(deal.funding_date)}</p></div>)}
                  {deal.repayment_date && (<div><span className="text-gray-500">Repayment Date</span><p className="text-gray-900 font-medium mt-0.5">{formatDate(deal.repayment_date)}</p></div>)}
                </div>
                {deal.notes && (<div className="mt-4 pt-4 border-t"><span className="text-sm text-gray-500">Notes</span><p className="text-sm text-gray-900 mt-0.5 whitespace-pre-line">{deal.notes}</p></div>)}
              </div>
            </div>

            <div className="bg-white rounded-lg shadow-sm border">
              <div className="px-6 py-4 border-b"><h3 className="text-lg font-semibold text-gray-900 flex items-center gap-2"><DollarSign size={18} className="text-gray-400" />Financial Breakdown</h3></div>
              <div className="p-6">
                <div className="space-y-3 text-sm">
                  <div className="flex justify-between"><span className="text-gray-500">Gross Commission</span><span className="text-gray-900 font-medium">{formatCurrency(deal.gross_commission)}</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">Brokerage Split ({deal.brokerage_split_pct}%)</span><span className="text-red-600 font-medium">-{formatCurrency(deal.gross_commission - deal.net_commission)}</span></div>
                  <div className="flex justify-between border-t pt-2"><span className="text-gray-700 font-medium">Agent Net Commission</span><span className="text-gray-900 font-semibold">{formatCurrency(deal.net_commission)}</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">Discount Fee ($0.75/$1K/day x {deal.days_until_closing} days)</span><span className="text-red-600 font-medium">-{formatCurrency(deal.discount_fee)}</span></div>
                  <div className="flex justify-between border-t pt-3 bg-green-50 -mx-6 px-6 py-3 rounded-b-lg"><span className="text-green-900 font-bold text-base">Advance to Agent</span><span className="text-green-700 font-bold text-xl">{formatCurrency(deal.advance_amount)}</span></div>
                </div>
                <div className="mt-6 pt-4 border-t">
                  <h4 className="text-sm font-semibold text-gray-700 mb-3">Firm Funds Revenue</h4>
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between"><span className="text-gray-500">Total Discount Fee Earned</span><span className="text-gray-900 font-medium">{formatCurrency(deal.discount_fee)}</span></div>
                    <div className="flex justify-between"><span className="text-gray-500">Brokerage Referral Fee ({((brokerage?.referral_fee_percentage || 0.20) * 100).toFixed(0)}%)</span><span className="text-red-600 font-medium">-{formatCurrency(deal.brokerage_referral_fee)}</span></div>
                    <div className="flex justify-between border-t pt-2"><span className="text-gray-700 font-semibold">Net Revenue to Firm Funds</span><span className="text-gray-900 font-bold">{formatCurrency(deal.discount_fee - deal.brokerage_referral_fee)}</span></div>
                  </div>
                </div>
                <div className="mt-6 pt-4 border-t">
                  <h4 className="text-sm font-semibold text-gray-700 mb-3">Settlement at Closing</h4>
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between"><span className="text-gray-500">Amount Due from Brokerage</span><span className="text-gray-900 font-bold">{formatCurrency(deal.amount_due_from_brokerage)}</span></div>
                    <div className="flex justify-between text-xs text-gray-400"><span>(Agent&apos;s net commission held by brokerage in trust)</span></div>
                  </div>
                </div>
              </div>
            </div>

            <div className="bg-white rounded-lg shadow-sm border">
              <div className="px-6 py-4 border-b flex items-center justify-between cursor-pointer hover:bg-gray-50" onClick={() => setChecklistExpanded(!checklistExpanded)}>
                <div className="flex items-center gap-3">
                  <h3 className="text-lg font-semibold text-gray-900 flex items-center gap-2"><Shield size={18} className="text-gray-400" />Underwriting Checklist</h3>
                  <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${checklistPct === 100 ? 'bg-green-100 text-green-700' : checklistPct > 50 ? 'bg-yellow-100 text-yellow-700' : 'bg-gray-100 text-gray-600'}`}>{checkedCount}/{totalChecklist} ({checklistPct}%)</span>
                </div>
                {checklistExpanded ? <ChevronUp size={18} className="text-gray-400" /> : <ChevronDown size={18} className="text-gray-400" />}
              </div>
              {checklistExpanded && (
                <div className="p-6">
                  <div className="w-full bg-gray-200 rounded-full h-2 mb-6"><div className={`h-2 rounded-full transition-all duration-300 ${checklistPct === 100 ? 'bg-green-500' : checklistPct > 50 ? 'bg-yellow-500' : 'bg-blue-500'}`} style={{ width: `${checklistPct}%` }} /></div>
                  <div className="space-y-1">
                    {checklist.map((item) => (
                      <div key={item.id} className={`flex items-center gap-3 p-3 rounded-lg cursor-pointer transition-colors ${item.is_checked ? 'bg-green-50 hover:bg-green-100' : 'hover:bg-gray-50'}`} onClick={() => handleChecklistToggle(item)}>
                        {item.is_checked ? <CheckCircle2 size={20} className="text-green-600 flex-shrink-0" /> : <Circle size={20} className="text-gray-300 flex-shrink-0" />}
                        <span className={`text-sm flex-1 ${item.is_checked ? 'text-green-800 line-through' : 'text-gray-700'}`}>{item.checklist_item}</span>
                        {item.checked_at && <span className="text-xs text-gray-400">{formatDateTime(item.checked_at)}</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="bg-white rounded-lg shadow-sm border">
              <div className="px-6 py-4 border-b flex items-center justify-between cursor-pointer hover:bg-gray-50" onClick={() => setDocsExpanded(!docsExpanded)}>
                <div className="flex items-center gap-3">
                  <h3 className="text-lg font-semibold text-gray-900 flex items-center gap-2"><Paperclip size={18} className="text-gray-400" />Documents</h3>
                  <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">{documents.length} file{documents.length !== 1 ? 's' : ''}</span>
                </div>
                {docsExpanded ? <ChevronUp size={18} className="text-gray-400" /> : <ChevronDown size={18} className="text-gray-400" />}
              </div>
              {docsExpanded && (
                <div className="p-6">
                  {documents.length === 0 ? (
                    <div className="text-center text-gray-400 py-4"><FileText className="mx-auto mb-2 text-gray-300" size={32} /><p className="text-sm">No documents uploaded yet</p></div>
                  ) : (
                    <div className="space-y-2">
                      {documents.map((doc) => (
                        <div key={doc.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg hover:bg-gray-100 transition-colors">
                          <div className="flex items-center gap-3 flex-1 min-w-0">
                            <FileText size={18} className="text-gray-400 flex-shrink-0" />
                            <div className="min-w-0">
                              <p className="text-sm font-medium text-gray-900 truncate">{doc.file_name}</p>
                              <p className="text-xs text-gray-500">{getDocTypeLabel(doc.document_type)} &middot; {formatFileSize(doc.file_size)} &middot; {formatDateTime(doc.created_at)}</p>
                            </div>
                          </div>
                          <div className="flex items-center gap-1 flex-shrink-0 ml-2">
                            <button onClick={() => handleDocumentDownload(doc)} className="p-2 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors" title="Download"><Download size={16} /></button>
                            <button onClick={() => handleDocumentDelete(doc)} className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors" title="Delete"><Trash2 size={16} /></button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

          </div>

          <div className="space-y-6">
            {availableActions.length > 0 && (
              <div className="bg-white rounded-lg shadow-sm border">
                <div className="px-6 py-4 border-b"><h3 className="text-sm font-semibold text-gray-900">Actions</h3></div>
                <div className="p-4 space-y-3">
                  {showDenialInput && (
                    <div className="mb-3">
                      <label className="block text-sm font-medium text-gray-700 mb-1">Reason for denial *</label>
                      <textarea value={denialReason} onChange={(e) => setDenialReason(e.target.value)} placeholder="Explain why this deal is being denied..." rows={3} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-gray-900 focus:border-transparent outline-none resize-none" />
                    </div>
                  )}
                  {availableActions.map((nextStatus) => {
                    const action = ACTION_LABELS[nextStatus]
                    if (!action) return null
                    const Icon = action.icon
                    if (nextStatus === 'denied' && showDenialInput) {
                      return (
                        <div key={nextStatus} className="flex gap-2">
                          <button onClick={() => handleStatusChange('denied')} disabled={updating || !denialReason.trim()} className="flex-1 flex items-center justify-center gap-2 text-white py-2.5 px-4 rounded-lg font-medium text-sm disabled:opacity-50 bg-red-600 hover:bg-red-700"><XCircle size={16} />{updating ? 'Updating...' : 'Confirm Denial'}</button>
                          <button onClick={() => { setShowDenialInput(false); setDenialReason('') }} className="px-3 py-2.5 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 text-sm">Cancel</button>
                        </div>
                      )
                    }
                    return (
                      <button key={nextStatus} onClick={() => handleStatusChange(nextStatus)} disabled={updating} className={`w-full flex items-center justify-center gap-2 text-white py-2.5 px-4 rounded-lg font-medium text-sm disabled:opacity-50 ${action.color}`}><Icon size={16} />{updating ? 'Updating...' : action.label}</button>
                    )
                  })}
                  {deal.status === 'approved' && (<p className="text-xs text-gray-400 text-center mt-2">Marking as funded will recalculate financials based on today&apos;s date.</p>)}
                </div>
              </div>
            )}

            {agent && (
              <div className="bg-white rounded-lg shadow-sm border">
                <div className="px-6 py-4 border-b"><h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2"><User size={14} className="text-gray-400" />Agent</h3></div>
                <div className="p-4 space-y-3 text-sm">
                  <div><span className="text-gray-500">Name</span><p className="text-gray-900 font-medium">{agent.first_name} {agent.last_name}</p></div>
                  <div><span className="text-gray-500">Email</span><p className="text-gray-900 font-medium">{agent.email}</p></div>
                  {agent.phone && (<div><span className="text-gray-500">Phone</span><p className="text-gray-900 font-medium">{agent.phone}</p></div>)}
                  {agent.reco_number && (<div><span className="text-gray-500">RECO #</span><p className="text-gray-900 font-medium">{agent.reco_number}</p></div>)}
                  <div><span className="text-gray-500">Status</span><p className={`font-medium ${agent.status === 'active' ? 'text-green-700' : 'text-red-700'}`}>{agent.status.charAt(0).toUpperCase() + agent.status.slice(1)}</p></div>
                  {agent.flagged_by_brokerage && (<div className="bg-red-50 border border-red-200 rounded-lg p-3 flex items-start gap-2"><AlertTriangle size={16} className="text-red-600 mt-0.5 flex-shrink-0" /><p className="text-xs text-red-700 font-medium">This agent has been flagged by their brokerage</p></div>)}
                </div>
              </div>
            )}

            {brokerage && (
              <div className="bg-white rounded-lg shadow-sm border">
                <div className="px-6 py-4 border-b"><h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2"><Building2 size={14} className="text-gray-400" />Brokerage</h3></div>
                <div className="p-4 space-y-3 text-sm">
                  <div><span className="text-gray-500">Name</span><p className="text-gray-900 font-medium">{brokerage.name}</p></div>
                  {brokerage.brand && (<div><span className="text-gray-500">Brand</span><p className="text-gray-900 font-medium">{brokerage.brand}</p></div>)}
                  {brokerage.email && (<div><span className="text-gray-500">Email</span><p className="text-gray-900 font-medium">{brokerage.email}</p></div>)}
                  {brokerage.phone && (<div><span className="text-gray-500">Phone</span><p className="text-gray-900 font-medium">{brokerage.phone}</p></div>)}
                  {brokerage.referral_fee_percentage && (<div><span className="text-gray-500">Referral Fee</span><p className="text-gray-900 font-medium">{(brokerage.referral_fee_percentage * 100).toFixed(0)}%</p></div>)}
                  {brokerage.transaction_system && (<div><span className="text-gray-500">Transaction System</span><p className="text-gray-900 font-medium">{brokerage.transaction_system}</p></div>)}
                </div>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  )
}
