'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import Image from 'next/image'
import { Bell, MessageSquare, Home, ArrowLeft, User, Settings, Wallet, AlertTriangle, LifeBuoy, Menu, X } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import SignOutModal from '@/components/SignOutModal'
import { getAgentNotificationCounts } from '@/lib/actions/notification-actions'

function NotificationBadge({ count }: { count: number }) {
  return (
    <span className="inline-flex items-center justify-center h-4 min-w-[16px] px-1 rounded-full text-[10px] font-bold bg-red-500 text-white">
      {count > 99 ? '99+' : count}
    </span>
  )
}

interface AgentHeaderProps {
  agentName: string
  agentId: string
  /** If provided, shows a back button and this title instead of "Agent Portal" */
  backHref?: string
  title?: string
  subtitle?: string
  /** Right-side content (e.g., status badge) */
  rightContent?: React.ReactNode
  /** White-label: brokerage logo URL */
  brokerageLogo?: string | null
  /** White-label: brokerage name (for alt text) */
  brokerageName?: string | null
  /** White-label: brokerage brand color (hex) */
  brokerageBrandColor?: string | null
  /** TRUE when brokerageLogo is a generated SVG that already includes the
   *  "Powered by Firm Funds" tagline. When true, the FF wordmark beside the
   *  logo is suppressed to avoid duplication. Migration 096. */
  brokerageLogoIncludesTagline?: boolean | null
}

export default function AgentHeader({
  agentName,
  agentId,
  backHref,
  title,
  subtitle,
  rightContent,
  brokerageLogo,
  brokerageName,
  brokerageBrandColor,
  brokerageLogoIncludesTagline,
}: AgentHeaderProps) {
  const [unreadCount, setUnreadCount] = useState(0)
  const [pendingReturns, setPendingReturns] = useState(0)
  const [failedDealsCount, setFailedDealsCount] = useState(0)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const router = useRouter()
  const pathname = usePathname()
  const supabase = createClient()

  // Fall back to primary CSS var if no brand color override
  const accentStyle = brokerageBrandColor
    ? { color: brokerageBrandColor }
    : undefined
  const accentClass = brokerageBrandColor ? '' : 'text-primary'

  const totalNotifications = unreadCount + pendingReturns
  const prevTotalRef = useRef<number>(0)
  const notifPermissionAsked = useRef(false)

  // Request notification permission after first successful load
  const requestNotificationPermission = useCallback(() => {
    if (notifPermissionAsked.current) return
    if (typeof window === 'undefined' || !('Notification' in window)) return
    if (Notification.permission === 'default') {
      notifPermissionAsked.current = true
      // Small delay so it doesn't fire immediately on page load
      setTimeout(() => {
        Notification.requestPermission()
      }, 5000)
    }
  }, [])

  // Fire browser notification when new messages arrive
  useEffect(() => {
    if (typeof window === 'undefined' || !('Notification' in window)) return
    if (Notification.permission !== 'granted') return
    // Only fire if count went UP (not on initial load)
    if (prevTotalRef.current > 0 && totalNotifications > prevTotalRef.current) {
      const diff = totalNotifications - prevTotalRef.current
      try {
        new Notification('Firm Funds', {
          body: diff === 1
            ? 'You have a new message from Firm Funds'
            : `You have ${diff} new notifications`,
          icon: '/brand/icon.png',
          tag: 'firm-funds-notif', // prevents stacking
        })
      } catch { /* notification failed silently */ }
    }
    prevTotalRef.current = totalNotifications
  }, [totalNotifications])

  const loadNotifications = useCallback(async () => {
    if (!agentId) return
    try {
      const result = await getAgentNotificationCounts(agentId)
      if (result.success && result.data) {
        setUnreadCount(result.data.unreadMessages)
        setPendingReturns(result.data.pendingReturns)
        setFailedDealsCount(result.data.failedDeals ?? 0)
        requestNotificationPermission()
      }
    } catch {
      // Silently fail — don't break the header over notification counts
    }
  }, [agentId, requestNotificationPermission])

  useEffect(() => {
    // Intentional: bootstrap + poll notification counts from the server every 30s.
    // The "set state in effect" warning is a false positive for polling patterns —
    // we're synchronizing React with an external system (the API), not deriving state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadNotifications()
    const interval = setInterval(loadNotifications, 30000)
    return () => clearInterval(interval)
  }, [loadNotifications])

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }

  const isMessagesPage = pathname === '/agent/messages'
  const isDashboard = pathname === '/agent'
  const isAccountPage = pathname === '/agent/account'
  const isProfilePage = pathname === '/agent/profile'
  const isSettingsPage = pathname === '/agent/settings'
  const isFailedDealsPage = pathname === '/agent/failed-deals'
  const isHelpPage = pathname.startsWith('/help')

  // Shared nav model used by both the desktop nav and the mobile menu so the
  // two can never drift apart. `badge` renders a count chip when > 0; the
  // Failed deals item is only included when the agent actually has one.
  const navLinks: Array<{
    href: string
    label: string
    icon: typeof Home
    active: boolean
    badge?: number
    badgeTone?: 'red' | 'amber'
    ariaLabel?: string
  }> = [
    { href: '/agent', label: 'Dashboard', icon: Home, active: isDashboard },
    { href: '/agent/messages', label: 'Messages', icon: MessageSquare, active: isMessagesPage, badge: totalNotifications, badgeTone: 'red' },
    ...(failedDealsCount > 0
      ? [{ href: '/agent/failed-deals', label: 'Failed deals', icon: AlertTriangle, active: isFailedDealsPage, badge: failedDealsCount, badgeTone: 'amber' as const, ariaLabel: `Failed deals, ${failedDealsCount} needing attention` }]
      : []),
    { href: '/agent/account', label: 'Account Balance', icon: Wallet, active: isAccountPage },
    { href: '/agent/profile', label: 'Profile', icon: User, active: isProfilePage },
    { href: '/agent/settings', label: 'Settings', icon: Settings, active: isSettingsPage },
    { href: '/help', label: 'Help', icon: LifeBuoy, active: isHelpPage, ariaLabel: 'Open Help Center' },
  ]

  // Note: the mobile menu links close the menu in their own onClick handler,
  // so there's no route-change effect here (which would trip
  // react-hooks/set-state-in-effect and cause cascading renders).

  // Escape closes the mobile menu.
  useEffect(() => {
    if (!mobileMenuOpen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMobileMenuOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [mobileMenuOpen])

  const navBtnClass = (active: boolean) =>
    `flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
      active
        ? 'text-white bg-white/10'
        : 'text-white/50 hover:text-white/80 hover:bg-white/5'
    }`

  return (
    <header className="bg-card/80 ff-header-blur border-b border-border/50">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center py-4 sm:py-5">
          {/* Left side */}
          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={() => router.push('/agent')}
              className="flex items-center gap-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-lg"
              aria-label="Go to agent dashboard"
            >
              {brokerageLogo ? (
                <>
                  <Image
                    src={brokerageLogo}
                    alt={brokerageLogoIncludesTagline
                      ? `${brokerageName || 'Brokerage'}, Powered by Firm Funds`
                      : `${brokerageName || 'Brokerage'} logo`}
                    width={160}
                    height={80}
                    unoptimized
                    className={brokerageLogoIncludesTagline
                      ? 'h-20 sm:h-28 md:h-32 w-36 sm:w-48 md:w-56 shrink-0 object-contain'
                      : 'h-12 sm:h-16 md:h-20 w-32 sm:w-44 md:w-52 shrink-0 object-contain'}
                  />
                  {/* Skip the separate FF wordmark when the logo already
                      contains "Powered by Firm Funds" (generated logos —
                      migration 096). */}
                  {!brokerageLogoIncludesTagline && (
                    <>
                      <div className="w-px h-8 bg-white/15" aria-hidden="true" />
                      <Image
                        src="/brand/white.png"
                        alt="Firm Funds"
                        width={120}
                        height={40}
                        className="h-8 sm:h-10 w-auto opacity-60"
                      />
                    </>
                  )}
                </>
              ) : (
                <Image
                  src="/brand/white.png"
                  alt="Firm Funds"
                  width={224}
                  height={112}
                  className="h-16 sm:h-20 md:h-28 w-auto"
                />
              )}
            </button>
            <div className="w-px h-10 bg-white/15" />

            {backHref ? (
              <>
                <button
                  type="button"
                  onClick={() => router.push(backHref)}
                  aria-label="Go back"
                  className="text-white/60 hover:text-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-lg"
                >
                  <ArrowLeft size={20} aria-hidden="true" />
                </button>
                <div>
                  {title && <h1 className="text-lg font-bold text-white">{title}</h1>}
                  {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
                </div>
              </>
            ) : (
              <div className="flex items-center gap-6">
                <p className="text-lg font-medium tracking-wide text-white" style={{ fontFamily: 'var(--font-geist-sans), sans-serif' }}>
                  Agent Portal
                </p>
                {/* Nav links (desktop). Failed deals only appears when the
                    agent has one; the amber badge differentiates it from the
                    red Messages badge. Rendered from the shared navLinks
                    model so the mobile menu stays in sync. */}
                <nav className="hidden sm:flex items-center gap-1" aria-label="Agent">
                  {navLinks.map(({ href, label, icon: Icon, active, badge, badgeTone, ariaLabel }) => (
                    <button
                      key={href}
                      type="button"
                      onClick={() => router.push(href)}
                      className={`${navBtnClass(active)} ${badge ? 'relative' : ''}`}
                      aria-label={ariaLabel}
                      aria-current={active ? 'page' : undefined}
                    >
                      <Icon size={14} aria-hidden="true" />
                      {label}
                      {badge && badge > 0 && (
                        badgeTone === 'amber' ? (
                          <span className="ml-1 inline-flex items-center justify-center h-4 min-w-[16px] px-1 rounded-full text-[10px] font-bold bg-amber-500 text-amber-950">
                            {badge > 99 ? '99+' : badge}
                          </span>
                        ) : (
                          <span className="ml-1">
                            <NotificationBadge count={badge} />
                          </span>
                        )
                      )}
                    </button>
                  ))}
                </nav>
              </div>
            )}
          </div>

          {/* Right side */}
          <div className="flex items-center gap-3">
            {rightContent}

            {/* Mobile notification bell (always visible) */}
            <button
              type="button"
              onClick={() => router.push('/agent/messages')}
              className="relative p-2 rounded-lg transition-colors text-white/60 hover:text-white sm:hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={totalNotifications > 0 ? `Messages: ${totalNotifications} unread` : 'Messages'}
            >
              <Bell size={18} aria-hidden="true" />
              {totalNotifications > 0 && (
                <span className="absolute -top-0.5 -right-0.5">
                  <NotificationBadge count={totalNotifications} />
                </span>
              )}
            </button>

            {/* Mobile menu toggle (hamburger). Only shown in the main-nav
                layout, where the desktop nav is hidden on small screens. */}
            {!backHref && (
              <button
                type="button"
                onClick={() => setMobileMenuOpen(v => !v)}
                className="relative p-2 rounded-lg transition-colors text-white/60 hover:text-white sm:hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={mobileMenuOpen ? 'Close menu' : 'Open menu'}
                aria-expanded={mobileMenuOpen}
                aria-controls="agent-mobile-menu"
              >
                {mobileMenuOpen ? <X size={20} aria-hidden="true" /> : <Menu size={20} aria-hidden="true" />}
              </button>
            )}

            {/* Desktop bell (when on deal pages, not in main nav) */}
            {backHref && (
              <button
                type="button"
                onClick={() => router.push('/agent/messages')}
                className="relative p-2 rounded-lg transition-colors text-white/60 hover:text-white hidden sm:block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={totalNotifications > 0 ? `Messages: ${totalNotifications} unread` : 'Messages'}
              >
                <Bell size={18} aria-hidden="true" />
                {totalNotifications > 0 && (
                  <span className="absolute -top-0.5 -right-0.5">
                    <NotificationBadge count={totalNotifications} />
                  </span>
                )}
              </button>
            )}

            <span
              className={`text-sm hidden sm:inline ${accentClass}`}
              style={accentStyle}
            >
              {agentName}
            </span>
            <SignOutModal onConfirm={handleLogout} />
          </div>
        </div>

        {/* Mobile menu panel. Mirrors the desktop nav from the shared
            navLinks model. Hidden on sm+ where the inline nav is shown. */}
        {!backHref && mobileMenuOpen && (
          <nav
            id="agent-mobile-menu"
            aria-label="Agent"
            className="sm:hidden border-t border-border/50 py-2"
          >
            {navLinks.map(({ href, label, icon: Icon, active, badge, badgeTone, ariaLabel }) => (
              <button
                key={href}
                type="button"
                onClick={() => { setMobileMenuOpen(false); router.push(href) }}
                aria-label={ariaLabel}
                aria-current={active ? 'page' : undefined}
                className={`flex w-full items-center gap-2.5 px-2 py-3 rounded-lg text-sm font-medium transition-colors ${
                  active ? 'text-white bg-white/10' : 'text-white/70 hover:text-white hover:bg-white/5'
                } focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`}
              >
                <Icon size={16} aria-hidden="true" />
                <span className="flex-1 text-left">{label}</span>
                {badge && badge > 0 && (
                  badgeTone === 'amber' ? (
                    <span className="inline-flex items-center justify-center h-4 min-w-[16px] px-1 rounded-full text-[10px] font-bold bg-amber-500 text-amber-950">
                      {badge > 99 ? '99+' : badge}
                    </span>
                  ) : (
                    <NotificationBadge count={badge} />
                  )
                )}
              </button>
            ))}
          </nav>
        )}
      </div>
    </header>
  )
}
