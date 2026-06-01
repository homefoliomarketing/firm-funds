import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  formatCurrency,
  formatCurrencyWhole,
  formatFileSize,
  formatRelativeTime,
} from './formatting'

// Intl may emit a non-breaking space between symbol and digits depending on
// the ICU build; normalize so assertions are stable across environments.
const norm = (s: string) => s.replace(/ /g, ' ').replace(/ /g, ' ')

describe('formatCurrency', () => {
  it('positive, negative, zero', () => {
    expect(norm(formatCurrency(1234.56))).toBe('$1,234.56')
    expect(norm(formatCurrency(-1234.56))).toBe('-$1,234.56')
    expect(norm(formatCurrency(0))).toBe('$0.00')
  })

  it('rounds to two decimals (half-up via Intl)', () => {
    expect(norm(formatCurrency(1.005))).toBe('$1.01')
    expect(norm(formatCurrency(2.349))).toBe('$2.35')
  })
})

describe('formatCurrencyWhole', () => {
  it('drops decimals and rounds', () => {
    expect(norm(formatCurrencyWhole(1234.56))).toBe('$1,235')
    expect(norm(formatCurrencyWhole(0))).toBe('$0')
    expect(norm(formatCurrencyWhole(999.49))).toBe('$999')
  })
})

describe('formatFileSize', () => {
  it('bytes below 1 KB', () => {
    expect(formatFileSize(0)).toBe('0 B')
    expect(formatFileSize(512)).toBe('512 B')
    expect(formatFileSize(1023)).toBe('1023 B')
  })

  it('KB boundary (no decimals)', () => {
    expect(formatFileSize(1024)).toBe('1 KB')
    expect(formatFileSize(1536)).toBe('2 KB') // 1.5 KB -> toFixed(0) rounds up
    expect(formatFileSize(1024 * 1024 - 1)).toBe('1024 KB')
  })

  it('MB boundary (one decimal)', () => {
    expect(formatFileSize(1024 * 1024)).toBe('1.0 MB')
    expect(formatFileSize(1.2 * 1024 * 1024)).toBe('1.2 MB')
    expect(formatFileSize(25 * 1024 * 1024)).toBe('25.0 MB')
  })
})

describe('formatRelativeTime', () => {
  // Pin "now" to a fixed instant so all thresholds are deterministic.
  const NOW = new Date('2026-06-01T12:00:00Z')

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString()
  const SEC = 1000
  const MIN = 60 * SEC
  const HR = 60 * MIN
  const DAY = 24 * HR

  it('"Just now" under a minute', () => {
    expect(formatRelativeTime(ago(0))).toBe('Just now')
    expect(formatRelativeTime(ago(59 * SEC))).toBe('Just now')
  })

  it('minutes', () => {
    expect(formatRelativeTime(ago(1 * MIN))).toBe('1m ago')
    expect(formatRelativeTime(ago(59 * MIN))).toBe('59m ago')
  })

  it('hours', () => {
    expect(formatRelativeTime(ago(1 * HR))).toBe('1h ago')
    expect(formatRelativeTime(ago(23 * HR))).toBe('23h ago')
  })

  it('"Yesterday" at exactly 1 day', () => {
    expect(formatRelativeTime(ago(1 * DAY))).toBe('Yesterday')
  })

  it('days up to a week', () => {
    expect(formatRelativeTime(ago(2 * DAY))).toBe('2d ago')
    expect(formatRelativeTime(ago(6 * DAY))).toBe('6d ago')
  })

  it('falls back to a short date at 7+ days', () => {
    // 10 days before 2026-06-01 = 2026-05-22
    expect(norm(formatRelativeTime(ago(10 * DAY)))).toBe('May 22')
  })
})
