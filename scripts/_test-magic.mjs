import { createClient } from '@supabase/supabase-js'

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
)

const r = await sb.auth.admin.generateLink({
  type: 'magiclink',
  email: 'bud.jones@century21.ca',
  options: {
    redirectTo: 'https://firmfunds.ca/agent/dashboard?firm_deal=e2a83d88-5ce9-49aa-a788-a78d1a9c473b',
  },
})

if (r.error) {
  console.log('ERR', JSON.stringify({ status: r.error.status, code: r.error.code, message: r.error.message }))
} else {
  const u = new URL(r.data.properties.action_link)
  console.log('OK link_host=' + u.host + ' verify_path=' + u.pathname)
}
