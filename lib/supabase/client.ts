import { createBrowserClient } from '@supabase/ssr'
import { IMPERSONATION_HINT_COOKIE } from '@/lib/constants'
import { decodeImpersonationHint } from '@/lib/impersonation-core'

function readImpersonationHintCookie(): string | null {
  if (typeof document === 'undefined') return null
  const prefix = IMPERSONATION_HINT_COOKIE + '='
  const entry = document.cookie.split('; ').find((c) => c.startsWith(prefix))
  if (!entry) return null
  // document.cookie returns the raw (URL-encoded) value the cookie store wrote;
  // decode once to recover the JSON before decodeImpersonationHint parses it.
  try {
    return decodeURIComponent(entry.slice(prefix.length))
  } catch {
    return null
  }
}

export function createClient() {
  const client = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )

  // "View as user" override. The dashboards resolve their own identity in the
  // browser via supabase.auth.getUser(). When an Owner is viewing-as another
  // user, a non-httpOnly hint cookie names the target; here we make getUser()
  // report that TARGET so every client dashboard renders the target's world
  // without each page needing to know about impersonation.
  //
  // This is UI-only and NOT a security boundary: the client stays authenticated
  // as the real Owner, so RLS (evaluated on the real auth.uid() — a super_admin
  // who can already read everything) is still the boundary, and the explicit
  // agent_id/brokerage_id filters in the dashboards scope reads to the target.
  // Writes are blocked by the proxy. A forged cookie cannot widen what the real
  // signed-in user is allowed to read. Absent the cookie, behavior is unchanged.
  const realGetUser = client.auth.getUser.bind(client.auth)
  client.auth.getUser = (async (...args: Parameters<typeof realGetUser>) => {
    const hint = decodeImpersonationHint(readImpersonationHintCookie(), Date.now())
    const real = await realGetUser(...args)
    if (!hint || real.error || !real.data?.user) return real
    return {
      data: {
        user: { ...real.data.user, id: hint.t, email: hint.e ?? real.data.user.email },
      },
      error: null,
    }
  }) as typeof client.auth.getUser

  return client
}
