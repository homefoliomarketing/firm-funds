import Image from 'next/image'

interface HelpScreenshotProps {
  src: string
  alt: string
  width: number
  height: number
  caption?: string
}

/**
 * Captioned figure for help-article screenshots. Forbids missing `alt` at the
 * type level (it is required, not optional). Uses `unoptimized` because the
 * Help screenshots live in `public/help/` and do not need Next's image CDN
 * pass, they are already PNGs at the right size.
 */
export default function HelpScreenshot({
  src,
  alt,
  width,
  height,
  caption,
}: HelpScreenshotProps) {
  return (
    <figure className="my-4 rounded-xl border border-border bg-card overflow-hidden">
      <Image
        src={src}
        alt={alt}
        width={width}
        height={height}
        unoptimized
        className="w-full h-auto block"
      />
      {caption && (
        <figcaption className="border-t border-border/50 px-4 py-2 text-xs text-muted-foreground">
          {caption}
        </figcaption>
      )}
    </figure>
  )
}
