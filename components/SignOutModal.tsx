'use client'

import { useState } from 'react'
import { LogOut, Loader2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'

interface SignOutModalProps {
  onConfirm: () => void | Promise<void>
}

export default function SignOutModal({ onConfirm }: SignOutModalProps) {
  const [open, setOpen] = useState(false)
  const [signingOut, setSigningOut] = useState(false)

  const handleConfirm = async () => {
    setSigningOut(true)
    try {
      const supabase = createClient()
      const { data: { user } } = await supabase.auth.getUser()
      if (user) {
        const { data: profile } = await supabase
          .from('user_profiles')
          .select('role')
          .eq('id', user.id)
          .single()
        void supabase.from('audit_log').insert({
          user_id: user.id,
          action: 'auth.logout',
          entity_type: 'auth',
          severity: 'info',
          actor_email: user.email,
          actor_role: profile?.role || null,
          metadata: { email: user.email },
        })
      }
    } catch {
      // Don't block logout on audit failure
    }
    await onConfirm()
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !signingOut && setOpen(v)}>
      <DialogTrigger
        className="inline-flex items-center justify-center gap-2 rounded-md border border-border/50 bg-transparent px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-primary"
      >
        <LogOut size={14} />
        Sign out
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader className="text-center sm:text-center">
          <div className="mx-auto mb-4">
            <img src="/brand/white.png" alt="Firm Funds" className="h-14 w-auto mx-auto mb-4" />
            <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center mx-auto">
              <LogOut size={24} className="text-primary" />
            </div>
          </div>
          <DialogTitle>Sign out?</DialogTitle>
          <DialogDescription>
            You&apos;ll need to sign back in to access your account.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="flex-row gap-3 sm:flex-row">
          {!signingOut && (
            <Button variant="outline" className="flex-1" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          )}
          <Button
            onClick={handleConfirm}
            disabled={signingOut}
            className="flex-1"
          >
            {signingOut ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Signing out...
              </>
            ) : (
              'Sign out'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
