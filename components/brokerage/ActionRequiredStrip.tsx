'use client'

import { AlertTriangle, Clock, Shield, MessageSquare, CalendarClock, CheckCircle2, ChevronRight } from 'lucide-react'

export type ActionTab = 'deals' | 'payments' | 'messages' | 'agents' | 'referrals'

type Tone = 'red' | 'amber' | 'blue' | 'primary'

interface Item {
  key: string
  count: number
  label: string
  Icon: typeof AlertTriangle
  tone: Tone
  onClick: () => void
  ariaLabel: string
}

interface Props {
  tradeRecordsMissing: number
  paymentClaimsPending: number
  amendmentsPending: number
  kycPending: number
  unreadMessages: number
  onNavigate: (tab: ActionTab) => void
  onAmendmentClick: () => void
}

const toneClasses: Record<Tone, { bg: string; border: string; hover: string; iconBg: string; iconText: string; count: string }> = {
  red: {
    bg: 'bg-red-950/30',
    border: 'border-red-800/50',
    hover: 'hover:border-red-600 hover:bg-red-950/45',
    iconBg: 'bg-red-500/15',
    iconText: 'text-red-400',
    count: 'text-red-300',
  },
  amber: {
    bg: 'bg-amber-950/30',
    border: 'border-amber-800/50',
    hover: 'hover:border-amber-600 hover:bg-amber-950/45',
    iconBg: 'bg-amber-500/15',
    iconText: 'text-amber-400',
    count: 'text-amber-300',
  },
  blue: {
    bg: 'bg-blue-950/30',
    border: 'border-blue-800/50',
    hover: 'hover:border-blue-600 hover:bg-blue-950/45',
    iconBg: 'bg-blue-500/15',
    iconText: 'text-blue-400',
    count: 'text-blue-300',
  },
  primary: {
    bg: 'bg-primary/[0.06]',
    border: 'border-primary/30',
    hover: 'hover:border-primary hover:bg-primary/[0.10]',
    iconBg: 'bg-primary/15',
    iconText: 'text-primary',
    count: 'text-primary',
  },
}

export default function ActionRequiredStrip({
  tradeRecordsMissing,
  paymentClaimsPending,
  amendmentsPending,
  kycPending,
  unreadMessages,
  onNavigate,
  onAmendmentClick,
}: Props) {
  const items: Item[] = [
    {
      key: 'trade',
      count: tradeRecordsMissing,
      label: tradeRecordsMissing === 1 ? 'Trade record missing' : 'Trade records missing',
      Icon: AlertTriangle,
      tone: 'red',
      onClick: () => onNavigate('deals'),
      ariaLabel: `${tradeRecordsMissing} trade record${tradeRecordsMissing === 1 ? '' : 's'} missing — view deals`,
    },
    {
      key: 'payments',
      count: paymentClaimsPending,
      label: paymentClaimsPending === 1 ? 'Payment claim pending' : 'Payment claims pending',
      Icon: Clock,
      tone: 'amber',
      onClick: () => onNavigate('payments'),
      ariaLabel: `${paymentClaimsPending} payment claim${paymentClaimsPending === 1 ? '' : 's'} awaiting Firm Funds confirmation — view payments`,
    },
    {
      key: 'amendments',
      count: amendmentsPending,
      label: amendmentsPending === 1 ? 'Amendment under review' : 'Amendments under review',
      Icon: CalendarClock,
      tone: 'amber',
      onClick: onAmendmentClick,
      ariaLabel: `${amendmentsPending} amendment${amendmentsPending === 1 ? '' : 's'} under review — view details`,
    },
    {
      key: 'kyc',
      count: kycPending,
      label: kycPending === 1 ? 'Agent ID to review' : 'Agent IDs to review',
      Icon: Shield,
      tone: 'blue',
      onClick: () => onNavigate('agents'),
      ariaLabel: `${kycPending} agent ID${kycPending === 1 ? '' : 's'} awaiting review — view agents`,
    },
    {
      key: 'messages',
      count: unreadMessages,
      label: unreadMessages === 1 ? 'Unread message' : 'Unread messages',
      Icon: MessageSquare,
      tone: 'red',
      onClick: () => onNavigate('messages'),
      ariaLabel: `${unreadMessages} unread message${unreadMessages === 1 ? '' : 's'} — view messages`,
    },
  ]

  const active = items.filter(i => i.count > 0)

  if (active.length === 0) {
    return (
      <section aria-label="Action items" className="mb-6">
        <div className="rounded-xl border border-status-green-border/50 bg-status-green-muted/30 px-5 py-3.5 flex items-center gap-3">
          <div className="w-9 h-9 rounded-full bg-status-green/15 flex items-center justify-center flex-shrink-0">
            <CheckCircle2 size={18} className="text-status-green" />
          </div>
          <div>
            <p className="text-sm font-semibold text-foreground">You&apos;re all caught up.</p>
            <p className="text-xs text-muted-foreground">Nothing needs your attention right now.</p>
          </div>
        </div>
      </section>
    )
  }

  const gridCols =
    active.length === 1 ? 'grid-cols-1' :
    active.length === 2 ? 'grid-cols-1 sm:grid-cols-2' :
    active.length === 3 ? 'grid-cols-1 sm:grid-cols-3' :
    active.length === 4 ? 'grid-cols-2 lg:grid-cols-4' :
    'grid-cols-2 lg:grid-cols-5'

  return (
    <section aria-label="Action required" className="mb-6">
      <div className="flex items-center justify-between mb-3">
        <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Needs your attention</p>
        <p className="text-[11px] text-muted-foreground/70">
          {active.length} {active.length === 1 ? 'item' : 'items'}
        </p>
      </div>
      <div className={`grid gap-3 ${gridCols}`}>
        {active.map((item) => {
          const t = toneClasses[item.tone]
          return (
            <button
              key={item.key}
              type="button"
              onClick={item.onClick}
              aria-label={item.ariaLabel}
              className={`group relative text-left rounded-xl p-4 transition-all border ${t.bg} ${t.border} ${t.hover} focus:outline-none focus:ring-2 focus:ring-ring`}
            >
              <div className="flex items-start justify-between gap-2 mb-3">
                <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${t.iconBg}`} aria-hidden="true">
                  <item.Icon size={17} className={t.iconText} />
                </div>
                <ChevronRight
                  size={15}
                  className={`opacity-30 group-hover:opacity-80 transition ${t.iconText}`}
                  aria-hidden="true"
                />
              </div>
              <p className={`text-2xl font-bold tabular-nums leading-none ${t.count}`}>{item.count}</p>
              <p className="text-xs mt-1.5 text-foreground/70">{item.label}</p>
            </button>
          )
        })}
      </div>
    </section>
  )
}
