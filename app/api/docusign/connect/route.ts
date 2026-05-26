import { randomUUID } from 'node:crypto'
import { cookies } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'

// Initiates the DocuSign OAuth flow. Generates a one-time CSRF state value,
// stores it in an httpOnly cookie with 5-min TTL, and redirects to DocuSign
// with `state` in the auth URL. The callback (/api/docusign/callback) MUST
// verify the returned state matches the cookie before exchanging the code.
//
// Without this, an attacker can trick an admin into clicking a crafted
// callback URL that links the admin's Firm Funds account to a DocuSign
// account the attacker controls — every signed contract from then on flows
// through the attacker.

const STATE_COOKIE = 'ds_oauth_state'
const STATE_TTL_SECONDS = 300

export async function GET(request: NextRequest) {
  // Require an authenticated admin. The OAuth flow links a DocuSign account
  // to the Firm Funds DocuSign integration; only admins should be able to
  // start it.
  const cookieStore = await cookies()
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
    return NextResponse.redirect(new URL('/login', request.url))
  }

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('role')
    .eq('id', user.id)
    .single()

  if (!profile || !['super_admin', 'firm_funds_admin'].includes(profile.role)) {
    return NextResponse.redirect(new URL('/login', request.url))
  }

  const state = randomUUID()

  const DOCUSIGN_INTEGRATION_KEY = process.env.DOCUSIGN_INTEGRATION_KEY
  const DOCUSIGN_AUTH_URL = process.env.DOCUSIGN_AUTH_URL || 'https://account-d.docusign.com'
  const DOCUSIGN_REDIRECT_URI = process.env.DOCUSIGN_REDIRECT_URI || 'http://localhost:3000/api/docusign/callback'

  if (!DOCUSIGN_INTEGRATION_KEY) {
    return NextResponse.redirect(new URL('/admin/settings?docusign=error&reason=not_configured', request.url))
  }

  const scopes = 'signature impersonation'
  const dsUrl = `${DOCUSIGN_AUTH_URL}/oauth/auth?response_type=code&scope=${encodeURIComponent(scopes)}&client_id=${DOCUSIGN_INTEGRATION_KEY}&redirect_uri=${encodeURIComponent(DOCUSIGN_REDIRECT_URI)}&state=${state}`

  const response = NextResponse.redirect(dsUrl)
  response.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: STATE_TTL_SECONDS,
  })
  return response
}
