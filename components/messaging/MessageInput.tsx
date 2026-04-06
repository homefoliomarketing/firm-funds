'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
import { Send, Smile, Paperclip, Zap, X } from 'lucide-react'
import { useTheme } from '@/lib/theme'
import EmojiPicker from './EmojiPicker'
import FilePreview from './FilePreview'

interface QuickReply {
  label: string
  message: string
}

interface MessageInputProps {
  onSend: (message: string, file?: File | null) => Promise<void>
  placeholder?: string
  disabled?: boolean
  /** Show quick reply templates (admin feature) */
  quickReplies?: QuickReply[]
}

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10MB
const ALLOWED_FILE_TYPES = [
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'application/pdf',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]

export default function MessageInput({ onSend, placeholder, disabled, quickReplies }: MessageInputProps) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [showEmoji, setShowEmoji] = useState(false)
  const [showQuickReplies, setShowQuickReplies] = useState(false)
  const [attachedFile, setAttachedFile] = useState<File | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const { colors } = useTheme()

  // Auto-grow textarea
  const adjustHeight = useCallback(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = Math.min(ta.scrollHeight, 120) + 'px' // max ~5 lines
  }, [])

  useEffect(() => { adjustHeight() }, [text, adjustHeight])

  const handleSend = async () => {
    if ((!text.trim() && !attachedFile) || sending) return
    const msgText = text.trim()
    const msgFile = attachedFile
    // Clear input immediately for responsive feel
    setText('')
    setAttachedFile(null)
    setFileError(null)
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
    setSending(true)
    try {
      await onSend(msgText, msgFile)
    } catch {
      // If send failed, restore the text so user can retry
      setText(msgText)
      if (msgFile) setAttachedFile(msgFile)
    }
    setSending(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setFileError(null)

    if (!ALLOWED_FILE_TYPES.includes(file.type)) {
      setFileError('File type not supported. Use images, PDFs, or Word docs.')
      e.target.value = ''
      return
    }
    if (file.size > MAX_FILE_SIZE) {
      setFileError('File must be under 10MB.')
      e.target.value = ''
      return
    }

    setAttachedFile(file)
    e.target.value = ''
  }

  const handleEmojiSelect = (emoji: string) => {
    const ta = textareaRef.current
    if (ta) {
      const start = ta.selectionStart
      const end = ta.selectionEnd
      const newText = text.substring(0, start) + emoji + text.substring(end)
      setText(newText)
      // Restore cursor position after emoji
      setTimeout(() => {
        ta.selectionStart = ta.selectionEnd = start + emoji.length
        ta.focus()
      }, 0)
    } else {
      setText(prev => prev + emoji)
    }
  }

  const canSend = (text.trim() || attachedFile) && !sending && !disabled

  return (
    <div style={{ borderTop: `1px solid ${colors.border}`, background: colors.tableHeaderBg }}>
      {/* Quick replies strip */}
      {showQuickReplies && quickReplies && (
        <div className="px-4 py-2 flex flex-wrap gap-1.5" style={{ borderBottom: `1px solid ${colors.border}` }}>
          {quickReplies.map((qr, i) => (
            <button
              key={i}
              onClick={() => { setText(qr.message); setShowQuickReplies(false); textareaRef.current?.focus() }}
              className="px-2.5 py-1.5 rounded-md text-[11px] font-medium transition-colors"
              style={{ background: colors.cardBg, color: colors.textSecondary, border: `1px solid ${colors.border}` }}
              onMouseEnter={(e) => { e.currentTarget.style.borderColor = colors.gold; e.currentTarget.style.color = colors.gold }}
              onMouseLeave={(e) => { e.currentTarget.style.borderColor = colors.border; e.currentTarget.style.color = colors.textSecondary }}
            >
              {qr.label}
            </button>
          ))}
        </div>
      )}

      {/* Attached file preview */}
      {attachedFile && (
        <div className="px-4 pt-3">
          <FilePreview
            fileName={attachedFile.name}
            fileType={attachedFile.type}
            fileSize={attachedFile.size}
            fileUrl={URL.createObjectURL(attachedFile)}
            onRemove={() => setAttachedFile(null)}
          />
        </div>
      )}

      {/* Error message */}
      {fileError && (
        <div className="px-4 pt-2">
          <p className="text-xs" style={{ color: '#E07B7B' }}>{fileError}</p>
        </div>
      )}

      {/* Input row */}
      <div className="px-4 py-3 flex items-end gap-2">
        {/* Emoji + File buttons */}
        <div className="flex items-center gap-1 pb-0.5 relative">
          {showEmoji && (
            <EmojiPicker onSelect={handleEmojiSelect} onClose={() => setShowEmoji(false)} />
          )}
          <button
            onClick={() => { setShowEmoji(!showEmoji); setShowQuickReplies(false) }}
            className="p-2 rounded-lg transition-colors"
            style={{
              color: showEmoji ? colors.gold : colors.textMuted,
              background: showEmoji ? `${colors.gold}15` : 'transparent',
            }}
            onMouseEnter={(e) => { if (!showEmoji) e.currentTarget.style.color = colors.textPrimary }}
            onMouseLeave={(e) => { if (!showEmoji) e.currentTarget.style.color = colors.textMuted }}
          >
            <Smile size={18} />
          </button>
          <button
            onClick={() => fileInputRef.current?.click()}
            className="p-2 rounded-lg transition-colors"
            style={{ color: attachedFile ? colors.gold : colors.textMuted }}
            onMouseEnter={(e) => { if (!attachedFile) e.currentTarget.style.color = colors.textPrimary }}
            onMouseLeave={(e) => { if (!attachedFile) e.currentTarget.style.color = colors.textMuted }}
          >
            <Paperclip size={18} />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".jpg,.jpeg,.png,.gif,.webp,.pdf,.doc,.docx"
            onChange={handleFileSelect}
            className="hidden"
          />
          {quickReplies && (
            <button
              onClick={() => { setShowQuickReplies(!showQuickReplies); setShowEmoji(false) }}
              className="p-2 rounded-lg transition-colors"
              style={{
                color: showQuickReplies ? colors.gold : colors.textMuted,
                background: showQuickReplies ? `${colors.gold}15` : 'transparent',
              }}
            >
              <Zap size={18} />
            </button>
          )}
        </div>

        {/* Textarea */}
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder || 'Type a message... (Shift+Enter for new line)'}
          disabled={disabled || sending}
          rows={1}
          className="flex-1 resize-none rounded-xl px-4 py-2.5 text-sm outline-none transition-colors disabled:opacity-50"
          style={{
            background: colors.inputBg,
            border: `1px solid ${colors.inputBorder}`,
            color: colors.inputText,
            minHeight: '40px',
            maxHeight: '120px',
          }}
          onFocus={(e) => { e.currentTarget.style.borderColor = colors.gold }}
          onBlur={(e) => { e.currentTarget.style.borderColor = colors.inputBorder }}
        />

        {/* Send button */}
        <button
          onClick={handleSend}
          disabled={!canSend}
          className="p-2.5 rounded-xl transition-colors disabled:opacity-30 flex-shrink-0"
          style={{ background: canSend ? '#5FA873' : colors.inputBg, color: canSend ? '#FFFFFF' : colors.textMuted }}
          onMouseEnter={(e) => { if (canSend) e.currentTarget.style.background = '#4E9462' }}
          onMouseLeave={(e) => { if (canSend) e.currentTarget.style.background = '#5FA873' }}
        >
          <Send size={18} />
        </button>
      </div>
    </div>
  )
}
