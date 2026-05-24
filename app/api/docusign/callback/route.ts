import { cookies } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'
import { exchangeCodeForTokens, getUserInfo, saveTokens } from '@/lib/docusign'

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

    return NextResponse.redirect(new URL('/admin/settings?docusign=connected', request.url))
  } catch (err: any) {
    console.error('DocuSign callback error:', err?.message)
    return NextResponse.redirect(new URL('/admin/settings?docusign=error&reason=' + encodeURIComponent(err?.message || 'unknown'), request.url))
  }
}
