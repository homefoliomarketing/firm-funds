'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import {
  MessageSquare, AlertTriangle, ExternalLink, Inbox, Search, Upload,
  CheckCircle2, ChevronDown, ChevronUp, ArrowLeft,
} from 'lucide-react'
import { formatRelativeTime } from '@/lib/formatting'
import { getStatusBadgeClass, formatStatusLabel } from '@/lib/constants'
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
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'

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

  const handleSend = async (message: string, file?: File | null) => {
    if (!selectedDealId) return

    let filePath: string | null = null
    let fileName: string | null = null
    let fileSize: number | null = null
    let fileType: string | null = null

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

  const handleBack = () => {
    setSelectedDealId(null)
    setMessages([])
  }

  const filteredInbox = searchQuery.trim()
    ? inbox.filter(item => item.property_address.toLowerCase().includes(searchQuery.toLowerCase()))
    : inbox

  const selectedDeal = inbox.find(d => d.deal_id === selectedDealId)
  const selectedDealReturns = pendingReturns.filter(r => r.deal_id === selectedDealId)

  const showList = !isMobile || !selectedDealId
  const showThread = !isMobile || !!selectedDealId

  if (loading) {
    return (
      <div className="min-h-screen bg-background">
        <div className="h-24 bg-card border-b border-border" />
        <main className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="rounded-xl p-8 bg-card border border-border">
            <Skeleton className="h-4 w-32 mb-4" />
            {[1,2,3].map(i => (
              <Skeleton key={i} className="h-16 rounded-lg mb-3" />
            ))}
          </div>
        </main>
      </div>
    )
  }

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-background">
      <AgentHeader
        agentName={profile?.full_name || ''}
        agentId={agent?.id || ''}
        brokerageLogo={agent?.brokerages?.logo_url}
        brokerageName={agent?.brokerages?.name}
      />

      <main id="main-content" className="flex-1 overflow-hidden max-w-5xl w-full mx-auto px-2 sm:px-4 md:px-6 lg:px-8 py-2 sm:py-4">
        <h1 className="sr-only">Agent Messages</h1>

        {/* Status message */}
        {statusMessage && (
          <div
            className={`mb-3 p-3 rounded-xl text-sm font-medium cursor-pointer border ${
              statusMessage.type === 'success'
                ? 'bg-primary/10 border-primary/30 text-primary'
                : 'bg-destructive/10 border-destructive/30 text-destructive'
            }`}
            onClick={() => setStatusMessage(null)}
          >
            {statusMessage.text}
          </div>
        )}

        {inbox.length === 0 ? (
          <div className="rounded-xl p-12 text-center flex flex-col items-center justify-center h-full bg-card border border-border">
            <Inbox className="mx-auto mb-4 text-muted-foreground/50" size={48} />
            <p className="text-lg font-semibold text-muted-foreground">No active deals</p>
            <p className="text-sm mt-2 text-muted-foreground">
              Submit an advance request to get started.
            </p>
          </div>
        ) : (
          <div className="rounded-xl overflow-hidden flex h-full bg-card border border-border">

            {/* LEFT PANEL — Deal list */}
            {showList && (
              <section
                aria-label="Deal list"
                className="flex flex-col border-r border-border"
                style={{ width: isMobile ? '100%' : '340px', minWidth: isMobile ? '100%' : '280px', borderRight: isMobile ? 'none' : undefined }}
              >
                <div className="p-3 border-b border-border">
                  <div className="relative">
                    <Search size={14} className="text-muted-foreground absolute left-2.5 top-1/2 -translate-y-1/2" />
                    <Input
                      type="text"
                      placeholder="Search deals..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="pl-8"
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
                        className={`w-full text-left px-4 py-3.5 transition-colors border-b border-border/50 ${
                          isSelected
                            ? 'bg-muted border-l-[3px] border-l-primary'
                            : 'border-l-[3px] border-l-transparent hover:bg-muted/50'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <p className={`text-sm truncate ${hasUnread ? 'font-bold text-foreground' : 'font-medium text-foreground'}`}>
                              {item.property_address}
                            </p>
                            <div className="flex items-center gap-2 mt-1">
                              <span className={`inline-flex px-1.5 py-0.5 text-[10px] font-semibold rounded ${getStatusBadgeClass(item.deal_status)}`}>
                                {formatStatusLabel(item.deal_status)}
                              </span>
                            </div>
                          </div>
                          <div className="flex flex-col items-end gap-1 flex-shrink-0">
                            {item.latest_message_at && (
                              <span className="text-[10px] text-muted-foreground/60">
                                {formatRelativeTime(item.latest_message_at)}
                              </span>
                            )}
                            <div className="flex items-center gap-1">
                              {hasUnread && (
                                <span className="inline-flex items-center justify-center h-4 min-w-[16px] px-1 rounded-full text-[10px] font-bold bg-red-500 text-white">
                                  {item.unread_message_count}
                                </span>
                              )}
                              {hasReturns && (
                                <span className="inline-flex items-center justify-center h-4 min-w-[16px] px-1 rounded-full text-[10px] font-bold bg-destructive text-destructive-foreground" title="Returned documents need attention">!</span>
                              )}
                            </div>
                          </div>
                        </div>
                        <p className={`text-xs mt-1.5 truncate ${hasUnread ? 'font-medium text-muted-foreground' : 'text-muted-foreground/70'}`}>
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
                      <p className="text-xs text-muted-foreground">No matching deals</p>
                    </div>
                  )}
                </div>
              </section>
            )}

            {/* RIGHT PANEL — Messages thread */}
            {showThread && (
              <section aria-label="Message thread" className="flex-1 flex flex-col min-w-0">
                {!selectedDealId ? (
                  <div className="flex-1 flex items-center justify-center">
                    <div className="text-center">
                      <MessageSquare size={40} className="text-muted-foreground/40 mx-auto mb-3" />
                      <p className="text-sm font-medium text-muted-foreground">Select a deal to view messages</p>
                      <p className="text-xs mt-1 text-muted-foreground/70">Choose from the list on the left</p>
                    </div>
                  </div>
                ) : (
                  <>
                    {/* Thread header */}
                    <div className="px-4 sm:px-5 py-3 flex items-center justify-between gap-2 border-b border-border">
                      {isMobile && (
                        <button onClick={handleBack} className="p-1 mr-1 text-muted-foreground hover:text-foreground transition-colors">
                          <ArrowLeft size={20} />
                        </button>
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-bold truncate text-foreground">
                          {selectedDeal?.property_address}
                        </p>
                        <div className="flex items-center gap-2 mt-0.5">
                          {selectedDeal && (
                            <span className={`inline-flex px-1.5 py-0.5 text-[10px] font-semibold rounded ${getStatusBadgeClass(selectedDeal.deal_status)}`}>
                              {formatStatusLabel(selectedDeal.deal_status)}
                            </span>
                          )}
                          <span className="text-[10px] text-muted-foreground/60">
                            {selectedDeal?.total_message_count || 0} messages
                          </span>
                        </div>
                      </div>
                      <button
                        onClick={() => router.push(`/agent/deals/${selectedDealId}`)}
                        className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg transition-colors flex-shrink-0 text-primary border border-border hover:bg-muted hover:border-primary"
                      >
                        <ExternalLink size={12} />
                        <span className="hidden sm:inline">View Deal</span>
                      </button>
                    </div>

                    {/* Returned docs alert */}
                    {selectedDealReturns.length > 0 && (
                      <div className="bg-status-red-muted border-b border-status-red-border">
                        <button onClick={() => setReturnsExpanded(!returnsExpanded)} className="w-full px-4 sm:px-5 py-2.5 flex items-center justify-between gap-3">
                          <div className="flex items-center gap-2 min-w-0 flex-1">
                            <AlertTriangle size={14} className="text-destructive flex-shrink-0" />
                            <span className="text-xs font-bold truncate text-destructive">
                              {selectedDealReturns.filter(r => !uploadedReturnIds.has(r.id)).length === 0
                                ? 'All returned documents re-uploaded!'
                                : `${selectedDealReturns.length} document${selectedDealReturns.length > 1 ? 's' : ''} returned for revision`}
                            </span>
                          </div>
                          {returnsExpanded
                            ? <ChevronUp size={14} className="text-destructive" />
                            : <ChevronDown size={14} className="text-destructive" />}
                        </button>
                        {returnsExpanded && (
                          <div className="px-4 sm:px-5 pb-3 space-y-2">
                            {selectedDealReturns.map(ret => (
                              <div key={ret.id} className="rounded-lg px-3 py-2.5 bg-status-red-muted border border-status-red-border">
                                <div className="flex items-start justify-between gap-2">
                                  <div className="min-w-0 flex-1">
                                    <p className="text-xs font-semibold truncate text-red-300">{ret.deal_documents?.file_name || 'Document'}</p>
                                    <p className="text-[10px] mt-0.5 text-destructive">Reason: {ret.reason}</p>
                                  </div>
                                  {uploadedReturnIds.has(ret.id) ? (
                                    <div className="flex items-center gap-1 flex-shrink-0">
                                      <CheckCircle2 size={12} className="text-primary" />
                                      <span className="text-[10px] font-semibold text-primary">Uploaded</span>
                                    </div>
                                  ) : (
                                    <label
                                      className="flex items-center gap-1 flex-shrink-0 text-[10px] font-semibold px-2.5 py-1.5 rounded-md cursor-pointer transition-colors bg-status-red-border text-red-300 hover:bg-status-red-border/80"
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
              </section>
            )}
          </div>
        )}
      </main>
    </div>
  )
}
