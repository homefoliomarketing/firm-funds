'use client'

import { useEffect, useRef } from 'react'
import { MessageSquare } from 'lucide-react'
import MessageBubble, { type MessageData } from './MessageBubble'

interface MessageThreadProps {
  messages: MessageData[]
  viewerRole: 'admin' | 'agent' | 'brokerage_admin'
  loading?: boolean
  emptyMessage?: string
}

export default function MessageThread({ messages, viewerRole, loading, emptyMessage }: MessageThreadProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const prevLengthRef = useRef(0)

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (messages.length > prevLengthRef.current && containerRef.current) {
      setTimeout(() => {
        if (containerRef.current) {
          containerRef.current.scrollTop = containerRef.current.scrollHeight
        }
      }, 100)
    }
    prevLengthRef.current = messages.length
  }, [messages.length])

  // Scroll to bottom on initial load
  useEffect(() => {
    if (messages.length > 0 && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight
    }
  }, [messages.length > 0])

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        <div className="text-sm">Loading messages...</div>
      </div>
    )
  }

  if (messages.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center px-4">
        <MessageSquare size={36} className="mb-3 opacity-20 text-muted-foreground" />
        <p className="text-sm font-medium text-muted-foreground">
          {emptyMessage || 'No messages yet'}
        </p>
        <p className="text-xs mt-1 text-muted-foreground/60">
          Start the conversation by sending a message below.
        </p>
      </div>
    )
  }

  return (
    <div ref={containerRef} className="flex-1 overflow-y-auto px-4 sm:px-5 py-4">
      {messages.map(msg => (
        <MessageBubble key={msg.id} msg={msg} viewerRole={viewerRole} />
      ))}
    </div>
  )
}
