'use client'

import { useEffect, useState, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import {
  MessageSquare, ExternalLink, Inbox, Search, ArrowLeft,
  AlertCircle, CheckCircle,
} from 'lucide-react'
import { formatRelativeTime } from '@/lib/formatting'
import { getStatusBadgeStyle, formatStatusLabel, ADMIN_QUICK_REPLIES } from '@/lib/constants'
import SignOutModal from '@/components/SignOutModal'
import MessageThread from '@/components/messaging/MessageThread'
import MessageInput from '@/components/messaging/MessageInput'
import type { MessageData } from '@/components/messaging/MessageBubble'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import {
  getAdminInbox,
  getAdminDealMessages,
  getNewMessages,
  sendAdminMessage,
  dismissDealMessages,
  type AdminInboxDeal,
} from '@/lib/actions/notification-actions'
import { uploadDocument } from '@/lib/actions/deal-actions'

export default function AdminMessagesPage() {
  const [profile, setProfile] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [inbox, setInbox] = useState<AdminInboxDeal[]>([])
  const [selectedDealId, setSelectedDealId] = useState<string | null>(null)
  const [messages, setMessages] = useState<MessageData[]>([])
  const [messagesLoading, setMessagesLoading] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [filterMode, setFilterMode] = useState<'all' | 'needs_reply'>('all')
  const [isMobile, setIsMobile] = useState(false)
  const router = useRouter()
  const supabase = createClient()

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

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
    const result = await getAdminDealMessages(dealId)
    if (result.success && result.data) {
      setMessages(result.data)
    }
    setMessagesLoading(false)
  }, [])

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
        const hasAgentMsg = result.data.some((m: any) => m.sender_role === 'agent')
        if (hasAgentMsg) {
          setInbox(prev => prev.map(item =>
            item.deal_id === selectedDealId ? { ...item, needs_reply: true } : item
          ))
        }
      }
    }, 5000)
    return () => clearInterval(interval)
  }, [selectedDealId, messages])

  const handleSend = async (message: string, file?: File | null) => {
    if (!selectedDealId) return

    let filePath: string | null = null
    let fileName: string | null = null
    let fileSize: number | null = null
    let fileType: string | null = null

    if (file) {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('dealId', selectedDealId)
      fd.append('documentType', 'other')
      const uploadResult = await uploadDocument(fd)
      if (!uploadResult.success) throw new Error(uploadResult.error || 'Upload failed')
      filePath = uploadResult.data?.file_path || null
      fileName = file.name
      fileSize = file.size
      fileType = file.type
    }

    try {
      const result = await sendAdminMessage({ dealId: selectedDealId, message, filePath, fileName, fileSize, fileType })
      if (result.success) {
        const newMsg = result.data || {
          id: crypto.randomUUID(),
          sender_role: 'admin',
          sender_name: profile?.full_name || 'Firm Funds',
          message,
          is_email_reply: false,
          file_path: filePath, file_name: fileName, file_size: fileSize, file_type: fileType,
          created_at: new Date().toISOString(),
        }
        setMessages(prev => [...prev, newMsg])
        setInbox(prev => prev.map(item =>
          item.deal_id === selectedDealId
            ? { ...item, latest_message: message, latest_message_at: newMsg.created_at, latest_sender_role: 'admin', latest_sender_name: profile?.full_name || 'Firm Funds', needs_reply: false }
            : item
        ))
      }
    } catch (err) {
      console.error('Send message error:', err)
    }
  }

  const handleDismiss = async (dealId: string) => {
    const result = await dismissDealMessages(dealId)
    if (result.success) {
      setInbox(prev => prev.map(item =>
        item.deal_id === dealId ? { ...item, needs_reply: false } : item
      ))
    }
  }

  const handleLogout = async () => { await supabase.auth.signOut(); router.push('/login') }
  const handleBack = () => { setSelectedDealId(null); setMessages([]) }

  const filteredInbox = inbox.filter(item => {
    if (filterMode === 'needs_reply' && !item.needs_reply) return false
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      return item.property_address.toLowerCase().includes(q) || item.agent_name.toLowerCase().includes(q)
    }
    return true
  })

  const selectedDeal = inbox.find(d => d.deal_id === selectedDealId)
  const needsReplyCount = inbox.filter(d => d.needs_reply).length

  const showList = !isMobile || !selectedDealId
  const showThread = !isMobile || !!selectedDealId

  const quickReplies = ADMIN_QUICK_REPLIES.map((t: any) => ({ label: t.label, message: t.message }))

  if (loading) {
    return (
      <div className="min-h-screen bg-background">
        <div className="bg-card/80 backdrop-blur-sm h-20" />
        <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="rounded-xl p-8 bg-card border border-border/50">
            <Skeleton className="h-4 w-32 mb-4" />
            {[1, 2, 3].map(i => (
              <Skeleton key={i} className="h-16 rounded-lg mb-3" />
            ))}
          </div>
        </main>
      </div>
    )
  }

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-background">
      {/* Header */}
      <header className="bg-card/80 backdrop-blur-sm border-b border-border/50 flex-shrink-0">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center py-4">
            <div className="flex items-center gap-4">
              <img src="/brand/white.png" alt="Firm Funds" className="h-14 sm:h-18 md:h-24 w-auto cursor-pointer" onClick={() => router.push('/admin')} />
              <div className="w-px h-8 bg-white/15" />
              <button
                onClick={() => router.push('/admin')}
                className="text-white/70 hover:text-primary transition-colors"
              >
                <ArrowLeft size={20} />
              </button>
              <div>
                <h1 className="text-lg font-bold text-white">Messages</h1>
                <p className="text-xs text-muted-foreground">
                  {inbox.length} conversation{inbox.length !== 1 ? 's' : ''}
                  {needsReplyCount > 0 && <span className="text-primary"> · {needsReplyCount} awaiting reply</span>}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-sm hidden sm:inline text-primary">{profile?.full_name}</span>
              <SignOutModal onConfirm={handleLogout} />
            </div>
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-hidden max-w-7xl w-full mx-auto px-2 sm:px-4 md:px-6 lg:px-8 py-2 sm:py-4">
        {inbox.length === 0 ? (
          <div className="rounded-xl p-12 text-center flex flex-col items-center justify-center h-full bg-card border border-border/50">
            <Inbox className="mx-auto mb-4 text-muted-foreground/40" size={48} />
            <p className="text-lg font-semibold text-muted-foreground">No messages yet</p>
            <p className="text-sm mt-2 text-muted-foreground/70">Messages sent on deal pages will appear here.</p>
          </div>
        ) : (
          <div className="rounded-xl overflow-hidden flex h-full bg-card border border-border/50">

            {/* LEFT PANEL */}
            {showList && (
              <div
                className="flex flex-col border-r border-border/50"
                style={{ width: isMobile ? '100%' : '380px', minWidth: isMobile ? '100%' : '300px' }}
              >
                <div className="p-3 space-y-2 border-b border-border/50">
                  <div className="relative">
                    <Search size={14} className="text-muted-foreground absolute left-2.5 top-1/2 -translate-y-1/2" />
                    <Input
                      type="text"
                      placeholder="Search by address or agent..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="pl-8"
                    />
                  </div>
                  <div className="flex gap-1.5">
                    <button
                      onClick={() => setFilterMode('all')}
                      className={`px-2.5 py-1 rounded-md text-xs font-semibold transition-colors border ${
                        filterMode === 'all'
                          ? 'bg-primary text-primary-foreground border-primary'
                          : 'text-muted-foreground border-border/50 hover:text-foreground'
                      }`}
                    >
                      All ({inbox.length})
                    </button>
                    <button
                      onClick={() => setFilterMode('needs_reply')}
                      className={`px-2.5 py-1 rounded-md text-xs font-semibold transition-colors border ${
                        filterMode === 'needs_reply'
                          ? 'bg-red-600 text-white border-red-600'
                          : 'text-muted-foreground border-border/50 hover:text-foreground'
                      }`}
                    >
                      Needs Reply ({needsReplyCount})
                    </button>
                  </div>
                </div>

                <div className="flex-1 overflow-y-auto">
                  {filteredInbox.map((item) => {
                    const isSelected = item.deal_id === selectedDealId
                    return (
                      <button
                        key={item.deal_id}
                        onClick={() => selectDeal(item.deal_id)}
                        className={`w-full text-left px-4 py-3 transition-colors border-b border-border/30 border-l-[3px] ${
                          isSelected
                            ? 'bg-muted border-l-primary'
                            : 'border-l-transparent hover:bg-muted/50'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <p className={`text-sm truncate ${item.needs_reply ? 'font-bold' : 'font-medium'} text-foreground`}>
                              {item.property_address}
                            </p>
                            <div className="flex items-center gap-2 mt-0.5">
                              <span className="text-xs text-primary">{item.agent_name}</span>
                              <span className="inline-flex px-1.5 py-0.5 text-[10px] font-semibold rounded" style={getStatusBadgeStyle(item.deal_status)}>
                                {formatStatusLabel(item.deal_status)}
                              </span>
                            </div>
                          </div>
                          <div className="flex flex-col items-end gap-1 flex-shrink-0">
                            <span className="text-[10px] text-muted-foreground/60">{formatRelativeTime(item.latest_message_at)}</span>
                            {item.needs_reply && (
                              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold animate-pulse bg-red-500/10 text-red-400 border border-red-500/25">
                                <AlertCircle size={9} />Reply
                              </span>
                            )}
                          </div>
                        </div>
                        <p className={`text-xs mt-1 truncate ${item.needs_reply ? 'font-medium text-foreground/80' : 'text-muted-foreground'}`}>
                          {item.latest_sender_role === 'agent' ? `${item.agent_name.split(' ')[0]}: ` : 'You: '}{item.latest_message}
                        </p>
                      </button>
                    )
                  })}
                  {filteredInbox.length === 0 && (
                    <div className="px-4 py-8 text-center">
                      <p className="text-xs text-muted-foreground">
                        {searchQuery.trim() ? 'No matching conversations' : 'No conversations need a reply'}
                      </p>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* RIGHT PANEL */}
            {showThread && (
              <div className="flex-1 flex flex-col min-w-0">
                {!selectedDealId ? (
                  <div className="flex-1 flex items-center justify-center">
                    <div className="text-center">
                      <MessageSquare size={40} className="text-muted-foreground/30 mx-auto mb-3" />
                      <p className="text-sm font-medium text-muted-foreground">Select a conversation</p>
                      <p className="text-xs mt-1 text-muted-foreground/70">Choose from the list on the left</p>
                    </div>
                  </div>
                ) : (
                  <>
                    {/* Thread header */}
                    <div className="px-4 sm:px-5 py-3 flex items-center justify-between gap-2 border-b border-border/50">
                      {isMobile && (
                        <button onClick={handleBack} className="p-1 mr-1 text-muted-foreground hover:text-foreground transition-colors">
                          <ArrowLeft size={20} />
                        </button>
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-bold truncate text-foreground">{selectedDeal?.property_address}</p>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="text-xs text-primary">{selectedDeal?.agent_name}</span>
                          {selectedDeal && (
                            <span className="inline-flex px-1.5 py-0.5 text-[10px] font-semibold rounded" style={getStatusBadgeStyle(selectedDeal.deal_status)}>
                              {formatStatusLabel(selectedDeal.deal_status)}
                            </span>
                          )}
                          <span className="text-[10px] text-muted-foreground/50">{selectedDeal?.total_message_count || 0} messages</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        {selectedDeal?.needs_reply && (
                          <Button
                            onClick={() => handleDismiss(selectedDealId!)}
                            variant="outline"
                            size="sm"
                            className="gap-1.5 text-xs h-8"
                          >
                            <CheckCircle size={12} /><span className="hidden sm:inline">Dismiss</span>
                          </Button>
                        )}
                        <Button
                          onClick={() => router.push(`/admin/deals/${selectedDealId}`)}
                          variant="outline"
                          size="sm"
                          className="gap-1.5 text-xs text-primary border-border/50 h-8 hover:border-primary"
                        >
                          <ExternalLink size={12} /><span className="hidden sm:inline">View Deal</span>
                        </Button>
                      </div>
                    </div>

                    <MessageThread messages={messages} viewerRole="admin" loading={messagesLoading} emptyMessage="No messages yet" />

                    <MessageInput
                      onSend={handleSend}
                      placeholder="Reply to agent... (sends email notification)"
                      quickReplies={quickReplies}
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
