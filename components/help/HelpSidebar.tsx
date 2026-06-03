'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useMemo } from 'react'
import { HelpCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getArticlesByRole } from '@/content/help/index'
import {
  HELP_CATEGORY_LABELS,
  type HelpCategory,
  type HelpRole,
  type HelpArticle,
} from '@/content/help/types'

interface HelpSidebarProps {
  role: HelpRole
}

/**
 * Client component sidebar. Lists role-filtered articles grouped by category
 * and highlights the active route.
 *
 * The article list is module-level. `getArticlesByRole` is a pure filter, so
 * re-reading it on every render is cheap.
 */
export default function HelpSidebar({ role }: HelpSidebarProps) {
  const pathname = usePathname()

  // Group the role's articles by category, preserving category-order via the
  // article's `order` field within each group.
  const groups = useMemo(() => {
    const articles = getArticlesByRole(role)
    const byCategory = new Map<HelpCategory, HelpArticle[]>()
    for (const a of articles) {
      const list = byCategory.get(a.meta.category) ?? []
      list.push(a)
      byCategory.set(a.meta.category, list)
    }
    // Sort within each category by `order`.
    for (const list of byCategory.values()) {
      list.sort((x, y) => x.meta.order - y.meta.order)
    }
    return Array.from(byCategory.entries())
  }, [role])

  return (
    <nav aria-label="Help topics" className="text-sm">
      <div className="flex flex-col gap-2 mb-4">
        <Link
          href="/help/faq"
          className={cn(
            'inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            pathname === '/help/faq'
              ? 'bg-primary/10 text-primary'
              : 'text-foreground hover:bg-muted hover:text-foreground'
          )}
        >
          <HelpCircle size={14} aria-hidden="true" />
          Frequently asked questions
        </Link>
      </div>

      <div className="flex flex-col gap-5">
        {groups.map(([category, list]) => (
          <section key={category}>
            <h2 className="px-2 mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {HELP_CATEGORY_LABELS[category]}
            </h2>
            <ul className="flex flex-col gap-0.5">
              {list.map(article => {
                const href = `/help/${article.meta.role}/${article.meta.slug}`
                const isActive = pathname === href
                return (
                  <li key={article.meta.slug}>
                    <Link
                      href={href}
                      aria-current={isActive ? 'page' : undefined}
                      className={cn(
                        'block rounded-md px-2 py-1.5 text-sm leading-snug transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        isActive
                          ? 'bg-primary/10 text-primary font-medium'
                          : 'text-foreground/80 hover:bg-muted hover:text-foreground'
                      )}
                    >
                      {article.meta.title}
                    </Link>
                  </li>
                )
              })}
            </ul>
          </section>
        ))}
      </div>
    </nav>
  )
}
