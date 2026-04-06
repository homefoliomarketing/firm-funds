'use client'

import { createContext, useContext, useEffect, useState, ReactNode } from 'react'

// =============================================================================
// Theme Color Definitions
// Updated to match CSS variable theme in globals.css
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

// Dark colors — synced with CSS variables in globals.css
export const darkColors: ThemeColors = {
  pageBg: '#0B0B0F',
  cardBg: '#141418',
  cardBorder: 'rgba(255, 255, 255, 0.08)',
  cardHoverBg: '#1E1E24',

  headerBg: '#0B0B0F',
  headerBgGradient: 'linear-gradient(135deg, #0B0B0F, #141418)',

  textPrimary: '#EAEAEF',
  textSecondary: '#A0A0AB',
  textMuted: '#6B6B78',
  textFaint: '#3A3A44',

  gold: '#5FA873',
  goldDark: '#7BC48D',
  goldBg: '#0E2016',

  border: 'rgba(255, 255, 255, 0.08)',
  borderLight: 'rgba(255, 255, 255, 0.05)',
  divider: 'rgba(255, 255, 255, 0.06)',

  inputBg: '#1E1E24',
  inputBorder: 'rgba(255, 255, 255, 0.1)',
  inputText: '#EAEAEF',

  tableHeaderBg: '#0F0F13',
  tableRowHoverBg: '#1E1E24',
  tableRowBorder: 'rgba(255, 255, 255, 0.06)',

  skeletonBase: '#1E1E24',
  skeletonHighlight: '#28282F',

  successText: '#4ADE80',
  successBg: '#0F2416',
  successBorder: '#1E4228',
  errorText: '#F87171',
  errorBg: '#241010',
  errorBorder: '#422020',
  warningText: '#F5A623',
  warningBg: '#201C0E',
  warningBorder: '#423618',
  infoText: '#60A5FA',
  infoBg: '#101524',
  infoBorder: '#203050',

  overlayBg: 'rgba(0,0,0,0.75)',
  shadowColor: 'rgba(0,0,0,0.5)',
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
  const [mode] = useState<ThemeMode>('dark')

  useEffect(() => {
    document.documentElement.classList.add('dark')
  }, [])

  // Light mode disabled — always dark
  const toggle = () => {}

  const value: ThemeContextType = {
    mode,
    colors: darkColors,
    toggle,
    isDark: true,
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
