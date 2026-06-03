import { ChevronDown } from 'lucide-react'
import {
  helpCategoryLabel,
  type HelpCategory,
  type HelpFaq,
  type HelpRole,
} from '@/content/help/types'
import HelpFaqFilter from './HelpFaqFilter'

interface HelpFaqListProps {
  faqs: HelpFaq[]
  role: HelpRole
}

/**
 * Server component. Renders every FAQ at build time so each `Answer`
 * component runs on the server and ships as plain markup. A small client
 * island, `<HelpFaqFilter>`, attaches an input and a hashchange listener,
 * then toggles `data-faq-hidden` on each row to filter or scroll-on-hash.
 *
 * Doing it this way avoids the "Functions cannot be passed directly to
 * Client Components" boundary error we hit when FAQs (which carry
 * `Answer: ComponentType`) were passed into a client component as props.
 */
export default function HelpFaqList({ faqs, role }: HelpFaqListProps) {
  const byCategory = new Map<HelpCategory, HelpFaq[]>()
  for (const f of faqs) {
    const list = byCategory.get(f.category) ?? []
    list.push(f)
    byCategory.set(f.category, list)
  }
  const grouped = Array.from(byCategory.entries())

  return (
    <div data-faq-root>
      <HelpFaqFilter />
      <p
        data-faq-empty
        className="hidden text-sm text-muted-foreground data-[show=true]:block"
        role="status"
        aria-live="polite"
      >
        No questions match that filter. Try a shorter word.
      </p>

      <div className="flex flex-col gap-8">
        {grouped.map(([category, list]) => (
          <section
            key={category}
            data-faq-section
            aria-labelledby={`faq-cat-${category}`}
          >
            <h2
              id={`faq-cat-${category}`}
              className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground"
            >
              {helpCategoryLabel(category, role)}
            </h2>
            <ul className="flex flex-col gap-2">
              {list.map((faq) => {
                const { Answer } = faq
                return (
                  <li
                    key={faq.id}
                    data-faq-item
                    data-faq-question={faq.question.toLowerCase()}
                  >
                    <details
                      id={faq.id}
                      className="group/help-faq rounded-lg border border-border bg-card scroll-mt-20"
                    >
                      <summary className="cursor-pointer list-none px-4 py-3 text-sm font-medium text-foreground select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-lg flex items-center justify-between gap-3">
                        <span>{faq.question}</span>
                        <ChevronDown
                          size={16}
                          aria-hidden="true"
                          className="shrink-0 text-muted-foreground transition-transform group-open/help-faq:rotate-180"
                        />
                      </summary>
                      <div className="border-t border-border/50 px-4 py-3 text-sm text-foreground/90 leading-relaxed space-y-2 [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5">
                        <Answer />
                      </div>
                    </details>
                  </li>
                )
              })}
            </ul>
          </section>
        ))}
      </div>
    </div>
  )
}
