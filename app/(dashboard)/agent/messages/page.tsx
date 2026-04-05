'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import {
  MessageSquare, AlertTriangle, Send, FileText, ExternalLink,
  Inbox, ChevronRight, Clock, Search,
} from 'lucide-react'
import { useTheme } from '@/lib/theme'
import { formatDate, formatDateTime } from '@/lib/formatting'
import { getStatusBadgeStyle, formatStatusLabel } from '@/lib/constants'
import AgentHeader from '@/components/AgentHeader'
import {
  getAgentInbox,
  getDealMessages,
  markDealMessagesRead,
  sendAgentReply,
  type InboxDeal,
} from '@/lib/actions/notification-actions'

interface DealMessageItem {
  id: string
  sender_role: string
  sender_name: string | null
  message: string
  is_email_reply: boolean
  created_at: string
}

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
  const [messages, setMessages] = useState<DealMessageItem[]>([])
  const [messagesLoading, setMessagesLoading] = useState(false)
  const [replyText, setReplyText] = useState('')
  const [replySending, setReplySending] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [statusMessage, setStatusMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const router = useRouter()
  const supabase = createClient()
  const { colors } = useTheme()

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
          const { data: agentData } = await supabase.from('agents').select('*').eq('id', profileData.agent_id).single()
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
    setReplyText('')

    const result = await getDealMessages(dealId)
    if (result.success && result.data) {
      setMessages(result.data)
    }
    setMessagesLoading(false)

    // Mark as read
    if (agent?.id) {
      await markDealMessagesRead({ agentId: agent.id, dealId })
      // Update inbox unread count locally
      setInbox(prev => prev.map(item =>
        item.deal_id === dealId ? { ...item, unread_message_count: 0 } : item
      ))
    }
  }, [agent?.id])

  // Scroll to bottom when messages change
  useEffect(() => {
    if (messages.length > 0) {
      setTimeout(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
      }, 100)
    }
  }, [messages.length])

  // Send reply
  const handleSendReply = async () => {
    if (!selectedDealId || !replyText.trim()) return
    setReplySending(true)
    const result = await sendAgentReply({ dealId: selectedDealId, message: replyText })
    if (result.success && result.data) {
      setMessages(prev => [...prev, result.data])
      setReplyText('')
      // Update inbox preview
      setInbox(prev => prev.map(item =>
        item.deal_id === selectedDealId
          ? {
              ...item,
              latest_message: result.data.message,
              latest_message_at: result.data.created_at,
              latest_sender_role: 'agent',
              latest_sender_name: profile?.full_name || 'You',
            }
          : item
      ))
    } else {
      setStatusMessage({ type: 'error', text: result.error || 'Failed to send reply' })
    }
    setReplySending(false)
  }

  // Filter inbox by search
  const filteredInbox = searchQuery.trim()
    ? inbox.filter(item => item.property_address.toLowerCase().includes(searchQuery.toLowerCase()))
    : inbox

  const selectedDeal = inbox.find(d => d.deal_id === selectedDealId)
  const selectedDealReturns = pendingReturns.filter(r => r.deal_id === selectedDealId)

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
      />

      <main className="flex-1 overflow-hidden max-w-5xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-4">
        {/* Status message */}
        {statusMessage && (
          <div
            className="mb-4 p-3 rounded-xl text-sm font-medium"
            style={statusMessage.type === 'success'
              ? { background: colors.successBg, border: `1px solid ${colors.successBorder}`, color: colors.successText }
              : { background: colors.errorBg, border: `1px solid ${colors.errorBorder}`, color: colors.errorText }
            }
          >
            {statusMessage.text}
          </div>
        )}

        {inbox.length === 0 && pendingReturns.length === 0 ? (
          /* Empty state */
          <div className="rounded-xl p-12 text-center flex flex-col items-center justify-center h-full" style={{ background: colors.cardBg, border: `1px solid ${colors.border}` }}>
            <Inbox className="mx-auto mb-4" size={48} style={{ color: colors.textFaint }} />
            <p className="text-lg font-semibold" style={{ color: colors.textSecondary }}>No messages yet</p>
            <p className="text-sm mt-2" style={{ color: colors.textMuted }}>
              When Firm Funds sends you messages or returns documents, they&apos;ll show up here.
            </p>
          </div>
        ) : (
          /* Inbox layout */
          <div
            className="rounded-xl overflow-hidden flex h-full"
            style={{
              background: colors.cardBg,
              border: `1px solid ${colors.border}`,
            }}
          >
            {/* LEFT PANEL — Deal list */}
            <div
              className="flex flex-col"
              style={{
                width: '340px',
                minWidth: '280px',
                borderRight: `1px solid ${colors.border}`,
              }}
            >
              {/* Search */}
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

              {/* Deal list */}
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
                          <p
                            className={`text-sm truncate ${hasUnread ? 'font-bold' : 'font-medium'}`}
                            style={{ color: colors.textPrimary }}
                          >
                            {item.property_address}
                          </p>
                          <div className="flex items-center gap-2 mt-1">
                            <span
                              className="inline-flex px-1.5 py-0.5 text-[10px] font-semibold rounded"
                              style={getStatusBadgeStyle(item.deal_status)}
                            >
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
                              <span
                                className="inline-flex items-center justify-center h-4 min-w-[16px] px-1 rounded-full text-[10px] font-bold"
                                style={{ background: colors.gold, color: '#FFFFFF' }}
                              >
                                {item.unread_message_count}
                              </span>
                            )}
                            {hasReturns && (
                              <span
                                className="inline-flex items-center justify-center h-4 min-w-[16px] px-1 rounded-full text-[10px] font-bold"
                                style={{ background: '#EF4444', color: '#FFFFFF' }}
                                title="Returned documents need attention"
                              >
                                !
                              </span>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Message preview */}
                      <p
                        className={`text-xs mt-1.5 truncate ${hasUnread ? 'font-medium' : ''}`}
                        style={{ color: hasUnread ? colors.textSecondary : colors.textMuted }}
                      >
                        {item.latest_sender_role === 'admin' ? 'Firm Funds: ' : 'You: '}
                        {item.latest_message || (item.pending_return_count > 0 ? 'Document returned for revision' : '')}
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

            {/* RIGHT PANEL — Messages thread */}
            <div className="flex-1 flex flex-col min-w-0">
              {!selectedDealId ? (
                /* No deal selected */
                <div className="flex-1 flex items-center justify-center">
                  <div className="text-center">
                    <MessageSquare size={40} style={{ color: colors.textFaint }} className="mx-auto mb-3" />
                    <p className="text-sm font-medium" style={{ color: colors.textSecondary }}>
                      Select a deal to view messages
                    </p>
                    <p className="text-xs mt-1" style={{ color: colors.textMuted }}>
                      Choose from the list on the left
                    </p>
                  </div>
                </div>
              ) : (
                <>
                  {/* Thread header */}
                  <div
                    className="px-5 py-3 flex items-center justify-between"
                    style={{ borderBottom: `1px solid ${colors.border}` }}
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-bold truncate" style={{ color: colors.textPrimary }}>
                        {selectedDeal?.property_address}
                      </p>
                      <div className="flex items-center gap-2 mt-0.5">
                        {selectedDeal && (
                          <span
                            className="inline-flex px-1.5 py-0.5 text-[10px] font-semibold rounded"
                            style={getStatusBadgeStyle(selectedDeal.deal_status)}
                          >
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
                      className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg transition-colors"
                      style={{ color: colors.gold, border: `1px solid ${colors.border}` }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = colors.cardHoverBg; e.currentTarget.style.borderColor = colors.gold }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = colors.border }}
                    >
                      <ExternalLink size={12} />
                      View Deal
                    </button>
                  </div>

                  {/* Returned docs alert (if any for selected deal) */}
                  {selectedDealReturns.length > 0 && (
                    <div className="px-5 py-2.5 flex items-center justify-between gap-3" style={{ background: '#2A1212', borderBottom: '1px solid #4A2020' }}>
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        <AlertTriangle size={14} style={{ color: '#F87171', flexShrink: 0 }} />
                        <span className="text-xs font-bold truncate" style={{ color: '#F87171' }}>
                          {selectedDealReturns.length === 1
                            ? `Returned: ${selectedDealReturns[0].deal_documents?.file_name || 'Document'} — ${selectedDealReturns[0].reason}`
                            : `${selectedDealReturns.length} documents returned for revision`
                          }
                        </span>
                      </div>
                      <button
                        onClick={() => router.push(`/agent/deals/${selectedDealId}#returned-docs`)}
                        className="flex-shrink-0 text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors"
                        style={{ background: '#4A2020', color: '#F87171' }}
                        onMouseEnter={(e) => e.currentTarget.style.background = '#5A2525'}
                        onMouseLeave={(e) => e.currentTarget.style.background = '#4A2020'}
                      >
                        Fix & Upload →
                      </button>
                    </div>
                  )}

                  {/* Messages area */}
                  <div className="flex-1 overflow-y-auto px-5 py-4" style={{ scrollbarWidth: 'thin' }}>
                    {messagesLoading ? (
                      <div className="space-y-3">
                        {[1,2,3].map(i => (
                          <div key={i} className="h-12 rounded-lg animate-pulse" style={{ background: colors.skeletonHighlight }} />
                        ))}
                      </div>
                    ) : messages.length === 0 ? (
                      <div className="flex items-center justify-center h-full">
                        <p className="text-xs" style={{ color: colors.textMuted }}>No messages in this thread yet</p>
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {messages.map(msg => (
                          <div
                            key={msg.id}
                            className={`px-4 py-3 rounded-xl max-w-[85%] ${msg.sender_role === 'agent' ? 'ml-auto' : ''}`}
                            style={{
                              background: msg.sender_role === 'admin' ? '#0F2A18' : colors.tableHeaderBg,
                              border: `1px solid ${msg.sender_role === 'admin' ? '#1E4A2C' : colors.border}`,
                            }}
                          >
                            <div className="flex items-center gap-2 mb-1">
                              <span className="text-xs font-semibold" style={{
                                color: msg.sender_role === 'admin' ? '#5FA873' : '#7B9FE0',
                              }}>
                                {msg.sender_role === 'admin' ? (msg.sender_name || 'Firm Funds') : 'You'}
                              </span>
                              <span className="text-[10px]" style={{ color: colors.textFaint }}>
                                {formatDateTime(msg.created_at)}
                              </span>
                            </div>
                            <p className="text-sm whitespace-pre-wrap leading-relaxed" style={{ color: colors.textPrimary }}>
                              {msg.message}
                            </p>
                          </div>
                        ))}
                        <div ref={messagesEndRef} />
                      </div>
                    )}
                  </div>

                  {/* Reply input */}
                  <div
                    className="px-5 py-3 flex gap-2"
                    style={{ borderTop: `1px solid ${colors.border}`, background: colors.tableHeaderBg }}
                  >
                    <input
                      type="text"
                      value={replyText}
                      onChange={(e) => setReplyText(e.target.value)}
                      placeholder="Type a reply..."
                      className="flex-1 px-4 py-2.5 rounded-lg text-sm outline-none"
                      style={{ background: colors.inputBg, border: `1px solid ${colors.inputBorder}`, color: colors.inputText }}
                      onFocus={(e) => { e.currentTarget.style.borderColor = colors.gold }}
                      onBlur={(e) => { e.currentTarget.style.borderColor = colors.inputBorder }}
                      onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendReply() } }}
                    />
                    <button
                      onClick={handleSendReply}
                      disabled={replySending || !replyText.trim()}
                      className="px-4 py-2.5 rounded-lg text-sm font-medium text-white disabled:opacity-40 flex items-center gap-1.5 transition-colors"
                      style={{ background: '#5FA873' }}
                      onMouseEnter={(e) => { if (!replySending && replyText.trim()) e.currentTarget.style.background = '#4A8B5F' }}
                      onMouseLeave={(e) => e.currentTarget.style.background = '#5FA873'}
                    >
                      <Send size={14} />
                      {replySending ? 'Sending...' : 'Reply'}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  )
}

// ============================================================================
// Helper: format relative time (e.g., "2h ago", "Yesterday", "Apr 3")
// ============================================================================

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)

  if (diffMins < 1) return 'Just now'
  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 7) return `${diffDays}d ago`
  return date.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })
}
