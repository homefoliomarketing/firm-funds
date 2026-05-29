import Link from 'next/link'
import Image from 'next/image'
import type { ReactNode } from 'react'
import { ArrowLeft, LifeBuoy } from 'lucide-react'
import HelpSidebar from './HelpSidebar'
import type { HelpRole } from '@/content/help/types'

interface HelpShellProps {
  role: HelpRole
  children: ReactNode
}

/**
 * Server component shell for every page under `/help`. Renders the top header,
 * a sidebar with the role-filtered nav (collapses into a <details> on mobile),
 * and a main content column.
 *
 * Auth is enforced by the parent dashboard layout; this component only deals
 * with structure and role-aware navigation.
 */
export default function HelpShell({ role, children }: HelpShellProps) {
  // Brokerage admins go back to their portal; everyone else to the agent portal.
  const portalHref = role === 'brokerage' ? '/brokerage' : '/agent'
  const portalLabel = role === 'brokerage' ? 'Back to brokerage portal' : 'Back to agent portal'

  return (
    <div className="min-h-screen bg-background text-foreground">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:px-3 focus:py-2 focus:rounded-md focus:bg-primary focus:text-primary-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        Skip to content
      </a>

      <header className="border-b border-border/50 bg-card/80 ff-header-blur">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between py-4">
            <div className="flex items-center gap-3">
              <Link
                href="/help"
                aria-label="Firm Funds Help home"
                className="flex items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-md"
              >
                <Image
                  src="/brand/white.png"
                  alt="Firm Funds"
                  width={140}
                  height={56}
                  className="h-10 w-auto"
                />
                <span className="hidden sm:inline-flex items-center gap-1.5 text-sm font-medium text-foreground">
                  <LifeBuoy size={14} className="text-primary" aria-hidden="true" />
                  Help
                </span>
              </Link>
            </div>
            <Link
              href={portalHref}
              className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-md px-2 py-1"
            >
              <ArrowLeft size={14} aria-hidden="true" />
              {portalLabel}
            </Link>
          </div>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-6 lg:py-10">
        <details className="lg:hidden mb-6 rounded-xl border border-border bg-card group/help-sidebar-toggle">
          <summary className="cursor-pointer list-none px-4 py-3 text-sm font-medium text-foreground select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-xl">
            <span className="inline-flex items-center gap-2">
              <LifeBuoy size={14} className="text-primary" aria-hidden="true" />
              Browse help topics
            </span>
          </summary>
          <div className="border-t border-border/50 p-3">
            <HelpSidebar role={role} />
          </div>
        </details>

        <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] lg:gap-10">
          <aside
            aria-label="Help navigation"
            className="hidden lg:block"
          >
            <div className="sticky top-6">
              <HelpSidebar role={role} />
            </div>
          </aside>

          <main id="main-content" className="min-w-0">
            {children}
          </main>
        </div>
      </div>
    </div>
  )
}
