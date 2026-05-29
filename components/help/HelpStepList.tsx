import type { ReactNode } from 'react'

export interface HelpStep {
  title: string
  expected: string
  fallback?: ReactNode
}

interface HelpStepListProps {
  steps: HelpStep[]
}

/**
 * Numbered walkthrough. Each step has a title, an expected outcome, and an
 * optional fallback (rendered as a collapsible "what to do if this does not
 * work" disclosure).
 *
 * Using native `<ol>` and `<details>` gives keyboard + screen-reader
 * semantics for free.
 */
export default function HelpStepList({ steps }: HelpStepListProps) {
  return (
    <ol className="my-4 flex flex-col gap-3" role="list">
      {steps.map((step, index) => (
        <li
          key={`${index}-${step.title}`}
          className="rounded-lg border border-border bg-card/50 p-4"
        >
          <div className="flex items-start gap-3">
            <span
              aria-hidden="true"
              className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary"
            >
              {index + 1}
            </span>
            <div className="min-w-0 flex-1">
              <p className="font-semibold text-foreground leading-snug">
                {step.title}
              </p>
              <p className="mt-1 text-sm italic text-muted-foreground">
                Expected: {step.expected}
              </p>
              {step.fallback && (
                <details className="mt-2 rounded-md border border-border/60 bg-background/50 group/help-fallback">
                  <summary className="cursor-pointer list-none px-3 py-1.5 text-xs font-medium text-foreground/80 hover:text-foreground select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-md">
                    What to do if this does not work
                  </summary>
                  <div className="px-3 py-2 text-sm text-foreground/90 border-t border-border/50">
                    {step.fallback}
                  </div>
                </details>
              )}
            </div>
          </div>
        </li>
      ))}
    </ol>
  )
}
