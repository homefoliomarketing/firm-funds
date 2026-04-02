'use client'

import { useTheme } from '@/lib/theme'
import { Sun, Moon } from 'lucide-react'

export default function ThemeToggle() {
  const { isDark, toggle } = useTheme()

  return (
    <button
      onClick={toggle}
      className="flex items-center justify-center w-8 h-8 rounded-lg transition-colors"
      style={{
        color: isDark ? '#C4B098' : '#888',
        border: `1px solid ${isDark ? '#333' : 'rgba(255,255,255,0.1)'}`,
        background: isDark ? 'rgba(196,176,152,0.08)' : 'transparent',
      }}
      title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
    >
      {isDark ? <Sun size={14} /> : <Moon size={14} />}
    </button>
  )
}
