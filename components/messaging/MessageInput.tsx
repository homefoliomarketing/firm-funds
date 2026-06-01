'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
import { Send, Smile, Paperclip, Zap } from 'lucide-react'
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
    <div className="border-t border-border/50 bg-card/50">
      {/* Quick replies strip */}
      {showQuickReplies && quickReplies && (
        <div className="px-4 py-2 flex flex-wrap gap-1.5 border-b border-border/50">
          {quickReplies.map((qr, i) => (
            <button
              key={i}
              type="button"
              onClick={() => { setText(qr.message); setShowQuickReplies(false); textareaRef.current?.focus() }}
              className="px-2.5 py-1.5 rounded-md text-[11px] font-medium transition-colors bg-background text-muted-foreground border border-border/50 hover:border-primary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
          <p className="text-xs text-destructive">{fileError}</p>
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
            type="button"
            onClick={() => { setShowEmoji(!showEmoji); setShowQuickReplies(false) }}
            aria-label="Add emoji"
            aria-pressed={showEmoji}
            aria-expanded={showEmoji}
            className={`p-2 rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${showEmoji ? 'text-primary bg-primary/10' : 'text-muted-foreground hover:text-foreground'}`}
          >
            <Smile size={18} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            aria-label="Attach file"
            className={`p-2 rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${attachedFile ? 'text-primary' : 'text-muted-foreground hover:text-foreground'}`}
          >
            <Paperclip size={18} aria-hidden="true" />
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
              type="button"
              onClick={() => { setShowQuickReplies(!showQuickReplies); setShowEmoji(false) }}
              aria-label="Quick replies"
              aria-pressed={showQuickReplies}
              aria-expanded={showQuickReplies}
              className={`p-2 rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${showQuickReplies ? 'text-primary bg-primary/10' : 'text-muted-foreground hover:text-foreground'}`}
            >
              <Zap size={18} aria-hidden="true" />
            </button>
          )}
        </div>

        {/* Textarea */}
        <label htmlFor="message-input" className="sr-only">Message</label>
        <textarea
          id="message-input"
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder || 'Type a message... (Shift+Enter for new line)'}
          disabled={disabled || sending}
          rows={1}
          aria-label="Message"
          className="flex-1 resize-none rounded-xl px-4 py-2.5 text-sm outline-none transition-colors disabled:opacity-50 bg-muted/30 border border-border/50 text-foreground placeholder:text-muted-foreground focus:border-primary focus-visible:ring-2 focus-visible:ring-ring min-h-[40px] max-h-[120px]"
        />

        {/* Send button */}
        <button
          type="button"
          onClick={handleSend}
          disabled={!canSend}
          aria-label="Send message"
          className={`p-2.5 rounded-xl transition-colors disabled:opacity-30 flex-shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${canSend ? 'bg-primary text-primary-foreground hover:bg-primary/90' : 'bg-muted text-muted-foreground'}`}
        >
          <Send size={18} aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}
