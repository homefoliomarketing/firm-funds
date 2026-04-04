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

/** Format an ISO date string as a short date (e.g., "Apr 3, 2026") */
export function formatDate(date: string): string {
  return new Date(date).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' })
}

/** Format an ISO date string as date + time (e.g., "Apr 3, 2026, 02:30 PM") */
export function formatDateTime(date: string): string {
  return new Date(date).toLocaleString('en-CA', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
