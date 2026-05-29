import { notFound } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import HelpArticleHeader from '@/components/help/HelpArticleHeader'
import HelpArticleBody from '@/components/help/HelpArticleBody'
import {
  getAllArticleParams,
  getArticle,
} from '@/content/help/index'
import type { HelpRole } from '@/content/help/types'

interface PageProps {
  params: Promise<{ role: string; slug: string }>
}

const VALID_ROLES: readonly HelpRole[] = ['agent', 'brokerage', 'shared'] as const

function isHelpRole(value: string): value is HelpRole {
  return (VALID_ROLES as readonly string[]).includes(value)
}

/** Pre-render every known article. */
export function generateStaticParams() {
  return getAllArticleParams().map(({ role, slug }) => ({ role, slug }))
}

export async function generateMetadata({ params }: PageProps) {
  const { role, slug } = await params
  if (!isHelpRole(role)) return { title: 'Help | Firm Funds' }
  const article = getArticle(role, slug)
  if (!article) return { title: 'Help | Firm Funds' }
  return {
    title: `${article.meta.title} | Help | Firm Funds`,
    description: article.meta.summary,
    robots: { index: false, follow: false },
  }
}

export default async function HelpArticlePage({ params }: PageProps) {
  const { role, slug } = await params
  if (!isHelpRole(role)) {
    notFound()
  }
  const article = getArticle(role, slug)
  if (!article) {
    notFound()
  }

  const { Body, meta } = article

  return (
    <article>
      <Link
        href="/help"
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mb-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
      >
        <ArrowLeft size={12} aria-hidden="true" /> All help topics
      </Link>
      <HelpArticleHeader
        title={meta.title}
        summary={meta.summary}
        role={meta.role}
        updatedAt={meta.updatedAt}
      />
      <HelpArticleBody>
        <Body />
      </HelpArticleBody>
    </article>
  )
}
