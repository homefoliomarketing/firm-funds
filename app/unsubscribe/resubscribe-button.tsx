'use client'

import { useState } from 'react'

// ============================================================================
// Client-only button that flips the unsubscribe state via /api/unsubscribe.
// Lives in /app/unsubscribe so the parent server component can colocate the
// network call without forcing the whole page into client mode.
//
// mode='unsubscribe' POSTs to /api/unsubscribe (turns notifications off)
// mode='resubscribe' PUTs to /api/unsubscribe (turns them back on)
// ============================================================================

type Mode = 'unsubscribe' | 'resubscribe'

export function ResubscribeButton({
  token,
  mode,
}: {
  token: string
  mode: Mode
}) {
  const [state, setState] = useState<
    'idle' | 'submitting' | 'done' | 'error'
  >('idle')
  const [error, setError] = useState<string | null>(null)

  const targetMode: Mode = mode === 'unsubscribe' ? 'resubscribe' : 'unsubscribe'
  const buttonLabel =
    mode === 'unsubscribe'
      ? state === 'submitting'
        ? 'Unsubscribing…'
        : state === 'done'
        ? 'Unsubscribed'
        : 'Unsubscribe'
      : state === 'submitting'
      ? 'Resubscribing…'
      : state === 'done'
      ? 'Resubscribed'
      : 'Resubscribe'

  async function onClick() {
    if (state === 'submitting' || state === 'done') return
    setState('submitting')
    setError(null)
    try {
      const method = mode === 'unsubscribe' ? 'POST' : 'PUT'
      const res = await fetch('/api/unsubscribe', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok || !json?.ok) {
        setState('error')
        setError(json?.error ?? 'Failed to update preference. Please try again.')
        return
      }
      setState('done')
      // Soft refresh so the server-rendered copy at the top of the card
      // flips to reflect the new state.
      setTimeout(() => window.location.reload(), 600)
    } catch {
      setState('error')
      setError('Network error. Please try again.')
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={onClick}
        disabled={state === 'submitting' || state === 'done'}
        aria-busy={state === 'submitting'}
        style={{
          display: 'inline-block',
          padding: '14px 36px',
          background:
            mode === 'unsubscribe' ? '#5FA873' : '#5FA873',
          color: '#fff',
          border: 'none',
          borderRadius: 10,
          fontSize: 14,
          fontWeight: 700,
          letterSpacing: '0.02em',
          cursor:
            state === 'submitting' || state === 'done'
              ? 'default'
              : 'pointer',
          opacity: state === 'submitting' || state === 'done' ? 0.7 : 1,
        }}
      >
        {buttonLabel}
      </button>
      {error ? (
        <p
          style={{
            marginTop: 12,
            color: '#F87171',
            fontSize: 13,
            lineHeight: 1.5,
          }}
          role="alert"
        >
          {error}
        </p>
      ) : null}
      {state === 'done' ? (
        <p
          style={{
            marginTop: 12,
            color: '#A3A3A3',
            fontSize: 12,
            lineHeight: 1.5,
          }}
        >
          You can {targetMode} at any time from this page or your account
          settings.
        </p>
      ) : null}
    </div>
  )
}
