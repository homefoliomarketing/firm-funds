import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface HelpArticleBodyProps {
  children: ReactNode
  className?: string
}

/**
 * Article body wrapper. We do not use `@tailwindcss/typography` (not installed),
 * so we apply prose-ish utility classes directly via descendant selectors.
 *
 * Spacing: tight enough to read on a phone, loose enough to scan on desktop.
 * Heading hierarchy: <h2> -> section divider, <h3> -> sub-step.
 */
export default function HelpArticleBody({
  children,
  className,
}: HelpArticleBodyProps) {
  return (
    <div
      className={cn(
        'text-sm sm:text-base text-foreground leading-relaxed space-y-4',
        '[&_h2]:mt-8 [&_h2]:mb-3 [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:text-foreground',
        '[&_h3]:mt-6 [&_h3]:mb-2 [&_h3]:text-base [&_h3]:font-semibold [&_h3]:text-foreground',
        '[&_p]:text-foreground/90',
        '[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 hover:[&_a]:text-primary/80',
        '[&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-5 [&_ul>li]:my-1.5 [&_ul>li]:text-foreground/90',
        '[&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-5 [&_ol>li]:my-1.5 [&_ol>li]:text-foreground/90',
        '[&_code]:rounded [&_code]:bg-muted [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:text-[0.85em] [&_code]:font-mono [&_code]:text-foreground',
        '[&_strong]:font-semibold [&_strong]:text-foreground',
        '[&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-4 [&_blockquote]:text-muted-foreground',
        className
      )}
    >
      {children}
    </div>
  )
}
