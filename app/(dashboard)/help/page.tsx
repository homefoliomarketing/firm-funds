import Link from 'next/link'
import { ArrowRight, BookOpen, HelpCircle, Shield } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { getArticlesByRole } from '@/content/help/index'
import { HELP_CATEGORY_LABELS } from '@/content/help/types'
import type { HelpRole } from '@/content/help/types'
import { createClient } from '@/lib/supabase/server'

export const metadata = {
  title: 'Help Center | Firm Funds',
  robots: { index: false, follow: false },
}

/**
 * `/help` landing. Shows a short welcome, a quick-start tile row that links to
 * three high-traffic articles for the user's role, and a "popular questions"
 * footer with a link to the full FAQ page.
 */
export default async function HelpLanding() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const { data: profile } = user
    ? await supabase
        .from('user_profiles')
        .select('role')
        .eq('id', user.id)
        .single()
    : { data: null }

  const role: HelpRole = profile?.role === 'brokerage_admin' ? 'brokerage' : 'agent'
  const articles = getArticlesByRole(role)

  // Pick three highlighted articles per role. These are the most-asked flows.
  const featuredSlugs = role === 'brokerage'
    ? ['brokerage-dashboard-tour', 'submit-on-behalf-of-agent', 'record-a-payment']
    : ['submit-a-deal', 'reading-your-dashboard', 'what-happens-if-deal-falls-through']

  const featured = featuredSlugs
    .map(slug => articles.find(a => a.meta.slug === slug))
    .filter((a): a is NonNullable<typeof a> => a != null)

  return (
    <div>
      <header className="mb-8">
        <h1 className="text-3xl font-bold text-foreground tracking-tight">Help Center</h1>
        <p className="mt-2 text-base text-muted-foreground">
          {role === 'brokerage'
            ? 'Walkthroughs and answers for brokerage admins. Submit deals on behalf of agents, settle funded deals, manage your team.'
            : 'Walkthroughs and answers for agents. Get paid early, verify your identity, understand your account.'}
        </p>
      </header>

      <section aria-label="Featured walkthroughs" className="mb-10">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-3">
          Start here
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {featured.map(article => (
            <Link
              key={article.meta.slug}
              href={`/help/${article.meta.role}/${article.meta.slug}`}
              className="group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-xl"
            >
              <Card className="h-full p-5 hover:bg-card/80 transition-colors border-border/50">
                <div className="flex items-start gap-3">
                  <BookOpen size={18} className="text-primary shrink-0 mt-0.5" aria-hidden="true" />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-foreground">
                      {article.meta.title}
                    </p>
                    <p className="text-xs mt-1 text-muted-foreground">
                      {article.meta.summary}
                    </p>
                  </div>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      </section>

      <section aria-label="Browse all topics" className="mb-10">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-3">
          Browse all topics
        </h2>
        <div className="grid gap-2 sm:grid-cols-2">
          {Object.entries(
            articles.reduce<Record<string, typeof articles>>((acc, a) => {
              const key = a.meta.category
              if (!acc[key]) acc[key] = []
              acc[key].push(a)
              return acc
            }, {})
          ).map(([category, list]) => (
            <div key={category}>
              <p className="text-xs font-semibold text-muted-foreground mb-1">
                {HELP_CATEGORY_LABELS[category as keyof typeof HELP_CATEGORY_LABELS] ?? category}
              </p>
              <ul className="space-y-1">
                {list.map(a => (
                  <li key={a.meta.slug}>
                    <Link
                      href={`/help/${a.meta.role}/${a.meta.slug}`}
                      className="text-sm text-foreground hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
                    >
                      {a.meta.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      <section aria-label="Frequently asked questions" className="mb-10">
        <Card className="p-5 border-border/50">
          <div className="flex items-start gap-3">
            <HelpCircle size={18} className="text-primary shrink-0 mt-0.5" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-foreground">Frequently asked questions</p>
              <p className="text-xs mt-1 text-muted-foreground">
                Quick answers to the questions we hear most often. Searchable.
              </p>
            </div>
            <Link
              href="/help/faq"
              className="text-sm font-medium text-primary hover:text-primary/80 inline-flex items-center gap-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
            >
              Open FAQ <ArrowRight size={14} aria-hidden="true" />
            </Link>
          </div>
        </Card>
      </section>

      <section aria-label="Security note">
        <div className="flex items-start gap-2 text-xs text-muted-foreground">
          <Shield size={14} className="shrink-0 mt-0.5" aria-hidden="true" />
          <p>
            Firm Funds admins: this Help Center serves the agent and brokerage
            portals. Internal admin docs live in the admin section.
          </p>
        </div>
      </section>
    </div>
  )
}
