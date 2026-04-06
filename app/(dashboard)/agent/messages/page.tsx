'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import {
  MessageSquare, AlertTriangle, ExternalLink, Inbox, Search, Upload,
  CheckCircle2, ChevronDown, ChevronUp, ArrowLeft,
} from 'lucide-react'
import { useTheme } from '@/lib/theme'
import { formatRelativeTime } from '@/lib/formatting'
import { getStatusBadgeStyle, formatStatusLabel } from '@/lib/constants'
import AgentHeader from '@/components/AgentHeader'
import MessageThread from '@/components/messaging/MessageThread'
import MessageInput from '@/components/messaging/MessageInput'
import type { MessageData } from '@/components/messaging/MessageBubble'
import {
  getAgentInbox,
  getDealMessages,
  getNewMessages,
  markDealMessagesRead,
  sendAgentReply,
  type InboxDeal,
} from '@/lib/actions/notification-actions'
import { uploadDocument } from '@/lib/actions/deal-actions'

interface DocumentReturnItem {
  id: string
  deal_id: string
  document_id: string
  reason: string
  status: string
  created_at: string
  property_address: string
  deal_status: string
  deal_documents?: { file_name: string; document_type: string }
}

export default function AgentMessagesPage() {
  const [profile, setProfile] = useState<any>(null)
  const [agent, setAgent] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [inbox, setInbox] = useState<InboxDeal[]>([])
  const [pendingReturns, setPendingReturns] = useState<DocumentReturnItem[]>([])
  const [selectedDealId, setSelectedDealId] = useState<string | null>(null)
  const [messages, setMessages] = useState<MessageData[]>([])
  const [messagesLoading, setMessagesLoading] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [statusMessage, setStatusMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [returnsExpanded, setReturnsExpanded] = useState(false)
  const [uploadingReturnId, setUploadingReturnId] = useState<string | null>(null)
  const [uploadedReturnIds, setUploadedReturnIds] = useState<Set<string>>(new Set())
  const [isMobile, setIsMobile] = useState(false)
  const router = useRouter()
  const supabase = createClient()
  const { colors } = useTheme()

  // Mobile detection
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  // Load agent profile and inbox
  useEffect(() => {
    async function load() {
      try {
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) { router.push('/login'); return }
        const { data: profileData } = await supabase.from('user_profiles').select('*').eq('id', user.id).single()
        if (!profileData || profileData.role !== 'agent') { router.push('/login'); return }
        setProfile(profileData)

        if (profileData.agent_id) {
          const { data: agentData } = await supabase.from('agents').select('*, brokerages(name, logo_url, brand_color)').eq('id', profileData.agent_id).single()
          setAgent(agentData)
          await loadInbox(profileData.agent_id)
        }
      } catch (err) {
        console.error('Messages page load error:', err)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  const loadInbox = useCallback(async (agentId: string) => {
    const result = await getAgentInbox(agentId)
    if (result.success && result.data) {
      setInbox(result.data.inbox)
      setPendingReturns(result.data.pendingReturns)
    }
  }, [])

  // Load messages for a selected deal
  const selectDeal = useCallback(async (dealId: string) => {
    setSelectedDealId(dealId)
    setMessagesLoading(true)
    setReturnsExpanded(false)
    setUploadedReturnIds(new Set())

    const result = await getDealMessages(dealId)
    if (result.success && result.data) {
      setMessages(result.data)
    }
    setMessagesLoading(false)

    // Mark as read
    if (agent?.id) {
      await markDealMessagesRead({ agentId: agent.id, dealId })
      setInbox(prev => prev.map(item =>
        item.deal_id === dealId ? { ...item, unread_message_count: 0 } : item
      ))
    }
  }, [agent?.id])

  // Poll for new messages every 5 seconds
  useEffect(() => {
    if (!selectedDealId || messages.length === 0) return
    const interval = setInterval(async () => {
      const lastMsg = messages[messages.length - 1]
      if (!lastMsg) return
      const result = await getNewMessages({ dealId: selectedDealId, afterTimestamp: lastMsg.created_at })
      if (result.success && result.data && result.data.length > 0) {
        setMessages(prev => {
          const existingIds = new Set(prev.map(m => m.id))
          const newMsgs = result.data.filter((m: any) => !existingIds.has(m.id))
          return newMsgs.length > 0 ? [...prev, ...newMsgs] : prev
        })
        // Mark as read
        if (agent?.id) {
          markDealMessagesRead({ agentId: agent.id, dealId: selectedDealId })
          setInbox(prev => prev.map(item =>
            item.deal_id === selectedDealId ? { ...item, unread_message_count: 0 } : item
          ))
        }
      }
    }, 5000)
    return () => clearInterval(interval)
  }, [selectedDealId, messages, agent?.id])

  // Send message with optional file
  const handleSend = async (message: string, file?: File | null) => {
    if (!selectedDealId) return

    let filePath: string | null = null
    let fileName: string | null = null
    let fileSize: number | null = null
    let fileType: string | null = null

    // Upload file if attached
    if (file) {
      try {
        const fd = new FormData()
        fd.append('file', file)
        fd.append('dealId', selectedDealId)
        fd.append('documentType', 'other')
        const uploadResult = await uploadDocument(fd)
        if (!uploadResult.success) {
          setStatusMessage({ type: 'error', text: uploadResult.error || 'File upload failed' })
          return
        }
        filePath = uploadResult.data?.file_path || null
        fileName = file.name
        fileSize = file.size
        fileType = file.type
      } catch (err) {
        setStatusMessage({ type: 'error', text: 'File upload failed' })
        return
      }
    }

    try {
      const result = await sendAgentReply({
        dealId: selectedDealId,
        message,
        filePath,
        fileName,
        fileSize,
        fileType,
      })

      if (result.success) {
        // Add message to thread — create fallback if data is incomplete
        const newMsg = result.data || {
          id: crypto.randomUUID(),
          sender_role: 'agent',
          sender_name: profile?.full_name || 'You',
          message,
          is_email_reply: false,
          file_path: filePath,
          file_name: fileName,
          file_size: fileSize,
          file_type: fileType,
          created_at: new Date().toISOString(),
        }
        setMessages(prev => [...prev, newMsg])
        setInbox(prev => prev.map(item =>
          item.deal_id === selectedDealId
            ? { ...item, latest_message: message, latest_message_at: newMsg.created_at, latest_sender_role: 'agent', latest_sender_name: profile?.full_name || 'You' }
            : item
        ))
      } else {
        setStatusMessage({ type: 'error', text: result.error || 'Failed to send message' })
      }
    } catch (err) {
      console.error('Send message error:', err)
      setStatusMessage({ type: 'error', text: 'Failed to send message' })
    }
  }

  // Back to inbox (mobile)
  const handleBack = () => {
    setSelectedDealId(null)
    setMessages([])
  }

  const filteredInbox = searchQuery.trim()
    ? inbox.filter(item => item.property_address.toLowerCase().includes(searchQuery.toLowerCase()))
    : inbox

  const selectedDeal = inbox.find(d => d.deal_id === selectedDealId)
  const selectedDealReturns = pendingReturns.filter(r => r.deal_id === selectedDealId)

  // Mobile: show either list or thread
  const showList = !isMobile || !selectedDealId
  const showThread = !isMobile || !!selectedDealId

  if (loading) {
    return (
      <div className="min-h-screen" style={{ background: colors.pageBg }}>
        <div style={{ background: colors.headerBgGradient }} className="h-24" />
        <main className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="rounded-xl p-8" style={{ background: colors.cardBg, border: `1px solid ${colors.border}` }}>
            <div className="h-4 w-32 rounded animate-pulse mb-4" style={{ background: colors.skeletonBase }} />
            {[1,2,3].map(i => (
              <div key={i} className="h-16 rounded-lg animate-pulse mb-3" style={{ background: colors.skeletonHighlight }} />
            ))}
          </div>
        </main>
      </div>
    )
  }

  return (
    <div className="h-screen flex flex-col overflow-hidden" style={{ background: colors.pageBg }}>
      <AgentHeader
        agentName={profile?.full_name || ''}
        agentId={agent?.id || ''}
        brokerageLogo={agent?.brokerages?.logo_url}
        brokerageName={agent?.brokerages?.name}
      />

      <main className="flex-1 overflow-hidden max-w-5xl w-full mx-auto px-2 sm:px-4 md:px-6 lg:px-8 py-2 sm:py-4">
        {/* Status message */}
        {statusMessage && (
          <div
            className="mb-3 p-3 rounded-xl text-sm font-medium"
            style={statusMessage.type === 'success'
              ? { background: colors.successBg, border: `1px solid ${colors.successBorder}`, color: colors.successText }
              : { background: colors.errorBg, border: `1px solid ${colors.errorBorder}`, color: colors.errorText }
            }
            onClick={() => setStatusMessage(null)}
          >
            {statusMessage.text}
          </div>
        )}

        {inbox.length === 0 ? (
          <div className="rounded-xl p-12 text-center flex flex-col items-center justify-center h-full" style={{ background: colors.cardBg, border: `1px solid ${colors.border}` }}>
            <Inbox className="mx-auto mb-4" size={48} style={{ color: colors.textFaint }} />
            <p className="text-lg font-semibold" style={{ color: colors.textSecondary }}>No active deals</p>
            <p className="text-sm mt-2" style={{ color: colors.textMuted }}>
              Submit an advance request to get started.
            </p>
          </div>
        ) : (
          <div className="rounded-xl overflow-hidden flex h-full" style={{ background: colors.cardBg, border: `1px solid ${colors.border}` }}>

            {/* LEFT PANEL — Deal list */}
            {showList && (
              <div className="flex flex-col" style={{ width: isMobile ? '100%' : '340px', minWidth: isMobile ? '100%' : '280px', borderRight: isMobile ? 'none' : `1px solid ${colors.border}` }}>
                <div className="p-3" style={{ borderBottom: `1px solid ${colors.border}` }}>
                  <div className="relative">
                    <Search size={14} style={{ color: colors.textMuted, position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)' }} />
                    <input
                      type="text"
                      placeholder="Search deals..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="w-full rounded-lg pl-8 pr-3 py-2 text-sm outline-none"
                      style={{ border: `1px solid ${colors.inputBorder}`, color: colors.inputText, background: colors.inputBg }}
                      onFocus={(e) => { e.currentTarget.style.borderColor = colors.gold }}
                      onBlur={(e) => { e.currentTarget.style.borderColor = colors.inputBorder }}
                    />
                  </div>
                </div>

                <div className="flex-1 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
                  {filteredInbox.map((item) => {
                    const isSelected = item.deal_id === selectedDealId
                    const hasUnread = item.unread_message_count > 0
                    const hasReturns = item.pending_return_count > 0

                    return (
                      <button
                        key={item.deal_id}
                        onClick={() => selectDeal(item.deal_id)}
                        className="w-full text-left px-4 py-3.5 transition-colors"
                        style={{
                          background: isSelected ? colors.tableHeaderBg : 'transparent',
                          borderBottom: `1px solid ${colors.divider}`,
                          borderLeft: isSelected ? `3px solid ${colors.gold}` : '3px solid transparent',
                        }}
                        onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = colors.cardHoverBg }}
                        onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = 'transparent' }}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <p className={`text-sm truncate ${hasUnread ? 'font-bold' : 'font-medium'}`} style={{ color: colors.textPrimary }}>
                              {item.property_address}
                            </p>
                            <div className="flex items-center gap-2 mt-1">
                              <span className="inline-flex px-1.5 py-0.5 text-[10px] font-semibold rounded" style={getStatusBadgeStyle(item.deal_status)}>
                                {formatStatusLabel(item.deal_status)}
                              </span>
                            </div>
                          </div>
                          <div className="flex flex-col items-end gap-1 flex-shrink-0">
                            {item.latest_message_at && (
                              <span className="text-[10px]" style={{ color: colors.textFaint }}>
                                {formatRelativeTime(item.latest_message_at)}
                              </span>
                            )}
                            <div className="flex items-center gap-1">
                              {hasUnread && (
                                <span className="inline-flex items-center justify-center h-4 min-w-[16px] px-1 rounded-full text-[10px] font-bold" style={{ background: colors.gold, color: '#FFFFFF' }}>
                                  {item.unread_message_count}
                                </span>
                              )}
                              {hasReturns && (
                                <span className="inline-flex items-center justify-center h-4 min-w-[16px] px-1 rounded-full text-[10px] font-bold" style={{ background: '#EF4444', color: '#FFFFFF' }} title="Returned documents need attention">!</span>
                              )}
                            </div>
                          </div>
                        </div>
                        <p className={`text-xs mt-1.5 truncate ${hasUnread ? 'font-medium' : ''}`} style={{ color: hasUnread ? colors.textSecondary : colors.textMuted }}>
                          {item.total_message_count === 0 && item.pending_return_count === 0
                            ? 'No messages yet — tap to start a conversation'
                            : <>
                                {item.latest_sender_role === 'admin' ? 'Firm Funds: ' : item.latest_sender_role === 'agent' ? 'You: ' : ''}
                                {item.latest_message || (item.pending_return_count > 0 ? 'Document returned for revision' : '')}
                              </>
                          }
                        </p>
                      </button>
                    )
                  })}
                  {filteredInbox.length === 0 && searchQuery.trim() && (
                    <div className="px-4 py-8 text-center">
                      <p className="text-xs" style={{ color: colors.textMuted }}>No matching deals</p>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* RIGHT PANEL — Messages thread */}
            {showThread && (
              <div className="flex-1 flex flex-col min-w-0">
                {!selectedDealId ? (
                  <div className="flex-1 flex items-center justify-center">
                    <div className="text-center">
                      <MessageSquare size={40} style={{ color: colors.textFaint }} className="mx-auto mb-3" />
                      <p className="text-sm font-medium" style={{ color: colors.textSecondary }}>Select a deal to view messages</p>
                      <p className="text-xs mt-1" style={{ color: colors.textMuted }}>Choose from the list on the left</p>
                    </div>
                  </div>
                ) : (
                  <>
                    {/* Thread header */}
                    <div className="px-4 sm:px-5 py-3 flex items-center justify-between gap-2" style={{ borderBottom: `1px solid ${colors.border}` }}>
                      {isMobile && (
                        <button onClick={handleBack} className="p-1 mr-1" style={{ color: colors.textMuted }}>
                          <ArrowLeft size={20} />
                        </button>
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-bold truncate" style={{ color: colors.textPrimary }}>
                          {selectedDeal?.property_address}
                        </p>
                        <div className="flex items-center gap-2 mt-0.5">
                          {selectedDeal && (
                            <span className="inline-flex px-1.5 py-0.5 text-[10px] font-semibold rounded" style={getStatusBadgeStyle(selectedDeal.deal_status)}>
                              {formatStatusLabel(selectedDeal.deal_status)}
                            </span>
                          )}
                          <span className="text-[10px]" style={{ color: colors.textFaint }}>
                            {selectedDeal?.total_message_count || 0} messages
                          </span>
                        </div>
                      </div>
                      <button
                        onClick={() => router.push(`/agent/deals/${selectedDealId}`)}
                        className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg transition-colors flex-shrink-0"
                        style={{ color: colors.gold, border: `1px solid ${colors.border}` }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = colors.cardHoverBg; e.currentTarget.style.borderColor = colors.gold }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = colors.border }}
                      >
                        <ExternalLink size={12} />
                        <span className="hidden sm:inline">View Deal</span>
                      </button>
                    </div>

                    {/* Returned docs alert */}
                    {selectedDealReturns.length > 0 && (
                      <div style={{ background: '#2A1212', borderBottom: '1px solid #4A2020' }}>
                        <button onClick={() => setReturnsExpanded(!returnsExpanded)} className="w-full px-4 sm:px-5 py-2.5 flex items-center justify-between gap-3">
                          <div className="flex items-center gap-2 min-w-0 flex-1">
                            <AlertTriangle size={14} style={{ color: '#F87171', flexShrink: 0 }} />
                            <span className="text-xs font-bold truncate" style={{ color: '#F87171' }}>
                              {selectedDealReturns.filter(r => !uploadedReturnIds.has(r.id)).length === 0
                                ? 'All returned documents re-uploaded!'
                                : `${selectedDealReturns.length} document${selectedDealReturns.length > 1 ? 's' : ''} returned for revision`}
                            </span>
                          </div>
                          {returnsExpanded ? <ChevronUp size={14} style={{ color: '#F87171' }} /> : <ChevronDown size={14} style={{ color: '#F87171' }} />}
                        </button>
                        {returnsExpanded && (
                          <div className="px-4 sm:px-5 pb-3 space-y-2">
                            {selectedDealReturns.map(ret => (
                              <div key={ret.id} className="rounded-lg px-3 py-2.5" style={{ background: '#3A1818', border: '1px solid #4A2020' }}>
                                <div className="flex items-start justify-between gap-2">
                                  <div className="min-w-0 flex-1">
                                    <p className="text-xs font-semibold truncate" style={{ color: '#FCA5A5' }}>{ret.deal_documents?.file_name || 'Document'}</p>
                                    <p className="text-[10px] mt-0.5" style={{ color: '#F87171' }}>Reason: {ret.reason}</p>
                                  </div>
                                  {uploadedReturnIds.has(ret.id) ? (
                                    <div className="flex items-center gap-1 flex-shrink-0">
                                      <CheckCircle2 size={12} style={{ color: '#5FA873' }} />
                                      <span className="text-[10px] font-semibold" style={{ color: '#5FA873' }}>Uploaded</span>
                                    </div>
                                  ) : (
                                    <label className="flex items-center gap-1 flex-shrink-0 text-[10px] font-semibold px-2.5 py-1.5 rounded-md cursor-pointer transition-colors"
                                      style={{ background: '#4A2020', color: '#FCA5A5' }}
                                      onMouseEnter={(e) => e.currentTarget.style.background = '#5A2525'}
                                      onMouseLeave={(e) => e.currentTarget.style.background = '#4A2020'}
                                    >
                                      <Upload size={10} />
                                      {uploadingReturnId === ret.id ? 'Uploading...' : 'Re-upload'}
                                      <input type="file" accept=".pdf,.jpg,.jpeg,.png,.doc,.docx" className="hidden"
                                        disabled={uploadingReturnId === ret.id}
                                        onChange={async (e) => {
                                          const file = e.target.files?.[0]
                                          if (!file || !selectedDealId) return
                                          setUploadingReturnId(ret.id)
                                          try {
                                            const fd = new FormData()
                                            fd.append('file', file)
                                            fd.append('dealId', selectedDealId)
                                            fd.append('documentType', ret.deal_documents?.document_type || 'other')
                                            const result = await uploadDocument(fd)
                                            if (result.success) {
                                              setUploadedReturnIds(prev => new Set([...prev, ret.id]))
                                            } else {
                                              setStatusMessage({ type: 'error', text: result.error || 'Upload failed' })
                                            }
                                          } catch { setStatusMessage({ type: 'error', text: 'Upload failed' }) }
                                          setUploadingReturnId(null)
                                          e.target.value = ''
                                        }}
                                      />
                                    </label>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Messages */}
                    <MessageThread
                      messages={messages}
                      viewerRole="agent"
                      loading={messagesLoading}
                      emptyMessage="No messages yet — send a message to the Firm Funds team below"
                    />

                    {/* Input */}
                    <MessageInput
                      onSend={handleSend}
                      placeholder={messages.length > 0 ? 'Type a reply... (Shift+Enter for new line)' : 'Type a message... (Shift+Enter for new line)'}
                    />
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  )
}
