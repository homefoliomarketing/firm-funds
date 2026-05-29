import { Badge } from '@/components/ui/badge'
import type { HelpRole } from '@/content/help/types'

interface HelpArticleHeaderProps {
  title: string
  summary: string
  role: HelpRole
  /** ISO date `YYYY-MM-DD`. */
  updatedAt: string
}

const ROLE_LABELS: Record<HelpRole, string> = {
  agent: 'Agent',
  brokerage: 'Brokerage',
  shared: 'Money + Policy',
}

/**
 * Top-of-article header: title, summary, a role badge, and a small "Updated"
 * line. Pure server component, no client JS.
 */
export default function HelpArticleHeader({
  title,
  summary,
  role,
  updatedAt,
}: HelpArticleHeaderProps) {
  return (
    <header className="mb-6">
      <div className="mb-2">
        <Badge variant="outline" className="border-primary/40 text-primary">
          {ROLE_LABELS[role]}
        </Badge>
      </div>
      <h1 className="text-3xl font-bold tracking-tight text-foreground">
        {title}
      </h1>
      <p className="mt-2 text-base text-muted-foreground">{summary}</p>
      <p className="mt-3 text-xs text-muted-foreground">
        Updated <time dateTime={updatedAt}>{updatedAt}</time>
      </p>
    </header>
  )
}
