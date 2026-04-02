'use client'

import { createContext, useContext, useEffect, useState, ReactNode } from 'react'

// =============================================================================
// Theme Color Definitions
// =============================================================================

export interface ThemeColors {
  // Page backgrounds
  pageBg: string
  cardBg: string
  cardBorder: string
  cardHoverBg: string

  // Header
  headerBg: string
  headerBgGradient: string

  // Text
  textPrimary: string
  textSecondary: string
  textMuted: string
  textFaint: string

  // Accents (brand)
  gold: string
  goldDark: string
  goldBg: string

  // Borders & dividers
  border: string
  borderLight: string
  divider: string

  // Input fields
  inputBg: string
  inputBorder: string
  inputText: string

  // Table
  tableHeaderBg: string
  tableRowHoverBg: string
  tableRowBorder: string

  // Skeleton loading
  skeletonBase: string
  skeletonHighlight: string

  // Status colors (same in both themes — they're designed to be readable)
  // These come from constants.ts STATUS_BADGE_STYLES

  // Functional colors
  successText: string
  successBg: string
  successBorder: string
  errorText: string
  errorBg: string
  errorBorder: string
  warningText: string
  warningBg: string
  warningBorder: string
  infoText: string
  infoBg: string
  infoBorder: string

  // Special
  overlayBg: string
  shadowColor: string
}

export const lightColors: ThemeColors = {
  pageBg: '#F5F3EF',
  cardBg: '#FFFFFF',
  cardBorder: '#E8E4DF',
  cardHoverBg: '#FAF8F5',

  headerBg: '#1E1E1E',
  headerBgGradient: 'linear-gradient(135deg, #1E1E1E, #2D2D2D)',

  textPrimary: '#1E1E1E',
  textSecondary: '#888888',
  textMuted: '#B8B8B8',
  textFaint: '#D0D0D0',

  gold: '#5FA873',
  goldDark: '#3D7A4F',
  goldBg: '#EDFAF0',

  border: '#E8E4DF',
  borderLight: '#F0EDE8',
  divider: '#F0EDE8',

  inputBg: '#FFFFFF',
  inputBorder: '#E8E4DF',
  inputText: '#1E1E1E',

  tableHeaderBg: '#FAF8F5',
  tableRowHoverBg: '#FAF8F5',
  tableRowBorder: '#F0EDE8',

  skeletonBase: '#E8E4DF',
  skeletonHighlight: '#F0EDE8',

  successText: '#1A7A2E',
  successBg: '#EDFAF0',
  successBorder: '#B8E6C4',
  errorText: '#993D3D',
  errorBg: '#FFF0F0',
  errorBorder: '#F0C5C5',
  warningText: '#92700C',
  warningBg: '#FFF8ED',
  warningBorder: '#E8D5A8',
  infoText: '#3D5A99',
  infoBg: '#F0F4FF',
  infoBorder: '#C5D3F0',

  overlayBg: 'rgba(0,0,0,0.5)',
  shadowColor: 'rgba(0,0,0,0.06)',
}

export const darkColors: ThemeColors = {
  pageBg: '#121212',
  cardBg: '#1C1C1C',
  cardBorder: '#2E2E2E',
  cardHoverBg: '#242424',

  headerBg: '#121212',
  headerBgGradient: 'linear-gradient(135deg, #121212, #1C1C1C)',

  textPrimary: '#E8E4DF',
  textSecondary: '#999999',
  textMuted: '#666666',
  textFaint: '#444444',

  gold: '#5FA873',
  goldDark: '#7BC48D',
  goldBg: '#0E2016',

  border: '#2E2E2E',
  borderLight: '#282828',
  divider: '#262626',

  inputBg: '#222222',
  inputBorder: '#383838',
  inputText: '#E8E4DF',

  tableHeaderBg: '#191919',
  tableRowHoverBg: '#222222',
  tableRowBorder: '#262626',

  skeletonBase: '#262626',
  skeletonHighlight: '#2E2E2E',

  successText: '#4ADE80',
  successBg: '#0F2416',
  successBorder: '#1E4228',
  errorText: '#F87171',
  errorBg: '#241010',
  errorBorder: '#422020',
  warningText: '#D4A844',
  warningBg: '#201C0E',
  warningBorder: '#423618',
  infoText: '#7BA3E0',
  infoBg: '#101524',
  infoBorder: '#203050',

  overlayBg: 'rgba(0,0,0,0.75)',
  shadowColor: 'rgba(0,0,0,0.4)',
}

// =============================================================================
// Theme Context
// =============================================================================

type ThemeMode = 'light' | 'dark'

interface ThemeContextType {
  mode: ThemeMode
  colors: ThemeColors
  toggle: () => void
  isDark: boolean
}

const ThemeContext = createContext<ThemeContextType>({
  mode: 'dark',
  colors: darkColors,
  toggle: () => {},
  isDark: true,
})

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<ThemeMode>('dark')

  // Load from localStorage on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem('ff-theme')
      if (stored === 'dark' || stored === 'light') {
        setMode(stored)
      }
    } catch {
      // localStorage not available
    }
  }, [])

  // Persist to localStorage on change
  useEffect(() => {
    try {
      localStorage.setItem('ff-theme', mode)
    } catch {
      // localStorage not available
    }
    // Also set a class on <html> for potential CSS usage
    document.documentElement.classList.toggle('dark', mode === 'dark')
  }, [mode])

  const toggle = () => setMode(prev => prev === 'light' ? 'dark' : 'light')

  const value: ThemeContextType = {
    mode,
    colors: mode === 'dark' ? darkColors : lightColors,
    toggle,
    isDark: mode === 'dark',
  }

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme() {
  return useContext(ThemeContext)
}
