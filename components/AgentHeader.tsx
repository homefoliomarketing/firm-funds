'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { Bell, MessageSquare, Home, ArrowLeft, User, Settings } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import SignOutModal from '@/components/SignOutModal'
import { getAgentNotificationCounts } from '@/lib/actions/notification-actions'

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
}: AgentHeaderProps) {
  const [unreadCount, setUnreadCount] = useState(0)
  const [pendingReturns, setPendingReturns] = useState(0)
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
        requestNotificationPermission()
      }
    } catch {
      // Silently fail — don't break the header over notification counts
    }
  }, [agentId, requestNotificationPermission])

  useEffect(() => {
    loadNotifications()
    // Poll every 30 seconds for new notifications
    const interval = setInterval(loadNotifications, 30000)
    return () => clearInterval(interval)
  }, [loadNotifications])

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }

  const isMessagesPage = pathname === '/agent/messages'
  const isDashboard = pathname === '/agent'
  const isProfilePage = pathname === '/agent/profile'
  const isSettingsPage = pathname === '/agent/settings'

  const navBtnClass = (active: boolean) =>
    `flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
      active
        ? 'text-white bg-white/10'
        : 'text-white/50 hover:text-white/80 hover:bg-white/5'
    }`

  const NotificationBadge = ({ count }: { count: number }) => (
    <span className="inline-flex items-center justify-center h-4 min-w-[16px] px-1 rounded-full text-[10px] font-bold bg-red-500 text-white">
      {count > 99 ? '99+' : count}
    </span>
  )

  return (
    <header className="bg-card/80 backdrop-blur-sm border-b border-border/50">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center py-5">
          {/* Left side */}
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-3 cursor-pointer" onClick={() => router.push('/agent')}>
              {brokerageLogo ? (
                <>
                  <img
                    src={brokerageLogo}
                    alt={brokerageName || 'Brokerage'}
                    className="h-12 sm:h-16 md:h-20 w-auto object-contain"
                  />
                  <div className="w-px h-8 bg-white/15" />
                  <img
                    src="/brand/white.png"
                    alt="Firm Funds"
                    className="h-8 sm:h-10 w-auto opacity-60"
                  />
                </>
              ) : (
                <img
                  src="/brand/white.png"
                  alt="Firm Funds"
                  className="h-16 sm:h-20 md:h-28 w-auto"
                />
              )}
            </div>
            <div className="w-px h-10 bg-white/15" />

            {backHref ? (
              <>
                <button
                  onClick={() => router.push(backHref)}
                  className="text-white/60 hover:text-primary transition-colors"
                >
                  <ArrowLeft size={20} />
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
                {/* Nav links */}
                <nav className="hidden sm:flex items-center gap-1">
                  <button onClick={() => router.push('/agent')} className={navBtnClass(isDashboard)}>
                    <Home size={14} />
                    Dashboard
                  </button>
                  <button onClick={() => router.push('/agent/messages')} className={`${navBtnClass(isMessagesPage)} relative`}>
                    <MessageSquare size={14} />
                    Messages
                    {totalNotifications > 0 && (
                      <span className="ml-1">
                        <NotificationBadge count={totalNotifications} />
                      </span>
                    )}
                  </button>
                  <button onClick={() => router.push('/agent/profile')} className={navBtnClass(isProfilePage)}>
                    <User size={14} />
                    Profile
                  </button>
                  <button onClick={() => router.push('/agent/settings')} className={navBtnClass(isSettingsPage)}>
                    <Settings size={14} />
                    Settings
                  </button>
                </nav>
              </div>
            )}
          </div>

          {/* Right side */}
          <div className="flex items-center gap-3">
            {rightContent}

            {/* Mobile notification bell (always visible) */}
            <button
              onClick={() => router.push('/agent/messages')}
              className="relative p-2 rounded-lg transition-colors text-white/60 hover:text-white sm:hidden"
              title="Messages & Notifications"
            >
              <Bell size={18} />
              {totalNotifications > 0 && (
                <span className="absolute -top-0.5 -right-0.5">
                  <NotificationBadge count={totalNotifications} />
                </span>
              )}
            </button>

            {/* Desktop bell (when on deal pages, not in main nav) */}
            {backHref && (
              <button
                onClick={() => router.push('/agent/messages')}
                className="relative p-2 rounded-lg transition-colors text-white/60 hover:text-white hidden sm:block"
                title="Messages & Notifications"
              >
                <Bell size={18} />
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
      </div>
    </header>
  )
}
