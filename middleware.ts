import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

// Role-to-route mapping for authorization
const ROUTE_ROLES: Record<string, string[]> = {
  '/admin': ['super_admin', 'firm_funds_admin'],
  '/brokerage': ['brokerage_admin'],
  '/agent': ['agent'],
}

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          )
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  // Validate JWT server-side (not just check session)
  const { data: { user } } = await supabase.auth.getUser()

  const pathname = request.nextUrl.pathname

  // Redirect unauthenticated users to login (except login/auth/kyc-upload/kyc API routes/invite/magic-link)
  // Preserve the original URL so we can redirect back after login
  if (!user && !pathname.startsWith('/login') && !pathname.startsWith('/auth') && !pathname.startsWith('/kyc-upload') && !pathname.startsWith('/api/kyc-') && !pathname.startsWith('/invite') && !pathname.startsWith('/api/magic-link') && !pathname.startsWith('/api/rate-limit')) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    // Pass the original destination so login can redirect back
    url.searchParams.set('redirect', pathname)
    return NextResponse.redirect(url)
  }

  // For authenticated users: enforce role-based route access
  if (user) {
    // Check if user must reset their password (first login after invite)
    // Skip if user already changed password (metadata flag set client-side)
    if (!pathname.startsWith('/change-password') && !pathname.startsWith('/api/') && !pathname.startsWith('/login') && !pathname.startsWith('/auth')) {
      const hasChangedPassword = user.user_metadata?.password_changed === true
      if (!hasChangedPassword) {
        const { data: pwProfile } = await supabase
          .from('user_profiles')
          .select('must_reset_password')
          .eq('id', user.id)
          .single()

        if (pwProfile?.must_reset_password) {
          const url = request.nextUrl.clone()
          url.pathname = '/change-password'
          return NextResponse.redirect(url)
        }
      }
    }

    // If on login page, redirect to appropriate dashboard (or redirect param if present)
    if (pathname.startsWith('/login')) {
      const { data: profile } = await supabase
        .from('user_profiles')
        .select('role')
        .eq('id', user.id)
        .single()

      // If no profile exists, sign them out and let them stay on login
      // (prevents redirect loop when profile row is missing)
      if (!profile) {
        await supabase.auth.signOut()
        return supabaseResponse
      }

      const url = request.nextUrl.clone()
      const redirectParam = request.nextUrl.searchParams.get('redirect')

      // If there's a redirect URL, validate it matches the user's role prefix
      if (redirectParam) {
        const roleRoutes: Record<string, string> = {
          agent: '/agent',
          brokerage_admin: '/brokerage',
          firm_funds_admin: '/admin',
          super_admin: '/admin',
        }
        const allowedPrefix = roleRoutes[profile.role] || '/agent'
        if (redirectParam.startsWith(allowedPrefix)) {
          url.pathname = redirectParam
          url.searchParams.delete('redirect')
          return NextResponse.redirect(url)
        }
      }

      switch (profile.role) {
        case 'agent': url.pathname = '/agent'; break
        case 'brokerage_admin': url.pathname = '/brokerage'; break
        case 'firm_funds_admin':
        case 'super_admin': url.pathname = '/admin'; break
        default: url.pathname = '/agent'
      }
      return NextResponse.redirect(url)
    }

    // Check role-based access for protected routes
    for (const [routePrefix, allowedRoles] of Object.entries(ROUTE_ROLES)) {
      if (pathname.startsWith(routePrefix)) {
        const { data: profile } = await supabase
          .from('user_profiles')
          .select('role')
          .eq('id', user.id)
          .single()

        if (!profile || !allowedRoles.includes(profile.role)) {
          // User doesn't have the right role or no profile — sign out and redirect to login
          await supabase.auth.signOut()
          const url = request.nextUrl.clone()
          url.pathname = '/login'
          return NextResponse.redirect(url)
        }
        break
      }
    }
  }

  return supabaseResponse
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|robots.txt|.well-known|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
