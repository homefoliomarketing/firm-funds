'use client'

import { useRouter } from 'next/navigation'
import { useMemo, useState } from 'react'
import { BookOpen, HelpCircle } from 'lucide-react'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Command as CommandPrimitive } from 'cmdk'
import { SEARCH_INDEX } from '@/content/help/index'
import { HELP_CATEGORY_LABELS } from '@/content/help/types'

interface HelpSearchPaletteProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * cmdk-backed search dialog. Filters `SEARCH_INDEX` with case-insensitive
 * `String.includes` over the `haystack` field, groups by entry type (article
 * vs. FAQ), and routes the user to the right page on selection.
 *
 * Article hrefs in the index are stored as `<role>/<slug>`; FAQ hrefs are
 * `faq#<id>` so clicking opens the FAQ page and scrolls to the question.
 */
export default function HelpSearchPalette({ open, onOpenChange }: HelpSearchPaletteProps) {
  const router = useRouter()
  const [query, setQuery] = useState('')

  // Reset the query alongside any close so the next open starts fresh. We
  // wrap the consumer's onOpenChange instead of doing setState in an effect,
  // which would trigger a cascading render warning.
  const handleOpenChange = (next: boolean) => {
    if (!next) setQuery('')
    onOpenChange(next)
  }

  const normalizedQuery = query.trim().toLowerCase()

  const { articles, faqs } = useMemo(() => {
    const filtered = normalizedQuery.length === 0
      ? SEARCH_INDEX
      : SEARCH_INDEX.filter(entry => entry.haystack.includes(normalizedQuery))
    return {
      articles: filtered.filter(e => e.type === 'article'),
      faqs: filtered.filter(e => e.type === 'faq'),
    }
  }, [normalizedQuery])

  const handleSelect = (href: string, type: 'article' | 'faq') => {
    handleOpenChange(false)
    if (type === 'faq') {
      // href = "faq#some-id", route to /help/faq with the hash so the
      // <details id={...}> opens to that question.
      router.push(`/help/${href}`)
    } else {
      // href = "<role>/<slug>"
      router.push(`/help/${href}`)
    }
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={handleOpenChange}
      title="Search Firm Funds Help"
      description="Type to find an article or FAQ."
      className="max-w-xl"
    >
      <CommandPrimitive shouldFilter={false} className="flex size-full flex-col overflow-hidden rounded-xl bg-popover p-1 text-popover-foreground">
        <CommandInput
          placeholder="Search help articles and FAQs..."
          value={query}
          onValueChange={setQuery}
          aria-label="Search help articles and FAQs"
        />
        <CommandList>
          {articles.length === 0 && faqs.length === 0 && (
            <CommandEmpty>No matches. Try a different word.</CommandEmpty>
          )}
          {articles.length > 0 && (
            <CommandGroup heading="Articles">
              {articles.map(entry => (
                <CommandItem
                  key={`article-${entry.href}`}
                  value={`article-${entry.href}`}
                  onSelect={() => handleSelect(entry.href, 'article')}
                >
                  <BookOpen size={14} className="text-primary" aria-hidden="true" />
                  <div className="flex flex-col min-w-0">
                    <span className="truncate text-sm text-foreground">
                      {entry.title}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      {HELP_CATEGORY_LABELS[entry.category]}
                      {entry.summary ? `, ${entry.summary}` : ''}
                    </span>
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {faqs.length > 0 && (
            <CommandGroup heading="FAQs">
              {faqs.map(entry => (
                <CommandItem
                  key={`faq-${entry.href}`}
                  value={`faq-${entry.href}`}
                  onSelect={() => handleSelect(entry.href, 'faq')}
                >
                  <HelpCircle size={14} className="text-primary" aria-hidden="true" />
                  <div className="flex flex-col min-w-0">
                    <span className="truncate text-sm text-foreground">
                      {entry.title}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      {HELP_CATEGORY_LABELS[entry.category]}
                    </span>
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
        </CommandList>
      </CommandPrimitive>
    </CommandDialog>
  )
}
