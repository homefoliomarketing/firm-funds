'use client'

import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import Image from 'next/image'
import { Bell, MessageSquare, Home, ArrowLeft, User, Settings, Wallet, AlertTriangle, LifeBuoy, Menu, X } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import SignOutModal from '@/components/SignOutModal'
import { getAgentNotificationCounts } from '@/lib/actions/notification-actions'
import { brokerageLogoDataUri } from '@/lib/brokerage-logo-generator'
import { NotificationBadge } from '@/components/ui/notification-badge'

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

  // Guarantee: an agent ALWAYS sees a generated logo for their brokerage's
  // advance division. If no logo_url was ever saved on the brokerages row
  // (e.g. onboarding never ran "Generate Logo"), synthesize one on the fly
  // from the brokerage name. The generated SVG already bakes in the "Powered
  // by Firm Funds" tagline, so we also force includesTagline=true for the
  // fallback (suppresses the duplicate FF wordmark + uses the taller sizing).
  // Only the bare-FF wordmark remains when we have neither a logo nor a name.
  const effectiveLogo = useMemo(() => {
    if (brokerageLogo) return brokerageLogo
    if (brokerageName && brokerageName.trim()) {
      return brokerageLogoDataUri(brokerageName, { background: 'transparent' })
    }
    return null
  }, [brokerageLogo, brokerageName])
  const effectiveIncludesTagline = brokerageLogo
    ? brokerageLogoIncludesTagline
    : true

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
          <div className="flex items-center gap-2 sm:gap-4 min-w-0">
            <button
              type="button"
              onClick={() => router.push('/agent')}
              className="flex items-center gap-3 min-w-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-lg"
              aria-label="Go to agent dashboard"
            >
              {effectiveLogo ? (
                <>
                  {/* Brokerage logo as an object-contain <img>, NOT a cropped
                      background box. History: a fixed-width background box with
                      bg-center cropped the logo to a sliver (just the centred
                      "K" of a long wordmark) whenever the crowded desktop nav
                      shrank the box below the logo's natural width. object-contain
                      never crops — it scales the WHOLE logo down to fit its box,
                      so under flex pressure the logo gets smaller but stays
                      complete and legible. Height drives the size; w-auto lets the
                      width follow the SVG's aspect; the max-w caps keep a wide
                      logo from pushing the row past the viewport (the mobile cap
                      is the one that prevented the old off-screen overflow), and
                      shrink + min-w-0 let it yield width gracefully. The taller
                      tagline heights keep "POWERED BY FIRM FUNDS" legible (a short
                      box shrinks the tagline to a few px). */}
                  {/* User/generated logo URL or inline data URI — a raw <img>
                      (next/image needs build-time domain config we don't have for
                      arbitrary brokerage hosts + data URIs). */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={effectiveLogo}
                    alt={effectiveIncludesTagline
                      ? `${brokerageName || 'Brokerage'}, Powered by Firm Funds`
                      : `${brokerageName || 'Brokerage'} logo`}
                    className={effectiveIncludesTagline
                      ? 'shrink min-w-0 w-auto object-contain object-left h-12 max-w-[150px] sm:h-20 sm:max-w-[210px] md:h-24 md:max-w-[250px]'
                      : 'shrink min-w-0 w-auto object-contain object-left h-9 max-w-[120px] sm:h-14 sm:max-w-[170px] md:h-16 md:max-w-[200px]'}
                  />
                  {/* Skip the separate FF wordmark when the logo already
                      contains "Powered by Firm Funds" (generated logos —
                      migration 096). Also hide it below sm: on a phone the
                      brokerage logo + divider + this wordmark + the right-side
                      controls overran the row and clipped the brokerage logo at
                      the screen edge. The wordmark is decorative duplication of
                      branding; dropping it only on mobile keeps the brokerage
                      logo fully visible without overflow. Desktop unchanged. */}
                  {!effectiveIncludesTagline && (
                    <>
                      <div className="hidden sm:block w-px h-8 bg-white/15" aria-hidden="true" />
                      <Image
                        src="/brand/white.png"
                        alt="Firm Funds"
                        width={120}
                        height={40}
                        className="hidden sm:block h-8 sm:h-10 w-auto opacity-60"
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
            {/* Divider sits between the logo and either the back-button (deal
                pages, room at sm) or the inline nav (dashboard, which now only
                appears at lg — see the nav below). Gate it to match so it never
                floats next to an absent nav. */}
            <div
              className={`w-px h-10 bg-white/15 ${backHref ? 'hidden sm:block' : 'hidden lg:block'}`}
              aria-hidden="true"
            />

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
              <div className="hidden lg:flex items-center gap-4 xl:gap-6 min-w-0">
                {/* "Agent Portal" wordmark is redundant once a brokerage logo is
                    shown (the logo already brands the portal), and on desktop it
                    competed with the nav for the room the logo needs. Show it
                    only when there's no brokerage logo (bare Firm Funds header). */}
                {!effectiveLogo && (
                  <p className="text-lg font-medium tracking-wide text-white" style={{ fontFamily: 'var(--font-geist-sans), sans-serif' }}>
                    Agent Portal
                  </p>
                )}
                {/* Nav links (desktop). Failed deals only appears when the
                    agent has one; the amber badge differentiates it from the
                    red Messages badge. Rendered from the shared navLinks
                    model so the mobile menu stays in sync. */}
                <nav className="flex items-center gap-1" aria-label="Agent">
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
                        <NotificationBadge
                          count={badge}
                          tone={badgeTone === 'amber' ? 'pending' : 'attention'}
                          className="ml-1"
                        />
                      )}
                    </button>
                  ))}
                </nav>
              </div>
            )}
          </div>

          {/* Right side */}
          <div className="flex items-center gap-1.5 sm:gap-3 shrink-0">
            {rightContent}

            {/* Compact notification bell, shown whenever the inline nav (which
                carries its own Messages link) is collapsed. On the dashboard the
                inline nav appears at lg, so the bell shows below lg; on deal
                pages there's no inline nav, so the separate desktop bell below
                takes over at sm and this one hides at sm (avoids a double bell
                between sm and lg). */}
            <button
              type="button"
              onClick={() => router.push('/agent/messages')}
              className={`relative p-2 rounded-lg transition-colors text-white/60 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${backHref ? 'sm:hidden' : 'lg:hidden'}`}
              aria-label={totalNotifications > 0 ? `Messages: ${totalNotifications} unread` : 'Messages'}
            >
              <Bell size={18} aria-hidden="true" />
              {totalNotifications > 0 && (
                <span className="absolute -top-0.5 -right-0.5">
                  <NotificationBadge count={totalNotifications} />
                </span>
              )}
            </button>

            {/* Menu toggle (hamburger). Shown in the dashboard layout below lg,
                where the inline nav is collapsed. The inline nav takes over at
                lg because a 6-7 item text nav plus the brokerage logo doesn't
                fit the capped header row until then. */}
            {!backHref && (
              <button
                type="button"
                onClick={() => setMobileMenuOpen(v => !v)}
                className="relative p-2 rounded-lg transition-colors text-white/60 hover:text-white lg:hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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

            {/* Agent name label. Shown only on the deal-page (backHref) layout,
                which has no inline nav and therefore room for it. On the main
                dashboard layout the 6-7 item nav + brokerage logo already fill
                the row, and the name is redundant with the "Welcome back, …"
                heading below, so we drop it here to give the logo + nav the
                room they need (otherwise the nav overlapped this label). */}
            {backHref && (
              <span
                className={`text-sm hidden sm:inline ${accentClass}`}
                style={accentStyle}
              >
                {agentName}
              </span>
            )}
            <SignOutModal onConfirm={handleLogout} />
          </div>
        </div>

        {/* Collapsible menu panel. Mirrors the inline nav from the shared
            navLinks model. Hidden at lg+ where the inline nav is shown. */}
        {!backHref && mobileMenuOpen && (
          <nav
            id="agent-mobile-menu"
            aria-label="Agent"
            className="lg:hidden border-t border-border/50 py-2"
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
                  <NotificationBadge
                    count={badge}
                    tone={badgeTone === 'amber' ? 'pending' : 'attention'}
                  />
                )}
              </button>
            ))}
          </nav>
        )}
      </div>
    </header>
  )
}
