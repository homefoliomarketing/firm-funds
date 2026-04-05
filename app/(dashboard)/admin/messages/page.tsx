'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import {
  MessageSquare, Send, ExternalLink, Inbox, Search, ArrowLeft,
  AlertCircle, Clock, CheckCircle,
} from 'lucide-react'
import { useTheme } from '@/lib/theme'
import { formatDateTime } from '@/lib/formatting'
import { getStatusBadgeStyle, formatStatusLabel } from '@/lib/constants'
import SignOutModal from '@/components/SignOutModal'
import {
  getAdminInbox,
  getAdminDealMessages,
  sendAdminMessage,
  dismissDealMessages,
  type AdminInboxDeal,
} from '@/lib/actions/notification-actions'

interface DealMessageItem {
  id: string
  sender_role: string
  sender_name: string | null
  message: string
  is_email_reply: boolean
  created_at: string
}

export default function AdminMessagesPage() {
  const [profile, setProfile] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [inbox, setInbox] = useState<AdminInboxDeal[]>([])
  const [selectedDealId, setSelectedDealId] = useState<string | null>(null)
  const [messages, setMessages] = useState<DealMessageItem[]>([])
  const [messagesLoading, setMessagesLoading] = useState(false)
  const [replyText, setReplyText] = useState('')
  const [replySending, setReplySending] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [filterMode, setFilterMode] = useState<'all' | 'needs_reply'>('all')
  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const router = useRouter()
  const supabase = createClient()
  const { colors, isDark } = useTheme()

  useEffect(() => {
    async function load() {
      try {
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) { router.push('/login'); return }
        const { data: profileData } = await supabase.from('user_profiles').select('*').eq('id', user.id).single()
        if (!profileData || !['super_admin', 'firm_funds_admin'].includes(profileData.role)) {
          router.push('/login'); return
        }
        setProfile(profileData)
        await loadInbox()
      } catch (err) {
        console.error('Admin messages load error:', err)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  const loadInbox = useCallback(async () => {
    const result = await getAdminInbox()
    if (result.success && result.data) {
      setInbox(result.data.inbox)
    }
  }, [])

  const selectDeal = useCallback(async (dealId: string) => {
    setSelectedDealId(dealId)
    setMessagesLoading(true)
    setReplyText('')

    const result = await getAdminDealMessages(dealId)
    if (result.success && result.data) {
      setMessages(result.data)
    }
    setMessagesLoading(false)
  }, [])

  // Scroll messages container to bottom
  useEffect(() => {
    if (messages.length > 0) {
      setTimeout(() => {
        const container = messagesContainerRef.current
        if (container) container.scrollTop = container.scrollHeight
      }, 100)
    }
  }, [messages.length])

  const handleSendReply = async () => {
    if (!selectedDealId || !replyText.trim()) return
    setReplySending(true)
    const result = await sendAdminMessage({ dealId: selectedDealId, message: replyText })
    if (result.success && result.data) {
      setMessages(prev => [...prev, result.data])
      setReplyText('')
      // Update inbox
      setInbox(prev => prev.map(item =>
        item.deal_id === selectedDealId
          ? {
              ...item,
              latest_message: result.data.message,
              latest_message_at: result.data.created_at,
              latest_sender_role: 'admin',
              latest_sender_name: profile?.full_name || 'Firm Funds',
              needs_reply: false,
            }
          : item
      ))
    }
    setReplySending(false)
  }

  const handleDismiss = async (dealId: string) => {
    const result = await dismissDealMessages(dealId)
    if (result.success) {
      setInbox(prev => prev.map(item =>
        item.deal_id === dealId ? { ...item, needs_reply: false } : item
      ))
    } else {
      console.error('Dismiss failed:', result.error)
      alert('Failed to dismiss — have you run migration 020? Check console for details.')
    }
  }

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }

  // Filter inbox
  const filteredInbox = inbox.filter(item => {
    if (filterMode === 'needs_reply' && !item.needs_reply) return false
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      return item.property_address.toLowerCase().includes(q) ||
        item.agent_name.toLowerCase().includes(q)
    }
    return true
  })

  const selectedDeal = inbox.find(d => d.deal_id === selectedDealId)
  const needsReplyCount = inbox.filter(d => d.needs_reply).length

  if (loading) {
    return (
      <div className="min-h-screen" style={{ background: colors.pageBg }}>
        <div style={{ background: colors.headerBgGradient }} className="h-20" />
        <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
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
      {/* Header */}
      <header style={{ background: colors.headerBgGradient }}>
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center py-4">
            <div className="flex items-center gap-4">
              <img
                src="/brand/white.png"
                alt="Firm Funds"
                className="h-14 sm:h-18 md:h-24 w-auto cursor-pointer"
                onClick={() => router.push('/admin')}
              />
              <div className="w-px h-8" style={{ background: 'rgba(255,255,255,0.15)' }} />
              <button
                onClick={() => router.push('/admin')}
                className="transition-colors"
                style={{ color: colors.textSecondary }}
                onMouseEnter={(e) => e.currentTarget.style.color = colors.gold}
                onMouseLeave={(e) => e.currentTarget.style.color = colors.textSecondary}
              >
                <ArrowLeft size={20} />
              </button>
              <div>
                <h1 className="text-lg font-bold text-white">Messages</h1>
                <p className="text-xs" style={{ color: colors.textMuted }}>
                  {inbox.length} conversation{inbox.length !== 1 ? 's' : ''}
                  {needsReplyCount > 0 && (
                    <span style={{ color: '#5FA873' }}> · {needsReplyCount} awaiting reply</span>
                  )}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-sm hidden sm:inline" style={{ color: colors.gold }}>{profile?.full_name}</span>
              <SignOutModal onConfirm={handleLogout} />
            </div>
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-hidden max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-4">
        {inbox.length === 0 ? (
          <div className="rounded-xl p-12 text-center flex flex-col items-center justify-center h-full" style={{ background: colors.cardBg, border: `1px solid ${colors.border}` }}>
            <Inbox className="mx-auto mb-4" size={48} style={{ color: colors.textFaint }} />
            <p className="text-lg font-semibold" style={{ color: colors.textSecondary }}>No messages yet</p>
            <p className="text-sm mt-2" style={{ color: colors.textMuted }}>
              Messages sent on deal pages will appear here.
            </p>
          </div>
        ) : (
          <div
            className="rounded-xl overflow-hidden flex h-full"
            style={{ background: colors.cardBg, border: `1px solid ${colors.border}` }}
          >
            {/* LEFT PANEL */}
            <div
              className="flex flex-col"
              style={{ width: '380px', minWidth: '300px', borderRight: `1px solid ${colors.border}` }}
            >
              {/* Search + filter */}
              <div className="p-3 space-y-2" style={{ borderBottom: `1px solid ${colors.border}` }}>
                <div className="relative">
                  <Search size={14} style={{ color: colors.textMuted, position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)' }} />
                  <input
                    type="text"
                    placeholder="Search by address or agent..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full rounded-lg pl-8 pr-3 py-2 text-sm outline-none"
                    style={{ border: `1px solid ${colors.inputBorder}`, color: colors.inputText, background: colors.inputBg }}
                    onFocus={(e) => { e.currentTarget.style.borderColor = colors.gold }}
                    onBlur={(e) => { e.currentTarget.style.borderColor = colors.inputBorder }}
                  />
                </div>
                <div className="flex gap-1.5">
                  <button
                    onClick={() => setFilterMode('all')}
                    className="px-2.5 py-1 rounded-md text-xs font-semibold transition-colors"
                    style={{
                      background: filterMode === 'all' ? colors.gold : 'transparent',
                      color: filterMode === 'all' ? '#FFF' : colors.textMuted,
                      border: `1px solid ${filterMode === 'all' ? colors.gold : colors.border}`,
                    }}
                  >
                    All ({inbox.length})
                  </button>
                  <button
                    onClick={() => setFilterMode('needs_reply')}
                    className="px-2.5 py-1 rounded-md text-xs font-semibold transition-colors"
                    style={{
                      background: filterMode === 'needs_reply' ? '#DC2626' : 'transparent',
                      color: filterMode === 'needs_reply' ? '#FFF' : colors.textMuted,
                      border: `1px solid ${filterMode === 'needs_reply' ? '#DC2626' : colors.border}`,
                    }}
                  >
                    Needs Reply ({needsReplyCount})
                  </button>
                </div>
              </div>

              {/* Deal list */}
              <div className="flex-1 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
                {filteredInbox.map((item) => {
                  const isSelected = item.deal_id === selectedDealId

                  return (
                    <button
                      key={item.deal_id}
                      onClick={() => selectDeal(item.deal_id)}
                      className="w-full text-left px-4 py-3 transition-colors"
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
                          <p className={`text-sm truncate ${item.needs_reply ? 'font-bold' : 'font-medium'}`} style={{ color: colors.textPrimary }}>
                            {item.property_address}
                          </p>
                          <div className="flex items-center gap-2 mt-0.5">
                            <span className="text-xs" style={{ color: colors.gold }}>{item.agent_name}</span>
                            <span
                              className="inline-flex px-1.5 py-0.5 text-[10px] font-semibold rounded"
                              style={getStatusBadgeStyle(item.deal_status)}
                            >
                              {formatStatusLabel(item.deal_status)}
                            </span>
                          </div>
                        </div>
                        <div className="flex flex-col items-end gap-1 flex-shrink-0">
                          <span className="text-[10px]" style={{ color: colors.textFaint }}>
                            {formatRelativeTime(item.latest_message_at)}
                          </span>
                          {item.needs_reply && (
                            <span
                              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold animate-pulse"
                              style={{ background: '#DC262620', color: '#DC2626', border: '1px solid #DC262640' }}
                            >
                              <AlertCircle size={9} />
                              Reply
                            </span>
                          )}
                        </div>
                      </div>
                      <p className={`text-xs mt-1 truncate ${item.needs_reply ? 'font-medium' : ''}`} style={{ color: item.needs_reply ? colors.textSecondary : colors.textMuted }}>
                        {item.latest_sender_role === 'agent' ? `${item.agent_name.split(' ')[0]}: ` : 'You: '}
                        {item.latest_message}
                      </p>
                    </button>
                  )
                })}

                {filteredInbox.length === 0 && (
                  <div className="px-4 py-8 text-center">
                    <p className="text-xs" style={{ color: colors.textMuted }}>
                      {searchQuery.trim() ? 'No matching conversations' : 'No conversations need a reply'}
                    </p>
                  </div>
                )}
              </div>
            </div>

            {/* RIGHT PANEL */}
            <div className="flex-1 flex flex-col min-w-0">
              {!selectedDealId ? (
                <div className="flex-1 flex items-center justify-center">
                  <div className="text-center">
                    <MessageSquare size={40} style={{ color: colors.textFaint }} className="mx-auto mb-3" />
                    <p className="text-sm font-medium" style={{ color: colors.textSecondary }}>Select a conversation</p>
                    <p className="text-xs mt-1" style={{ color: colors.textMuted }}>Choose from the list on the left</p>
                  </div>
                </div>
              ) : (
                <>
                  {/* Thread header */}
                  <div className="px-5 py-3 flex items-center justify-between" style={{ borderBottom: `1px solid ${colors.border}` }}>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-bold truncate" style={{ color: colors.textPrimary }}>
                        {selectedDeal?.property_address}
                      </p>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-xs" style={{ color: colors.gold }}>{selectedDeal?.agent_name}</span>
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
                    <div className="flex items-center gap-2">
                      {selectedDeal?.needs_reply && (
                        <button
                          onClick={() => handleDismiss(selectedDealId!)}
                          className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg transition-colors cursor-pointer"
                          style={{ color: colors.textPrimary, background: colors.cardBg, border: `1px solid ${colors.border}` }}
                          onMouseEnter={(e) => { e.currentTarget.style.background = colors.cardHoverBg; e.currentTarget.style.borderColor = colors.textSecondary }}
                          onMouseLeave={(e) => { e.currentTarget.style.background = colors.cardBg; e.currentTarget.style.borderColor = colors.border }}
                          title="Dismiss notification — it will return if the agent sends another message"
                        >
                          <CheckCircle size={12} />
                          Dismiss Notification
                        </button>
                      )}
                      <button
                        onClick={() => router.push(`/admin/deals/${selectedDealId}`)}
                        className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg transition-colors"
                        style={{ color: colors.gold, border: `1px solid ${colors.border}` }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = colors.cardHoverBg; e.currentTarget.style.borderColor = colors.gold }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = colors.border }}
                      >
                        <ExternalLink size={12} />
                        View Deal
                      </button>
                    </div>
                  </div>

                  {/* Messages */}
                  <div ref={messagesContainerRef} className="flex-1 overflow-y-auto px-5 py-4" style={{ scrollbarWidth: 'thin' }}>
                    {messagesLoading ? (
                      <div className="space-y-3">
                        {[1,2,3].map(i => (
                          <div key={i} className="h-12 rounded-lg animate-pulse" style={{ background: colors.skeletonHighlight }} />
                        ))}
                      </div>
                    ) : messages.length === 0 ? (
                      <div className="flex items-center justify-center h-full">
                        <p className="text-xs" style={{ color: colors.textMuted }}>No messages yet</p>
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {messages.map(msg => (
                          <div
                            key={msg.id}
                            className={`px-4 py-3 rounded-xl max-w-[85%] ${msg.sender_role === 'admin' ? 'ml-auto' : ''}`}
                            style={{
                              background: msg.sender_role === 'admin' ? '#0F2A18' : colors.tableHeaderBg,
                              border: `1px solid ${msg.sender_role === 'admin' ? '#1E4A2C' : colors.border}`,
                            }}
                          >
                            <div className="flex items-center gap-2 mb-1">
                              <span className="text-xs font-semibold" style={{
                                color: msg.sender_role === 'admin' ? '#5FA873' : '#7B9FE0',
                              }}>
                                {msg.sender_role === 'admin' ? (msg.sender_name || 'Firm Funds') : (msg.sender_name || 'Agent')}
                              </span>
                              {msg.is_email_reply && <span className="text-xs px-1 rounded" style={{ background: '#2D3A5C', color: '#7B9FE0' }}>via email</span>}
                              <span className="text-[10px]" style={{ color: colors.textFaint }}>
                                {formatDateTime(msg.created_at)}
                              </span>
                            </div>
                            <p className="text-sm whitespace-pre-wrap leading-relaxed" style={{ color: colors.textPrimary }}>
                              {msg.message}
                            </p>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Reply input */}
                  <div className="px-5 py-3 flex gap-2" style={{ borderTop: `1px solid ${colors.border}`, background: colors.tableHeaderBg }}>
                    <input
                      type="text"
                      value={replyText}
                      onChange={(e) => setReplyText(e.target.value)}
                      placeholder="Reply to agent... (sends email notification)"
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
                      {replySending ? 'Sending...' : 'Send'}
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
