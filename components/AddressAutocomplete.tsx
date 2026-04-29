'use client'

import { useEffect, useRef, useState } from 'react'
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
  /** Restrict suggestions to this 2-letter country code (default: 'ca') */
  country?: string
  required?: boolean
}

// Google Maps script loader — singleton, idempotent across mounts.
// Types are kept as `any` so we don't need to install @types/google.maps.
let mapsLoadPromise: Promise<any> | null = null
function loadGoogleMaps(apiKey: string): Promise<any> {
  if (typeof window === 'undefined') return Promise.reject(new Error('window unavailable'))
  if ((window as any).google?.maps?.places) return Promise.resolve((window as any).google)
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
    // Site-wide Referrer-Policy is `no-referrer`, which strips the Referer
    // header. Google Cloud's HTTP-referrer key restriction needs the origin
    // to match. Per-element override sends just the origin (e.g.
    // https://firmfunds.ca/).
    script.referrerPolicy = 'strict-origin-when-cross-origin'
    // Note: no `loading=async` — that requires Google's inline bootstrap
    // loader to define google.maps.importLibrary up-front. With a plain
    // <script> tag the legacy mode is what we want; once onload fires,
    // google.maps.places.Autocomplete is already attached.
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&libraries=places`
    script.onload = () => resolve((window as any).google)
    script.onerror = () => reject(new Error('Google Maps script failed to load'))
    document.head.appendChild(script)
  })
  return mapsLoadPromise
}

interface AddressComponent { types: string[]; long_name: string; short_name: string }
interface PlaceResult { address_components?: AddressComponent[]; formatted_address?: string }

function parsePlace(place: PlaceResult): AddressParts {
  const get = (type: string, useShort = false): string => {
    const comp = place.address_components?.find(c => c.types.includes(type))
    return comp ? (useShort ? comp.short_name : comp.long_name) : ''
  }
  const streetNumber = get('street_number')
  const route = get('route')
  const street = [streetNumber, route].filter(Boolean).join(' ').trim()
  const city = get('locality') || get('sublocality_level_1') || get('administrative_area_level_2')
  const province = get('administrative_area_level_1')
  const postalCode = get('postal_code').toUpperCase()
  return { street, city, province, postalCode }
}

export default function AddressAutocomplete({
  value,
  onChange,
  country = 'ca',
  required = false,
}: AddressAutocompleteProps) {
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY
  const inputRef = useRef<HTMLInputElement>(null)
  const autoRef = useRef<any>(null)
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  // Track latest onChange so the place_changed listener never holds a stale closure
  const onChangeRef = useRef(onChange)
  useEffect(() => { onChangeRef.current = onChange }, [onChange])

  useEffect(() => {
    if (!apiKey || !inputRef.current) return
    let cancelled = false
    loadGoogleMaps(apiKey)
      .then((g) => {
        if (cancelled || !inputRef.current) return
        autoRef.current = new g.maps.places.Autocomplete(inputRef.current, {
          types: ['address'],
          componentRestrictions: { country: [country] },
          fields: ['address_components', 'formatted_address'],
        })
        autoRef.current.addListener('place_changed', () => {
          const place = autoRef.current?.getPlace()
          if (!place?.address_components) return
          const parts = parsePlace(place)
          if (!parts.street) return
          onChangeRef.current(parts)
          // Sync the visible search input to the parsed street so the user
          // sees what they picked (Google sets the value to the formatted
          // address; we want the just-the-street version that lives in state).
          if (inputRef.current) inputRef.current.value = parts.street
        })
        setLoaded(true)
      })
      .catch((e) => {
        if (cancelled) return
        console.error('[AddressAutocomplete] failed to load:', e)
        setLoadError('Address suggestions unavailable — enter the address manually below.')
      })
    return () => { cancelled = true }
  }, [apiKey, country])

  // Defensive: Google's pac-container (suggestion dropdown) renders at the
  // document body and z-indexes above modals on its own, but it inherits
  // light colors. Make it readable on our dark theme.
  useEffect(() => {
    if (typeof document === 'undefined') return
    const id = 'pac-dark-style'
    if (document.getElementById(id)) return
    const style = document.createElement('style')
    style.id = id
    style.textContent = `
      .pac-container {
        background: var(--card, #141418);
        border: 1px solid var(--border, rgba(255,255,255,0.08));
        border-radius: 8px;
        margin-top: 4px;
        box-shadow: 0 8px 24px rgba(0,0,0,0.4);
        font-family: inherit;
      }
      .pac-item, .pac-item-query {
        color: var(--foreground, #EAEAEF);
        border-top-color: var(--border, rgba(255,255,255,0.05));
        padding: 8px 12px;
      }
      .pac-item:hover, .pac-item-selected, .pac-item-selected:hover {
        background: var(--secondary, #1E1E24);
      }
      .pac-matched { color: var(--primary, #5FA873); }
      .pac-icon { filter: invert(0.8); }
    `
    document.head.appendChild(style)
  }, [])

  // Single search input + revealed parts (parts are still editable in case Google misses something)
  return (
    <div className="space-y-3">
      <div>
        <Label htmlFor="address-search">
          Property address {required && <span className="text-destructive">*</span>}
        </Label>
        <div className="relative">
          <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/60 pointer-events-none" aria-hidden="true" />
          <Input
            id="address-search"
            ref={inputRef}
            placeholder={apiKey ? 'Start typing an address…' : 'Enter street address'}
            className="pl-9"
            defaultValue={value.street}
            onChange={(e) => onChange({ ...value, street: e.target.value })}
            required={required}
            autoComplete="off"
          />
          {apiKey && !loaded && !loadError && (
            <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/60 animate-spin" aria-label="Loading suggestions" />
          )}
        </div>
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
