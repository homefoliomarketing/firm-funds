import { createServiceRoleClient } from '@/lib/supabase/server'
import { ResubscribeButton } from './resubscribe-button'

// ============================================================================
// /unsubscribe — CASL human-facing landing page (server component)
// ============================================================================
//
// Two modes:
//   1. ?token=<hex>   — looks up the entity, displays current preference
//                        state, and renders a Resubscribe button if the
//                        entity has been unsubscribed.
//   2. (no token)     — generic landing page directing the user to manage
//                        notifications from their account settings.
//
// IMPORTANT: this page is a server component because it reads from Supabase
// with the service role. The page is reachable WITHOUT a session — the
// token is the authentication — so the route is in middleware.ts PUBLIC_PATHS.
//
// The page does NOT auto-unsubscribe on GET. That's an intentional design
// choice: Gmail / iCloud pre-fetch HTTP links to populate previews, and
// auto-unsubscribing on GET would silently mute users when their inbox
// scans the email. The one-click button on the Gmail / iCloud bar POSTs
// to /api/unsubscribe (which DOES unsubscribe), and the human flow uses
// the same POST via the wrapper page below.
// ============================================================================

type EntityType = 'agent' | 'brokerage'

type LoadResult =
  | {
      kind: 'ok'
      token: string
      entityType: EntityType
      entityId: string
      displayName: string
      currentlyEnabled: boolean
    }
  | { kind: 'invalid_token' }
  | { kind: 'no_token' }
  | { kind: 'error' }

async function load(rawToken: string | undefined): Promise<LoadResult> {
  if (!rawToken) return { kind: 'no_token' }
  if (rawToken.length < 16) return { kind: 'invalid_token' }
  try {
    const service = createServiceRoleClient()
    const { data: tokenRow, error: tokenErr } = await service
      .from('email_unsubscribe_tokens')
      .select('entity_type, entity_id')
      .eq('token', rawToken)
      .maybeSingle()
    if (tokenErr || !tokenRow) return { kind: 'invalid_token' }
    const row = tokenRow as { entity_type: EntityType; entity_id: string }
    const entityType: EntityType = row.entity_type
    const entityId: string = row.entity_id

    let displayName = ''
    let currentlyEnabled = true
    if (entityType === 'agent') {
      const { data: agent } = await service
        .from('agents')
        .select('first_name, last_name, email, email_notifications_enabled')
        .eq('id', entityId)
        .maybeSingle()
      if (agent) {
        const a = agent as {
          first_name?: string | null
          last_name?: string | null
          email?: string | null
          email_notifications_enabled?: boolean | null
        }
        const named = [a.first_name, a.last_name].filter(Boolean).join(' ').trim()
        displayName = named || a.email || ''
        currentlyEnabled = a.email_notifications_enabled !== false
      }
    } else {
      const { data: brokerage } = await service
        .from('brokerages')
        .select('name, email, email_notifications_enabled')
        .eq('id', entityId)
        .maybeSingle()
      if (brokerage) {
        const b = brokerage as {
          name?: string | null
          email?: string | null
          email_notifications_enabled?: boolean | null
        }
        displayName = b.name || b.email || ''
        currentlyEnabled = b.email_notifications_enabled !== false
      }
    }

    return {
      kind: 'ok',
      token: rawToken,
      entityType,
      entityId,
      displayName,
      currentlyEnabled,
    }
  } catch (err) {
    console.error('[unsubscribe page] load failed:', err)
    return { kind: 'error' }
  }
}

export default async function UnsubscribePage({
  searchParams,
}: {
  // Next.js 16: searchParams is a Promise (per the project's AGENTS.md
  // breaking-changes warning).
  searchParams: Promise<{ token?: string | string[] }>
}) {
  const params = await searchParams
  const raw = params?.token
  const token = Array.isArray(raw) ? raw[0] : raw
  const result = await load(token)

  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '40px 20px',
        background: '#0C0C0C',
        color: '#E5E5E5',
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
      }}
    >
      <article
        style={{
          width: '100%',
          maxWidth: 520,
          background: '#171717',
          border: '1px solid #262626',
          borderRadius: 16,
          padding: '40px 32px',
          textAlign: 'center',
        }}
        aria-live="polite"
      >
        <h1
          style={{
            margin: '0 0 12px',
            fontSize: 22,
            fontWeight: 700,
            letterSpacing: '-0.01em',
          }}
        >
          {result.kind === 'ok' && result.currentlyEnabled
            ? 'Confirm Unsubscribe'
            : result.kind === 'ok' && !result.currentlyEnabled
            ? "You're Unsubscribed"
            : 'Manage Notification Preferences'}
        </h1>

        {result.kind === 'ok' && (
          <>
            {result.displayName ? (
              <p style={{ margin: '0 0 18px', color: '#A3A3A3', fontSize: 14 }}>
                {result.entityType === 'agent' ? 'Agent: ' : 'Brokerage: '}
                <strong style={{ color: '#E5E5E5' }}>
                  {result.displayName}
                </strong>
              </p>
            ) : null}

            {result.currentlyEnabled ? (
              <>
                <p
                  style={{
                    margin: '0 0 24px',
                    color: '#BCBBB8',
                    fontSize: 14,
                    lineHeight: 1.6,
                  }}
                >
                  Click the button below to stop receiving promotional and
                  notification emails from Firm Funds. Account, security, and
                  legal emails will still be sent.
                </p>
                <ResubscribeButton
                  token={result.token}
                  mode="unsubscribe"
                />
              </>
            ) : (
              <>
                <p
                  style={{
                    margin: '0 0 24px',
                    color: '#BCBBB8',
                    fontSize: 14,
                    lineHeight: 1.6,
                  }}
                >
                  You will no longer receive promotional or notification emails
                  from Firm Funds. Account, security, and legal emails will
                  still be sent.
                </p>
                <ResubscribeButton
                  token={result.token}
                  mode="resubscribe"
                />
              </>
            )}
          </>
        )}

        {result.kind === 'no_token' && (
          <p
            style={{
              margin: '0 0 12px',
              color: '#BCBBB8',
              fontSize: 14,
              lineHeight: 1.6,
            }}
          >
            To manage your notification preferences, sign in and visit your
            account settings.
          </p>
        )}

        {result.kind === 'invalid_token' && (
          <p
            style={{
              margin: '0 0 12px',
              color: '#F87171',
              fontSize: 14,
              lineHeight: 1.6,
            }}
          >
            This unsubscribe link is invalid or has expired. To manage your
            notification preferences, sign in and visit your account settings.
          </p>
        )}

        {result.kind === 'error' && (
          <p
            style={{
              margin: '0 0 12px',
              color: '#F87171',
              fontSize: 14,
              lineHeight: 1.6,
            }}
          >
            Something went wrong loading your preferences. Please try again in
            a few minutes.
          </p>
        )}

        <hr
          style={{
            border: 'none',
            borderTop: '1px solid #2A2A2A',
            margin: '28px 0 20px',
          }}
        />
        <p style={{ margin: 0, color: '#666', fontSize: 12 }}>
          Firm Funds Inc. &mdash; Ontario, Canada
        </p>
      </article>
    </main>
  )
}
