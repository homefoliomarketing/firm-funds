'use client'

import { FileText, Image as ImageIcon, Download, X } from 'lucide-react'
import { useTheme } from '@/lib/theme'
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
  const { colors } = useTheme()
  const isImage = fileType?.startsWith('image/')
  const isPdf = fileType === 'application/pdf'

  if (isImage && fileUrl) {
    return (
      <div className="relative group">
        <a href={fileUrl} target="_blank" rel="noopener noreferrer">
          <img
            src={fileUrl}
            alt={fileName}
            className={`rounded-lg object-cover ${compact ? 'max-w-[200px] max-h-[150px]' : 'max-w-[280px] max-h-[200px]'}`}
            style={{ border: `1px solid ${colors.border}` }}
          />
        </a>
        {onRemove && (
          <button
            onClick={onRemove}
            className="absolute -top-2 -right-2 w-5 h-5 rounded-full flex items-center justify-center"
            style={{ background: '#DC2626', color: '#FFF' }}
          >
            <X size={12} />
          </button>
        )}
        {fileSize && (
          <p className="text-[10px] mt-0.5" style={{ color: colors.textFaint }}>{formatFileSize(fileSize)}</p>
        )}
      </div>
    )
  }

  return (
    <div
      className={`flex items-center gap-2.5 rounded-lg ${compact ? 'px-2.5 py-2' : 'px-3 py-2.5'}`}
      style={{ background: `${colors.inputBg}`, border: `1px solid ${colors.border}` }}
    >
      <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
        style={{ background: isPdf ? '#DC262620' : `${colors.gold}20` }}>
        {isPdf ? <FileText size={16} style={{ color: '#DC2626' }} /> : <FileText size={16} style={{ color: colors.gold }} />}
      </div>
      <div className="flex-1 min-w-0">
        <p className={`font-medium truncate ${compact ? 'text-[11px]' : 'text-xs'}`} style={{ color: colors.textPrimary }}>{fileName}</p>
        {fileSize && <p className="text-[10px]" style={{ color: colors.textFaint }}>{formatFileSize(fileSize)}</p>}
      </div>
      {fileUrl && (
        <a href={fileUrl} target="_blank" rel="noopener noreferrer"
          className="p-1.5 rounded-md transition-colors flex-shrink-0"
          style={{ color: colors.textMuted }}
          onMouseEnter={(e) => e.currentTarget.style.color = colors.gold}
          onMouseLeave={(e) => e.currentTarget.style.color = colors.textMuted}
        >
          <Download size={14} />
        </a>
      )}
      {onRemove && (
        <button onClick={onRemove} className="p-1 rounded-md flex-shrink-0" style={{ color: colors.textMuted }}>
          <X size={14} />
        </button>
      )}
    </div>
  )
}
