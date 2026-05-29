import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'

export default function HelpNotFound() {
  return (
    <div className="py-12">
      <h1 className="text-2xl font-bold text-foreground">We could not find that help article</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        The link may be old, or the article was renamed. Try the Help Center
        landing page or use search.
      </p>
      <Link
        href="/help"
        className="mt-4 inline-flex items-center gap-1 text-sm text-primary hover:text-primary/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
      >
        <ArrowLeft size={14} aria-hidden="true" /> Back to the Help Center
      </Link>
    </div>
  )
}
