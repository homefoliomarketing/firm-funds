'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Loader2, MapPin } from 'lucide-react'

export interface AddressParts {
  street: string
  city: string
  province: string
  postalCode: string
}

interface AddressAutocompleteProps {
  value: AddressParts
  onChange: (parts: AddressParts) => void
  /** Restrict suggestions to this 2-letter region code (default: 'ca') */
  country?: string
  required?: boolean
}

// Google Maps script loader — singleton, idempotent across mounts.
// Types are kept as `any` so we don't need to install @types/google.maps.
let mapsLoadPromise: Promise<any> | null = null
function loadGoogleMaps(apiKey: string): Promise<any> {
  if (typeof window === 'undefined') return Promise.reject(new Error('window unavailable'))
  if ((window as any).google?.maps) return Promise.resolve((window as any).google)
  if (mapsLoadPromise) return mapsLoadPromise

  mapsLoadPromise = new Promise((resolve, reject) => {
    const existing = document.getElementById('google-maps-js') as HTMLScriptElement | null
    if (existing) {
      existing.addEventListener('load', () => resolve((window as any).google), { once: true })
      existing.addEventListener('error', () => reject(new Error('Google Maps script failed to load')), { once: true })
      return
    }
    const script = document.createElement('script')
    script.id = 'google-maps-js'
    script.async = true
    script.defer = true
    // Site-wide Referrer-Policy is `no-referrer`. Per-element override sends
    // the origin so Google Cloud's HTTP-referrer key restriction matches.
    script.referrerPolicy = 'strict-origin-when-cross-origin'
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&libraries=places&v=weekly`
    script.onload = () => resolve((window as any).google)
    script.onerror = () => reject(new Error('Google Maps script failed to load'))
    document.head.appendChild(script)
  })
  return mapsLoadPromise
}

interface AddressComponentNew {
  types: string[]
  longText?: string | null
  shortText?: string | null
}

function partsFromComponents(components: AddressComponentNew[]): AddressParts {
  const get = (type: string, useShort = false): string => {
    const comp = components.find(c => c.types.includes(type))
    if (!comp) return ''
    return (useShort ? comp.shortText : comp.longText) || ''
  }
  const streetNumber = get('street_number')
  const route = get('route')
  const street = [streetNumber, route].filter(Boolean).join(' ').trim()
  const city = get('locality') || get('sublocality_level_1') || get('administrative_area_level_2')
  const province = get('administrative_area_level_1')
  const postalCode = get('postal_code').toUpperCase()
  return { street, city, province, postalCode }
}

interface Suggestion {
  text: string
  placeId: string
  fetchPlace: () => Promise<any>
}

export default function AddressAutocomplete({
  value,
  onChange,
  country = 'ca',
  required = false,
}: AddressAutocompleteProps) {
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY
  const [query, setQuery] = useState(value.street)
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [mapsReady, setMapsReady] = useState(false)
  const placesLibRef = useRef<any>(null)
  const sessionTokenRef = useRef<any>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const onChangeRef = useRef(onChange)
  useEffect(() => { onChangeRef.current = onChange }, [onChange])

  // Load the Maps SDK + Places library once
  useEffect(() => {
    if (!apiKey) return
    let cancelled = false
    loadGoogleMaps(apiKey)
      .then(async (g) => {
        if (cancelled) return
        const places = await g.maps.importLibrary('places')
        if (cancelled) return
        placesLibRef.current = places
        sessionTokenRef.current = new places.AutocompleteSessionToken()
        setMapsReady(true)
      })
      .catch((e) => {
        if (cancelled) return
        console.error('[AddressAutocomplete] failed to load:', e)
        setLoadError('Address suggestions unavailable — enter the address manually below.')
      })
    return () => { cancelled = true }
  }, [apiKey])

  // Debounced suggestion fetch
  const fetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fetchSuggestions = useCallback((input: string) => {
    if (fetchTimerRef.current) clearTimeout(fetchTimerRef.current)
    if (!input || input.trim().length < 3 || !placesLibRef.current) {
      setSuggestions([])
      setOpen(false)
      return
    }
    fetchTimerRef.current = setTimeout(async () => {
      setLoading(true)
      try {
        const { AutocompleteSuggestion } = placesLibRef.current
        const { suggestions: results } = await AutocompleteSuggestion.fetchAutocompleteSuggestions({
          input: input.trim(),
          includedRegionCodes: [country],
          sessionToken: sessionTokenRef.current,
        })
        const mapped: Suggestion[] = (results || [])
          .filter((s: any) => s.placePrediction)
          .slice(0, 6)
          .map((s: any) => ({
            text: s.placePrediction.text?.toString?.() || '',
            placeId: s.placePrediction.placeId,
            fetchPlace: async () => {
              const place = s.placePrediction.toPlace()
              await place.fetchFields({
                fields: ['addressComponents', 'formattedAddress'],
              })
              return place
            },
          }))
        setSuggestions(mapped)
        setActiveIndex(0)
        setOpen(mapped.length > 0)
      } catch (err) {
        console.error('[AddressAutocomplete] suggestion fetch failed:', err)
        setSuggestions([])
        setOpen(false)
      } finally {
        setLoading(false)
      }
    }, 250)
  }, [country])

  const pickSuggestion = useCallback(async (s: Suggestion) => {
    setOpen(false)
    setLoading(true)
    try {
      const place = await s.fetchPlace()
      const comps: AddressComponentNew[] = place.addressComponents || []
      const parts = partsFromComponents(comps)
      if (parts.street) {
        setQuery(parts.street)
        onChangeRef.current(parts)
      } else {
        setQuery(s.text)
      }
    } catch (err) {
      console.error('[AddressAutocomplete] place fetch failed:', err)
      setQuery(s.text)
    } finally {
      setLoading(false)
      // Start a fresh session for the next query — Google bills per session
      if (placesLibRef.current?.AutocompleteSessionToken) {
        sessionTokenRef.current = new placesLibRef.current.AutocompleteSessionToken()
      }
    }
  }, [])

  // Close dropdown on outside click
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const handleInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value
    setQuery(v)
    onChangeRef.current({ ...value, street: v })
    fetchSuggestions(v)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open || suggestions.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex(i => (i + 1) % suggestions.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex(i => (i - 1 + suggestions.length) % suggestions.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const sel = suggestions[activeIndex]
      if (sel) pickSuggestion(sel)
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  // Sync external value changes back to local query (e.g. parent reset)
  useEffect(() => {
    if (value.street !== query && document.activeElement !== inputRef.current) {
      setQuery(value.street)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.street])

  return (
    <div className="space-y-3">
      <div ref={containerRef} className="relative">
        <Label htmlFor="address-search">
          Property address {required && <span className="text-destructive">*</span>}
        </Label>
        <div className="relative">
          <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/60 pointer-events-none" aria-hidden="true" />
          <Input
            id="address-search"
            ref={inputRef}
            value={query}
            placeholder={apiKey ? 'Start typing an address…' : 'Enter street address'}
            className="pl-9"
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            onFocus={() => { if (suggestions.length > 0) setOpen(true) }}
            required={required}
            autoComplete="off"
            role="combobox"
            aria-expanded={open}
            aria-controls="address-suggestions"
            aria-autocomplete="list"
            aria-activedescendant={open ? `address-suggestion-${activeIndex}` : undefined}
          />
          {(loading || (apiKey && !mapsReady && !loadError)) && (
            <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/60 animate-spin pointer-events-none" aria-label="Loading" />
          )}
        </div>

        {open && suggestions.length > 0 && (
          <ul
            id="address-suggestions"
            role="listbox"
            className="absolute left-0 right-0 z-50 mt-1 max-h-72 overflow-auto rounded-md border border-border bg-card shadow-xl"
          >
            {suggestions.map((s, i) => (
              <li
                key={s.placeId}
                id={`address-suggestion-${i}`}
                role="option"
                aria-selected={i === activeIndex}
                onMouseDown={(e) => { e.preventDefault(); pickSuggestion(s) }}
                onMouseEnter={() => setActiveIndex(i)}
                className={`cursor-pointer px-3 py-2 text-sm text-foreground ${i === activeIndex ? 'bg-secondary' : 'hover:bg-secondary/60'}`}
              >
                <span className="flex items-start gap-2">
                  <MapPin className="h-4 w-4 mt-0.5 text-muted-foreground/60 shrink-0" aria-hidden="true" />
                  <span className="leading-snug">{s.text}</span>
                </span>
              </li>
            ))}
          </ul>
        )}

        {loadError && <p className="text-[11px] text-amber-400/80 mt-1">{loadError}</p>}
        {!apiKey && (
          <p className="text-[11px] text-muted-foreground/70 mt-1">
            Set <code>NEXT_PUBLIC_GOOGLE_MAPS_API_KEY</code> for address suggestions.
          </p>
        )}
      </div>

      {/* Editable parsed parts — visible so the user can verify and tweak */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <Label htmlFor="addr-city">City {required && <span className="text-destructive">*</span>}</Label>
          <Input
            id="addr-city"
            value={value.city}
            onChange={(e) => onChange({ ...value, city: e.target.value })}
            required={required}
          />
        </div>
        <div>
          <Label htmlFor="addr-province">Province</Label>
          <Input
            id="addr-province"
            value={value.province}
            onChange={(e) => onChange({ ...value, province: e.target.value })}
          />
        </div>
        <div>
          <Label htmlFor="addr-postal">Postal Code {required && <span className="text-destructive">*</span>}</Label>
          <Input
            id="addr-postal"
            value={value.postalCode}
            onChange={(e) => onChange({ ...value, postalCode: e.target.value.toUpperCase() })}
            maxLength={7}
            required={required}
          />
        </div>
      </div>
    </div>
  )
}
