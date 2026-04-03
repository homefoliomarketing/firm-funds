import { createServerClient } from '@supabase/ssr'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'

export async function createClient() {
  const cookieStore = await cookies()

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch {
            // This can be ignored if you have middleware refreshing user sessions
          }
        },
      },
    }
  )
}

/**
 * Service-role client for admin operations (user creation, etc.)
 * This bypasses RLS — only use in server actions that have already
 * verified the caller is an authenticated admin.
 */
export function createServiceRoleClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !key) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured. Add it to your Netlify environment variables.')
  }

  return createSupabaseClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  })
}