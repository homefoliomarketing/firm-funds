'use server'

import { headers } from 'next/headers'
import { createClient, createServiceRoleClient } from '@/lib/supabase/server'
import { checkLoginRateLimit } from '@/lib/rate-limit'

type LoginResult = {
  success: boolean
  error?: string
  data?: {
    role: string
  }
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
    .select('role, email, is_active')
    .eq('id', data.user.id)
    .single()

  if (profileError || !profile) {
    await supabase.auth.signOut()
    await insertAuthAudit({
      userId: data.user.id,
      action: 'auth.login_blocked',
      severity: 'warning',
      actorEmail: data.user.email ?? email,
      metadata: { email: data.user.email ?? email, reason: 'missing_profile' },
    })
    return { success: false, error: 'Your account is not fully provisioned. Contact Firm Funds support.' }
  }

  if (profile.is_active === false) {
    await supabase.auth.signOut()
    await insertAuthAudit({
      userId: data.user.id,
      action: 'auth.login_blocked',
      severity: 'warning',
      actorEmail: profile.email ?? data.user.email ?? email,
      actorRole: profile.role,
      metadata: { email: profile.email ?? data.user.email ?? email, reason: 'inactive_profile' },
    })
    return { success: false, error: 'Your account is inactive. Contact Firm Funds support.' }
  }

  await insertAuthAudit({
    userId: data.user.id,
    action: 'auth.login',
    actorEmail: profile.email ?? data.user.email ?? email,
    actorRole: profile.role,
    metadata: { email: profile.email ?? data.user.email ?? email },
  })

  return { success: true, data: { role: profile.role } }
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
