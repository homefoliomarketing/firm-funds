'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { issueAgentRefund } from '@/lib/actions/deal-actions'
import { formatCurrency } from '@/lib/formatting'

// Account-level "issue refund" control on the admin agent page. Shown only to
// Owners (money.write) when the agent carries a standing credit. Records that
// the refund was paid out (the e-transfer/cheque happens out-of-band) and clears
// the credit from the agent's account via issueAgentRefund.
export function IssueRefundButton({ agentId, amount }: { agentId: string; amount: number }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleIssue() {
    setBusy(true)
    setError(null)
    const res = await issueAgentRefund({ agentId })
    if (res.success) {
      setConfirming(false)
      router.refresh()
    } else {
      setError(res.error || 'Could not issue the refund. Please try again.')
    }
    setBusy(false)
  }

  if (!confirming) {
    return (
      <div className="mt-4">
        <Button
          type="button"
          onClick={() => {
            setError(null)
            setConfirming(true)
          }}
          className="bg-status-teal-muted/60 text-status-teal hover:bg-status-teal-muted border border-status-teal-border/50"
        >
          Mark refund issued
        </Button>
        {error && (
          <p className="text-xs text-status-amber mt-2" role="alert">
            {error}
          </p>
        )}
      </div>
    )
  }

  return (
    <div className="mt-4 rounded-lg border border-status-teal-border/40 bg-status-teal-muted/30 p-4">
      <p className="text-sm text-foreground">
        Confirm you have paid <span className="font-semibold">{formatCurrency(amount)}</span> back to this agent (e-transfer or
        cheque)? This clears the credit from their account.
      </p>
      <div className="flex gap-2 mt-3">
        <Button type="button" variant="outline" onClick={() => setConfirming(false)} disabled={busy}>
          Cancel
        </Button>
        <Button type="button" onClick={handleIssue} disabled={busy}>
          {busy ? 'Recording…' : 'Yes, refund issued'}
        </Button>
      </div>
      {error && (
        <p className="text-xs text-status-amber mt-2" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
