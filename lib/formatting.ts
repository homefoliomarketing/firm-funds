/**
 * Shared formatting utilities for currency, dates, and display values.
 * Consolidates duplicate formatters that were previously defined locally in 7+ files.
 */

/** Format a number as Canadian currency (e.g., "$1,234.56") */
export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(amount)
}

/** Format a number as Canadian currency with no decimals (e.g., "$1,235") */
export function formatCurrencyWhole(amount: number): string {
  return new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 }).format(amount)
}

/**
 * Format an ISO date string as a short date (e.g., "Apr 3, 2026").
 * Timezone-safe for date-only values: a bare "YYYY-MM-DD" is anchored at noon
 * UTC (not UTC midnight) and formatted in America/Toronto, so the calendar day
 * never rolls back one day on a host behind UTC (e.g. Netlify functions run in
 * UTC). Same noon-UTC anchor pattern as `ymd()`/`longDate()` in lib/reports/build.ts.
 */
export function formatDate(date: string): string {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(date)
    ? new Date(date + 'T12:00:00Z')
    : new Date(date)
  return d.toLocaleDateString('en-CA', {
    timeZone: 'America/Toronto',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

/** Format an ISO date string as date + time (e.g., "Apr 3, 2026, 02:30 PM"), rendered in Toronto business time */
export function formatDateTime(date: string): string {
  return new Date(date).toLocaleString('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** Format a timestamp as relative time (e.g., "Just now", "5m ago", "2h ago", "Yesterday", "Apr 3") */
export function formatRelativeTime(dateStr: string): string {
  const now = Date.now()
  const then = new Date(dateStr).getTime()
  const diffMs = now - then
  const diffMin = Math.floor(diffMs / 60000)
  const diffHr = Math.floor(diffMs / 3600000)
  const diffDay = Math.floor(diffMs / 86400000)
  if (diffMin < 1) return 'Just now'
  if (diffMin < 60) return `${diffMin}m ago`
  if (diffHr < 24) return `${diffHr}h ago`
  if (diffDay === 1) return 'Yesterday'
  if (diffDay < 7) return `${diffDay}d ago`
  return new Date(dateStr).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })
}

/** Format file size in human-readable form (e.g., "1.2 MB", "340 KB") */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
