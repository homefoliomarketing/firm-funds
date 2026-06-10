'use client'

import { useState } from 'react'
import { Sparkles, ChevronRight, X, AlertCircle } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { formatDate } from '@/lib/formatting'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import { DealNumber } from '@/components/DealNumber'
import { declineFirmDealOffer } from '@/lib/actions/firm-deal-offer-actions'

/**
 * Surfaces deals in status='offered' for the brokerage admin. Each row gives
 * them two actions: submit the advance (pre-filled form) or decline (with a
 * reason). Used on the brokerage dashboard. Offered deals are shown here
 * rather than mixed into the regular Deals tab so the brokerage admin
 * doesn't have to scroll past "real" deals to find the ones that need their
 * attention.
 *
 * The decline modal calls declineFirmDealOffer which flips the deal to
 * 'cancelled' and stamps the reason for the agent to see on their detail
 * page.
 */

export interface OfferedDeal {
  id: string
  /** Human-readable deal number. NULL for offered leads (assigned only on
   *  submission), so the banner renders a "Not yet submitted" chip. */
  deal_number?: string | null
  property_address: string
  closing_date: string | null
  created_at: string
  /** Set when the agent took this offer over to submit it themselves. The
   *  brokerage is paused on it: shown here as a passive, non-actionable note
   *  (no Submit / Decline). Migration 105. */
  agent_self_submit_at?: string | null
  agent?: {
    first_name?: string | null
    last_name?: string | null
    email?: string | null
  } | null
}

interface Props {
  deals: OfferedDeal[]
  onDeclined: (dealId: string) => void
}

export default function OfferedDealsBanner({ deals, onDeclined }: Props) {
  const router = useRouter()
  const [declineModal, setDeclineModal] = useState<{ dealId: string; agentName: string; address: string } | null>(null)
  const [declineReason, setDeclineReason] = useState('')
  const [declineSubmitting, setDeclineSubmitting] = useState(false)
  const [declineError, setDeclineError] = useState<string | null>(null)

  if (deals.length === 0) return null

  const openSubmission = (dealId: string) => {
    router.push(`/brokerage/deals/new?from_offer=${encodeURIComponent(dealId)}`)
  }

  const submitDecline = async () => {
    if (!declineModal) return
    if (declineReason.trim().length < 3) {
      setDeclineError('Please add a short reason so the agent understands.')
      return
    }
    setDeclineSubmitting(true)
    setDeclineError(null)
    try {
      const res = await declineFirmDealOffer(declineModal.dealId, declineReason.trim())
      if (!res.success) {
        setDeclineError(res.error || 'Could not decline this offer. Try again.')
        return
      }
      onDeclined(declineModal.dealId)
      setDeclineModal(null)
      setDeclineReason('')
    } catch (e) {
      setDeclineError(e instanceof Error ? e.message : 'Unexpected error.')
    } finally {
      setDeclineSubmitting(false)
    }
  }

  // Rows the agent took over to submit themselves are passive notes — the
  // brokerage can't act on them, so they don't count toward "waiting on you".
  const actionableCount = deals.filter(d => !d.agent_self_submit_at).length

  const label = actionableCount === 0
    ? 'Firm-deal offers'
    : actionableCount === 1
      ? '1 agent is waiting on you to submit an advance'
      : `${actionableCount} agents are waiting on you to submit an advance`

  return (
    <section aria-label="Offers awaiting brokerage submission" className="mb-6">
      <Card className="border-primary/40 bg-primary/[0.04]">
        <CardContent className="p-5">
          <div className="flex items-start gap-3 mb-4">
            <div className="flex-shrink-0 mt-0.5">
              <Sparkles size={18} className="text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="text-sm font-bold text-foreground">{label}</h3>
              <p className="text-xs mt-1 text-muted-foreground">
                {actionableCount === 0
                  ? 'These agents accepted firm-deal offers and chose to submit them themselves. Nothing for you to do here.'
                  : 'These agents accepted firm-deal offers and asked you to submit on their behalf. Open the pre-filled form to add the commission split and trade record, or decline if it doesn’t qualify.'}
              </p>
            </div>
          </div>

          <ul className="space-y-2.5">
            {deals.map((deal) => {
              const agentName = `${deal.agent?.first_name ?? ''} ${deal.agent?.last_name ?? ''}`.trim() || 'Agent'
              const agentSelfSubmitting = !!deal.agent_self_submit_at
              return (
                <li key={deal.id} className="rounded-lg border border-primary/20 bg-card/60 px-4 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 min-w-0">
                        <p className="text-sm font-semibold text-foreground truncate">{deal.property_address}</p>
                        <DealNumber value={deal.deal_number} showPending className="shrink-0" />
                      </div>
                      <p className="text-xs mt-0.5 text-muted-foreground">
                        Agent: <span className="text-foreground font-medium">{agentName}</span>
                        {deal.closing_date && (
                          <>
                            <span aria-hidden="true"> &middot; </span>
                            Closing <span className="text-foreground font-medium">{formatDate(deal.closing_date)}</span>
                          </>
                        )}
                        <span aria-hidden="true"> &middot; </span>
                        Accepted {formatDate(deal.created_at)}
                      </p>
                    </div>
                    {agentSelfSubmitting ? (
                      // Paused: the agent is submitting this one themselves, so
                      // the brokerage gets a passive note and no action buttons.
                      <span className="inline-flex items-center rounded-md bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground flex-shrink-0">
                        This agent is submitting this themselves
                      </span>
                    ) : (
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setDeclineModal({ dealId: deal.id, agentName, address: deal.property_address })}
                          className="text-status-amber hover:bg-status-amber-muted hover:text-status-amber"
                        >
                          Decline
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => openSubmission(deal.id)}
                          className="bg-primary text-primary-foreground hover:bg-primary/90"
                        >
                          Submit advance
                          <ChevronRight size={14} />
                        </Button>
                      </div>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        </CardContent>
      </Card>

      {declineModal && (
        <div
          className="fixed inset-0 z-[9999] bg-black/70 backdrop-blur-sm flex items-center justify-center p-6"
          onClick={() => !declineSubmitting && setDeclineModal(null)}
          role="dialog"
          aria-modal="true"
          aria-labelledby="decline-offer-title"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-card border border-border rounded-2xl p-6 max-w-md w-full shadow-2xl"
          >
            <div className="flex items-start justify-between mb-3">
              <div>
                <h2 id="decline-offer-title" className="text-base font-bold text-foreground">
                  Decline this advance offer
                </h2>
                <p className="text-xs mt-1 text-muted-foreground">
                  {declineModal.agentName} &middot; {declineModal.address}
                </p>
              </div>
              <button
                type="button"
                onClick={() => !declineSubmitting && setDeclineModal(null)}
                className="text-muted-foreground hover:text-foreground"
                aria-label="Close"
                disabled={declineSubmitting}
              >
                <X size={18} />
              </button>
            </div>
            <p className="text-sm text-foreground mb-3">
              Why doesn&apos;t this deal qualify? The agent will see this so they know what happened.
            </p>
            <Textarea
              value={declineReason}
              onChange={(e) => setDeclineReason(e.target.value)}
              placeholder="e.g. Agent owes us money from a previous deal, or unusual deal structure that won't fit an advance"
              rows={4}
              className="resize-none mb-3"
              maxLength={500}
            />
            {declineError && (
              <div className="mb-3 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3">
                <AlertCircle size={16} className="text-destructive shrink-0 mt-0.5" />
                <p className="text-xs text-destructive">{declineError}</p>
              </div>
            )}
            <div className="flex items-center justify-end gap-2">
              <Button
                variant="ghost"
                onClick={() => setDeclineModal(null)}
                disabled={declineSubmitting}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={submitDecline}
                disabled={declineSubmitting || declineReason.trim().length < 3}
              >
                {declineSubmitting ? 'Declining…' : 'Decline offer'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
