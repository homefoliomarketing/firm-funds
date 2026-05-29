import HelpFaqList from '@/components/help/HelpFaqList'
import { getFaqsByRole } from '@/content/help/index'
import { createClient } from '@/lib/supabase/server'
import type { HelpRole } from '@/content/help/types'

export const metadata = {
  title: 'FAQ | Help | Firm Funds',
  robots: { index: false, follow: false },
}

/**
 * `/help/faq`: searchable, grouped Q&A list. Filtered by role (shared FAQs
 * surface in every role's view). We resolve the role from the signed-in
 * profile so a brokerage admin gets brokerage + shared questions, and an
 * agent gets agent + shared.
 */
export default async function HelpFaqPage() {
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
  const faqs = getFaqsByRole(role)

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-3xl font-bold text-foreground tracking-tight">
          Frequently asked questions
        </h1>
        <p className="mt-2 text-base text-muted-foreground">
          Quick answers to the things we hear most often. Type to filter.
        </p>
      </header>
      <HelpFaqList faqs={faqs} />
    </div>
  )
}
