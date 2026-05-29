'use client'

import { useEffect, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

/**
 * Tiny client island for the FAQ page. Listens to user input and toggles
 * `data-faq-hidden` on each FAQ row, plus hides empty category sections
 * and surfaces a no-match note. Also reads the URL hash on mount and
 * opens the matching `<details>` element so search-palette deep links
 * land on the right answer.
 */
export default function HelpFaqFilter() {
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)

  // Open + scroll to a hash target once the list is rendered.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const hash = window.location.hash.replace(/^#/, '')
    if (!hash) return
    const target = document.getElementById(hash)
    if (target instanceof HTMLDetailsElement) {
      target.open = true
      target.scrollIntoView({ block: 'start', behavior: 'smooth' })
    }
  }, [])

  // Apply the filter every time the query changes.
  useEffect(() => {
    if (typeof document === 'undefined') return
    const needle = query.trim().toLowerCase()
    const items = document.querySelectorAll<HTMLElement>('[data-faq-item]')
    let visibleCount = 0
    items.forEach((el) => {
      const hay = el.getAttribute('data-faq-question') ?? ''
      const matches = needle === '' || hay.includes(needle)
      if (matches) {
        el.removeAttribute('data-faq-hidden')
        el.style.display = ''
        visibleCount += 1
      } else {
        el.setAttribute('data-faq-hidden', 'true')
        el.style.display = 'none'
      }
    })
    const sections = document.querySelectorAll<HTMLElement>('[data-faq-section]')
    sections.forEach((sec) => {
      const anyVisible = sec.querySelector('[data-faq-item]:not([data-faq-hidden])')
      sec.style.display = anyVisible ? '' : 'none'
    })
    const empty = document.querySelector<HTMLElement>('[data-faq-empty]')
    if (empty) {
      empty.dataset.show = visibleCount === 0 ? 'true' : 'false'
    }
  }, [query])

  return (
    <div className="mb-6">
      <Label htmlFor="faq-filter" className="sr-only">
        Filter questions
      </Label>
      <div className="relative">
        <Search
          size={14}
          aria-hidden="true"
          className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          ref={inputRef}
          id="faq-filter"
          type="search"
          placeholder="Type to filter questions..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="pl-8"
        />
      </div>
    </div>
  )
}
