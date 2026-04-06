'use server'

import { createServiceRoleClient } from '@/lib/supabase/server'
import { getAuthenticatedUser } from '@/lib/auth-helpers'

// ============================================================================
// Types
// ============================================================================

interface ActionResult {
  success: boolean
  error?: string
  data?: any
}

export interface InboxDeal {
  deal_id: string
  property_address: string
  deal_status: string
  closing_date: string
  latest_message: string
  latest_message_at: string
  latest_sender_role: string
  latest_sender_name: string | null
  unread_message_count: number
  pending_return_count: number
  total_message_count: number
}

// ============================================================================
// Get unread notification counts for the bell icon
// ============================================================================

export async function getAgentNotificationCounts(agentId: string): Promise<ActionResult> {
  const { error: authErr, user } = await getAuthenticatedUser(['agent'])
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  const serviceClient = createServiceRoleClient()

  try {
    // Get all deals for this agent that have messages
    const { data: deals } = await serviceClient
      .from('deals')
      .select('id')
      .eq('agent_id', agentId)

    if (!deals || deals.length === 0) {
      return { success: true, data: { unreadMessages: 0, pendingReturns: 0 } }
    }

    const dealIds = deals.map(d => d.id)

    // Get read status for all deals
    const { data: readStatuses } = await serviceClient
      .from('agent_message_reads')
      .select('deal_id, last_read_at')
      .eq('agent_id', agentId)

    const readMap = new Map<string, string>()
    if (readStatuses) {
      for (const rs of readStatuses) {
        readMap.set(rs.deal_id, rs.last_read_at)
      }
    }

    // Count unread messages across all deals (messages from admin after last read)
    let unreadMessages = 0
    for (const dealId of dealIds) {
      const lastRead = readMap.get(dealId)
      let query = serviceClient
        .from('deal_messages')
        .select('id', { count: 'exact', head: true })
        .eq('deal_id', dealId)
        .eq('sender_role', 'admin')

      if (lastRead) {
        query = query.gt('created_at', lastRead)
      }

      const { count } = await query
      unreadMessages += (count || 0)
    }

    // Count pending document returns
    const { count: pendingReturns } = await serviceClient
      .from('document_returns')
      .select('id', { count: 'exact', head: true })
      .in('deal_id', dealIds)
      .eq('status', 'pending')

    return {
      success: true,
      data: {
        unreadMessages,
        pendingReturns: pendingReturns || 0,
        total: unreadMessages + (pendingReturns || 0),
      },
    }
  } catch (err: any) {
    console.error('getAgentNotificationCounts error:', err?.message)
    return { success: false, error: 'Failed to load notification counts' }
  }
}

// ============================================================================
// Get inbox data — deals with messages, sorted by most recent activity
// ============================================================================

export async function getAgentInbox(agentId: string): Promise<ActionResult> {
  const { error: authErr, user } = await getAuthenticatedUser(['agent'])
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  const serviceClient = createServiceRoleClient()

  try {
    // Get all deals for this agent
    const { data: deals } = await serviceClient
      .from('deals')
      .select('id, property_address, status, closing_date, created_at')
      .eq('agent_id', agentId)

    if (!deals || deals.length === 0) {
      return { success: true, data: { inbox: [], pendingReturns: [] } }
    }

    const dealIds = deals.map(d => d.id)
    const dealMap = new Map(deals.map(d => [d.id, d]))

    // Get read statuses
    const { data: readStatuses } = await serviceClient
      .from('agent_message_reads')
      .select('deal_id, last_read_at')
      .eq('agent_id', agentId)

    const readMap = new Map<string, string>()
    if (readStatuses) {
      for (const rs of readStatuses) {
        readMap.set(rs.deal_id, rs.last_read_at)
      }
    }

    // Get all messages for all deals
    const { data: allMessages } = await serviceClient
      .from('deal_messages')
      .select('*')
      .in('deal_id', dealIds)
      .order('created_at', { ascending: false })

    // Get all pending document returns (no join — two FKs to deal_documents makes it ambiguous)
    const { data: rawReturns } = await serviceClient
      .from('document_returns')
      .select('*')
      .in('deal_id', dealIds)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })

    // Fetch doc names for the returned documents
    const returnDocIds = (rawReturns || []).map(r => r.document_id).filter(Boolean)
    let docNameMap = new Map<string, { file_name: string; document_type: string }>()
    if (returnDocIds.length > 0) {
      const { data: docs } = await serviceClient
        .from('deal_documents')
        .select('id, file_name, document_type')
        .in('id', returnDocIds)
      if (docs) {
        docNameMap = new Map(docs.map(d => [d.id, { file_name: d.file_name, document_type: d.document_type }]))
      }
    }
    const allReturns = (rawReturns || []).map(r => ({
      ...r,
      deal_documents: docNameMap.get(r.document_id) || { file_name: 'Document', document_type: 'other' },
    }))

    // Build inbox items: ALL active deals (agents can start conversations on any deal)
    const inboxDeals: InboxDeal[] = []

    for (const deal of deals) {
      // Skip denied/cancelled deals — no reason to message about those
      if (['denied', 'cancelled'].includes(deal.status)) continue

      const msgs = (allMessages || []).filter(m => m.deal_id === deal.id)
      const returns = (allReturns || []).filter(r => r.deal_id === deal.id)

      const latestMsg = msgs[0] // already sorted desc
      const lastRead = readMap.get(deal.id)

      // Count unread (admin messages after last read)
      const unreadCount = msgs.filter(m =>
        m.sender_role === 'admin' && (!lastRead || new Date(m.created_at) > new Date(lastRead))
      ).length

      inboxDeals.push({
        deal_id: deal.id,
        property_address: deal.property_address,
        deal_status: deal.status,
        closing_date: deal.closing_date,
        latest_message: latestMsg?.message || '',
        latest_message_at: latestMsg?.created_at || returns[0]?.created_at || deal.created_at || '',
        latest_sender_role: latestMsg?.sender_role || '',
        latest_sender_name: latestMsg?.sender_name || null,
        unread_message_count: unreadCount,
        pending_return_count: returns.length,
        total_message_count: msgs.length,
      })
    }

    // Sort: deals with unread messages first, then by most recent activity
    inboxDeals.sort((a, b) => {
      // Unread first
      if (a.unread_message_count > 0 && b.unread_message_count === 0) return -1
      if (b.unread_message_count > 0 && a.unread_message_count === 0) return 1
      // Then by latest activity
      const aTime = new Date(a.latest_message_at).getTime() || 0
      const bTime = new Date(b.latest_message_at).getTime() || 0
      return bTime - aTime
    })

    // Format pending returns with deal info
    const pendingReturns = (allReturns || []).map(r => ({
      ...r,
      property_address: dealMap.get(r.deal_id)?.property_address || 'Unknown',
      deal_status: dealMap.get(r.deal_id)?.status || 'unknown',
    }))

    return {
      success: true,
      data: { inbox: inboxDeals, pendingReturns },
    }
  } catch (err: any) {
    console.error('getAgentInbox error:', err?.message)
    return { success: false, error: 'Failed to load inbox' }
  }
}

// ============================================================================
// Get messages for a specific deal (for the right panel)
// ============================================================================

export async function getDealMessages(dealId: string): Promise<ActionResult> {
  const { error: authErr, user } = await getAuthenticatedUser(['agent'])
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  const serviceClient = createServiceRoleClient()

  try {
    const { data: messages, error } = await serviceClient
      .from('deal_messages')
      .select('*')
      .eq('deal_id', dealId)
      .order('created_at', { ascending: true })

    if (error) return { success: false, error: error.message }

    return { success: true, data: messages || [] }
  } catch (err: any) {
    return { success: false, error: 'Failed to load messages' }
  }
}

// ============================================================================
// Mark messages as read for a deal
// ============================================================================

export async function markDealMessagesRead(input: {
  agentId: string
  dealId: string
}): Promise<ActionResult> {
  const { error: authErr, user } = await getAuthenticatedUser(['agent'])
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  const serviceClient = createServiceRoleClient()

  try {
    // Upsert: insert or update the last_read_at timestamp
    const { error } = await serviceClient
      .from('agent_message_reads')
      .upsert(
        {
          agent_id: input.agentId,
          deal_id: input.dealId,
          last_read_at: new Date().toISOString(),
        },
        { onConflict: 'agent_id,deal_id' }
      )

    if (error) return { success: false, error: error.message }

    return { success: true }
  } catch (err: any) {
    return { success: false, error: 'Failed to mark messages as read' }
  }
}

// ============================================================================
// Send reply from messages page (same as deal page but standalone)
// ============================================================================

export async function sendAgentReply(input: {
  dealId: string
  message: string
  filePath?: string | null
  fileName?: string | null
  fileSize?: number | null
  fileType?: string | null
}): Promise<ActionResult> {
  const { error: authErr, user, profile } = await getAuthenticatedUser(['agent'])
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  const serviceClient = createServiceRoleClient()

  try {
    // Get deal for email notification
    const { data: deal } = await serviceClient
      .from('deals')
      .select('id, property_address')
      .eq('id', input.dealId)
      .single()

    const { data: msg, error } = await serviceClient
      .from('deal_messages')
      .insert({
        deal_id: input.dealId,
        sender_id: user.id,
        sender_role: 'agent',
        sender_name: profile?.full_name || 'Agent',
        message: input.message.trim(),
        is_email_reply: false,
        file_path: input.filePath || null,
        file_name: input.fileName || null,
        file_size: input.fileSize || null,
        file_type: input.fileType || null,
      })
      .select()
      .single()

    if (error) return { success: false, error: error.message }

    // Send email to admin — throttled 1 per deal per 15 min
    try {
      const fifteenMinsAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString()
      const { data: recentAgentMsgs } = await serviceClient
        .from('deal_messages')
        .select('id')
        .eq('deal_id', input.dealId)
        .eq('sender_role', 'agent')
        .neq('id', msg.id)
        .gte('created_at', fifteenMinsAgo)
        .limit(1)

      if (!recentAgentMsgs || recentAgentMsgs.length === 0) {
        const { sendAgentMessageNotification } = await import('@/lib/email')
        await sendAgentMessageNotification({
          dealId: deal?.id || input.dealId,
          propertyAddress: deal?.property_address || 'Unknown',
          agentName: profile?.full_name || 'Agent',
          message: input.message.trim(),
        })
      }
    } catch { /* non-fatal */ }

    return { success: true, data: msg }
  } catch (err: any) {
    return { success: false, error: 'Failed to send reply' }
  }
}

// ============================================================================
// Get new messages since a timestamp (for polling)
// ============================================================================

export async function getNewMessages(input: {
  dealId: string
  afterTimestamp: string
}): Promise<ActionResult> {
  const { error: authErr, user } = await getAuthenticatedUser(['agent', 'super_admin', 'firm_funds_admin', 'brokerage_admin'])
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  const serviceClient = createServiceRoleClient()

  const { data: messages, error } = await serviceClient
    .from('deal_messages')
    .select('id, deal_id, sender_id, sender_role, sender_name, message, is_email_reply, file_path, file_name, file_size, file_type, created_at')
    .eq('deal_id', input.dealId)
    .gt('created_at', input.afterTimestamp)
    .order('created_at', { ascending: true })

  if (error) return { success: false, error: error.message }
  return { success: true, data: messages || [] }
}

// ============================================================================
// Auto-resolve pending document returns when agent uploads a new doc
// ============================================================================

export async function autoResolvePendingReturns(input: {
  dealId: string
  newDocumentId: string
}): Promise<ActionResult> {
  const { error: authErr, user } = await getAuthenticatedUser(['agent'])
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  const serviceClient = createServiceRoleClient()

  try {
    // Resolve all pending returns for this deal
    const { data: resolved, error } = await serviceClient
      .from('document_returns')
      .update({
        status: 'resolved',
        resolved_at: new Date().toISOString(),
        resolved_document_id: input.newDocumentId,
      })
      .eq('deal_id', input.dealId)
      .eq('status', 'pending')
      .select()

    if (error) return { success: false, error: error.message }

    return { success: true, data: { resolvedCount: resolved?.length || 0 } }
  } catch (err: any) {
    return { success: false, error: 'Failed to resolve returns' }
  }
}

// ============================================================================
// ADMIN — Inbox: all deals with messages, with agent info
// ============================================================================

export interface AdminInboxDeal {
  deal_id: string
  property_address: string
  deal_status: string
  closing_date: string
  agent_name: string
  agent_email: string
  latest_message: string
  latest_message_at: string
  latest_sender_role: string
  latest_sender_name: string | null
  needs_reply: boolean
  total_message_count: number
}

export async function getAdminInbox(): Promise<ActionResult> {
  const { error: authErr, user } = await getAuthenticatedUser(['super_admin', 'firm_funds_admin'])
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  const serviceClient = createServiceRoleClient()

  try {
    // Get all messages grouped by deal + admin dismissals in parallel
    const [{ data: allMessages }, { data: dismissals }] = await Promise.all([
      serviceClient
        .from('deal_messages')
        .select('*')
        .order('created_at', { ascending: false }),
      serviceClient
        .from('admin_message_dismissals')
        .select('deal_id, dismissed_at')
        .eq('admin_id', user.id),
    ])

    if (!allMessages || allMessages.length === 0) {
      return { success: true, data: { inbox: [] } }
    }

    // Build dismissal map: deal_id -> dismissed_at timestamp
    const dismissMap = new Map<string, string>()
    if (dismissals) {
      for (const d of dismissals) {
        dismissMap.set(d.deal_id, d.dismissed_at)
      }
    }

    // Get unique deal IDs that have messages
    const dealIds = [...new Set(allMessages.map(m => m.deal_id))]

    // Get deal + agent info
    const { data: deals } = await serviceClient
      .from('deals')
      .select('id, property_address, status, closing_date, agent_id, agents(first_name, last_name, email)')
      .in('id', dealIds)

    if (!deals) return { success: true, data: { inbox: [] } }

    const dealMap = new Map(deals.map(d => [d.id, d]))

    // Build inbox
    const inbox: AdminInboxDeal[] = []

    for (const dealId of dealIds) {
      const deal = dealMap.get(dealId)
      if (!deal) continue

      const msgs = allMessages.filter(m => m.deal_id === dealId)
      const latestMsg = msgs[0] // already sorted desc
      const agent = (deal as any).agents

      // needs_reply = last message from agent AND not dismissed after that message
      let needsReply = latestMsg.sender_role === 'agent'
      if (needsReply && dismissMap.has(dealId)) {
        const dismissedAt = new Date(dismissMap.get(dealId)!)
        const latestMsgAt = new Date(latestMsg.created_at)
        // If dismissed AFTER the latest agent message, it's been acknowledged
        if (dismissedAt >= latestMsgAt) {
          needsReply = false
        }
      }

      inbox.push({
        deal_id: deal.id,
        property_address: deal.property_address,
        deal_status: deal.status,
        closing_date: deal.closing_date,
        agent_name: agent ? `${agent.first_name} ${agent.last_name}` : 'Unknown Agent',
        agent_email: agent?.email || '',
        latest_message: latestMsg.message,
        latest_message_at: latestMsg.created_at,
        latest_sender_role: latestMsg.sender_role,
        latest_sender_name: latestMsg.sender_name,
        needs_reply: needsReply,
        total_message_count: msgs.length,
      })
    }

    // Sort: needs reply first, then by most recent
    inbox.sort((a, b) => {
      if (a.needs_reply && !b.needs_reply) return -1
      if (!a.needs_reply && b.needs_reply) return 1
      return new Date(b.latest_message_at).getTime() - new Date(a.latest_message_at).getTime()
    })

    return { success: true, data: { inbox } }
  } catch (err: any) {
    console.error('getAdminInbox error:', err?.message)
    return { success: false, error: 'Failed to load admin inbox' }
  }
}

// ============================================================================
// ADMIN — Dismiss/acknowledge agent messages on a deal (clears notification)
// ============================================================================

export async function dismissDealMessages(dealId: string): Promise<ActionResult> {
  const { error: authErr, user } = await getAuthenticatedUser(['super_admin', 'firm_funds_admin'])
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  const serviceClient = createServiceRoleClient()

  try {
    const { error } = await serviceClient
      .from('admin_message_dismissals')
      .upsert(
        { admin_id: user.id, deal_id: dealId, dismissed_at: new Date().toISOString() },
        { onConflict: 'admin_id,deal_id' }
      )

    if (error) return { success: false, error: error.message }
    return { success: true }
  } catch (err: any) {
    return { success: false, error: 'Failed to dismiss messages' }
  }
}

// ============================================================================
// ADMIN — Get messages for a specific deal
// ============================================================================

export async function getAdminDealMessages(dealId: string): Promise<ActionResult> {
  const { error: authErr, user } = await getAuthenticatedUser(['super_admin', 'firm_funds_admin'])
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  const serviceClient = createServiceRoleClient()

  try {
    const { data: messages, error } = await serviceClient
      .from('deal_messages')
      .select('*')
      .eq('deal_id', dealId)
      .order('created_at', { ascending: true })

    if (error) return { success: false, error: error.message }
    return { success: true, data: messages || [] }
  } catch (err: any) {
    return { success: false, error: 'Failed to load messages' }
  }
}

// ============================================================================
// ADMIN — Send message (reuses existing sendDealMessage but standalone here for the inbox)
// ============================================================================

export async function sendAdminMessage(input: {
  dealId: string
  message: string
  filePath?: string | null
  fileName?: string | null
  fileSize?: number | null
  fileType?: string | null
}): Promise<ActionResult> {
  const { error: authErr, user, profile } = await getAuthenticatedUser(['super_admin', 'firm_funds_admin'])
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  const serviceClient = createServiceRoleClient()

  try {
    // Get deal + agent for email notification
    const { data: deal } = await serviceClient
      .from('deals')
      .select('id, property_address, agent_id, agents(first_name, email)')
      .eq('id', input.dealId)
      .single()

    if (!deal) return { success: false, error: 'Deal not found' }

    const { data: msg, error } = await serviceClient
      .from('deal_messages')
      .insert({
        deal_id: input.dealId,
        sender_id: user.id,
        sender_role: 'admin',
        sender_name: profile?.full_name || 'Firm Funds',
        message: input.message.trim(),
        file_path: input.filePath || null,
        file_name: input.fileName || null,
        file_size: input.fileSize || null,
        file_type: input.fileType || null,
      })
      .select()
      .single()

    if (error) return { success: false, error: error.message }

    // Send email notification to agent — throttled to 1 per deal per 15 min
    const agent = (deal as any).agents
    if (agent?.email) {
      const fifteenMinsAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString()
      const { data: recentAdminMsgs } = await serviceClient
        .from('deal_messages')
        .select('id')
        .eq('deal_id', input.dealId)
        .eq('sender_role', 'admin')
        .neq('id', msg.id) // exclude the message we just inserted
        .gte('created_at', fifteenMinsAgo)
        .limit(1)

      const shouldSendEmail = !recentAdminMsgs || recentAdminMsgs.length === 0

      if (shouldSendEmail) {
        const { sendDealMessageNotification } = await import('@/lib/email')
        sendDealMessageNotification({
          dealId: deal.id,
          propertyAddress: deal.property_address,
          agentEmail: agent.email,
          agentFirstName: agent.first_name,
          message: input.message.trim(),
          senderName: profile?.full_name || 'Firm Funds',
        })
      }
    }

    return { success: true, data: msg }
  } catch (err: any) {
    return { success: false, error: 'Failed to send message' }
  }
}

// ============================================================================
// Brokerage messaging — send a message from a brokerage admin about a deal
// ============================================================================

export async function sendBrokerageMessage(input: {
  dealId: string
  message: string
  filePath?: string | null
  fileName?: string | null
  fileSize?: number | null
  fileType?: string | null
}): Promise<ActionResult> {
  const { error: authErr, user, profile } = await getAuthenticatedUser(['brokerage_admin'])
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  const serviceClient = createServiceRoleClient()

  try {
    // Verify the deal belongs to this brokerage
    const { data: deal } = await serviceClient
      .from('deals')
      .select('id, brokerage_id, property_address')
      .eq('id', input.dealId)
      .single()

    if (!deal) return { success: false, error: 'Deal not found' }
    if (deal.brokerage_id !== profile?.brokerage_id) return { success: false, error: 'Access denied' }

    const { data: msg, error } = await serviceClient
      .from('deal_messages')
      .insert({
        deal_id: input.dealId,
        sender_id: user.id,
        sender_role: 'brokerage_admin',
        sender_name: profile?.full_name || 'Brokerage',
        message: input.message.trim(),
        is_email_reply: false,
        file_path: input.filePath || null,
        file_name: input.fileName || null,
        file_size: input.fileSize || null,
        file_type: input.fileType || null,
      })
      .select()
      .single()

    if (error) return { success: false, error: error.message }

    // Send email notification to admin
    try {
      const { sendBrokerageMessageNotification } = await import('@/lib/email')
      await sendBrokerageMessageNotification({
        dealId: deal.id,
        propertyAddress: deal.property_address,
        senderName: profile?.full_name || 'Brokerage Admin',
        message: input.message.trim(),
      })
    } catch (emailErr) {
      console.error('[sendBrokerageMessage] Email notification failed:', emailErr)
      // Email failure shouldn't block the message
    }

    return { success: true, data: msg }
  } catch (err: any) {
    return { success: false, error: 'Failed to send message' }
  }
}

// ============================================================================
// Get brokerage inbox — deals this brokerage has, with message counts
// ============================================================================

export async function getBrokerageInbox(brokerageId: string): Promise<ActionResult> {
  const { error: authErr, user, profile } = await getAuthenticatedUser(['brokerage_admin'])
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }
  if (profile?.brokerage_id !== brokerageId) return { success: false, error: 'Access denied' }

  const serviceClient = createServiceRoleClient()

  try {
    const { data: deals } = await serviceClient
      .from('deals')
      .select('id, property_address, status, closing_date, agent:agents(first_name, last_name)')
      .eq('brokerage_id', brokerageId)
      .not('status', 'in', '("denied","cancelled")')
      .order('created_at', { ascending: false })

    if (!deals || deals.length === 0) return { success: true, data: { inbox: [] } }

    const dealIds = deals.map(d => d.id)
    const { data: messages } = await serviceClient
      .from('deal_messages')
      .select('deal_id, sender_role, sender_name, message, created_at')
      .in('deal_id', dealIds)
      .order('created_at', { ascending: false })

    // Build message map — latest message per deal
    const msgMap = new Map<string, { message: string; sender_role: string; sender_name: string | null; created_at: string; count: number }>()
    for (const msg of (messages || [])) {
      if (!msgMap.has(msg.deal_id)) {
        msgMap.set(msg.deal_id, { message: msg.message, sender_role: msg.sender_role, sender_name: msg.sender_name, created_at: msg.created_at, count: 0 })
      }
      const entry = msgMap.get(msg.deal_id)!
      entry.count++
    }

    const inbox = deals.map(d => {
      const msgEntry = msgMap.get(d.id)
      const agent = d.agent as any
      return {
        deal_id: d.id,
        property_address: d.property_address,
        deal_status: d.status,
        agent_name: agent ? `${agent.first_name} ${agent.last_name}` : 'Unknown',
        latest_message: msgEntry?.message || '',
        latest_message_at: msgEntry?.created_at || '',
        latest_sender_role: msgEntry?.sender_role || '',
        total_message_count: msgEntry?.count || 0,
      }
    })

    return { success: true, data: { inbox } }
  } catch (err: any) {
    return { success: false, error: 'Failed to load inbox' }
  }
}
