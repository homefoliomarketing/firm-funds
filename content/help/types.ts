/**
 * Type definitions for the Help Center content.
 *
 * Articles and FAQs are plain TypeScript modules so they can import live
 * constants from `lib/constants.ts` and `lib/calculations.ts`. A malformed
 * article fails the build rather than the user's page.
 */

import type { ComponentType } from 'react'

export type HelpRole = 'agent' | 'brokerage' | 'shared'

export type HelpCategory =
  | 'getting-started'
  | 'deals'
  | 'money-and-policy'
  | 'failed-deals'
  | 'support'

export interface HelpArticleMeta {
  /** Last URL segment, e.g. 'submit-a-deal'. */
  slug: string
  /** Page <h1>. Title-cased prose, no trailing punctuation. */
  title: string
  /** One-sentence preview shown in cards and search results. */
  summary: string
  /** Which side this article belongs to. Shared articles render in both sidebars. */
  role: HelpRole
  /** Used to group articles in the sidebar nav. */
  category: HelpCategory
  /** Sort order within the category (low first). */
  order: number
  /** ISO date `YYYY-MM-DD`. Refresh when copy or referenced code changes. */
  updatedAt: string
}

export interface HelpArticle {
  meta: HelpArticleMeta
  Body: ComponentType
}

export interface HelpFaq {
  /** kebab-case identifier, unique across all FAQs. */
  id: string
  role: HelpRole
  category: HelpCategory
  /** Plain prose question, no leading "Q:". */
  question: string
  Answer: ComponentType
  /** Optional list of related article slugs (any role). */
  related?: string[]
  updatedAt: string
}

/**
 * Search index entry. Built at module load from each article/FAQ. The sidebar
 * search palette filters this with `String.includes` over a lowercased
 * haystack.
 */
export interface HelpSearchEntry {
  type: 'article' | 'faq'
  /** URL path relative to /help. e.g. 'agent/submit-a-deal' or 'faq#id'. */
  href: string
  role: HelpRole
  category: HelpCategory
  title: string
  summary: string
  /** Lowercased concatenation of title + summary + question (if FAQ) + extra keywords. */
  haystack: string
}

/** Human-readable category labels for the sidebar group headings. */
export const HELP_CATEGORY_LABELS: Record<HelpCategory, string> = {
  'getting-started': 'Getting started',
  'deals': 'Deals and settlements',
  'money-and-policy': 'Money and policy',
  'failed-deals': 'Failed deals',
  'support': 'Account and support',
}
