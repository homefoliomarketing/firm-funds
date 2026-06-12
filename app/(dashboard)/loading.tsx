// Route-level loading state for every dashboard page. Shows a neutral
// skeleton (title, stat row, content block) instead of a blank screen while
// the server component tree resolves.
export default function DashboardLoading() {
  return (
    <main className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8" aria-busy="true" aria-label="Loading page">
      <div className="mb-2 h-8 w-64 animate-pulse rounded-md bg-muted" />
      <div className="mb-8 h-4 w-44 animate-pulse rounded bg-muted/60" />
      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
        {[1, 2, 3, 4].map((item) => (
          <div key={item} className="rounded-xl border border-border bg-card p-6">
            <div className="mb-3 h-3 w-24 animate-pulse rounded bg-muted/60" />
            <div className="h-9 w-20 animate-pulse rounded-lg bg-muted" />
          </div>
        ))}
      </div>
      <div className="mt-8 rounded-xl border border-border bg-card p-6">
        {[1, 2, 3, 4, 5].map((row) => (
          <div key={row} className="mb-4 flex gap-4">
            <div className="h-4 flex-1 animate-pulse rounded bg-muted/60" />
            <div className="h-4 w-20 animate-pulse rounded bg-muted/60" />
            <div className="h-4 w-24 animate-pulse rounded bg-muted/60" />
          </div>
        ))}
      </div>
    </main>
  )
}
