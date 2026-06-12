'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Camera, X, RefreshCw, AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface IdCameraCaptureProps {
  onCapture: (file: File) => void
  onClose: () => void
}

type FacingMode = 'environment' | 'user'

export default function IdCameraCapture({ onCapture, onClose }: IdCameraCaptureProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const streamRef = useRef<MediaStream | null>(null)

  const [facingMode, setFacingMode] = useState<FacingMode>('environment')
  const [unsupported, setUnsupported] = useState(false)
  const [cameraError, setCameraError] = useState<string | null>(null)
  const [starting, setStarting] = useState(true)

  // Stop every track on the active stream and clear the ref.
  const stopStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null
    }
  }, [])

  // (Re)start the camera with the given facing mode. Always stops the prior stream first.
  const startStream = useCallback(
    async (mode: FacingMode) => {
      if (typeof navigator.mediaDevices?.getUserMedia !== 'function') {
        setUnsupported(true)
        setStarting(false)
        return
      }

      setStarting(true)
      setCameraError(null)
      stopStream()

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: mode } },
          audio: false,
        })
        streamRef.current = stream
        if (videoRef.current) {
          videoRef.current.srcObject = stream
        }
      } catch (err) {
        console.error('IdCameraCapture getUserMedia error:', err)
        setCameraError(
          "We couldn't open your camera. Please allow camera access, or choose a photo from your library below.",
        )
      } finally {
        setStarting(false)
      }
    },
    [stopStream],
  )

  // Open the rear camera on mount; always release tracks on unmount.
  useEffect(() => {
    startStream('environment')
    return () => {
      stopStream()
    }
    // startStream/stopStream are stable (useCallback); run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Close handler: release the camera, then notify the parent.
  const handleClose = useCallback(() => {
    stopStream()
    onClose()
  }, [stopStream, onClose])

  // Esc closes the modal.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [handleClose])

  const handleFlip = useCallback(() => {
    const next: FacingMode = facingMode === 'environment' ? 'user' : 'environment'
    setFacingMode(next)
    startStream(next)
  }, [facingMode, startStream])

  const handleCapture = useCallback(() => {
    const video = videoRef.current
    const canvas = canvasRef.current
    if (!video || !canvas) return

    const width = video.videoWidth
    const height = video.videoHeight
    if (!width || !height) return

    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.drawImage(video, 0, 0, width, height)

    canvas.toBlob(
      (blob) => {
        if (!blob) return
        const file = new File([blob], `id-photo-${Date.now()}.jpg`, { type: 'image/jpeg' })
        stopStream()
        onCapture(file)
        onClose()
      },
      'image/jpeg',
      0.9,
    )
  }, [stopStream, onCapture, onClose])

  // Fallback file input used when getUserMedia is unavailable or denied.
  const renderFallbackInput = (label: string) => (
    <label className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-primary text-primary-foreground text-sm font-semibold cursor-pointer hover:bg-primary/90 transition-colors">
      <Camera size={16} />
      {label}
      <input
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => {
          if (e.target.files?.[0]) {
            const file = e.target.files[0]
            e.target.value = ''
            onCapture(file)
            onClose()
          }
        }}
      />
    </label>
  )

  const showFallback = unsupported || !!cameraError

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-background/95 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Take a photo of your ID"
    >
      {/* Top bar */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-card">
        <span className="text-sm font-semibold text-foreground">Take a photo of your ID</span>
        <button
          type="button"
          onClick={handleClose}
          aria-label="Close camera"
          className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
        >
          <X size={20} />
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 flex flex-col items-center justify-center p-4 min-h-0">
        {showFallback ? (
          <div className="max-w-sm w-full text-center">
            <div className="mx-auto mb-4 h-12 w-12 rounded-full bg-muted flex items-center justify-center">
              <AlertCircle size={24} className="text-muted-foreground" />
            </div>
            <p className="text-sm text-muted-foreground leading-relaxed mb-5">
              {cameraError ??
                "Your device doesn't support in-browser camera capture. You can still take or choose a photo using your device's camera app."}
            </p>
            {renderFallbackInput('Open camera / choose photo')}
          </div>
        ) : (
          <>
            <div className="relative w-full max-w-lg flex-1 min-h-0 flex items-center justify-center">
              {/* eslint-disable-next-line jsx-a11y/media-has-caption -- live camera preview, no audio track */}
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                className="max-h-full max-w-full rounded-xl border border-border bg-black object-contain"
              />
              {starting && (
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="w-10 h-10 border-[3px] border-muted border-t-primary rounded-full animate-spin" />
                </div>
              )}
            </div>
            <canvas ref={canvasRef} className="hidden" />
          </>
        )}
      </div>

      {/* Controls */}
      {!showFallback && (
        <div className="flex items-center justify-center gap-3 px-4 py-5 border-t border-border bg-card">
          <Button
            type="button"
            variant="outline"
            onClick={handleFlip}
            disabled={starting}
            aria-label="Flip camera"
            className="flex items-center gap-2"
          >
            <RefreshCw size={16} />
            Flip camera
          </Button>
          <Button
            type="button"
            onClick={handleCapture}
            disabled={starting}
            aria-label="Capture photo"
            className="flex items-center gap-2 px-8"
          >
            <Camera size={18} />
            Capture
          </Button>
        </div>
      )}
    </div>
  )
}
