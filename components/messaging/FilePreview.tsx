'use client'

import { FileText, Download, X } from 'lucide-react'
import { formatFileSize } from '@/lib/formatting'

interface FilePreviewProps {
  fileName: string
  fileType: string | null
  fileSize: number | null
  /** Signed URL or public URL for viewing/downloading */
  fileUrl?: string | null
  /** If true, show a remove button (for input preview before sending) */
  onRemove?: () => void
  /** Compact mode for message bubbles vs larger for input preview */
  compact?: boolean
}

export default function FilePreview({ fileName, fileType, fileSize, fileUrl, onRemove, compact }: FilePreviewProps) {
  const isImage = fileType?.startsWith('image/')
  const isPdf = fileType === 'application/pdf'

  if (isImage && fileUrl) {
    return (
      <div className="relative group">
        <a href={fileUrl} target="_blank" rel="noopener noreferrer">
          <img
            src={fileUrl}
            alt={fileName}
            className={`rounded-lg object-cover border border-border/50 ${compact ? 'max-w-[200px] max-h-[150px]' : 'max-w-[280px] max-h-[200px]'}`}
          />
        </a>
        {onRemove && (
          <button
            onClick={onRemove}
            className="absolute -top-2 -right-2 w-5 h-5 rounded-full flex items-center justify-center bg-destructive text-destructive-foreground"
          >
            <X size={12} />
          </button>
        )}
        {fileSize && (
          <p className="text-[10px] mt-0.5 text-muted-foreground/60">{formatFileSize(fileSize)}</p>
        )}
      </div>
    )
  }

  return (
    <div
      className={`flex items-center gap-2.5 rounded-lg border border-border/50 bg-muted/30 ${compact ? 'px-2.5 py-2' : 'px-3 py-2.5'}`}
    >
      <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${isPdf ? 'bg-destructive/10' : 'bg-primary/10'}`}>
        <FileText size={16} className={isPdf ? 'text-destructive' : 'text-primary'} />
      </div>
      <div className="flex-1 min-w-0">
        <p className={`font-medium truncate ${compact ? 'text-[11px]' : 'text-xs'} text-foreground`}>{fileName}</p>
        {fileSize && <p className="text-[10px] text-muted-foreground/60">{formatFileSize(fileSize)}</p>}
      </div>
      {fileUrl && (
        <a
          href={fileUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="p-1.5 rounded-md transition-colors flex-shrink-0 text-muted-foreground hover:text-primary"
        >
          <Download size={14} />
        </a>
      )}
      {onRemove && (
        <button
          onClick={onRemove}
          className="p-1 rounded-md flex-shrink-0 text-muted-foreground hover:text-destructive transition-colors"
        >
          <X size={14} />
        </button>
      )}
    </div>
  )
}
