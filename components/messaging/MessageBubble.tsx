'use client'

import { formatDateTime } from '@/lib/formatting'
import FilePreview from './FilePreview'

const ROLE_STYLES: Record<string, { bgClass: string; borderClass: string; nameClass: string; label: string }> = {
  admin: { bgClass: 'bg-status-green-muted', borderClass: 'border-status-green-border', nameClass: 'text-status-green', label: 'Firm Funds' },
  agent: { bgClass: 'bg-status-blue-muted', borderClass: 'border-status-blue-border', nameClass: 'text-status-blue', label: 'Agent' },
  brokerage_admin: { bgClass: 'bg-status-purple-muted', borderClass: 'border-status-purple-border', nameClass: 'text-status-purple', label: 'Brokerage' },
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
        className={`max-w-[85%] sm:max-w-[75%] rounded-2xl px-4 py-3 border ${style.bgClass} ${style.borderClass}`}
      >
        {/* Sender info */}
        <div className="flex items-center gap-2 mb-1">
          <span className={`text-[11px] font-semibold ${style.nameClass}`}>
            {msg.sender_role === 'admin' ? 'Firm Funds Agent' : (msg.sender_name || style.label)}
          </span>
          {msg.is_email_reply && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-status-blue-muted text-status-blue">
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
