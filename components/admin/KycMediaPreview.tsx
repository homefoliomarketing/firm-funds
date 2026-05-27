'use client'

import { useState } from 'react'

import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

/**
 * Image / PDF preview tile used in the KYC review side panel.
 *
 * Previously the admin saw a flash of empty white while large ID scans
 * decoded — even though the blob URL was already resolved. This wraps the
 * media element with a sized skeleton that fades out as soon as `onLoad`
 * (img) or `onLoad` (iframe) fires.
 */
export function KycMediaPreview({
  src,
  alt,
  isPdf,
  className,
}: {
  src: string
  alt: string
  isPdf: boolean
  className?: string
}) {
  const [loaded, setLoaded] = useState(false)
  const [errored, setErrored] = useState(false)

  return (
    <div className={cn('relative w-full', className)}>
      {/* Skeleton placeholder — sized to a sensible ID-card aspect for images,
          and to the iframe height for PDFs. Stays mounted under the media so
          slow networks don't show empty space. */}
      {!loaded && !errored ? (
        <Skeleton
          aria-hidden="true"
          className={cn(
            'absolute inset-0 w-full rounded-lg',
            isPdf ? 'h-[400px]' : 'aspect-[3/2] min-h-[200px]',
          )}
        />
      ) : null}

      {isPdf ? (
        <iframe
          src={src}
          title={alt}
          onLoad={() => setLoaded(true)}
          onError={() => setErrored(true)}
          className={cn(
            'relative w-full border-0 rounded-lg border border-border transition-opacity duration-200',
            loaded ? 'opacity-100' : 'opacity-0',
          )}
          style={{ height: 400 }}
        />
      ) : (
        <img
          src={src}
          alt={alt}
          onLoad={() => setLoaded(true)}
          onError={() => setErrored(true)}
          className={cn(
            'relative w-full rounded-lg border border-border transition-opacity duration-200',
            loaded ? 'opacity-100' : 'opacity-0',
          )}
        />
      )}

      {errored ? (
        <div
          role="alert"
          className="absolute inset-0 flex items-center justify-center rounded-lg border border-destructive/30 bg-destructive/10 text-xs text-destructive p-3"
        >
          Could not load preview. Use the &ldquo;Open in new tab&rdquo; link above.
        </div>
      ) : null}
    </div>
  )
}
