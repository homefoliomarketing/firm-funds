'use client'

import { formatDateTime } from '@/lib/formatting'
import FilePreview from './FilePreview'

// Role-based styling (kept as-is — hardcoded dark palette for chat bubbles)
const ROLE_STYLES: Record<string, { bg: string; border: string; nameColor: string; label: string }> = {
  admin: { bg: '#0F2A18', border: '#1E4A2C', nameColor: '#5FA873', label: 'Firm Funds' },
  agent: { bg: '#1A2240', border: '#2D3A5C', nameColor: '#7B9FE0', label: 'Agent' },
  brokerage_admin: { bg: '#1F1535', border: '#352A50', nameColor: '#C4A5F5', label: 'Brokerage' },
}

export interface MessageData {
  id: string
  sender_role: string
  sender_name?: string | null
  message: string
  is_email_reply?: boolean
  file_path?: string | null
  file_name?: string | null
  file_size?: number | null
  file_type?: string | null
  file_url?: string | null
  created_at: string
}

interface MessageBubbleProps {
  msg: MessageData
  /** The role of the person viewing (to determine alignment) */
  viewerRole: 'admin' | 'agent' | 'brokerage_admin'
}

export default function MessageBubble({ msg, viewerRole }: MessageBubbleProps) {
  const isOwn = msg.sender_role === viewerRole || (viewerRole === 'admin' && msg.sender_role === 'admin')
  const style = ROLE_STYLES[msg.sender_role] || ROLE_STYLES.agent

  return (
    <div className={`flex ${isOwn ? 'justify-end' : 'justify-start'} mb-3`}>
      <div
        className="max-w-[85%] sm:max-w-[75%] rounded-2xl px-4 py-3"
        style={{ background: style.bg, border: `1px solid ${style.border}` }}
      >
        {/* Sender info */}
        <div className="flex items-center gap-2 mb-1">
          <span className="text-[11px] font-semibold" style={{ color: style.nameColor }}>
            {msg.sender_name || style.label}
          </span>
          {msg.is_email_reply && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#2D3A5C] text-[#7B9FE0]">
              via email
            </span>
          )}
        </div>

        {/* Message text */}
        {msg.message && (
          <p className="text-sm whitespace-pre-wrap leading-relaxed text-foreground">
            {msg.message}
          </p>
        )}

        {/* File attachment */}
        {msg.file_path && msg.file_name && (
          <div className={msg.message ? 'mt-2' : ''}>
            <FilePreview
              fileName={msg.file_name}
              fileType={msg.file_type || null}
              fileSize={msg.file_size || null}
              fileUrl={msg.file_url || null}
              compact
            />
          </div>
        )}

        {/* Timestamp */}
        <p className="text-[10px] mt-1.5 text-muted-foreground/60">
          {formatDateTime(msg.created_at)}
        </p>
      </div>
    </div>
  )
}
