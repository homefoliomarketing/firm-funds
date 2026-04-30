'use client'

import { useEffect, useRef, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Loader2 } from 'lucide-react'

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
    // Site-wide Referrer-Policy is `no-referrer`, which strips the Referer
    // header. Google Cloud's HTTP-referrer key restriction needs the origin
    // to match. Per-element override sends just the origin (e.g.
    // https://firmfunds.ca/).
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

export default function AddressAutocomplete({
  value,
  onChange,
  country = 'ca',
  required = false,
}: AddressAutocompleteProps) {
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY
  const containerRef = useRef<HTMLDivElement>(null)
  const elementRef = useRef<any>(null)
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  // Track latest onChange so the listener never holds a stale closure
  const onChangeRef = useRef(onChange)
  useEffect(() => { onChangeRef.current = onChange }, [onChange])

  useEffect(() => {
    if (!apiKey || !containerRef.current) return
    let cancelled = false

    loadGoogleMaps(apiKey)
      .then(async (g) => {
        if (cancelled || !containerRef.current) return
        // Legacy google.maps.places.Autocomplete is blocked for projects
        // created after March 1, 2025. PlaceAutocompleteElement is the new
        // Web Component replacement and is what's available to new keys.
        const { PlaceAutocompleteElement } = await g.maps.importLibrary('places')
        if (cancelled || !containerRef.current) return

        const el = new PlaceAutocompleteElement({
          includedRegionCodes: [country],
        })
        el.id = 'address-search'
        // Pre-fill with whatever parent state holds, so the element shows
        // the same string the user typed before this remounted.
        if (value.street) {
          // PlaceAutocompleteElement does not expose a value setter as of
          // this writing; we rely on the embedded input's defaults.
        }

        elementRef.current = el
        containerRef.current.replaceChildren(el)

        el.addEventListener('gmp-placeselect', async (event: any) => {
          try {
            const place = event.place
            await place.fetchFields({ fields: ['addressComponents', 'formattedAddress'] })
            const comps: AddressComponentNew[] = place.addressComponents || []
            const parts = partsFromComponents(comps)
            if (parts.street) onChangeRef.current(parts)
          } catch (err) {
            console.error('[AddressAutocomplete] place select failed:', err)
          }
        })

        setLoaded(true)
      })
      .catch((e) => {
        if (cancelled) return
        console.error('[AddressAutocomplete] failed to load:', e)
        setLoadError('Address suggestions unavailable — enter the address manually below.')
      })

    return () => {
      cancelled = true
      if (elementRef.current) {
        try { elementRef.current.remove() } catch {}
        elementRef.current = null
      }
    }
  // value.street intentionally not a dep — we only seed on first mount
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey, country])

  // Theme the gmp-place-autocomplete custom element to match the dark theme.
  // Material-style CSS variables are exposed by the Web Component's shadow DOM.
  useEffect(() => {
    if (typeof document === 'undefined') return
    const id = 'gmp-place-autocomplete-theme'
    if (document.getElementById(id)) return
    const style = document.createElement('style')
    style.id = id
    style.textContent = `
      gmp-place-autocomplete {
        --gmp-mat-color-surface: var(--card, #141418);
        --gmp-mat-color-surface-container-low: var(--card, #141418);
        --gmp-mat-color-surface-container: var(--card, #141418);
        --gmp-mat-color-on-surface: var(--foreground, #EAEAEF);
        --gmp-mat-color-on-surface-variant: var(--muted-foreground, #B8B8B8);
        --gmp-mat-color-outline: var(--border, rgba(255,255,255,0.12));
        --gmp-mat-color-outline-variant: var(--border, rgba(255,255,255,0.08));
        --gmp-mat-color-primary: var(--primary, #5FA873);
        --gmp-mat-color-secondary-container: var(--secondary, #1E1E24);
        --gmp-mat-font-family: inherit;
        width: 100%;
        display: block;
      }
    `
    document.head.appendChild(style)
  }, [])

  return (
    <div className="space-y-3">
      <div>
        <Label htmlFor="address-search">
          Property address {required && <span className="text-destructive">*</span>}
        </Label>
        <div className="relative">
          <div ref={containerRef} className="min-h-[40px]">
            {!apiKey && (
              <Input
                id="address-search-fallback"
                placeholder="Enter street address"
                value={value.street}
                onChange={(e) => onChange({ ...value, street: e.target.value })}
                required={required}
                autoComplete="off"
              />
            )}
          </div>
          {apiKey && !loaded && !loadError && (
            <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/60 animate-spin pointer-events-none" aria-label="Loading suggestions" />
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
