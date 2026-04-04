'use client'

import { useState } from 'react'
import { useTheme } from '@/lib/theme'
import { LogOut, X } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'

interface SignOutModalProps {
  onConfirm: () => void | Promise<void>
}

export default function SignOutModal({ onConfirm }: SignOutModalProps) {
  const { colors } = useTheme()
  const [showModal, setShowModal] = useState(false)
  const [signingOut, setSigningOut] = useState(false)

  const handleConfirm = async () => {
    setSigningOut(true)
    // Log logout event before signing out (fire-and-forget)
    try {
      const supabase = createClient()
      const { data: { user } } = await supabase.auth.getUser()
      if (user) {
        const { data: profile } = await supabase
          .from('user_profiles')
          .select('role')
          .eq('id', user.id)
          .single()
        void supabase.from('audit_log').insert({
          user_id: user.id,
          action: 'auth.logout',
          entity_type: 'auth',
          severity: 'info',
          actor_email: user.email,
          actor_role: profile?.role || null,
          metadata: { email: user.email },
        })
      }
    } catch {
      // Don't block logout on audit failure
    }
    await onConfirm()
  }

  return (
    <>
      {/* Trigger button — same style as the existing Sign out buttons */}
      <button
        onClick={() => setShowModal(true)}
        className="flex items-center gap-2 text-sm px-3 py-2 rounded-lg transition-colors"
        style={{ color: colors.textSecondary, border: `1px solid ${colors.border}` }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'rgba(255,255,255,0.05)'
          e.currentTarget.style.color = colors.gold
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'transparent'
          e.currentTarget.style.color = colors.textSecondary
        }}
      >
        <LogOut size={14} />
        Sign out
      </button>

      {/* Modal overlay */}
      {showModal && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center"
          style={{ background: colors.overlayBg }}
          onClick={() => !signingOut && setShowModal(false)}
        >
          <div
            className="relative w-full max-w-sm mx-4 rounded-2xl p-5 sm:p-8 text-center"
            style={{
              background: colors.cardBg,
              border: `1px solid ${colors.cardBorder}`,
              boxShadow: `0 25px 50px -12px ${colors.shadowColor}`,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Close button */}
            {!signingOut && (
              <button
                onClick={() => setShowModal(false)}
                className="absolute top-4 right-4 p-1 rounded-lg transition-colors"
                style={{ color: colors.textMuted }}
                onMouseEnter={(e) => { e.currentTarget.style.color = colors.textPrimary }}
                onMouseLeave={(e) => { e.currentTarget.style.color = colors.textMuted }}
              >
                <X size={18} />
              </button>
            )}

            {/* Logo */}
            <img
              src="/brand/white.png"
              alt="Firm Funds"
              className="h-16 w-auto mx-auto mb-6"
            />

            {/* Icon */}
            <div
              className="w-14 h-14 rounded-full flex items-center justify-center mx-auto mb-4"
              style={{ background: `${colors.gold}15` }}
            >
              <LogOut size={24} style={{ color: colors.gold }} />
            </div>

            <h3
              className="text-lg font-semibold mb-2"
              style={{ color: colors.textPrimary }}
            >
              Sign out?
            </h3>

            <p
              className="text-sm mb-6"
              style={{ color: colors.textSecondary }}
            >
              You&apos;ll need to sign back in to access your account.
            </p>

            {/* Action buttons */}
            <div className="flex gap-3">
              {!signingOut && (
                <button
                  onClick={() => setShowModal(false)}
                  className="flex-1 py-2.5 rounded-lg text-sm font-medium transition-colors"
                  style={{
                    color: colors.textSecondary,
                    border: `1px solid ${colors.border}`,
                    background: 'transparent',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = colors.cardHoverBg
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'transparent'
                  }}
                >
                  Cancel
                </button>
              )}
              <button
                onClick={handleConfirm}
                disabled={signingOut}
                className="flex-1 py-2.5 rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2"
                style={{
                  background: signingOut ? colors.gold : colors.gold,
                  color: '#fff',
                  opacity: signingOut ? 0.7 : 1,
                }}
                onMouseEnter={(e) => {
                  if (!signingOut) e.currentTarget.style.background = colors.goldDark
                }}
                onMouseLeave={(e) => {
                  if (!signingOut) e.currentTarget.style.background = colors.gold
                }}
              >
                {signingOut ? (
                  <>
                    <span className="animate-spin inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full" />
                    Signing out…
                  </>
                ) : (
                  'Sign out'
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
