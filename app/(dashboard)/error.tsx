'use client'

import Link from 'next/link'
import { AlertTriangle, RotateCcw } from 'lucide-react'
import { Button, buttonVariants } from '@/components/ui/button'

// Route-level error boundary for the dashboard. Gives the user a retry, a way
// home, and a copyable reference code for support instead of a dead screen.
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <main className="px-4 py-16">
      <section className="mx-auto max-w-xl rounded-xl border border-border bg-card p-8">
        <div className="flex items-start gap-4">
          <span className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl bg-destructive/10">
            <AlertTriangle size={20} className="text-destructive" />
          </span>
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-wider text-primary">
              Something went wrong
            </p>
            <h1 className="mt-1.5 text-2xl font-bold text-foreground">
              This page could not be loaded.
            </h1>
            <p className="mt-3 text-sm text-muted-foreground">
              Try again. If this keeps happening, contact Firm Funds support and quote the reference below.
            </p>
            <p className="mt-3 inline-block select-all rounded-md border border-border bg-muted px-2.5 py-1 font-mono text-xs text-muted-foreground">
              Ref: {error.digest || 'unavailable'}
            </p>
            <div className="mt-6 flex gap-3">
              <Button onClick={reset}>
                <RotateCcw size={14} />
                Try again
              </Button>
              <Link href="/" className={buttonVariants({ variant: 'outline' })}>
                Return to dashboard
              </Link>
            </div>
          </div>
        </div>
      </section>
    </main>
  )
}
