'use client'

import { useState, useCallback, useImperativeHandle, forwardRef } from 'react'
import { Loader2, CheckCircle2, AlertCircle, X, RotateCw, FileText, Clock } from 'lucide-react'
import { Button } from '@/components/ui/button'

export type FileUploadStatus = 'pending' | 'uploading' | 'success' | 'failed'

export interface FileUploadItem {
  /** Stable unique id (e.g. crypto.randomUUID()) so React can key across re-renders */
  id: string
  /** Original File object */
  file: File
  /** Optional category tag (e.g. "trade_record", "aps") — passed back to uploader */
  category?: string
  status: FileUploadStatus
  /** 0–100. For server actions without progress events we toggle between 0 and 100 only. */
  progress: number
  /** Human-readable error if status === 'failed' */
  error?: string
}

export interface FileUploadProgressProps {
  items: FileUploadItem[]
  /** Called when user clicks the X on a queued (pending) or finished item */
  onRemove?: (id: string) => void
  /** Called when user clicks Retry on a failed item */
  onRetry?: (id: string) => void
  /** Hide the per-item remove button (use during/after a submitted upload batch) */
  hideRemove?: boolean
  className?: string
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

/**
 * FileUploadProgress
 *
 * A controlled list of files with per-file status, progress bar, and
 * retry/remove affordances. The parent owns the items array and the
 * upload orchestration; this component only renders.
 *
 * Designed for batched uploads where one failure should not block the
 * rest of the queue — the orchestrator should iterate and update each
 * item's status independently.
 */
export function FileUploadProgress({
  items,
  onRemove,
  onRetry,
  hideRemove,
  className = '',
}: FileUploadProgressProps) {
  if (items.length === 0) return null

  return (
    <ul
      role="list"
      aria-label="File upload queue"
      className={`space-y-2 ${className}`}
    >
      {items.map((item) => (
        <li
          key={item.id}
          className="rounded-lg border border-border bg-card/50 px-3 py-2.5"
          aria-live={item.status === 'uploading' ? 'polite' : 'off'}
        >
          <div className="flex items-center gap-3">
            <FileText size={16} className="text-muted-foreground shrink-0" aria-hidden="true" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-foreground truncate" title={item.file.name}>
                {item.file.name}
              </p>
              <p className="text-xs text-muted-foreground">
                {formatBytes(item.file.size)}
                {item.category ? <> · <span className="capitalize">{item.category.replace(/_/g, ' ')}</span></> : null}
              </p>
            </div>
            <StatusIcon status={item.status} />
            <div className="flex items-center gap-1">
              {item.status === 'failed' && onRetry && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => onRetry(item.id)}
                  aria-label={`Retry uploading ${item.file.name}`}
                  title="Retry"
                >
                  <RotateCw size={13} aria-hidden="true" />
                </Button>
              )}
              {!hideRemove && onRemove && (item.status === 'pending' || item.status === 'failed') && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => onRemove(item.id)}
                  aria-label={`Remove ${item.file.name} from queue`}
                  title="Remove"
                >
                  <X size={13} aria-hidden="true" />
                </Button>
              )}
            </div>
          </div>

          {/* Progress bar — indeterminate-ish stripe while uploading, full on success */}
          {(item.status === 'uploading' || item.status === 'success' || item.status === 'failed') && (
            <div
              className="mt-2 h-1 w-full rounded-full bg-muted overflow-hidden"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={item.status === 'success' ? 100 : item.status === 'failed' ? 0 : item.progress}
              aria-label={`Upload progress for ${item.file.name}`}
            >
              <div
                className={`h-full transition-all duration-300 ${
                  item.status === 'success'
                    ? 'bg-primary'
                    : item.status === 'failed'
                    ? 'bg-destructive'
                    : 'bg-primary/70'
                }`}
                style={{
                  width:
                    item.status === 'success'
                      ? '100%'
                      : item.status === 'failed'
                      ? '100%'
                      : `${Math.max(8, Math.min(100, item.progress))}%`,
                }}
              />
            </div>
          )}

          {item.status === 'failed' && item.error && (
            <p className="mt-1.5 text-xs text-destructive flex items-start gap-1">
              <AlertCircle size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span>{item.error}</span>
            </p>
          )}
        </li>
      ))}
    </ul>
  )
}

function StatusIcon({ status }: { status: FileUploadStatus }) {
  switch (status) {
    case 'pending':
      return (
        <span
          className="text-muted-foreground/70 shrink-0"
          title="Waiting"
          aria-label="Waiting to upload"
        >
          <Clock size={14} aria-hidden="true" />
        </span>
      )
    case 'uploading':
      return (
        <span
          className="text-primary shrink-0"
          title="Uploading"
          aria-label="Uploading"
        >
          <Loader2 size={14} className="animate-spin" aria-hidden="true" />
        </span>
      )
    case 'success':
      return (
        <span
          className="text-status-green shrink-0"
          title="Uploaded"
          aria-label="Uploaded successfully"
        >
          <CheckCircle2 size={14} aria-hidden="true" />
        </span>
      )
    case 'failed':
      return (
        <span
          className="text-destructive shrink-0"
          title="Failed"
          aria-label="Upload failed"
        >
          <AlertCircle size={14} aria-hidden="true" />
        </span>
      )
  }
}

/**
 * Helper: turn a list of (File, category) into FileUploadItem[].
 * Generates stable ids so React keys are predictable across renders.
 */
export function buildUploadItems(
  files: { file: File; category?: string }[]
): FileUploadItem[] {
  return files.map(({ file, category }) => ({
    id:
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2, 9)}`,
    file,
    category,
    status: 'pending' as const,
    progress: 0,
  }))
}
