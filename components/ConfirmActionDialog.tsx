'use client'

import { ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

/**
 * Branded replacement for window.confirm(). Spells out the consequence in
 * plain language and keeps Cancel as the safe default. Use tone="danger" for
 * actions that restrict someone or remove something.
 */
export function ConfirmActionDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'default',
  busy = false,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  tone?: 'default' | 'danger'
  busy?: boolean
  onConfirm: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2.5">
            {tone === 'danger' && (
              <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-destructive/10">
                <AlertTriangle size={16} className="text-destructive" />
              </span>
            )}
            {title}
          </DialogTitle>
          <DialogDescription className="pt-1.5 text-left">{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter showCloseButton={false}>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            {cancelLabel}
          </Button>
          <Button
            variant={tone === 'danger' ? 'destructive' : 'default'}
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? 'Working...' : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
