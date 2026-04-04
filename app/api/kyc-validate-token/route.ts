import { NextResponse } from 'next/server'
import { createServiceRoleClient } from '@/lib/supabase/server'

export async function POST(request: Request) {
  try {
    const { token } = await request.json()
    if (!token) return NextResponse.json({ success: false, error: 'invalid' })

    const serviceClient = createServiceRoleClient()

    const { data: tokenRecord, error } = await serviceClient
      .from('kyc_upload_tokens')
      .select('id, agent_id, expires_at, used_at')
      .eq('token', token)
      .single()

    // Return identical error for all failure modes to prevent token enumeration
    if (error || !tokenRecord) {
      return NextResponse.json({ success: false, error: 'Invalid or expired link' })
    }

    if (tokenRecord.used_at) {
      return NextResponse.json({ success: false, error: 'Invalid or expired link' })
    }

    if (new Date(tokenRecord.expires_at) < new Date()) {
      return NextResponse.json({ success: false, error: 'Invalid or expired link' })
    }

    // Get agent name
    const { data: agent } = await serviceClient
      .from('agents')
      .select('first_name')
      .eq('id', tokenRecord.agent_id)
      .single()

    return NextResponse.json({
      success: true,
      data: { agentName: agent?.first_name || 'Agent' },
    })
  } catch (err: any) {
    console.error('KYC token validation error:', err?.message)
    return NextResponse.json({ success: false, error: 'invalid' })
  }
}
