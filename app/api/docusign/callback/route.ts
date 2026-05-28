import { cookies } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { exchangeCodeForTokens, getUserInfo, saveTokens } from '@/lib/docusign'
import { createServiceRoleClient } from '@/lib/supabase/server'

const STATE_COOKIE = 'ds_oauth_state'

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams
  const code = searchParams.get('code')
  const error = searchParams.get('error')
  const state = searchParams.get('state')

  // Always delete the state cookie — single-use, regardless of outcome.
  const cookieStore = await cookies()
  const storedState = cookieStore.get(STATE_COOKIE)?.value
  cookieStore.delete(STATE_COOKIE)

  if (error) {
    console.error('DocuSign OAuth error:', error)
    return NextResponse.redirect(new URL('/admin/settings?docusign=error&reason=' + encodeURIComponent(error), request.url))
  }

  if (!code) {
    return NextResponse.redirect(new URL('/admin/settings?docusign=error&reason=no_code', request.url))
  }

  // CSRF protection: reject if state is missing, mismatched, or the cookie
  // has expired (cookie expired → storedState will be undefined). Without
  // this an attacker can complete the OAuth handshake with a code from a
  // DocuSign account they control and link it to an admin who clicks a
  // crafted callback URL.
  if (!state || !storedState || state !== storedState) {
    console.error('DocuSign callback: state mismatch', {
      hasState: !!state,
      hasStored: !!storedState,
    })
    return new NextResponse('Invalid state parameter', { status: 400 })
  }

  // Re-verify the caller is still an admin. /connect gates the start of the
  // flow, but if a session is hijacked between connect and callback a
  // non-admin could otherwise complete the link and own the integration.
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll() },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch { /* middleware handles refresh */ }
        },
      },
    }
  )

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.redirect(new URL('/login?error=docusign_link_unauthenticated', request.url))
  }

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('role, is_active')
    .eq('id', user.id)
    .single()

  if (!profile || profile.is_active === false || !['super_admin', 'firm_funds_admin'].includes(profile.role)) {
    console.error('DocuSign callback: non-admin attempted to complete link', { userId: user.id })
    return NextResponse.redirect(new URL('/login?error=docusign_link_forbidden', request.url))
  }

  try {
    const tokens = await exchangeCodeForTokens(code)

    const userInfo = await getUserInfo(tokens.access_token)
    const account = userInfo.accounts?.find(a => a.is_default) || userInfo.accounts?.[0]

    if (!account) {
      throw new Error('No DocuSign account found for this user')
    }

    await saveTokens({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_in: tokens.expires_in,
      token_type: tokens.token_type,
      account_id: account.account_id,
      base_uri: account.base_uri,
    })

    // Record who linked the integration for audit purposes. Best-effort: do
    // not fail the OAuth flow if this update errors (the token row is what
    // matters for functionality).
    try {
      const admin = createServiceRoleClient()
      await admin
        .from('docusign_tokens')
        .update({ linked_by_user_id: user.id, linked_at: new Date().toISOString() })
        .eq('id', 1)
    } catch (auditErr: unknown) {
      const message = auditErr instanceof Error ? auditErr.message : 'unknown'
      console.error('DocuSign callback: failed to record linker', message)
    }

    return NextResponse.redirect(new URL('/admin/settings?docusign=connected', request.url))
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'unknown'
    console.error('DocuSign callback error:', message)
    return NextResponse.redirect(new URL('/admin/settings?docusign=error&reason=' + encodeURIComponent(message), request.url))
  }
}
