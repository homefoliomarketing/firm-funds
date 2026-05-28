'use server'

import { headers } from 'next/headers'
import { createClient, createServiceRoleClient } from '@/lib/supabase/server'
import { checkLoginRateLimit } from '@/lib/rate-limit'
import {
  getAgentStatusError,
  getBrokerageStatusError,
  getProfileStatusError,
} from '@/lib/access'
import type { AgentStatus, BrokerageStatus, UserRole } from '@/types/database'
import type { SupabaseClient } from '@supabase/supabase-js'

type LoginResult = {
  success: boolean
  error?: string
  data?: {
    role: string
  }
}

type LoginProfile = {
  role: UserRole
  email: string | null
  is_active: boolean
  agent_id: string | null
  brokerage_id: string | null
}

type LoginAgent = {
  id: string
  brokerage_id: string | null
  status: AgentStatus
  flagged_by_brokerage: boolean
}

type LoginBrokerage = {
  id: string
  status: BrokerageStatus
}

function headerValue(headerStore: Headers, name: string): string | null {
  const value = headerStore.get(name)
  return value && value.trim().length > 0 ? value.trim() : null
}

function getClientIp(headerStore: Headers): string {
  const netlify = headerValue(headerStore, 'x-nf-client-connection-ip')
  if (netlify) return netlify

  const forwarded = headerValue(headerStore, 'x-forwarded-for')
  const firstForwarded = forwarded?.split(',')[0]?.trim()
  if (firstForwarded) return firstForwarded

  return headerValue(headerStore, 'x-real-ip') ?? '127.0.0.1'
}

function normalizeEmailForAudit(email: string): string {
  return email.trim().toLowerCase().slice(0, 320)
}

async function insertAuthAudit(input: {
  userId?: string | null
  action: 'auth.login' | 'auth.login_failed' | 'auth.login_blocked' | 'auth.logout'
  severity?: 'info' | 'warning'
  actorEmail?: string | null
  actorRole?: string | null
  metadata?: Record<string, unknown>
}) {
  try {
    const serviceClient = createServiceRoleClient()
    await serviceClient.from('audit_log').insert({
      user_id: input.userId ?? null,
      action: input.action,
      entity_type: 'auth',
      severity: input.severity ?? 'info',
      actor_email: input.actorEmail ?? null,
      actor_role: input.actorRole ?? null,
      metadata: input.metadata ?? {},
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.warn(`[AUDIT LOG FAILURE] action=${input.action} error=${message}`)
  }
}

async function blockAuthenticatedLogin(input: {
  supabase: SupabaseClient
  userId: string
  actorEmail: string | null
  actorRole: string | null
  reason: string
  error: string
}): Promise<LoginResult> {
  await input.supabase.auth.signOut()
  await insertAuthAudit({
    userId: input.userId,
    action: 'auth.login_blocked',
    severity: 'warning',
    actorEmail: input.actorEmail,
    actorRole: input.actorRole,
    metadata: { email: input.actorEmail, reason: input.reason },
  })
  return { success: false, error: input.error }
}

async function getBrokerageStatusForLogin(
  serviceClient: SupabaseClient,
  brokerageId: string | null
): Promise<BrokerageStatus | null> {
  if (!brokerageId) return null

  const { data } = await serviceClient
    .from('brokerages')
    .select('id, status')
    .eq('id', brokerageId)
    .single()

  return (data as LoginBrokerage | null)?.status ?? null
}

export async function loginWithPassword(input: {
  email: string
  password: string
}): Promise<LoginResult> {
  const email = normalizeEmailForAudit(input.email || '')
  if (!email || !input.password) {
    return { success: false, error: 'Email and password are required.' }
  }

  const headerStore = await headers()
  const limit = await checkLoginRateLimit(getClientIp(headerStore))
  if (!limit.allowed) {
    return {
      success: false,
      error: `Too many login attempts. Please try again in ${Math.max(1, Math.ceil(limit.resetInSeconds / 60))} minute${limit.resetInSeconds > 60 ? 's' : ''}.`,
    }
  }

  const supabase = await createClient()
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password: input.password,
  })

  if (error || !data.user) {
    await insertAuthAudit({
      action: 'auth.login_failed',
      severity: 'warning',
      actorEmail: email,
      metadata: { email, reason: error?.message ?? 'Unknown auth failure' },
    })
    return { success: false, error: error?.message ?? 'Invalid login credentials.' }
  }

  const serviceClient = createServiceRoleClient()
  const { data: profile, error: profileError } = await serviceClient
    .from('user_profiles')
    .select('role, email, is_active, agent_id, brokerage_id')
    .eq('id', data.user.id)
    .single()

  const loginProfile = profile as LoginProfile | null

  if (profileError || !loginProfile) {
    return blockAuthenticatedLogin({
      supabase,
      userId: data.user.id,
      actorEmail: data.user.email ?? email,
      actorRole: null,
      reason: 'missing_profile',
      error: 'Your account is not fully provisioned. Contact Firm Funds support.',
    })
  }

  const actorEmail = loginProfile.email ?? data.user.email ?? email
  const profileStatusError = getProfileStatusError(loginProfile)
  if (profileStatusError) {
    return blockAuthenticatedLogin({
      supabase,
      userId: data.user.id,
      actorEmail,
      actorRole: loginProfile.role,
      reason: 'inactive_profile',
      error: profileStatusError,
    })
  }

  if (loginProfile.role === 'agent') {
    if (!loginProfile.agent_id) {
      return blockAuthenticatedLogin({
        supabase,
        userId: data.user.id,
        actorEmail,
        actorRole: loginProfile.role,
        reason: 'missing_agent_profile',
        error: 'No agent profile is linked to your account. Contact Firm Funds support.',
      })
    }

    const { data: agentData } = await serviceClient
      .from('agents')
      .select('id, brokerage_id, status, flagged_by_brokerage')
      .eq('id', loginProfile.agent_id)
      .single()

    const agent = agentData as LoginAgent | null
    if (!agent) {
      return blockAuthenticatedLogin({
        supabase,
        userId: data.user.id,
        actorEmail,
        actorRole: loginProfile.role,
        reason: 'missing_agent_record',
        error: 'Agent profile not found. Contact Firm Funds support.',
      })
    }

    const agentStatusError = getAgentStatusError(agent)
    if (agentStatusError) {
      return blockAuthenticatedLogin({
        supabase,
        userId: data.user.id,
        actorEmail,
        actorRole: loginProfile.role,
        reason: agent.flagged_by_brokerage ? 'flagged_agent' : 'inactive_agent',
        error: agentStatusError,
      })
    }

    const brokerageStatus = await getBrokerageStatusForLogin(serviceClient, agent.brokerage_id)
    const brokerageStatusError = getBrokerageStatusError(brokerageStatus, loginProfile.role)
    if (brokerageStatusError) {
      return blockAuthenticatedLogin({
        supabase,
        userId: data.user.id,
        actorEmail,
        actorRole: loginProfile.role,
        reason: 'inactive_brokerage',
        error: brokerageStatusError,
      })
    }
  }

  if (loginProfile.role === 'brokerage_admin') {
    const brokerageStatus = await getBrokerageStatusForLogin(serviceClient, loginProfile.brokerage_id)
    const brokerageStatusError = getBrokerageStatusError(brokerageStatus, loginProfile.role)
    if (brokerageStatusError) {
      return blockAuthenticatedLogin({
        supabase,
        userId: data.user.id,
        actorEmail,
        actorRole: loginProfile.role,
        reason: 'inactive_brokerage',
        error: brokerageStatusError,
      })
    }
  }

  await insertAuthAudit({
    userId: data.user.id,
    action: 'auth.login',
    actorEmail,
    actorRole: loginProfile.role,
    metadata: { email: actorEmail },
  })

  return { success: true, data: { role: loginProfile.role } }
}

export async function logLogout(): Promise<{ success: boolean }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: true }

  const serviceClient = createServiceRoleClient()
  const { data: profile } = await serviceClient
    .from('user_profiles')
    .select('role, email')
    .eq('id', user.id)
    .single()

  await insertAuthAudit({
    userId: user.id,
    action: 'auth.logout',
    actorEmail: profile?.email ?? user.email ?? null,
    actorRole: profile?.role ?? null,
    metadata: { email: profile?.email ?? user.email ?? null },
  })

  return { success: true }
}
