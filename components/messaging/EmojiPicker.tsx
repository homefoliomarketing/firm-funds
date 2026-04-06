'use client'

import { useState, useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'

const EMOJI_CATEGORIES = [
  {
    label: 'Smileys',
    emojis: ['😀', '😊', '😂', '🤣', '😅', '😉', '😍', '🥰', '😘', '😎', '🤔', '😏', '😬', '🙄', '😴', '🤗', '😇', '🤩', '😤', '😢'],
  },
  {
    label: 'Hands',
    emojis: ['👍', '👎', '👏', '🙌', '🤝', '✌️', '🤞', '👋', '✋', '🫡', '💪', '🙏', '👌', '🤙', '☝️', '👆', '👉', '👈', '🫶', '🤌'],
  },
  {
    label: 'Objects',
    emojis: ['📎', '📄', '📋', '📁', '✅', '❌', '⚠️', '🔔', '📌', '🏠', '🏢', '💰', '💵', '🏦', '📊', '📈', '🔑', '📝', '💼', '🎯'],
  },
  {
    label: 'Hearts',
    emojis: ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '💯', '⭐', '🌟', '✨', '🔥', '💥', '🎉', '🎊', '🥳', '👀', '💡', '🚀'],
  },
  {
    label: 'Symbols',
    emojis: ['✅', '❌', '⬆️', '⬇️', '➡️', '⬅️', '🔄', '⏰', '📅', '🗓️', '⚡', '💬', '📩', '📤', '📥', '🔗', '🔒', '🔓', '⚙️', '🛡️'],
  },
]

interface EmojiPickerProps {
  onSelect: (emoji: string) => void
  onClose: () => void
}

export default function EmojiPicker({ onSelect, onClose }: EmojiPickerProps) {
  const [activeCategory, setActiveCategory] = useState(0)
  const ref = useRef<HTMLDivElement>(null)

  // Close on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <div
      ref={ref}
      className="absolute bottom-full left-0 mb-2 rounded-xl shadow-2xl overflow-hidden z-50 w-80 bg-card border border-border/50"
    >
      {/* Category tabs */}
      <div className="flex items-center justify-between px-2 pt-2 pb-1">
        <div className="flex gap-1">
          {EMOJI_CATEGORIES.map((cat, i) => (
            <button
              key={cat.label}
              onClick={() => setActiveCategory(i)}
              className={`px-2 py-1 rounded-md text-[10px] font-semibold transition-colors ${
                activeCategory === i
                  ? 'bg-primary/20 text-primary'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {cat.label}
            </button>
          ))}
        </div>
        <button onClick={onClose} className="p-1 rounded text-muted-foreground hover:text-foreground transition-colors">
          <X size={14} />
        </button>
      </div>

      {/* Emoji grid */}
      <div className="px-2 pb-2 grid grid-cols-10 gap-0.5 max-h-40 overflow-y-auto">
        {EMOJI_CATEGORIES[activeCategory].emojis.map((emoji, i) => (
          <button
            key={i}
            onClick={() => { onSelect(emoji); onClose() }}
            className="w-7 h-7 flex items-center justify-center rounded hover:bg-white/10 text-lg transition-colors"
          >
            {emoji}
          </button>
        ))}
      </div>
    </div>
  )
}
