'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter, useParams } from 'next/navigation'
import {
  ArrowLeft, FileText, DollarSign, MapPin, Clock,
  Upload, Download, ChevronDown, ChevronUp, Paperclip,
  CheckCircle2, AlertTriangle
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

export default function AgentDealDetailPage() {
  const [deal, setDeal] = useState<Deal | null>(null)
  const [documents, setDocuments] = useState<DealDocument[]>([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [uploadDocType, setUploadDocType] = useState('agreement_of_purchase_sale')
  const [docsExpanded, setDocsExpanded] = useState(true)
  const [statusMessage, setStatusMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const router = useRouter()
  const params = useParams()
  const dealId = params.id as string
  const supabase = createClient()

  useEffect(() => { loadDealData() }, [dealId])

  async function loadDealData() {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { router.push('/login'); return }

    const { data: profile } = await supabase.from('user_profiles').select('*').eq('id', user.id).single()
    if (!profile || profile.role !== 'agent') { router.push('/login'); return }

    const { data: dealData, error: dealError } = await supabase.from('deals').select('*').eq('id', dealId).single()
    if (dealError || !dealData) { router.push('/agent'); return }

    // Ensure this agent owns this deal
    if (dealData.agent_id !== profile.agent_id) { router.push('/agent'); return }

    setDeal(dealData)

    const { data: docsData } = await supabase
      .from('deal_documents')
      .select('*')
      .eq('deal_id', dealId)
      .order('created_at', { ascending: false })
    setDocuments(docsData || [])
    setLoading(false)
  }

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0 || !deal) return
    setUploading(true)
    setStatusMessage(null)

    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { setStatusMessage({ type: 'error', text: 'You must be logged in to upload.' }); setUploading(false); return }

    for (let i = 0; i < files.length; i++) {
      const file = files[i]

      // Validate file size (10MB max)
      if (file.size > 10 * 1024 * 1024) {
        setStatusMessage({ type: 'error', text: `${file.name} exceeds 10MB limit.` })
        continue
      }

      const filePath = `${deal.id}/${Date.now()}_${file.name}`

      const { error: uploadError } = await supabase.storage
        .from('deal-documents')
        .upload(filePath, file)

      if (uploadError) {
        console.error('Storage upload error:', uploadError)
        setStatusMessage({ type: 'error', text: `Failed to upload ${file.name}: ${uploadError.message}` })
        continue
      }

      const { data: docRecord, error: insertError } = await supabase
        .from('deal_documents')
        .insert({
          deal_id: deal.id,
          uploaded_by: user.id,
          document_type: uploadDocType,
          file_name: file.name,
          file_path: filePath,
          file_size: file.size,
          upload_source: 'agent_portal',
        })
        .select()
        .single()

      if (insertError) {
        console.error('DB insert error:', insertError)
        setStatusMessage({ type: 'error', text: `Failed to save ${file.name}: ${insertError.message}` })
        continue
      }

      if (docRecord) setDocuments(prev => [docRecord, ...prev])
    }

    setUploading(false)
    if (!statusMessage || statusMessage.type !== 'error') {
      setStatusMessage({ type: 'success', text: `Document${files.length > 1 ? 's' : ''} uploaded successfully` })
    }
    e.target.value = ''
  }

  const handleDocumentDownload = async (doc: DealDocument) => {
    const { data, error } = await supabase.storage.from('deal-documents').createSignedUrl(doc.file_path, 60)
    if (error) { setStatusMessage({ type: 'error', text: 'Failed to generate download link' }); return }
    window.open(data.signedUrl, '_blank')
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

  if (loading) return (<div className="min-h-screen flex items-center justify-center bg-gray-50"><div className="text-gray-500 text-lg">Loading deal...</div></div>)
  if (!deal) return (<div className="min-h-screen flex items-center justify-center bg-gray-50"><div className="text-gray-500 text-lg">Deal not found</div></div>)

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white shadow-sm border-b">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center py-4">
            <div className="flex items-center gap-3">
              <button onClick={() => router.push('/agent')} className="text-gray-400 hover:text-gray-600"><ArrowLeft size={20} /></button>
              <div>
                <h1 className="text-xl font-bold text-gray-900">{deal.property_address}</h1>
                <p className="text-sm text-gray-500">Submitted {formatDateTime(deal.created_at)}</p>
              </div>
            </div>
            <span className={`inline-flex px-3 py-1.5 text-sm font-semibold rounded-full border ${STATUS_COLORS[deal.status]}`}>
              {STATUS_LABELS[deal.status]}
            </span>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {statusMessage && (
          <div className={`mb-6 p-4 rounded-lg border ${statusMessage.type === 'success' ? 'bg-green-50 border-green-200 text-green-800' : 'bg-red-50 border-red-200 text-red-800'}`}>
            <p className="text-sm font-medium">{statusMessage.text}</p>
          </div>
        )}

        {/* Deal Pipeline */}
        <div className="bg-white rounded-lg shadow-sm border mb-6 p-6">
          <h3 className="text-sm font-semibold text-gray-700 mb-3">Deal Progress</h3>
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
          {deal.status === 'denied' && (
            <div className="mt-3 p-3 bg-red-50 rounded-lg border border-red-200">
              <div className="flex items-start gap-2">
                <AlertTriangle size={16} className="text-red-600 mt-0.5 flex-shrink-0" />
                <p className="text-sm text-red-700"><strong>Denied:</strong> {deal.denial_reason || 'No reason provided'}</p>
              </div>
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left column - Deal info & docs */}
          <div className="lg:col-span-2 space-y-6">

            {/* Deal Details */}
            <div className="bg-white rounded-lg shadow-sm border">
              <div className="px-6 py-4 border-b">
                <h3 className="text-lg font-semibold text-gray-900 flex items-center gap-2"><MapPin size={18} className="text-gray-400" />Deal Details</h3>
              </div>
              <div className="p-6">
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div><span className="text-gray-500">Property Address</span><p className="text-gray-900 font-medium mt-0.5">{deal.property_address}</p></div>
                  <div><span className="text-gray-500">Closing Date</span><p className="text-gray-900 font-medium mt-0.5">{formatDate(deal.closing_date)}</p></div>
                  <div><span className="text-gray-500">Days Until Closing</span><p className="text-gray-900 font-medium mt-0.5">{deal.days_until_closing} days</p></div>
                  <div><span className="text-gray-500">Source</span><p className="text-gray-900 font-medium mt-0.5">{deal.source === 'manual_portal' ? 'Agent Portal' : deal.source === 'nexone_auto' ? 'Nexone Auto' : deal.source}</p></div>
                  {deal.funding_date && (<div><span className="text-gray-500">Funding Date</span><p className="text-gray-900 font-medium mt-0.5">{formatDate(deal.funding_date)}</p></div>)}
                  {deal.repayment_date && (<div><span className="text-gray-500">Repayment Date</span><p className="text-gray-900 font-medium mt-0.5">{formatDate(deal.repayment_date)}</p></div>)}
                </div>
                {deal.notes && (
                  <div className="mt-4 pt-4 border-t">
                    <span className="text-sm text-gray-500">Notes</span>
                    <p className="text-sm text-gray-900 mt-0.5 whitespace-pre-line">{deal.notes}</p>
                  </div>
                )}
              </div>
            </div>

            {/* Documents Section - WITH UPLOAD */}
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
                  {/* Upload Area */}
                  <div className="border-2 border-dashed border-gray-300 rounded-lg p-6 mb-6 text-center hover:border-gray-400 transition-colors">
                    <Upload className="mx-auto text-gray-400 mb-2" size={28} />
                    <p className="text-sm text-gray-600 mb-3">Upload documents for this deal</p>
                    <div className="flex items-center justify-center gap-3 mb-3">
                      <select
                        value={uploadDocType}
                        onChange={(e) => setUploadDocType(e.target.value)}
                        className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-gray-900 focus:border-transparent outline-none bg-white"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {DOCUMENT_TYPES.map(dt => (<option key={dt.value} value={dt.value}>{dt.label}</option>))}
                      </select>
                    </div>
                    <label className="inline-flex items-center gap-2 bg-gray-900 text-white px-4 py-2 rounded-lg hover:bg-gray-800 font-medium text-sm cursor-pointer">
                      <Upload size={16} />{uploading ? 'Uploading...' : 'Choose Files'}
                      <input
                        type="file"
                        multiple
                        onChange={handleFileUpload}
                        disabled={uploading}
                        className="hidden"
                        accept=".pdf,.doc,.docx,.jpg,.jpeg,.png,.gif,.xls,.xlsx,.csv,.txt"
                      />
                    </label>
                    <p className="text-xs text-gray-400 mt-2">PDF, Word, Excel, Images up to 10MB each</p>
                  </div>

                  {/* Document List */}
                  {documents.length === 0 ? (
                    <div className="text-center text-gray-400 py-4">
                      <FileText className="mx-auto mb-2 text-gray-300" size={32} />
                      <p className="text-sm">No documents uploaded yet</p>
                      <p className="text-xs mt-1">Upload your APS, trade sheet, and other documents to speed up your advance.</p>
                    </div>
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
                          <button onClick={() => handleDocumentDownload(doc)} className="p-2 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors flex-shrink-0 ml-2" title="Download">
                            <Download size={16} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Right column - Financial summary */}
          <div className="space-y-6">
            <div className="bg-white rounded-lg shadow-sm border">
              <div className="px-6 py-4 border-b">
                <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2"><DollarSign size={14} className="text-gray-400" />Financial Summary</h3>
              </div>
              <div className="p-4 space-y-3 text-sm">
                <div className="flex justify-between"><span className="text-gray-500">Gross Commission</span><span className="text-gray-900 font-medium">{formatCurrency(deal.gross_commission)}</span></div>
                <div className="flex justify-between"><span className="text-gray-500">Brokerage Split ({deal.brokerage_split_pct}%)</span><span className="text-red-600 font-medium">-{formatCurrency(deal.gross_commission - deal.net_commission)}</span></div>
                <div className="flex justify-between border-t pt-2"><span className="text-gray-700 font-medium">Your Net Commission</span><span className="text-gray-900 font-semibold">{formatCurrency(deal.net_commission)}</span></div>
                <div className="flex justify-between"><span className="text-gray-500">Discount Fee</span><span className="text-red-600 font-medium">-{formatCurrency(deal.discount_fee)}</span></div>
                <div className="flex justify-between border-t pt-3 bg-green-50 -mx-4 px-4 py-3 rounded-b-lg">
                  <span className="text-green-900 font-bold">Advance Amount</span>
                  <span className="text-green-700 font-bold text-lg">{formatCurrency(deal.advance_amount)}</span>
                </div>
              </div>
            </div>

            {/* Timeline / Status Info */}
            <div className="bg-white rounded-lg shadow-sm border">
              <div className="px-6 py-4 border-b">
                <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2"><Clock size={14} className="text-gray-400" />Timeline</h3>
              </div>
              <div className="p-4 space-y-3 text-sm">
                <div className="flex items-start gap-3">
                  <CheckCircle2 size={16} className="text-green-500 mt-0.5 flex-shrink-0" />
                  <div>
                    <p className="text-gray-900 font-medium">Submitted</p>
                    <p className="text-xs text-gray-500">{formatDateTime(deal.created_at)}</p>
                  </div>
                </div>
                {deal.funding_date && (
                  <div className="flex items-start gap-3">
                    <CheckCircle2 size={16} className="text-purple-500 mt-0.5 flex-shrink-0" />
                    <div>
                      <p className="text-gray-900 font-medium">Funded</p>
                      <p className="text-xs text-gray-500">{formatDate(deal.funding_date)}</p>
                    </div>
                  </div>
                )}
                {deal.repayment_date && (
                  <div className="flex items-start gap-3">
                    <CheckCircle2 size={16} className="text-emerald-500 mt-0.5 flex-shrink-0" />
                    <div>
                      <p className="text-gray-900 font-medium">Repaid</p>
                      <p className="text-xs text-gray-500">{formatDate(deal.repayment_date)}</p>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* What to upload helper */}
            <div className="bg-blue-50 rounded-lg border border-blue-200 p-4">
              <h4 className="text-sm font-semibold text-blue-900 mb-2">Documents We Need</h4>
              <ul className="text-xs text-blue-800 space-y-1.5">
                <li className="flex items-start gap-1.5"><span className="mt-0.5">•</span>Agreement of Purchase and Sale</li>
                <li className="flex items-start gap-1.5"><span className="mt-0.5">•</span>Trade Record Sheet / Deal Sheet</li>
                <li className="flex items-start gap-1.5"><span className="mt-0.5">•</span>Notice of Fulfillment/Waiver</li>
                <li className="flex items-start gap-1.5"><span className="mt-0.5">•</span>Commission Invoice</li>
                <li className="flex items-start gap-1.5"><span className="mt-0.5">•</span>KYC / FINTRAC Documents</li>
                <li className="flex items-start gap-1.5"><span className="mt-0.5">•</span>Void Cheque or Banking Info</li>
              </ul>
              <p className="text-xs text-blue-700 mt-2">Uploading all documents upfront helps us process your advance faster.</p>
            </div>
          </div>
        </div>
      </main>
    </div>
  )
}
