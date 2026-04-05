import { NextRequest, NextResponse } from 'next/server'
import { exchangeCodeForTokens, getUserInfo, saveTokens } from '@/lib/docusign'

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams
  const code = searchParams.get('code')
  const error = searchParams.get('error')

  if (error) {
    console.error('DocuSign OAuth error:', error)
    return NextResponse.redirect(new URL('/admin/settings?docusign=error&reason=' + encodeURIComponent(error), request.url))
  }

  if (!code) {
    return NextResponse.redirect(new URL('/admin/settings?docusign=error&reason=no_code', request.url))
  }

  try {
    // Exchange authorization code for tokens
    const tokens = await exchangeCodeForTokens(code)

    // Get user info to find the account's base URI
    const userInfo = await getUserInfo(tokens.access_token)
    const account = userInfo.accounts?.find(a => a.is_default) || userInfo.accounts?.[0]

    if (!account) {
      throw new Error('No DocuSign account found for this user')
    }

    // Save tokens to database
    await saveTokens({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_in: tokens.expires_in,
      token_type: tokens.token_type,
      account_id: account.account_id,
      base_uri: account.base_uri,
    })

    // Redirect back to admin settings with success
    return NextResponse.redirect(new URL('/admin/settings?docusign=connected', request.url))
  } catch (err: any) {
    console.error('DocuSign callback error:', err?.message)
    return NextResponse.redirect(new URL('/admin/settings?docusign=error&reason=' + encodeURIComponent(err?.message || 'unknown'), request.url))
  }
}
