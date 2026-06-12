import Link from 'next/link'
import { Compass } from 'lucide-react'
import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'

// Route-level 404 for dashboard URLs. "/" redirects by role, so the exit
// always lands the user on their own portal.
export default function DashboardNotFound() {
  return (
    <main className="px-4 py-16">
      <section className="mx-auto max-w-xl rounded-xl border border-border bg-card p-8">
        <div className="flex items-start gap-4">
          <span className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl border border-border bg-muted">
            <Compass size={20} className="text-muted-foreground" />
          </span>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-primary">
              Not found
            </p>
            <h1 className="mt-1.5 text-2xl font-bold text-foreground">
              That page does not exist.
            </h1>
            <p className="mt-3 text-sm text-muted-foreground">
              The page may have moved, or your account may not have access to it.
            </p>
            <Link href="/" className={cn(buttonVariants(), 'mt-6')}>
              Return to your dashboard
            </Link>
          </div>
        </div>
      </section>
    </main>
  )
}
